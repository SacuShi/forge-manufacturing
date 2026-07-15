'use strict';
// Push notification endpoints + background job-completion checker.

const router = require('express').Router();

module.exports = function pushRoutes({ security, dbRun, dbAll, webpush }) {

  // Return VAPID public key so clients can subscribe
  router.get('/api/push/vapid-public-key', (req, res) => {
    if (!webpush || !process.env.VAPID_PUBLIC_KEY) {
      return res.status(503).json({ error: 'Push notifications not configured on this server' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
  });

  // Save a push subscription for a character
  router.post('/api/push/subscribe', security.apiLimiter, async (req, res) => {
    if (!webpush) return res.status(503).json({ error: 'Push not configured' });
    try {
      const { characterId } = await security.extractCharacterFromToken(req.headers.authorization || '');
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

  // Remove push subscription
  router.delete('/api/push/unsubscribe', security.apiLimiter, async (req, res) => {
    try {
      const { characterId } = await security.extractCharacterFromToken(req.headers.authorization || '');
      const { endpoint } = req.body;
      if (endpoint) {
        await dbRun('DELETE FROM push_subscriptions WHERE character_id = ? AND endpoint = ?', [characterId, endpoint]);
      } else {
        await dbRun('DELETE FROM push_subscriptions WHERE character_id = ?', [characterId]);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Sync job watch list — frontend sends current active jobs so we know when to notify
  router.post('/api/push/sync-jobs', security.apiLimiter, async (req, res) => {
    if (!webpush) return res.json({ ok: true, skipped: true });
    try {
      const { characterId } = await security.extractCharacterFromToken(req.headers.authorization || '');
      const { jobs } = req.body;
      if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be an array' });

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

  return router;
};

// Background checker — called from server startup, not a route.
// Exported separately so server.js can call it on an interval.
let _checkRunning = false;
module.exports.checkJobCompletions = async function checkJobCompletions({ dbRun, dbAll, webpush }) {
  if (!webpush) return;
  if (_checkRunning) return; // ESI slow-path guard — prevents overlapping runs
  _checkRunning = true;
  try {
    const now = new Date().toISOString();
    const due = await dbAll(
      `SELECT pjw.id, pjw.character_id, pjw.product_name,
              ps.endpoint, ps.p256dh, ps.auth
       FROM push_job_watch pjw
       JOIN push_subscriptions ps ON ps.character_id = pjw.character_id
       WHERE pjw.end_date <= ? AND pjw.notified = 0`,
      [now]
    );
    if (!due.length) return;

    const notified = [];
    const expired  = [];
    for (const job of due) {
      try {
        await webpush.sendNotification(
          { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
          JSON.stringify({ title: 'FORGE — Job Complete', body: `${job.product_name} has finished!`, tag: `job-${job.id}` })
        );
        notified.push(job.id);
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) expired.push(job.endpoint);
        else console.error('Push send error:', e.message);
      }
    }

    if (notified.length) {
      await dbRun(`UPDATE push_job_watch SET notified=1 WHERE id IN (${notified.map(() => '?').join(',')})`, notified);
    }
    if (expired.length) {
      for (const ep of expired) await dbRun('DELETE FROM push_subscriptions WHERE endpoint=?', [ep]);
    }
    if (notified.length) console.log(`🔔 Push: sent ${notified.length} job completion notification(s)`);

    await dbRun(`DELETE FROM push_job_watch WHERE notified=1 AND end_date < datetime('now','-2 days')`);
  } catch (err) {
    console.error('Push job check error:', err.message);
  } finally {
    _checkRunning = false;
  }
};
