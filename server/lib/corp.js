'use strict';
// Corporation data for the Corp tab: who may see it (Director role), fetching it from ESI with the viewer's token,
// caching it in the database, and the SQL predicate for blueprints that are actually usable.

const config = require('./config');
const logger = require('./logger');
const { dbGet, dbRun } = require('./db');
const { esiFetch } = require('./esi');
const { getCached, setCached } = require('./cache');
const { encryptToken, decryptToken } = require('./token-crypto');

// ── CORP ESI HELPERS (v1.4.0) ────────────────────────────────────────────────

/**
 * Refresh the director's EVE access token using the stored encrypted refresh token.
 * Returns the new short-lived access_token string.
 * Updates corp_config with the new refresh token if one is issued (token rotation).
 */
async function refreshCorpAccessToken(corpId) {
  const corpRow = await dbGet('SELECT * FROM corp_config WHERE corp_id = ?', [corpId]);
  if (!corpRow) throw new Error(`No corp config for corp_id ${corpId}`);

  const refreshToken = decryptToken(
    corpRow.enc_refresh_token,
    corpRow.token_iv,
    corpRow.token_tag
  );

  const clientId     = config.eve.clientId;
  const clientSecret = config.eve.clientSecret;
  const authHeader   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await esiFetch('https://login.eveonline.com/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Host':          'login.eveonline.com',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || res.status}`);
  }

  // If EVE issues a new refresh token (token rotation), encrypt and store it
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const enc = encryptToken(data.refresh_token);
    await dbRun(
      `UPDATE corp_config
         SET enc_refresh_token = ?, token_iv = ?, token_tag = ?, updated_at = datetime('now')
       WHERE corp_id = ?`,
      [enc.ciphertext, enc.iv, enc.tag, corpId]
    );
    logger.info(`✓ Corp ${corpId}: refresh token rotated and re-encrypted`);
  }

  return data.access_token;
}

/**
 * Fetch all pages of a paginated ESI endpoint using the director's access token.
 * Returns a flat array of all results.
 */
async function esiCorpFetchAll(path, accessToken) {
  const results = [];
  for (let page = 1; page <= 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await esiFetch(`https://esi.evetech.net${path}${sep}datasource=tranquility&page=${page}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      if (res.status === 404 && page === 1) return []; // empty corp data
      throw new Error(`ESI ${path} page ${page} returned ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.length === 0) break;
    results.push(...data);
    const xPages = res.headers.get('x-pages');
    if (!xPages || page >= parseInt(xPages)) break;
    // Brief delay to respect ESI rate limits
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

/**
 * Refresh all cached corp data (blueprints, assets, jobs) from ESI.
 * Uses the stored director refresh token.  Called on demand and on a schedule.
 * Updates corp_config.last_refresh_* columns on completion.
 */
// In-memory record of when each corp's cached data was last refreshed (epoch ms).
// Cleared on restart so the first access after a deploy re-pulls fresh data.
const corpDataRefreshedAt = new Map();

const CORP_DATA_TTL_MS    = 30 * 60 * 1000; // 30 min — corp data isn't fast-moving

const corpRefreshInFlight = new Map();      // corpId → Promise (dedupe concurrent refreshes)

// ISO timestamp of the last successful refresh for a corp, or null.
function corpLastRefreshIso(corpId) {
  const ts = corpDataRefreshedAt.get(corpId);
  return ts ? new Date(ts).toISOString() : null;
}

// Ensure a corp's cached data is fresh, fetching live with the viewer's token when
// stale or missing. Never throws — on ESI failure the endpoint returns whatever is
// already cached (possibly empty) so a transient error can't 500 the corp tab.
async function ensureCorpDataFresh(corpId, accessToken, { force = false } = {}) {
  const last = corpDataRefreshedAt.get(corpId) || 0;
  if (!force && Date.now() - last < CORP_DATA_TTL_MS) return;
  if (corpRefreshInFlight.has(corpId)) { try { await corpRefreshInFlight.get(corpId); } catch (_) {} return; }
  const p = refreshCorpData(corpId, accessToken)
    .catch(err => { logger.warn(`⚠ Corp ${corpId} on-demand refresh failed: ${err.message}`); })
    .finally(() => corpRefreshInFlight.delete(corpId));
  corpRefreshInFlight.set(corpId, p);
  await p;
}

async function refreshCorpData(corpId, providedAccessToken = null) {
  logger.info(`⟳ Corp ${corpId}: refreshing ESI data...`);
  try {
    // v1.14.0: prefer the viewing Director's access token (dynamic any-corp model);
    // fall back to the legacy stored corp refresh token if one was ever configured.
    const accessToken = providedAccessToken || await refreshCorpAccessToken(corpId);

    // ── Blueprints ───────────────────────────────────────────────────────────
    const bps = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/blueprints/`,
      accessToken
    );
    // ── replace corp_blueprints ──
    await dbRun('DELETE FROM corp_blueprints WHERE corp_id = ?', [corpId]);
    for (const bp of bps) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_blueprints
           (item_id, corp_id, type_id, quantity, runs,
            material_efficiency, time_efficiency, location_id, location_flag, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          bp.item_id, corpId, bp.type_id,
          bp.quantity   ?? 0,
          bp.runs       ?? -1,
          bp.material_efficiency ?? 0,
          bp.time_efficiency     ?? 0,
          bp.location_id   ?? null,
          bp.location_flag ?? null,
        ]
      );
    }
    logger.info(`  ✓ Corp ${corpId}: ${bps.length} blueprints cached`);

    // ── Assets ───────────────────────────────────────────────────────────────
    const assets = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/assets/`,
      accessToken
    );
    // ── replace corp_assets ──
    await dbRun('DELETE FROM corp_assets WHERE corp_id = ?', [corpId]);
    for (const asset of assets) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_assets
           (item_id, corp_id, type_id, quantity, location_id, location_flag, is_singleton, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          asset.item_id, corpId, asset.type_id,
          asset.quantity     ?? 1,
          asset.location_id  ?? null,
          asset.location_flag ?? null,
          asset.is_singleton  ? 1 : 0,
        ]
      );
    }
    logger.info(`  ✓ Corp ${corpId}: ${assets.length} assets cached`);

    // ── Industry Jobs ────────────────────────────────────────────────────────
    const jobs = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/industry/jobs/?include_completed=false`,
      accessToken
    );

    // Resolve installer character names via ESI /universe/names/ (bulk POST, max 1000 IDs).
    // installer_id is a CHARACTER ID — it cannot be resolved from the items table.
    // ESI returns [{ id, name, category }]; we only keep category === 'character'.
    const installerIds = [...new Set(
      jobs.map(j => j.installer_id).filter(Boolean)
    )];
    const installerNames = {};  // { characterId: name }

    if (installerIds.length) {
      // ESI /universe/names/ accepts up to 1000 IDs per request
      const BATCH = 1000;
      for (let i = 0; i < installerIds.length; i += BATCH) {
        const batch = installerIds.slice(i, i + BATCH);
        try {
          const r = await esiFetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(batch),
          });
          if (r.ok) {
            const names = await r.json();
            for (const entry of names) {
              if (entry.category === 'character') {
                installerNames[entry.id] = entry.name;
              }
            }
          } else {
            logger.warn(`  ⚠ Corp ${corpId}: /universe/names/ returned ${r.status} for installer IDs`);
          }
        } catch (nameErr) {
          // Non-fatal — jobs still get stored, installer_name will be null
          logger.warn(`  ⚠ Corp ${corpId}: installer name lookup failed — ${nameErr.message}`);
        }
      }
      logger.info(`  ✓ Corp ${corpId}: resolved ${Object.keys(installerNames).length}/${installerIds.length} installer names`);
    }

    // ── replace corp_jobs ──
    await dbRun('DELETE FROM corp_jobs WHERE corp_id = ?', [corpId]);
    for (const job of jobs) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_jobs
           (job_id, corp_id, installer_id, installer_name,
            blueprint_id, blueprint_type_id, product_type_id,
            activity_id, runs, status, start_date, end_date, duration,
            output_location_id, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          job.job_id,              corpId,
          job.installer_id        ?? null,
          job.installer_id ? (installerNames[job.installer_id] ?? null) : null,
          job.blueprint_id        ?? null,
          job.blueprint_type_id   ?? null,
          job.product_type_id     ?? null,
          job.activity_id         ?? null,
          job.runs                ?? null,
          job.status              ?? null,
          job.start_date          ?? null,
          job.end_date            ?? null,
          job.duration            ?? null,
          job.output_location_id  ?? null,
        ]
      );
    }
    logger.info(`  ✓ Corp ${corpId}: ${jobs.length} active jobs cached`);

    // Update last_refresh timestamp
    await dbRun(
      `UPDATE corp_config
         SET last_refresh_at = datetime('now'), last_refresh_status = 'ok', updated_at = datetime('now')
       WHERE corp_id = ?`,
      [corpId]
    );
    logger.info(`✓ Corp ${corpId}: ESI data refresh complete`);
    corpDataRefreshedAt.set(corpId, Date.now());
    if (corpDataRefreshedAt.size > 500) {
      const cutoff = Date.now() - 3600000;
      for (const [k, v] of corpDataRefreshedAt) {
        if (v < cutoff) corpDataRefreshedAt.delete(k);
      }
    }
    return { ok: true, blueprints: bps.length, assets: assets.length, jobs: jobs.length };

  } catch (err) {
    logger.error(`❌ Corp ${corpId}: ESI refresh failed — ${err.message}`);
    await dbRun(
      `UPDATE corp_config
         SET last_refresh_status = ?, updated_at = datetime('now')
       WHERE corp_id = ?`,
      [`error: ${err.message.slice(0, 200)}`, corpId]
    ).catch(() => {});
    throw err;
  }
}

/**
 * Corp data access model (v1.14.0 — dynamic, any-corp):
 * ANY character holding the in-game Director (or CEO) role can view THEIR OWN
 * corp's blueprints/assets/jobs. There is no server-side corp "setup" — data is
 * fetched live from ESI using the viewing Director's own access token (which must
 * carry the corp scopes, granted at login). `requireDirectorRole` attaches
 * req.corpId / req.corpName / req.corpAccessToken for the data endpoints.
 *
 * History: pre-v1.14.0 required a one-time admin OAuth "setup" that stored a single
 * corp's encrypted refresh token in corp_config; only that one corp was visible.
 * The legacy corp_config / setup / refreshCorpAccessToken path is retained but no
 * longer required (refreshCorpData falls back to it only if no viewer token given).
 */

const DIRECTOR_CACHE_TTL_MS    = 5 * 60 * 1000; // 5 min

const DIRECTOR_CACHE_TTL_SHORT = 60 * 1000;     // 1 min (after an ESI error — retry sooner)

// Fallback role check: scan the PAGINATED corp-wide roles list for the caller's
// Director role. Used only when the per-character roles endpoint is unavailable.
// Returns true/false when the list is readable, or null when it can't be read
// (missing scope / not a privileged member / ESI error) so the caller can fall
// back further (setup-director match).
async function corpRolesListHasDirector(corpId, characterId, headers) {
  try {
    let page = 1, pages = 1, readable = false;
    do {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/corporations/${corpId}/roles/?datasource=tranquility&page=${page}`,
        { headers }
      );
      if (!res.ok) return readable ? false : null; // first-page failure = unreadable
      readable = true;
      const list = await res.json();
      if (Array.isArray(list)) {
        const mine = list.find(e => e.character_id === characterId);
        if (mine?.roles?.includes('Director')) return true;
      }
      pages = parseInt(res.headers.get('x-pages') || '1', 10);
      page++;
    } while (page <= pages);
    return false;
  } catch (_) {
    return null;
  }
}

// Resolve the calling character's OWN corporation + Director status from ESI.
// Dynamic any-corp model (v1.14.0): no configured corp — a character can view
// whichever corp they are a Director (or CEO) of. Cached 5 min per character.
// Returns { corpId, corpName, isDirector }.
async function resolveViewerCorpAccess(characterId, bearerToken) {
  const cacheKey = `corpaccess:${characterId}`;
  const cached   = getCached(cacheKey);
  if (cached && cached.corpId !== null) return cached;

  const headers = { Authorization: `Bearer ${bearerToken}` };
  let corpId = null, corpName = null, isDirector = false;
  let ttl = DIRECTOR_CACHE_TTL_MS;

  try {
    // Character info (their corp) + their OWN roles (authoritative, no pagination).
    const [charRes, rolesRes] = await Promise.all([
      esiFetch(`https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`, { headers }),
      esiFetch(`https://esi.evetech.net/latest/characters/${characterId}/roles/?datasource=tranquility`, { headers }),
    ]);

    if (charRes.ok) corpId = (await charRes.json()).corporation_id ?? null;

    if (rolesRes.ok) {
      const data = await rolesRes.json();
      isDirector = Array.isArray(data.roles) && data.roles.includes('Director');
    } else if ((rolesRes.status === 403 || rolesRes.status === 401) && corpId) {
      // Per-character roles scope missing on this token — fall back to the paginated corp list.
      const listResult = await corpRolesListHasDirector(corpId, characterId, headers);
      if (listResult === null) ttl = DIRECTOR_CACHE_TTL_SHORT;
      else isDirector = listResult;
    } else if (!rolesRes.ok) {
      ttl = DIRECTOR_CACHE_TTL_SHORT; // transient — retry sooner
    }

    // Public corp info: name + CEO check (the CEO implicitly holds Director).
    if (corpId) {
      const corpRes = await esiFetch(`https://esi.evetech.net/latest/corporations/${corpId}/?datasource=tranquility`, {});
      if (corpRes.ok) {
        const cd = await corpRes.json();
        corpName = cd.name ?? null;
        if (!isDirector && cd.ceo_id === characterId) isDirector = true;
      }
    }
  } catch (esiErr) {
    logger.warn(`Corp access resolve failed for ${characterId}: ${esiErr.message}`);
    ttl = DIRECTOR_CACHE_TTL_SHORT;
  }

  const result = { corpId, corpName, isDirector };
  setCached(cacheKey, result, ttl);
  return result;
}

// Middleware: allow only characters holding the Director (or CEO) role in their
// own corp. On success attaches req.corpId, req.corpName, req.corpAccessToken for
// the data endpoints to fetch live ESI data with the viewer's own token.
async function requireDirectorRole(req, res, next) {
  const characterId = req.characterId;
  if (!characterId) return res.status(401).json({ error: 'Not authenticated' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Authorization required' });

  try {
    const access = await resolveViewerCorpAccess(characterId, token);
    if (!access.isDirector || !access.corpId) {
      return res.status(403).json({
        error: 'Corp data access requires the Director role on the selected character.',
        code:  'NOT_DIRECTOR',
      });
    }
    req.corpId          = access.corpId;
    req.corpName        = access.corpName;
    req.corpAccessToken = token;
    return next();
  } catch (err) {
    logger.error('requireDirectorRole error:', err.message);
    return res.status(500).json({ error: 'Access check failed' });
  }
}

// SQL predicate for corp_blueprints rows (alias cb) that are usable: not in a corp Asset Safety wrap, not located at
// CCP's Asset Safety location (2004), not flagged AssetSafety, and not inside anything that is (view corp_asset_safety_items).
const CORP_BP_USABLE_SQL = `(COALESCE(cb.location_flag, '') != 'AssetSafety'
  AND COALESCE(cb.location_id, 0) != 2004
  AND cb.item_id NOT IN (SELECT item_id FROM corp_asset_safety_items WHERE corp_id = cb.corp_id)
  AND COALESCE(cb.location_id, 0) NOT IN (SELECT item_id FROM corp_asset_safety_items WHERE corp_id = cb.corp_id))`;

module.exports = {
  CORP_BP_USABLE_SQL, refreshCorpAccessToken, refreshCorpData, ensureCorpDataFresh, corpLastRefreshIso, resolveViewerCorpAccess,
  requireDirectorRole,
};
