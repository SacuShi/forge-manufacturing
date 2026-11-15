'use strict';
// Job notifications: browser push subscriptions, Discord webhooks, the job watch list, and the background checker
// that tells players when their industry jobs finish (by browser push, Discord, or both).

const logger = require('../lib/logger');
const config = require('../lib/config');
const discord = require('../lib/discord');
const { SQL_VARIABLE_LIMIT } = require('../lib/db');
const router = require('express').Router();

const DISCORD_GAP_MS = 400; // between posts in one checker run; Discord allows ~5 per 2 s per webhook
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function pushRoutes({ security, dbRun, dbAll, webpush }) {

  // Return VAPID public key so clients can subscribe
  router.get('/api/push/vapid-public-key', (req, res) => {
    if (!webpush || !config.vapid.publicKey) {
      return res.status(503).json({ error: 'Push notifications not configured on this server' });
    }
    res.json({ publicKey: config.vapid.publicKey });
  });

  // Save a push subscription for a character
  router.post('/api/push/subscribe', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    if (!webpush) return res.status(503).json({ error: 'Push not configured' });
    try {
      const { characterId } = req;
      const { endpoint, keys } = req.body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        return res.status(400).json({ error: 'Invalid subscription object' });
      }
      await dbRun(
        `INSERT INTO push_subscriptions (character_id, endpoint, p256dh, auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
        [characterId, endpoint, keys.p256dh, keys.auth]
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Remove push subscription. The app sends POST (its API client has no DELETE); DELETE is kept for other callers.
  const unsubscribe = async (req, res) => {
    try {
      const { characterId } = req;
      const { endpoint } = req.body || {};
      if (endpoint) {
        await dbRun('DELETE FROM push_subscriptions WHERE character_id = ? AND endpoint = ?', [characterId, endpoint]);
      } else {
        await dbRun('DELETE FROM push_subscriptions WHERE character_id = ?', [characterId]);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  router.delete('/api/push/unsubscribe', security.apiLimiter, security.verifyEveToken, unsubscribe);
  router.post('/api/push/unsubscribe', security.apiLimiter, security.verifyEveToken, unsubscribe);

  // Sync job watch list — frontend sends current active jobs so we know when to notify. Only stored for characters
  // with somewhere to send a notification (a push subscription or an active Discord webhook).
  router.post('/api/push/sync-jobs', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const { characterId } = req;
      const { jobs } = req.body;
      if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be an array' });

      const channel = await dbAll(
        `SELECT 1 FROM push_subscriptions WHERE character_id = ?
         UNION ALL SELECT 1 FROM discord_webhooks WHERE character_id = ? AND active = 1 LIMIT 1`,
        [characterId, characterId]
      );
      if (!channel.length) return res.json({ ok: true, skipped: true });

      for (const job of jobs.slice(0, 50)) {
        if (!job.key || !job.productName || !job.endDate) continue;
        await dbRun(
          `INSERT INTO push_job_watch (character_id, job_key, product_name, end_date, notified)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(character_id, job_key) DO UPDATE SET end_date=excluded.end_date WHERE notified=0`,
          [characterId, String(job.key).slice(0, 200), String(job.productName).slice(0, 120), String(job.endDate).slice(0, 30)]
        );
      }
      res.json({ ok: true, synced: jobs.length });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Discord webhook ──────────────────────────────────────────────────────────

  router.get('/api/notify/discord', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    if (!discord.isAvailable()) return res.json({ available: false, connected: false });
    res.json({ available: true, ...(await discord.getStatus(req.characterId)) });
  });

  // Connect (or replace) a webhook. A confirmation message is posted first, so a wrong URL is caught here.
  router.post('/api/notify/discord', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    if (!discord.isAvailable()) {
      return res.status(503).json({ error: 'Discord notifications are not set up on this server' });
    }
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!discord.isDiscordWebhookUrl(url)) {
      return res.status(400).json({ error: 'That is not a Discord webhook URL. It starts with https://discord.com/api/webhooks/' });
    }
    const result = await discord.postWebhook(url, discord.connectedMessage());
    if (!result.ok) {
      return res.status(400).json({
        error: result.gone
          ? 'Discord says that webhook does not exist. Copy the URL again from the channel settings.'
          : `Discord did not accept the message (${result.status || 'no response'}). Try again in a minute.`,
      });
    }
    await discord.saveWebhook(req.characterId, url);
    res.json({ available: true, ...(await discord.getStatus(req.characterId)) });
  });

  router.post('/api/notify/discord/test', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    const url = await discord.getWebhookUrl(req.characterId);
    if (!url) return res.status(404).json({ error: 'No active Discord webhook. Connect one first.' });
    const result = await discord.postWebhook(url, discord.testMessage());
    await discord.recordResult(req.characterId, result);
    res.status(result.ok ? 200 : 502)
      .json({ ok: result.ok, available: true, ...(await discord.getStatus(req.characterId)) });
  });

  // POST alias for the app's API client, like /api/push/unsubscribe
  const disconnect = async (req, res) => {
    await discord.deleteWebhook(req.characterId);
    res.json({ available: discord.isAvailable(), connected: false, active: false, lastOkAt: null, lastError: null });
  };
  router.delete('/api/notify/discord', security.apiLimiter, security.verifyEveToken, disconnect);
  router.post('/api/notify/discord/disconnect', security.apiLimiter, security.verifyEveToken, disconnect);

  return router;
};

// Background checker — called from the scheduler every 5 minutes, not a route.
// A job counts as handled once any channel delivered it, or when nothing is left to try (no channel, or every channel
// is gone). Only when every channel failed temporarily is it left for the next run.
let _checkRunning = false;
module.exports.checkJobCompletions = async function checkJobCompletions({ dbRun, dbAll, webpush }) {
  if (_checkRunning) return; // ESI slow-path guard — prevents overlapping runs
  _checkRunning = true;
  try {
    const now = new Date().toISOString();
    const due = await dbAll(
      `SELECT id, character_id, product_name FROM push_job_watch
        WHERE end_date <= ? AND notified = 0 ORDER BY end_date`,
      [now]
    );

    const byCharacter = new Map();
    for (const job of due) {
      if (!byCharacter.has(job.character_id)) byCharacter.set(job.character_id, []);
      byCharacter.get(job.character_id).push(job);
    }

    const handled = [];
    let pushSent = 0, discordSent = 0;
    for (const [characterId, jobs] of byCharacter) {
      let delivered = false, retry = false;

      const subs = webpush
        ? await dbAll('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE character_id = ?', [characterId])
        : [];
      for (const sub of subs) {
        for (const job of jobs) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              JSON.stringify({ title: 'FORGE — Job Complete', body: `${job.product_name} has finished!`, tag: `job-${job.id}` })
            );
            delivered = true;
            pushSent++;
          } catch (e) {
            if (e.statusCode === 410 || e.statusCode === 404) {
              await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]);
              break; // this browser unsubscribed: skip its remaining jobs
            }
            retry = true;
            logger.error('Push send error:', e.message);
          }
        }
      }

      const hookUrl = await discord.getWebhookUrl(characterId);
      if (hookUrl) {
        const result = await discord.postWebhook(hookUrl, discord.jobsCompleteMessage(jobs.map((j) => j.product_name)));
        await discord.recordResult(characterId, result);
        if (result.ok) { delivered = true; discordSent++; }
        else if (!result.gone) { retry = true; logger.warn(`Discord post for ${characterId} failed: ${result.status || result.error}`); }
        await sleep(DISCORD_GAP_MS);
      }

      if (delivered || !retry) handled.push(...jobs.map((j) => j.id));
    }

    for (let i = 0; i < handled.length; i += SQL_VARIABLE_LIMIT) {
      const ids = handled.slice(i, i + SQL_VARIABLE_LIMIT);
      await dbRun(`UPDATE push_job_watch SET notified = 1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    }
    if (pushSent || discordSent) {
      logger.info(`🔔 Job notifications: ${pushSent} browser push, ${discordSent} Discord message(s)`);
    }

    // Old rows: delivered ones after 2 days; ones still failing after 7 (a channel that never recovered)
    await dbRun(`DELETE FROM push_job_watch
                  WHERE (notified = 1 AND end_date < datetime('now','-2 days')) OR end_date < datetime('now','-7 days')`);
  } catch (err) {
    logger.error('Push job check error:', err.message);
  } finally {
    _checkRunning = false;
  }
};
