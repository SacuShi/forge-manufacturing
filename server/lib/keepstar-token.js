'use strict';
// C-J6MT Keepstar market access: a pool of logged-in users' tokens (any alliance member can read the structure market),
// token refresh, and the 4-hourly market-history poll.

const fetch = require('node-fetch');
const config = require('./config');
const logger = require('./logger');
const { dbAll, dbGet, dbRun } = require('./db');
const { encryptToken, decryptToken } = require('./token-crypto');
const { KEEPSTAR_STRUCTURE_ID, KEEPSTAR_REGION_ID } = require('./hubs');

// Token pool: capture any authenticated user's EVE token during normal requests.
// EVE tokens expire in ~20 min; pool is refreshed on each /api/session-data POST.
// Precompute uses the pool token if available; if not, Keepstar prices are skipped.
// fromDb flag distinguishes tokens refreshed from the stored DB refresh token
// (guaranteed correct character) from tokens captured from active user sessions
// (any character — may lack Keepstar docking access).
const _ksTkPool = { token: null, expiry: 0, fromDb: false };

function cacheStructureToken(token) {
  _ksTkPool.token  = token;
  _ksTkPool.expiry = Date.now() + 17 * 60 * 1000; // 17 min (3 min safety margin)
  _ksTkPool.fromDb = false; // user session token — unknown character
}

function getStructureToken() {
  return (_ksTkPool.token && Date.now() < _ksTkPool.expiry) ? _ksTkPool.token : null;
}

// Always prefer the DB refresh token (tied to the specific character with Keepstar
// docking access). Only fall back to _ksTkPool if no DB token exists — any logged-in
// user's token has the right scope but may not have structure access.
async function getOrRefreshStructureToken() {
  // If pool holds a DB-refreshed token still within its window, reuse it — avoids
  // hitting CCP's token endpoint on every structure market call during precompute.
  if (_ksTkPool.fromDb && _ksTkPool.token && Date.now() < _ksTkPool.expiry) {
    return _ksTkPool.token;
  }

  // Refresh from DB (correct character, correct access guaranteed).
  try {
    const freshToken = await refreshStructureToken(KEEPSTAR_STRUCTURE_ID);
    if (freshToken) {
      _ksTkPool.token  = freshToken;
      _ksTkPool.expiry = Date.now() + 17 * 60 * 1000;
      _ksTkPool.fromDb = true;
      return freshToken;
    }
  } catch (err) {
    logger.warn('[KS token] DB refresh failed:', err.message);
  }

  // No DB token at all — fall back to session pool (any logged-in user).
  const poolToken = getStructureToken();
  if (poolToken) {
    logger.warn('[KS token] No DB token — using session pool token (may 403 if character lacks Keepstar access)');
  }
  return poolToken || null;
}

// ── Keepstar market history polling job (v1.34.0) ────────────────────────────
// Runs every 4 hours. Fetches all sell orders from C-J6MT Keepstar, computes a
// daily min/avg/max snapshot per type, stores in structure_market_history.
// Uses the encrypted refresh token from structure_token — no user presence needed.

const KS_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let   ksPollRunning        = false;

async function refreshStructureToken(structureId) {
  const row = await dbGet(`SELECT * FROM structure_token WHERE structure_id = ?`, [structureId]);
  if (!row) return null;

  const refreshToken = decryptToken(row.enc_refresh_token, row.token_iv, row.token_tag);
  const authHdr      = 'Basic ' + Buffer.from(`${config.eve.clientId}:${config.eve.clientSecret}`).toString('base64');

  const res  = await fetch('https://login.eveonline.com/v2/oauth/token', {
    method:  'POST',
    headers: { 'Authorization': authHdr, 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'login.eveonline.com' },
    body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    logger.error(`[KS poll] Token refresh failed (${res.status}):`, data.error_description || data.error);
    return null;
  }

  // Store rotated refresh token if EVE issued a new one
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const enc = encryptToken(data.refresh_token);
    await dbRun(
      `UPDATE structure_token SET enc_refresh_token=?, token_iv=?, token_tag=?, stored_at=datetime('now') WHERE structure_id=?`,
      [enc.ciphertext, enc.iv, enc.tag, structureId]
    );
  }
  return data.access_token;
}

async function pollKeepstarHistory() {
  if (ksPollRunning) return;
  ksPollRunning = true;
  logger.info('[KS poll] Starting Keepstar market snapshot...');

  try {
    const accessToken = await getOrRefreshStructureToken();
    if (!accessToken) {
      logger.warn('[KS poll] No valid token — skipping. Run /api/ks-test-auth to re-authorise.');
      return;
    }

    // Fetch all order pages
    let page = 1, sellOrders = [];
    while (true) {
      const res = await fetch(
        `https://esi.evetech.net/latest/markets/structures/${KEEPSTAR_STRUCTURE_ID}/?page=${page}&datasource=tranquility`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );
      if (!res.ok) { logger.error(`[KS poll] ESI ${res.status} on page ${page}`); break; }
      const orders = await res.json();
      if (!Array.isArray(orders) || orders.length === 0) break;
      sellOrders.push(...orders.filter(o => !o.is_buy_order));
      const totalPages = parseInt(res.headers.get('x-pages') || '1');
      if (page >= totalPages) break;
      page++;
    }

    if (sellOrders.length === 0) { logger.warn('[KS poll] No sell orders returned'); return; }

    // Group by type_id — track prices AND total available quantity
    const byType = {};
    for (const o of sellOrders) {
      if (!byType[o.type_id]) byType[o.type_id] = { prices: [], qty: 0 };
      byType[o.type_id].prices.push(o.price);
      byType[o.type_id].qty += (o.volume_remain || 0);
    }

    // Load yesterday's total_sell_qty for volume estimation (qty drop = implied sales)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const prevRows  = await dbAll(
      `SELECT type_id, total_sell_qty FROM structure_market_history
        WHERE structure_id = ? AND date = ?`,
      [KEEPSTAR_STRUCTURE_ID, yesterday]
    );
    const prevQtyMap = new Map(prevRows.map(r => [r.type_id, r.total_sell_qty]));

    // Pre-load existing rolling averages so we can cap impliedVol against them.
    // Restocks and order cancellations both cause a qty drop that looks like sales;
    // capping at 5× the established rolling average prevents single relist events
    // from spiking the EMA. New items (no history) get a conservative 500-unit seed cap.
    const existingVolRows = await dbAll(
      `SELECT type_id, avg_30d_volume FROM hub_history_prices WHERE region_id = ?`,
      [KEEPSTAR_REGION_ID]
    );
    const existingVolMap = new Map(existingVolRows.map(r => [r.type_id, r.avg_30d_volume]));

    // Write daily snapshot (INSERT OR REPLACE so re-runs on same day overwrite cleanly)
    const today = new Date().toISOString().slice(0, 10);
    let written = 0, volEstimates = 0;
    for (const [typeIdStr, { prices, qty }] of Object.entries(byType)) {
      const typeId = parseInt(typeIdStr);
      const avg    = prices.reduce((a, b) => a + b, 0) / prices.length;
      await dbRun(
        `INSERT OR REPLACE INTO structure_market_history
           (structure_id, type_id, date, avg_sell, min_sell, max_sell, order_count, total_sell_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [KEEPSTAR_STRUCTURE_ID, typeId, today,
         +avg.toFixed(2), Math.min(...prices), Math.max(...prices), prices.length, qty]
      );
      written++;

      // Volume estimate: if quantity dropped vs yesterday, implied sales = drop.
      // Restock/cancel guard: cap at 5× rolling average (established items) or 500
      // (no history yet). This prevents mass-cancel/relist events — which cause a
      // sudden large qty drop — from corrupting the EMA as fake "sales".
      const prevQty = prevQtyMap.get(typeId);
      if (prevQty != null && prevQty > qty) {
        const impliedVol = prevQty - qty;
        const existingAvg = existingVolMap.get(typeId);
        const plausibleCap = existingAvg != null
          ? Math.max(existingAvg * 5, 10)  // 5× rolling avg — allows genuine sell-outs
          : 500;                            // no history: conservative seed cap
        if (impliedVol > 0 && impliedVol <= plausibleCap) {
          await dbRun(
            `INSERT INTO hub_history_prices (type_id, region_id, avg_30d_volume, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(type_id, region_id) DO UPDATE SET
               avg_30d_volume = ROUND((avg_30d_volume * 29 + excluded.avg_30d_volume) / 30, 2),
               updated_at     = datetime('now')`,
            [typeId, KEEPSTAR_REGION_ID, impliedVol]
          );
          volEstimates++;
        }
      }
    }

    // Prune rows older than 95 days to keep DB lean
    await dbRun(
      `DELETE FROM structure_market_history WHERE structure_id=? AND date < date('now', '-95 days')`,
      [KEEPSTAR_STRUCTURE_ID]
    );

    logger.info(`[KS poll] ✓ Wrote ${written} type snapshots for ${today} (${sellOrders.length} sell orders, ${volEstimates} vol estimates)`);
  } catch (err) {
    logger.error('[KS poll] Error:', err.message);
  } finally {
    ksPollRunning = false;
  }
}

module.exports = {
  _ksTkPool, cacheStructureToken, getStructureToken, getOrRefreshStructureToken, refreshStructureToken, pollKeepstarHistory, KS_POLL_INTERVAL_MS,
};
