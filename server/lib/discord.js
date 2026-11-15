'use strict';
// Discord job notifications. A player pastes a webhook URL from their own Discord channel (Channel settings →
// Integrations → Webhooks) and FORGE posts there when their industry jobs finish. No bot account is involved.
// The URL is stored encrypted: anyone holding it can post to that channel.

const fetch = require('node-fetch');
const logger = require('./logger');
const { dbGet, dbRun } = require('./db');
const { REMEMBER_ENCRYPTION_KEY, encryptToken, decryptToken } = require('./token-crypto');

// Only real Discord webhook URLs: FORGE makes the request, so anything else would let a player point the server at an
// arbitrary address. Redirects are refused for the same reason.
const WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[\w-]{20,200}$/;
const POST_TIMEOUT_MS = 10_000;
const EMBED_COLOUR = 0x4fc3f7;   // FORGE accent cyan
const MAX_LISTED = 15;           // jobs listed by name in one message; the rest are counted
const SITE_URL = 'https://forge-ukc.com';

const isAvailable = () => !!REMEMBER_ENCRYPTION_KEY;
const isDiscordWebhookUrl = (url) => typeof url === 'string' && WEBHOOK_RE.test(url.trim());

/** POSTs a message. Never throws: { ok, status, gone } where gone = Discord says the webhook no longer exists. */
async function postWebhook(url, payload) {
  if (!isDiscordWebhookUrl(url)) return { ok: false, status: 0, gone: true, error: 'not a Discord webhook URL' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'FORGE job notifications (forge-ukc.com)' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, gone: res.status === 401 || res.status === 404 };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Product names arrive from the browser: strip Markdown so a name can't restyle or link the message
// (mentions are already disabled by allowed_mentions).
const plain = (s) => String(s ?? '').replace(/[*_`~|>\\[\]()<@#]/g, '').trim().slice(0, 100) || 'Unknown item';

function message(title, description) {
  return {
    username: 'FORGE',
    allowed_mentions: { parse: [] },
    embeds: [{
      title, description, url: SITE_URL, color: EMBED_COLOUR,
      footer: { text: 'FORGE · forge-ukc.com' },
      timestamp: new Date().toISOString(),
    }],
  };
}

function jobsCompleteMessage(productNames) {
  const n = productNames.length;
  const lines = productNames.slice(0, MAX_LISTED).map((p) => `• ${plain(p)}`);
  if (n > MAX_LISTED) lines.push(`…and ${n - MAX_LISTED} more`);
  return message(n === 1 ? 'Industry job complete' : `${n} industry jobs complete`, lines.join('\n'));
}

const connectedMessage = () =>
  message('Job notifications connected', 'FORGE will post here when your industry jobs finish.');
const testMessage = () =>
  message('Test notification', 'This is a test from FORGE. Job completions will look like this.');

async function saveWebhook(characterId, url) {
  const enc = encryptToken(url.trim(), REMEMBER_ENCRYPTION_KEY);
  await dbRun(
    `INSERT INTO discord_webhooks (character_id, enc_url, url_iv, url_tag, active, last_ok_at, last_error)
     VALUES (?, ?, ?, ?, 1, datetime('now'), NULL)
     ON CONFLICT(character_id) DO UPDATE SET
       enc_url = excluded.enc_url, url_iv = excluded.url_iv, url_tag = excluded.url_tag,
       active = 1, last_ok_at = excluded.last_ok_at, last_error = NULL`,
    [Number(characterId), enc.ciphertext, enc.iv, enc.tag]
  );
}

const deleteWebhook = (characterId) =>
  dbRun('DELETE FROM discord_webhooks WHERE character_id = ?', [Number(characterId)]);

/** The active webhook URL for a character, or null. */
async function getWebhookUrl(characterId) {
  if (!isAvailable()) return null;
  const row = await dbGet(
    'SELECT enc_url, url_iv, url_tag FROM discord_webhooks WHERE character_id = ? AND active = 1', [Number(characterId)]);
  if (!row) return null;
  try {
    return decryptToken(row.enc_url, row.url_iv, row.url_tag, REMEMBER_ENCRYPTION_KEY);
  } catch (err) {
    logger.error(`Discord webhook for ${characterId} could not be decrypted:`, err.message);
    return null;
  }
}

/** What the settings panel shows. Never includes the URL. */
async function getStatus(characterId) {
  const row = await dbGet(
    'SELECT active, last_ok_at, last_error FROM discord_webhooks WHERE character_id = ?', [Number(characterId)]);
  return row
    ? { connected: true, active: row.active === 1, lastOkAt: row.last_ok_at, lastError: row.last_error }
    : { connected: false, active: false, lastOkAt: null, lastError: null };
}

/** Stores the outcome of a post; a webhook Discord says is gone is switched off so FORGE stops posting to it. */
async function recordResult(characterId, result) {
  if (result.ok) {
    await dbRun(`UPDATE discord_webhooks SET last_ok_at = datetime('now'), last_error = NULL WHERE character_id = ?`,
      [Number(characterId)]);
  } else if (result.gone) {
    await dbRun(`UPDATE discord_webhooks SET active = 0, last_error = ? WHERE character_id = ?`,
      ['Discord says this webhook was deleted. Connect a new one to keep getting notifications.', Number(characterId)]);
  } else {
    await dbRun('UPDATE discord_webhooks SET last_error = ? WHERE character_id = ?',
      [`Last message failed (${result.status || result.error || 'no response'}); FORGE will retry.`, Number(characterId)]);
  }
}

module.exports = {
  isAvailable, isDiscordWebhookUrl, postWebhook, jobsCompleteMessage, connectedMessage, testMessage,
  saveWebhook, deleteWebhook, getWebhookUrl, getStatus, recordResult,
};
