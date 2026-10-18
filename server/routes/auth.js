'use strict';
// Login (EVE SSO code exchange) and "Remember my characters" (encrypted alt refresh tokens kept per browser).

const express = require('express');
const fetch = require('node-fetch');
const config = require('../lib/config');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { REMEMBER_ENCRYPTION_KEY, encryptToken, decryptToken } = require('../lib/token-crypto');

const router = express.Router();

// EVE OAUTH
router.post('/api/eve-token', security.authLimiter, async (req, res) => {
  try {
    const { code, redirect_uri, remember } = req.body;
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: "Missing code or redirect_uri" });
    }

    const clientId = config.eve.clientId;
    const clientSecret = config.eve.clientSecret;

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'login.eveonline.com'
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(String(code))}&redirect_uri=${encodeURIComponent(redirect_uri)}`
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      logger.error("EVE OAuth error:", tokenData.error, tokenData.error_description);
      return res.status(400).json({ error: tokenData.error_description || "Token exchange failed" });
    }

    logger.info("✓ EVE OAuth successful");

    // ── "Remember my characters" capture (alt-add only) ───────────────────────
    // Only runs when the client asks for it (remember=true, sent when adding an
    // alt while the main's remember preference is on) AND an Authorization
    // header identifying the MAIN is present. Never blocks the normal login —
    // any failure here is logged and swallowed so the alt still logs in.
    if (remember === true && req.headers.authorization && tokenData.refresh_token) {
      try {
        await captureRememberedCharacter(req.headers.authorization, tokenData);
      } catch (e) {
        logger.warn('⚠ Remember-character capture failed (alt still logs in normally):', e.message);
      }
    }

    // Return ONLY the access token — never send refresh_token to the client
    res.json({ access_token: tokenData.access_token });

  } catch (err) {
    logger.error("OAuth error:", err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── "Remember my characters" ────────────────────────────────────────────────
// Security model:
//  - Refresh tokens are captured ONLY for alts explicitly added while the
//    main's remember preference is on, and ONLY over a request carrying a
//    valid Authorization header for that main (proves the main is logged in
//    right now) — this is "remember MY OWN alt I just logged into via SSO",
//    never a way to add a character without its own SSO consent.
//  - Stored encrypted with REMEMBER_ENCRYPTION_KEY — deliberately a different
//    key/env var than the corp-director tokens (CORP_ENCRYPTION_KEY), so a
//    leak of one doesn't also decrypt the other.
//  - Every restore re-verifies the refreshed token's `owner` claim against the
//    one captured at add-time — if a character is sold/transferred, the owner
//    hash changes, the stored token is deleted, and it's never handed to the
//    new owner's account.
//  - granted_scopes is compared against the CURRENT required scope list on
//    every list/restore call — if CCP added scopes since capture, the alt is
//    flagged "needs re-authorisation" instead of silently running with fewer
//    permissions than the rest of the app assumes it has.
//  - Max REMEMBER_MAX_ALTS remembered alts per main; auto-pruned after
//    REMEMBER_RETENTION_DAYS unused.
//  - Turning the preference off deletes every stored token for that main
//    immediately, and a capture only ever happens if the server's OWN stored
//    preference is on (the client's `remember` flag alone is not trusted).

// Mirrors SCOPES in forge-v1/src/hooks/useAuth.ts — keep in sync when scopes change.
const REMEMBER_REQUIRED_SCOPES = new Set([
  'esi-assets.read_assets.v1',
  'esi-characters.read_blueprints.v1',
  'esi-wallet.read_character_wallet.v1',
  'esi-industry.read_character_jobs.v1',
  'esi-skills.read_skills.v1',
  'esi-planets.manage_planets.v1',
  'esi-characters.read_standings.v1',
  'esi-characters.read_corporation_roles.v1',
  'esi-corporations.read_corporation_membership.v1',
  'esi-corporations.read_blueprints.v1',
  'esi-assets.read_corporation_assets.v1',
  'esi-industry.read_corporation_jobs.v1',
  'esi-clones.read_implants.v1',
  'esi-clones.read_clones.v1',
  'esi-markets.read_character_orders.v1',
  'esi-markets.structure_markets.v1',
  'esi-characters.read_loyalty.v1',
  'esi-universe.read_structures.v1',
]);

const REMEMBER_MAX_ALTS        = 15;

const REMEMBER_RETENTION_DAYS  = 90;

/** EVE JWT 'scp' claim is either a single string or an array of strings. */
function scopesFromJwtPayload(payload) {
  if (!payload.scp) return [];
  return Array.isArray(payload.scp) ? payload.scp : [payload.scp];
}

/** Which of the currently-required scopes are absent from a stored space-separated scope string. */
function missingRememberScopes(grantedScopesStr) {
  const granted = new Set((grantedScopesStr || '').split(' ').filter(Boolean));
  return [...REMEMBER_REQUIRED_SCOPES].filter(s => !granted.has(s));
}

/** Delete remembered alts under one main that haven't been used in REMEMBER_RETENTION_DAYS. */
async function pruneRememberedCharacters(mainCharacterId) {
  await dbRun(
    `DELETE FROM remembered_characters
      WHERE main_character_id = ?
        AND datetime(COALESCE(last_used_at, created_at)) < datetime('now', ?)`,
    [mainCharacterId, `-${REMEMBER_RETENTION_DAYS} days`]
  );
}

/**
 * Called from /api/eve-token when an alt is added with remember=true in the
 * body. mainAuthHeader is the Authorization header of the MAIN character's
 * own request (proves the main is currently logged in); tokenData is the raw
 * EVE OAuth token response for the ALT that was just added. Throws on any
 * failure — the caller logs and swallows it, since a remember-capture
 * failure must never break the normal alt-login flow.
 */
async function captureRememberedCharacter(mainAuthHeader, tokenData) {
  if (!REMEMBER_ENCRYPTION_KEY) throw new Error('FORGE_REMEMBER_KEY not configured');

  const { characterId: mainCharacterId } = await security.extractCharacterFromToken(mainAuthHeader);

  const pref = await dbGet('SELECT enabled FROM character_remember_pref WHERE character_id = ?', [mainCharacterId]);
  if (!pref?.enabled) return; // server-side preference is the source of truth, not just the client's flag

  const { characterId: altCharacterId, characterName, payload } =
    await security.extractCharacterFromToken(`Bearer ${tokenData.access_token}`);

  if (altCharacterId === mainCharacterId) return; // don't remember yourself as your own alt

  await pruneRememberedCharacters(mainCharacterId);

  const existing = await dbGet(
    'SELECT 1 FROM remembered_characters WHERE main_character_id = ? AND character_id = ?',
    [mainCharacterId, altCharacterId]
  );
  if (!existing) {
    const row = await dbGet(
      'SELECT COUNT(*) AS count FROM remembered_characters WHERE main_character_id = ?',
      [mainCharacterId]
    );
    if ((row?.count || 0) >= REMEMBER_MAX_ALTS) {
      throw new Error(`Remembered-character limit reached (${REMEMBER_MAX_ALTS}) — forget one before adding another`);
    }
  }

  const enc       = encryptToken(tokenData.refresh_token, REMEMBER_ENCRYPTION_KEY);
  const scopesStr = scopesFromJwtPayload(payload).join(' ');

  await dbRun(
    `INSERT INTO remembered_characters
       (main_character_id, character_id, character_name, enc_refresh_token, token_iv, token_tag,
        owner_hash, granted_scopes, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(main_character_id, character_id) DO UPDATE SET
       character_name    = excluded.character_name,
       enc_refresh_token  = excluded.enc_refresh_token,
       token_iv           = excluded.token_iv,
       token_tag          = excluded.token_tag,
       owner_hash         = excluded.owner_hash,
       granted_scopes     = excluded.granted_scopes,
       last_used_at       = datetime('now')`,
    [mainCharacterId, altCharacterId, characterName, enc.ciphertext, enc.iv, enc.tag,
     payload.owner || '', scopesStr]
  );

  logger.info(`✓ Remembered alt ${characterName} (${altCharacterId}) under main ${mainCharacterId}`);
}

// GET current remember preference for the logged-in main.
router.get('/api/remember/status', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const row = await dbGet('SELECT enabled FROM character_remember_pref WHERE character_id = ?', [req.characterId]);
    res.json({ enabled: !!row?.enabled, configured: !!REMEMBER_ENCRYPTION_KEY });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// SET the remember preference. Turning it off immediately forgets every
// stored alt for this main — "off" means off, not "stop adding new ones."
router.post('/api/remember/status', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    await dbRun(
      `INSERT INTO character_remember_pref (character_id, enabled, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
      [req.characterId, enabled ? 1 : 0]
    );
    if (!enabled) {
      await dbRun('DELETE FROM remembered_characters WHERE main_character_id = ?', [req.characterId]);
    }
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// List remembered alts for the login-time restore prompt. No network calls —
// needsReauth is derived from the scopes captured at add-time vs. what's
// currently required, so listing is cheap and safe to call on every login.
router.get('/api/remember/list', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT character_id, character_name, granted_scopes, last_used_at, created_at
         FROM remembered_characters WHERE main_character_id = ?
        ORDER BY last_used_at DESC, created_at DESC`,
      [req.characterId]
    );
    res.json({
      characters: rows.map(r => ({
        characterId: r.character_id,
        name:        r.character_name,
        lastUsedAt:  r.last_used_at || r.created_at,
        needsReauth: missingRememberScopes(r.granted_scopes).length > 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Forget one remembered alt, or all of them.
router.post('/api/remember/forget', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    if (req.body?.all === true) {
      await dbRun('DELETE FROM remembered_characters WHERE main_character_id = ?', [req.characterId]);
    } else {
      const characterId = parseInt(req.body?.characterId, 10);
      if (!characterId) return res.status(400).json({ error: 'characterId or all required' });
      await dbRun(
        'DELETE FROM remembered_characters WHERE main_character_id = ? AND character_id = ?',
        [req.characterId, characterId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Restore selected remembered alts: refresh each one's token server-side and
// hand back fresh ACCESS tokens only (never the refresh token). A per-alt
// failure (revoked, transferred, expired) doesn't fail the others — each
// result is independently ok or { error }.
router.post('/api/remember/restore', security.authLimiter, security.verifyEveToken, async (req, res) => {
  try {
    if (!REMEMBER_ENCRYPTION_KEY) return res.status(503).json({ error: 'Remember-characters not configured on server' });

    const requested = Array.isArray(req.body?.characterIds)
      ? req.body.characterIds.map(Number).filter(Number.isFinite)
      : [];
    if (requested.length === 0) return res.json({ results: [] });

    const placeholders = requested.map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT * FROM remembered_characters
        WHERE main_character_id = ? AND character_id IN (${placeholders})`,
      [req.characterId, ...requested]
    );

    const clientId     = config.eve.clientId;
    const clientSecret  = config.eve.clientSecret;
    const basicAuth     = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const results = await Promise.all(rows.map(async (row) => {
      try {
        const refreshToken = decryptToken(row.enc_refresh_token, row.token_iv, row.token_tag, REMEMBER_ENCRYPTION_KEY);
        const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Host': 'login.eveonline.com',
          },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
        });
        const data = await tokenRes.json();
        if (!tokenRes.ok) throw new Error(data.error_description || data.error || 'Refresh failed');

        const { characterId: refreshedId, payload } =
          await security.extractCharacterFromToken(`Bearer ${data.access_token}`);

        // Character-transfer guard: the account that owns this character must
        // still be the one we captured the token under.
        if (payload.owner && row.owner_hash && payload.owner !== row.owner_hash) {
          await dbRun(
            'DELETE FROM remembered_characters WHERE main_character_id = ? AND character_id = ?',
            [req.characterId, row.character_id]
          );
          throw new Error('Character ownership changed — please re-add this character');
        }

        // Rotate the stored refresh token if EVE issued a new one; always refresh scopes + last_used_at.
        const scopesStr = scopesFromJwtPayload(payload).join(' ') || row.granted_scopes;
        if (data.refresh_token && data.refresh_token !== refreshToken) {
          const enc = encryptToken(data.refresh_token, REMEMBER_ENCRYPTION_KEY);
          await dbRun(
            `UPDATE remembered_characters
                SET enc_refresh_token = ?, token_iv = ?, token_tag = ?, granted_scopes = ?, last_used_at = datetime('now')
              WHERE main_character_id = ? AND character_id = ?`,
            [enc.ciphertext, enc.iv, enc.tag, scopesStr, req.characterId, row.character_id]
          );
        } else {
          await dbRun(
            `UPDATE remembered_characters SET granted_scopes = ?, last_used_at = datetime('now')
              WHERE main_character_id = ? AND character_id = ?`,
            [scopesStr, req.characterId, row.character_id]
          );
        }

        return { characterId: refreshedId, name: row.character_name, access_token: data.access_token };
      } catch (e) {
        return { characterId: row.character_id, name: row.character_name, error: e.message };
      }
    }));

    res.json({ results });
  } catch (err) {
    logger.error('Remember-restore error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
