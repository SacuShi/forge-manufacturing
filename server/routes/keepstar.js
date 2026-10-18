'use strict';
// C-J6MT Keepstar: whether the logged-in character can dock there, and the admin-only one-off flow that stores the
// structure-market token.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const crypto = require('crypto'); // built-in
const fetch = require('node-fetch');
const config = require('../lib/config');
const { dbRun } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { CORP_ENCRYPTION_KEY, encryptToken } = require('../lib/token-crypto');
const { KEEPSTAR_STRUCTURE_ID } = require('../lib/hubs');
const { _ksTkPool } = require('../lib/keepstar-token');

const router = express.Router();

// GET /api/can-dock-keepstar — checks if the authenticated character has docking rights
// at the C-J6MT Keepstar by probing the structure market endpoint.
// Uses esi-markets.structure_markets.v1 (already in the character's SCOPES — no re-login needed).
// ESI returns 200 if the character has docking rights, 403 if not.
// All non-403 outcomes (network errors, ESI 5xx, etc.) return canDock: true — fail-open so
// Imperium/corp/alliance members are NEVER locked out due to a transient ESI issue.
router.get('/api/can-dock-keepstar', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  // Kill switch: when disabled, everyone sees C-J6MT (safe rollback).
  if (!KEEPSTAR_ACCESS_CHECK_ENABLED) return res.json({ canDock: true });

  const eveToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  try {
    const esiRes = await fetch(
      `https://esi.evetech.net/latest/markets/structures/${KEEPSTAR_STRUCTURE_ID}/?datasource=tranquility&page=1`,
      { headers: { Authorization: `Bearer ${eveToken}` } }
    );
    // Drain body to close the connection — we only need the status code.
    await esiRes.text().catch(() => '');
    if (esiRes.status === 403) return res.json({ canDock: false });
    return res.json({ canDock: true });
  } catch {
    // Network error, ESI down, etc. — fail-open.
    return res.json({ canDock: true });
  }
});

// Kill switch: set false to show C-J6MT to all users (e.g. if ESI check causes unexpected issues).
// Redeploy routes/keepstar.js + pm2 restart 0 to activate — no frontend change needed.
const KEEPSTAR_ACCESS_CHECK_ENABLED = true;

// ── Keepstar structure-token (re-)authorisation flow ─────────────────────────
// Manual recovery path for when the stored structure_token refresh token gets
// revoked/expired (CCP returns an HTML error page instead of JSON in that case —
// see "[KS token] DB refresh failed" in logs). Referenced by error messages
// throughout this file and by test-keepstar-poll.js; was missing from the
// route table entirely until restored here (found during the Oct 2026 outage
// investigation — the normal session-pool token had been self-healing instead,
// masking the fact that this manual path was a dead link).
// Gated by FORGE_ADMIN_KEY (as a query param — this is a plain browser-visited
// link, not an API call, so it can't use the X-Admin-Key header convention).
const _ksAuthStates = new Map(); // state → expiry; short-lived CSRF nonce store

function isAdminKeyValid(provided) {
  const adminKey = config.adminKey;
  if (!adminKey || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(adminKey);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.get('/api/ks-test-auth', (req, res) => {
  if (!isAdminKeyValid(req.query.key)) return res.status(403).send('Forbidden — bad or missing ?key=');
  if (!CORP_ENCRYPTION_KEY) return res.status(500).send('FORGE_CORP_KEY not configured on server');
  if (!config.eve.clientId) return res.status(500).send('EVE_CLIENT_ID not configured on server');

  const state = crypto.randomBytes(16).toString('hex');
  _ksAuthStates.set(state, Date.now() + 10 * 60 * 1000); // 10 min to complete login

  const redirectUri = `${req.protocol}://${req.get('host')}/api/ks-test-callback`;
  const authorizeUrl = 'https://login.eveonline.com/v2/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    redirect_uri:  redirectUri,
    client_id:     config.eve.clientId,
    scope:         'esi-markets.structure_markets.v1',
    state,
  });
  res.redirect(authorizeUrl);
});

router.get('/api/ks-test-callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const expiry = state && _ksAuthStates.get(state);
    if (!expiry || Date.now() > expiry) return res.status(400).send('Invalid or expired state — start again from /api/ks-test-auth?key=...');
    _ksAuthStates.delete(state);
    if (!code) return res.status(400).send('Missing code');

    const authHdr = 'Basic ' + Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/ks-test-callback`;
    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method:  'POST',
      headers: { 'Authorization': authHdr, 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'login.eveonline.com' },
      body:    `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      return res.status(400).json({ error: `Token exchange failed: ${tokenData.error_description || tokenData.error || tokenRes.status}` });
    }

    // Identify the authorising character for the confirmation page (best-effort).
    let charName = 'unknown character';
    try {
      const verifyRes = await fetch('https://login.eveonline.com/oauth/verify', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (verifyRes.ok) charName = (await verifyRes.json()).CharacterName || charName;
    } catch (_) { /* best-effort only */ }

    const enc = encryptToken(tokenData.refresh_token); // default key = CORP_ENCRYPTION_KEY
    await dbRun(
      `INSERT INTO structure_token (structure_id, enc_refresh_token, token_iv, token_tag, stored_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(structure_id) DO UPDATE SET
         enc_refresh_token = excluded.enc_refresh_token,
         token_iv           = excluded.token_iv,
         token_tag           = excluded.token_tag,
         stored_at           = excluded.stored_at`,
      [KEEPSTAR_STRUCTURE_ID, enc.ciphertext, enc.iv, enc.tag]
    );

    // Drop the in-memory pool so the next Keepstar fetch re-reads the fresh DB token
    // immediately instead of waiting out whatever stale window it had cached.
    _ksTkPool.token = null;
    _ksTkPool.expiry = 0;
    _ksTkPool.fromDb = false;

    logger.info(`✓ [KS auth] Structure token re-authorised by ${charName}`);
    // Constant page: nothing from CCP is placed into HTML (who authorised it is in the server log above).
    res.send('<html><body style="font-family:sans-serif;padding:40px"><h2 style="color:#2a2">✓ Keepstar structure token refreshed</h2><p>The stored refresh token has been updated — Keepstar market polling will use it on the next fetch.</p></body></html>');
  } catch (err) {
    logger.error('[KS auth] Callback failed:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
