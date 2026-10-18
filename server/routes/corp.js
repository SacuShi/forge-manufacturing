'use strict';
// The Corp tab: status, set-up (legacy stored token), blueprints / assets / jobs for Directors, refresh, and the
// admin whitelist.

const crypto = require('crypto'); // built-in
const express = require('express');
const fetch = require('node-fetch');
const config = require('../lib/config');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { clientErrMsg } = require('../lib/http-errors');
const { CORP_ENCRYPTION_KEY, encryptToken } = require('../lib/token-crypto');
const {
  CORP_BP_USABLE_SQL, refreshCorpData, ensureCorpDataFresh, corpLastRefreshIso, resolveViewerCorpAccess, requireDirectorRole,
} = require('../lib/corp');

const router = express.Router();

// ════════════════════════════════════════════════════════════════════════════
// CORP API ENDPOINTS (v1.5.2 — Director-role access)
//
// Access model: characters with the EVE Director role in the configured corp
// may access all corp data. No PIN required. The requireDirectorRole middleware
// checks ESI /characters/{id}/roles/ and caches results for 5 minutes.
//
// Rate-limiting strategy:
//   - Data reads:   standard apiLimiter
//   - Admin ops:    admin key header replaces rate limit (no EVE token required)
//
// All data endpoints use: security.apiLimiter → security.verifyEveToken → requireDirectorRole
// ════════════════════════════════════════════════════════════════════════════

// ── Admin helper ────────────────────────────────────────────────────────────

/**
 * Validate X-Admin-Key header using a timing-safe comparison.
 * Returns true if the key matches FORGE_ADMIN_KEY.
 */
function isAdminRequest(req) {
  const adminKey = config.adminKey;
  if (!adminKey) return false;
  const provided = req.headers['x-admin-key'] || '';
  if (provided.length !== adminKey.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminKey));
}

// ── GET /api/corp/status ─────────────────────────────────────────────────────
// Public (no EVE token needed) — lets the frontend know whether a corp has been
// set up so it can show the correct UI state.
// v1.14.0 — dynamic any-corp model: "configured" now means the SELECTED character
// is in a player corporation (so the tab shows data or the not-Director notice,
// never the old "not set up" screen). Requires the character's token.
router.get('/api/corp/status', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.json({ configured: false });

    const access = await resolveViewerCorpAccess(req.characterId, token);
    if (!access.corpId) return res.json({ configured: false });

    res.json({
      configured:      true,
      corp_id:         access.corpId,
      corp_name:       access.corpName || `Corp ${access.corpId}`,
      last_refresh_at: corpLastRefreshIso(access.corpId),
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── POST /api/corp/setup ─────────────────────────────────────────────────────
// Admin-only (X-Admin-Key required).
// Body: { code, redirect_uri }
//
// Flow:
//  1. Validate admin key + inputs
//  2. Exchange EVE OAuth code for tokens (must have corp scopes)
//  3. Verify JWT to get character_id; look up corp_id from ESI
//  4. Encrypt refresh_token
//  5. Upsert corp_config
//  6. Trigger initial ESI data refresh in background
router.post('/api/corp/setup', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  const { code, redirect_uri } = req.body;

  if (!code || !redirect_uri) {
    return res.status(400).json({ error: 'Missing code or redirect_uri' });
  }
  if (!CORP_ENCRYPTION_KEY) {
    return res.status(500).json({ error: 'FORGE_CORP_KEY not configured on server' });
  }

  try {
    // 1. Exchange auth code for EVE tokens
    const clientId     = config.eve.clientId;
    const clientSecret = config.eve.clientSecret;
    const authHeader   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Host':          'login.eveonline.com',
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(String(code))}&redirect_uri=${encodeURIComponent(redirect_uri)}`,
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(400).json({ error: tokenData.error_description || 'Token exchange failed' });
    }

    const { access_token, refresh_token } = tokenData;
    if (!refresh_token) {
      return res.status(400).json({ error: 'No refresh token in response — ensure offline_access scope is granted' });
    }

    // 2. Verify token + get character info from EVE SSO
    const verifyRes = await fetch('https://login.eveonline.com/oauth/verify', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    const charInfo = await verifyRes.json();
    const characterId   = charInfo.CharacterID;
    const characterName = charInfo.CharacterName;

    if (!characterId) {
      return res.status(400).json({ error: 'Could not verify character from token' });
    }

    // 3. Confirm corp scopes are present
    const grantedScopes = (charInfo.Scopes || '').split(' ');
    const requiredScopes = [
      'esi-corporations.read_blueprints.v1',
      'esi-assets.read_corporation_assets.v1',
      'esi-industry.read_corporation_jobs.v1',
    ];
    const missingScopes = requiredScopes.filter(s => !grantedScopes.includes(s));
    if (missingScopes.length) {
      return res.status(400).json({
        error: `Missing required corp scopes: ${missingScopes.join(', ')}. ` +
               `Ensure the director authorized all corp scopes.`,
      });
    }

    // 4. Fetch character's corporation from ESI
    const charRes = await esiFetch(
      `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const charData = await charRes.json();
    const corpId   = charData.corporation_id;

    if (!corpId) {
      return res.status(400).json({ error: 'Could not determine corporation from ESI' });
    }

    // 5. Fetch corp name
    const corpRes  = await esiFetch(
      `https://esi.evetech.net/latest/corporations/${corpId}/?datasource=tranquility`
    );
    const corpData = await corpRes.json();
    const corpName = corpData.name || `Corp ${corpId}`;

    // 6. Encrypt refresh token
    const enc = encryptToken(refresh_token);

    // 7. Upsert corp_config
    await dbRun(
      `INSERT INTO corp_config
         (corp_id, corp_name, director_char_id, director_char_name,
          enc_refresh_token, token_iv, token_tag,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(corp_id) DO UPDATE SET
         corp_name           = excluded.corp_name,
         director_char_id    = excluded.director_char_id,
         director_char_name  = excluded.director_char_name,
         enc_refresh_token   = excluded.enc_refresh_token,
         token_iv            = excluded.token_iv,
         token_tag           = excluded.token_tag,
         updated_at          = datetime('now')`,
      [
        corpId, corpName, characterId, characterName,
        enc.ciphertext, enc.iv, enc.tag,
      ]
    );

    logger.info(`✓ Corp ${corpId} (${corpName}) configured by ${characterName} (${characterId})`);

    // 8. Trigger initial ESI data refresh in background (non-blocking)
    refreshCorpData(corpId).catch(err =>
      logger.error(`⚠ Initial corp data refresh failed: ${err.message}`)
    );

    res.json({
      ok:            true,
      corp_id:       corpId,
      corp_name:     corpName,
      director_name: characterName,
      message:       'Corp configured successfully. Initial data refresh started in background.',
    });

  } catch (err) {
    logger.error('Corp setup error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── GET /api/corp/access-status ──────────────────────────────────────────────
// Returns whether the current character has Director access to corp data.
// Used by frontend to decide whether to show corp data or the "not a director" message.
router.get('/api/corp/access-status', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    // Dynamic: access = the SELECTED character is a Director (or CEO) of their own corp.
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.json({ hasAccess: false });

    const access = await resolveViewerCorpAccess(req.characterId, token);
    const hasAccess = !!(access.isDirector && access.corpId);
    res.json({
      hasAccess,
      method:    hasAccess ? 'director' : undefined,
      corp_id:   access.corpId || undefined,
      corp_name: access.corpName || undefined,
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── GET /api/corp/access-debug (v1.14.0) ─────────────────────────────────────
// Diagnostic: shows the LIVE corp-access decision for the calling character in the
// dynamic any-corp model. Confirms the character's own corp + Director role and
// whether their token carries the corp scopes needed to read corp data.
router.get('/api/corp/access-debug', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const headers = { Authorization: `Bearer ${token}` };

    const [charRes, charRolesRes] = await Promise.all([
      esiFetch(`https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`, { headers }),
      esiFetch(`https://esi.evetech.net/latest/characters/${characterId}/roles/?datasource=tranquility`, { headers }),
    ]);

    const charCorpId   = charRes.ok ? (await charRes.json()).corporation_id : null;
    const perCharRoles = charRolesRes.ok ? ((await charRolesRes.json()).roles || []) : null;

    // Probe the corp blueprints endpoint to confirm the token has the corp scopes
    // and the in-game Director role (ESI returns 403 if either is missing).
    let corpBlueprintsStatus = null;
    if (charCorpId) {
      const bpRes = await esiFetch(
        `https://esi.evetech.net/latest/corporations/${charCorpId}/blueprints/?datasource=tranquility&page=1`,
        { headers }
      );
      corpBlueprintsStatus = bpRes.status; // 200 = can read corp data; 403 = no role/scope
    }

    res.json({
      characterId,
      characterCorpId:      charCorpId,
      perCharRolesStatus:   charRolesRes.status,
      perCharRoles,                                        // null = endpoint failed (check scope)
      isDirectorByRoles:    Array.isArray(perCharRoles) && perCharRoles.includes('Director'),
      corpBlueprintsStatus, // 200 = token can read corp data; 403 = missing role or corp scopes
      verdict: (Array.isArray(perCharRoles) && perCharRoles.includes('Director') && corpBlueprintsStatus === 200)
        ? 'OK — corp data should load'
        : (corpBlueprintsStatus === 403
            ? 'Blocked — token lacks corp scopes or the character is not a Director (log out/in to refresh scopes)'
            : 'Not a Director on this character'),
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── GET /api/corp/blueprints ─────────────────────────────────────────────────
// Returns cached corp blueprints with item names joined.
// Query params: search (name filter), type (BPO|BPC|all), limit, offset
router.get('/api/corp/blueprints',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const corpId = req.corpId;
      await ensureCorpDataFresh(corpId, req.corpAccessToken);

      const search = String(req.query.search || '').replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      const type   = req.query.type || 'all';   // BPO | BPC | all
      const limit  = Math.min(200, parseInt(req.query.limit  || '100') || 100);
      const offset = Math.min(Math.max(0, parseInt(req.query.offset || '0') || 0), 100000);

      // Blueprints locked in a corp Asset Safety wrap can't be used, so they aren't listed (meta.safety_hidden says how many).
      let whereClause = `WHERE cb.corp_id = ? AND ${CORP_BP_USABLE_SQL}`;
      const params = [corpId];

      if (type === 'BPO') {
        whereClause += ' AND cb.runs = -1';
      } else if (type === 'BPC') {
        whereClause += ' AND cb.runs >= 0';
      }

      if (search) {
        whereClause += " AND LOWER(COALESCE(i.name, '')) LIKE ?";
        params.push(`%${search.toLowerCase()}%`);
      }

      const blueprints = await dbAll(
        `SELECT
           cb.item_id, cb.type_id, cb.quantity, cb.runs,
           cb.material_efficiency AS me, cb.time_efficiency AS te,
           cb.location_id, cb.location_flag, cb.fetched_at,
           COALESCE(i.name, 'Item #' || cb.type_id) AS name,
           CASE WHEN cb.runs = -1 THEN 'BPO' ELSE 'BPC' END AS bp_type,
           b.product_id
         FROM corp_blueprints cb
         LEFT JOIN items i ON i.type_id = cb.type_id
         LEFT JOIN blueprints b ON b.blueprint_id = cb.type_id
         ${whereClause}
         ORDER BY i.name ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const total = await dbGet(
        `SELECT COUNT(*) AS n FROM corp_blueprints cb
         LEFT JOIN items i ON i.type_id = cb.type_id
         ${whereClause}`,
        params
      );

      const bpHidden = await dbGet(
        `SELECT COUNT(*) AS n FROM corp_blueprints cb WHERE cb.corp_id = ? AND NOT ${CORP_BP_USABLE_SQL}`, [corpId]
      );

      res.json({
        blueprints,
        meta: {
          total:          total?.n ?? 0,
          safety_hidden:  bpHidden?.n ?? 0,
          limit,
          offset,
          corp_name:       req.corpName,
          last_refresh_at: corpLastRefreshIso(corpId),
        },
      });
    } catch (err) {
      logger.error('Corp blueprints error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── GET /api/corp/assets ─────────────────────────────────────────────────────
// Returns cached corp assets grouped by type_id (summed quantity).
// Query params: search, limit, offset
router.get('/api/corp/assets',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const corpId = req.corpId;
      await ensureCorpDataFresh(corpId, req.corpAccessToken);

      const search = String(req.query.search || '').replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      const limit  = Math.min(500, parseInt(req.query.limit  || '200') || 200);
      const offset = Math.min(Math.max(0, parseInt(req.query.offset || '0') || 0), 100000);

      // Items locked in a corp Asset Safety wrap can't be used, so they aren't listed (meta.safety_hidden says how many).
      let whereClause = `WHERE ca.corp_id = ? AND ca.item_id NOT IN (SELECT item_id FROM corp_asset_safety_items WHERE corp_id = ca.corp_id)`;
      const params = [corpId];

      if (search) {
        whereClause += " AND LOWER(COALESCE(i.name, '')) LIKE ?";
        params.push(`%${search.toLowerCase()}%`);
      }

      // Group by type_id and sum quantities for an aggregated view
      const assets = await dbAll(
        `SELECT
           ca.type_id,
           COALESCE(i.name, 'Item #' || ca.type_id) AS name,
           SUM(ca.quantity) AS total_quantity,
           MIN(ca.fetched_at)  AS fetched_at
         FROM corp_assets ca
         LEFT JOIN items i ON i.type_id = ca.type_id
         ${whereClause}
         GROUP BY ca.type_id
         ORDER BY i.name ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const total = await dbGet(
        `SELECT COUNT(DISTINCT ca.type_id) AS n
         FROM corp_assets ca
         LEFT JOIN items i ON i.type_id = ca.type_id
         ${whereClause}`,
        params
      );

      const assetsHidden = await dbGet(
        `SELECT COUNT(*) AS n FROM corp_assets ca
          WHERE ca.corp_id = ? AND ca.type_id != 60
            AND ca.item_id IN (SELECT item_id FROM corp_asset_safety_items WHERE corp_id = ca.corp_id)`, [corpId]
      );

      res.json({
        assets,
        meta: {
          total:          total?.n ?? 0,
          safety_hidden:  assetsHidden?.n ?? 0,
          limit,
          offset,
          corp_name:       req.corpName,
          last_refresh_at: corpLastRefreshIso(corpId),
        },
      });
    } catch (err) {
      logger.error('Corp assets error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── GET /api/corp/jobs ───────────────────────────────────────────────────────
// Returns cached active corp industry jobs.
router.get('/api/corp/jobs',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const corpId = req.corpId;
      await ensureCorpDataFresh(corpId, req.corpAccessToken);

      const jobs = await dbAll(
        // installer_id is a CHARACTER ID — cannot be joined against items (which holds type_ids).
        // installer_name is stored directly at refresh time via ESI /universe/names/ lookup.
        // product/blueprint names use items table correctly (type_id → type_id).
        `SELECT
           cj.job_id, cj.installer_id, cj.blueprint_id,
           cj.blueprint_type_id, cj.product_type_id,
           cj.activity_id, cj.runs, cj.status,
           cj.start_date, cj.end_date, cj.duration,
           cj.output_location_id, cj.fetched_at,
           COALESCE(prod.name, 'Item #' || cj.product_type_id)   AS product_name,
           COALESCE(bp.name,   'BP #'   || cj.blueprint_type_id) AS blueprint_name,
           COALESCE(cj.installer_name, 'Char #' || cj.installer_id) AS installer_name
         FROM corp_jobs cj
         LEFT JOIN items prod ON prod.type_id = cj.product_type_id
         LEFT JOIN items bp   ON bp.type_id   = cj.blueprint_type_id
         WHERE cj.corp_id = ?
         ORDER BY cj.end_date ASC`,
        [corpId]
      );

      res.json({
        jobs,
        meta: { count: jobs.length, corp_name: req.corpName, last_refresh_at: corpLastRefreshIso(corpId) },
      });
    } catch (err) {
      logger.error('Corp jobs error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── POST /api/corp/refresh ───────────────────────────────────────────────────
// Manually trigger an ESI data refresh. Admin OR verified corp member can call this.
router.post('/api/corp/refresh',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      // Force a live re-pull using the viewing Director's own token.
      refreshCorpData(req.corpId, req.corpAccessToken)
        .then(result => logger.info(`✓ Manual corp refresh complete:`, result))
        .catch(err    => logger.error(`⚠ Manual corp refresh failed: ${err.message}`));

      res.json({ ok: true, message: 'Corp data refresh started in background' });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── Admin: whitelist management ──────────────────────────────────────────────

// GET /api/corp/admin/whitelist — list all whitelisted characters
router.get('/api/corp/admin/whitelist', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });
  try {
    const rows = await dbAll('SELECT * FROM corp_admin_access ORDER BY added_at DESC');
    res.json({ whitelist: rows });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// POST /api/corp/admin/whitelist — add a character to the whitelist
// Body: { character_id, note? }
router.post('/api/corp/admin/whitelist', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });

  const { character_id, note } = req.body;
  if (!character_id || isNaN(parseInt(character_id))) {
    return res.status(400).json({ error: 'character_id must be a numeric EVE character ID' });
  }

  try {
    const config = await dbGet('SELECT corp_id FROM corp_config LIMIT 1');
    await dbRun(
      `INSERT INTO corp_admin_access (character_id, corp_id, note, added_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET corp_id = excluded.corp_id, note = excluded.note`,
      [parseInt(character_id), config?.corp_id ?? null, note || null]
    );
    logger.info(`✓ Corp admin whitelist: added character ${character_id} (${note || 'no note'})`);
    res.json({ ok: true, character_id: parseInt(character_id) });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// DELETE /api/corp/admin/whitelist/:characterId — remove from whitelist
router.delete('/api/corp/admin/whitelist/:characterId', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });

  const characterId = parseInt(req.params.characterId);
  if (isNaN(characterId)) return res.status(400).json({ error: 'Invalid character ID' });

  try {
    await dbRun('DELETE FROM corp_admin_access WHERE character_id = ?', [characterId]);
    logger.info(`✓ Corp admin whitelist: removed character ${characterId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Admin: delete corp config entirely (for reset/re-setup)
router.delete('/api/corp/admin/config', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });
  try {
    await dbRun('DELETE FROM corp_config');
    await dbRun('DELETE FROM corp_blueprints');
    await dbRun('DELETE FROM corp_assets');
    await dbRun('DELETE FROM corp_jobs');
    logger.info('✓ Corp config and all cached corp data deleted');
    res.json({ ok: true, message: 'Corp config deleted. Re-run corp setup to reconfigure.' });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
