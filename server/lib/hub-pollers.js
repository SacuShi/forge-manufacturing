'use strict';
// The station-trading order books: five NPC hubs and the C-J6MT Keepstar, each kept ~5 minutes fresh from Fuzzwork
// (ESI as the fallback), snapshotted to the database, plus the 30-day history enrichment. Pollers start on demand
// (ensureHubPollerRunning) and stop after 30 minutes without a trading request.

const fetch = require('node-fetch');
const config = require('./config');
const logger = require('./logger');
const jobState = require('./job-state');
const market = require('./market-cache');
const { dbAll, dbGet, dbRun } = require('./db');
const { esiFetch, ESI_USER_AGENT } = require('./esi');
const { HUB_CONFIG, HUB_IDS } = require('./hubs');
const { getOrRefreshStructureToken } = require('./keepstar-token');

const TRADE_POLL_FALLBACK_MS = 300 * 1000;      // Fuzzwork / ESI cache cycle

const TRADE_IDLE_STOP_MS     = 30 * 60 * 1000;  // stop polling a hub after 30 min idle

const TRADE_MIN_ERROR_BUDGET = 20;              // ESI history enrichment hard floor

// Per-page conditional cache: pageUrl -> { etag, orders:[{type_id,price,is_buy_order,volume_remain}] }
const tradePageCache = new Map();

// Per-hub order books: hubId -> Map<typeId, {sell,buy,spread,spreadPct,sellOrders,buyOrders,sellQtyTop,buyQtyTop}>
const hubBooks   = Object.fromEntries(HUB_IDS.map(id => [id, new Map()]));

// Per-hub freshness meta
const hubMetas   = Object.fromEntries(HUB_IDS.map(id => [id, { updatedAt: 0, expiresAt: 0, fetching: false, lastError: null, types: 0 }]));

// Per-hub poll timers and running flags
const hubPollTimers  = {};

const hubPollRunning = {};

let lastTradingRequestAt = 0;

let lastHubPollStartedAt = 0; // stagger guard — prevents simultaneous hub poll bursts

const HUB_POLL_STAGGER_MS = 90_000; // minimum gap between two hubs starting their first poll

let enrichRunning = false; // global lock — only one hub enriches at a time

// Set to true when enrichment is deferred (precompute running) so the next poll retries
const hubEnrichPending = Object.fromEntries(HUB_IDS.map(id => [id, false]));

// Per-hub name lookup maps rebuilt after each book refresh
const hubNameMaps = Object.fromEntries(HUB_IDS.map(id => [id, new Map()]));

/** Rebuild the in-memory typeId→name lookup for one hub from the global item name map.
 *  Synchronous O(n) filter — no DB round-trips. Returns a resolved Promise so existing
 *  callers that use .catch() continue to work unchanged. */
function refreshHubNameMap(hubId, typeIds) {
  const map = new Map();
  for (const id of typeIds) {
    const name = market.globalItemNameMap.get(id);
    if (name) map.set(id, name);
  }
  hubNameMaps[hubId] = map;
  return Promise.resolve();
}

/** Load persisted book snapshots for all hubs so the scanner has instant data on restart. */
async function loadHubSnapshots() {
  // Jita: legacy jita_book_cache table
  try {
    const row = await dbGet('SELECT snapshot, updated_at FROM jita_book_cache WHERE id = 1');
    if (row) {
      const parsed = JSON.parse(row.snapshot);
      hubBooks.jita = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k, 10), v]));
      hubMetas.jita = { updatedAt: 0, expiresAt: 0, fetching: false, lastError: null, types: hubBooks.jita.size };
      logger.info(`✓ Jita book snapshot loaded — ${hubBooks.jita.size} types (from ${row.updated_at} UTC)`);
      refreshHubNameMap('jita', [...hubBooks.jita.keys()]).catch(e => logger.warn('Name map load error:', e.message));
    }
  } catch (e) { logger.warn('⚠ Could not load Jita snapshot:', e.message); }

  // Non-Jita hubs: hub_book_cache table
  for (const hubId of HUB_IDS.filter(h => h !== 'jita')) {
    try {
      const row = await dbGet('SELECT snapshot, updated_at FROM hub_book_cache WHERE hub_id = ?', [hubId]);
      if (row) {
        const parsed = JSON.parse(row.snapshot);
        hubBooks[hubId] = new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k, 10), v]));
        hubMetas[hubId] = { updatedAt: 0, expiresAt: 0, fetching: false, lastError: null, types: hubBooks[hubId].size };
        logger.info(`✓ ${HUB_CONFIG[hubId].name} snapshot loaded — ${hubBooks[hubId].size} types (from ${row.updated_at} UTC)`);
        refreshHubNameMap(hubId, [...hubBooks[hubId].keys()]).catch(e => logger.warn(`Name map load error (${hubId}):`, e.message));
      }
    } catch (e) { logger.warn(`⚠ Could not load ${hubId} snapshot:`, e.message); }
  }
}

/** Keep only target-station orders, only the fields the book needs (memory-bounded). */
function filterStationOrders(data, stationId) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const o of data) {
    if (o.location_id !== stationId) continue;
    out.push({ type_id: o.type_id, price: o.price, is_buy_order: o.is_buy_order, volume_remain: o.volume_remain });
  }
  return out;
}

/** Fetch one region-orders page conditionally. Returns { orders, expires, xPages, errorRemain, status, error? }. */
async function fetchTradePage(regionId, stationId, orderType, page) {
  const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/` +
              `?datasource=tranquility&order_type=${orderType}&page=${page}`;
  const cached = tradePageCache.get(url);
  const headers = {};
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

  const res = await esiFetch(url, { headers });
  const errorRemain = parseInt(res.headers.get('x-esi-error-limit-remain') || '100', 10);
  const xPages = parseInt(res.headers.get('x-pages') || '1', 10);
  const expires = res.headers.get('expires');

  if (res.status === 304) {
    // INVARIANT: reuse retained slice; if (somehow) absent, fall back to an unconditional GET.
    if (cached && cached.orders) {
      return { orders: cached.orders, expires, xPages, errorRemain, status: 304 };
    }
    const fresh = await esiFetch(url); // no If-None-Match → guaranteed body
    const data = await fresh.json();
    const slice = filterStationOrders(data, stationId);
    tradePageCache.set(url, { etag: fresh.headers.get('etag'), orders: slice });
    return {
      orders: slice,
      expires: fresh.headers.get('expires') || expires,
      xPages: parseInt(fresh.headers.get('x-pages') || String(xPages), 10),
      errorRemain, status: 200,
    };
  }

  if (!res.ok) {
    // Don't poison the cache — reuse last good slice if we have one.
    return { orders: cached?.orders || [], expires, xPages, errorRemain, status: res.status, error: true };
  }

  const data = await res.json();
  const slice = filterStationOrders(data, stationId);
  tradePageCache.set(url, { etag: res.headers.get('etag'), orders: slice });
  return { orders: slice, expires, xPages, errorRemain, status: 200 };
}

/**
 * Write a hub order-book snapshot to the appropriate SQLite table.
 * Jita uses its legacy single-row table; every other hub uses hub_book_cache.
 * Called inside setImmediate so it never blocks the poll loop.
 */
function persistHubSnapshot(hubId, snap) {
  if (hubId === 'jita') {
    dbRun(`INSERT OR REPLACE INTO jita_book_cache (id, snapshot, updated_at) VALUES (1, ?, datetime('now'))`, [snap])
      .catch(e => logger.error('jita_book_cache write error:', e.message));
  } else {
    dbRun(`INSERT OR REPLACE INTO hub_book_cache (hub_id, snapshot, updated_at) VALUES (?, ?, datetime('now'))`, [hubId, snap])
      .catch(e => logger.error(`hub_book_cache write error (${hubId}):`, e.message));
  }
}

// ── Fuzzwork poller (primary) — one hub at a time ────────────────────────────
const FUZZWORK_BASE_URL = 'https://market.fuzzwork.co.uk/aggregates/';

const FUZZWORK_CHUNK    = 1000;  // type IDs per request (URL-length safe)

const FUZZWORK_PARALLEL = 5;     // parallel requests per batch (polite ceiling)

async function pollFuzzworkHub(hubId) {
  const cfg  = HUB_CONFIG[hubId];
  const meta = hubMetas[hubId];
  if (meta.fetching) return;
  meta.fetching = true;
  const started = Date.now();

  try {
    const book = hubBooks[hubId];
    let typeIds;
    if (book.size > 0) {
      typeIds = [...book.keys()];
    } else {
      const rows = await dbAll(`SELECT type_id FROM items WHERE name IS NOT NULL AND name != ''`, []);
      typeIds = rows.map(r => r.type_id);
    }

    const newBook = new Map();
    let failedChunks = 0;

    for (let i = 0; i < typeIds.length; i += FUZZWORK_CHUNK * FUZZWORK_PARALLEL) {
      const batchChunks = [];
      for (let j = i; j < Math.min(i + FUZZWORK_CHUNK * FUZZWORK_PARALLEL, typeIds.length); j += FUZZWORK_CHUNK) {
        batchChunks.push(typeIds.slice(j, j + FUZZWORK_CHUNK));
      }

      const batchResults = await Promise.allSettled(
        batchChunks.map(chunk => {
          const url = `${FUZZWORK_BASE_URL}?station=${cfg.stationId}&types=${chunk.join(',')}`;
          const ctrl = new AbortController();
          const tid  = setTimeout(() => ctrl.abort(), 30_000);
          return fetch(url, { headers: { 'User-Agent': ESI_USER_AGENT }, signal: ctrl.signal })
            .then(r => { clearTimeout(tid); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .catch(e => { clearTimeout(tid); throw e; });
        })
      );

      for (const result of batchResults) {
        if (result.status !== 'fulfilled') {
          failedChunks++;
          logger.warn(`⚠ Fuzzwork ${hubId} chunk failed: ${result.reason?.message || result.reason}`);
          continue;
        }
        for (const [typeIdStr, agg] of Object.entries(result.value)) {
          const typeId = parseInt(typeIdStr, 10);
          const sell   = parseFloat(agg.sell?.min || 0);
          const buy    = parseFloat(agg.buy?.max  || 0);
          if (!sell && !buy) continue;
          const spread    = (sell && buy) ? sell - buy : 0;
          const spreadPct = (sell && buy) ? (spread / sell) * 100 : 0;
          newBook.set(typeId, {
            sell, buy, spread, spreadPct,
            sellOrders: parseInt(agg.sell?.orderCount || 0, 10),
            buyOrders:  parseInt(agg.buy?.orderCount  || 0, 10),
            sellQtyTop: parseInt(agg.sell?.volume      || 0, 10),
            buyQtyTop:  parseInt(agg.buy?.volume       || 0, 10),
          });
        }
      }

      if (i + FUZZWORK_CHUNK * FUZZWORK_PARALLEL < typeIds.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (newBook.size === 0) {
      throw new Error(`Fuzzwork returned empty book for ${hubId} (${failedChunks} failed chunks)`);
    }

    hubBooks[hubId] = newBook;
    Object.assign(hubMetas[hubId], { updatedAt: Date.now(), expiresAt: Date.now() + TRADE_POLL_FALLBACK_MS, fetching: false, lastError: null, types: newBook.size });

    const failNote = failedChunks ? ` (${failedChunks} chunks skipped)` : '';
    logger.info(`⟳ ${cfg.name} book refreshed via Fuzzwork — ${newBook.size} types in ${((Date.now() - started) / 1000).toFixed(1)}s${failNote}`);

    refreshHubNameMap(hubId, [...newBook.keys()]).catch(e => logger.error(`Name map error (${hubId}):`, e.message));

    // Persist snapshot (non-blocking)
    setImmediate(() => {
      const snap = JSON.stringify(Object.fromEntries(newBook));
      persistHubSnapshot(hubId, snap);
    });

    if (Date.now() - lastTradingRequestAt < 60_000 || hubEnrichPending[hubId]) {
      runHubHistoryEnrichment(hubId).catch(e => logger.error(`History enrichment error (${hubId}):`, e.message));
    }

  } catch (err) {
    hubMetas[hubId].fetching = false;
    hubMetas[hubId].lastError = err.message;
    logger.error(`⚠ Fuzzwork fallback poll failed for ${hubId}:`, err.message);
  }

  scheduleNextHubPoll(hubId, !!hubMetas[hubId].lastError);
}

// ── ESI order-page poller (fallback per hub) ──────────────────────────────────
async function pollHubESI(hubId) {
  const cfg  = HUB_CONFIG[hubId];
  const meta = hubMetas[hubId];
  if (meta.fetching) return;
  meta.fetching = true;
  const started = Date.now();
  let latestExpires = 0;
  let backoff = false;

  try {
    const agg = new Map();
    for (const orderType of ['sell', 'buy']) {
      let page = 1, pages = 1;
      do {
        const r = await fetchTradePage(cfg.regionId, cfg.stationId, orderType, page);
        if (r.expires) { const t = Date.parse(r.expires); if (t > latestExpires) latestExpires = t; }
        pages = r.xPages || 1;
        if (r.errorRemain < TRADE_MIN_ERROR_BUDGET || r.status === 420 || r.status >= 500) { backoff = true; break; }
        for (const o of r.orders) {
          // Scope to the hub's own station — region endpoint returns all stations.
          if (o.location_id !== cfg.stationId) continue;
          let e = agg.get(o.type_id);
          if (!e) { e = { sells: [], buys: [] }; agg.set(o.type_id, e); }
          (o.is_buy_order ? e.buys : e.sells).push(o);
        }
        page++;
        await new Promise(res => setTimeout(res, 100));
      } while (page <= pages);
      if (backoff) break;
    }

    if (!backoff) {
      const newBook = new Map();
      for (const [typeId, e] of agg) {
        let bestSell = Infinity, bestBuy = 0;
        for (const o of e.sells) if (o.price < bestSell) bestSell = o.price;
        for (const o of e.buys)  if (o.price > bestBuy)  bestBuy  = o.price;
        if (bestSell === Infinity) bestSell = 0;
        // Total depth across ALL orders at all price levels — consistent with Fuzzwork's agg.buy.volume
        const sellQtyTop = e.sells.reduce((s, o) => s + o.volume_remain, 0);
        const buyQtyTop  = e.buys.reduce( (s, o) => s + o.volume_remain, 0);
        // Compact buy order book [{p,v}] sorted high→low for profitable-order queries
        const buyOrderBook = e.buys
          .map(o => ({ p: o.price, v: o.volume_remain }))
          .sort((a, b) => b.p - a.p);
        const spread    = (bestSell && bestBuy) ? bestSell - bestBuy : 0;
        const spreadPct = (bestSell && bestBuy) ? (spread / bestSell) * 100 : 0;
        newBook.set(typeId, { sell: bestSell, buy: bestBuy, spread, spreadPct, sellOrders: e.sells.length, buyOrders: e.buys.length, sellQtyTop, buyQtyTop, buyOrderBook });
      }
      if (newBook.size === 0) {
        // A "successful" fetch (every page returned 200, the error-budget check
        // at line ~2189 never tripped) that still matches zero orders at a
        // known-high-volume station (Jita, Amarr always have thousands listed)
        // is not real data — it's degraded/rate-limited ESI pages slipping
        // through as empty rather than erroring outright. Accepting this as
        // success used to overwrite both hubBooks AND the persisted snapshot
        // with an empty book, leaving nothing valid to fall back to on the
        // next boot either (confirmed in production Oct 2026: a prior poll's
        // empty result poisoned the snapshot, so even the boot-time snapshot
        // load came back "0 types"). Keep whatever book we already have and
        // let Fuzzwork fill the gap this cycle instead.
        meta.fetching = false;
        meta.lastError = 'empty-result-suspected-rate-limit';
        logger.warn(`⚠ ${cfg.name} ESI poll returned 0 types (suspected rate-limit degradation) — keeping last good book, trying Fuzzwork`);
        return pollFuzzworkHub(hubId); // schedules its own next poll — don't schedule here too
      }

      hubBooks[hubId] = newBook;
      Object.assign(hubMetas[hubId], { updatedAt: Date.now(), expiresAt: latestExpires || (Date.now() + TRADE_POLL_FALLBACK_MS), fetching: false, lastError: null, types: newBook.size });
      logger.info(`⟳ ${cfg.name} book refreshed via ESI — ${newBook.size} types in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      refreshHubNameMap(hubId, [...newBook.keys()]).catch(e => logger.error(`Name map error (${hubId}):`, e.message));

      // Persist snapshot (strip buyOrderBook — it's memory-only, repopulated on next poll)
      setImmediate(() => {
        const snap = JSON.stringify(Object.fromEntries(
          [...newBook.entries()].map(([k, { buyOrderBook: _, ...rest }]) => [k, rest])
        ));
        persistHubSnapshot(hubId, snap);
      });
      if (Date.now() - lastTradingRequestAt < 60_000 || hubEnrichPending[hubId]) {
        runHubHistoryEnrichment(hubId).catch(e => logger.error(`History enrichment error (${hubId}):`, e.message));
      }
    } else {
      // Error-budget backoff (mid-pagination, unlike the all-pages-succeeded-but-
      // empty case above) previously just logged a warning and kept whatever was
      // already cached — with no path to Fuzzwork at all. If the currently cached
      // book is itself empty (e.g. poisoned by an empty result from before this
      // fix was deployed, or never successfully loaded this boot), that left the
      // hub stuck serving nothing indefinitely, every poll cycle, since backoff
      // alone never triggers a fallback. Fuzzwork doesn't touch ESI's rate limit,
      // so it's safe to use here regardless of why ESI backed off.
      meta.fetching = false;
      meta.lastError = 'error-budget-backoff';
      logger.warn(`⚠ ${cfg.name} ESI poll backed off (low error budget) — keeping last good book`);
      if (!hubBooks[hubId] || hubBooks[hubId].size === 0) {
        logger.warn(`⚠ ${cfg.name} has no usable cached book — trying Fuzzwork`);
        return pollFuzzworkHub(hubId); // schedules its own next poll — don't schedule here too
      }
    }
  } catch (err) {
    meta.fetching = false;
    meta.lastError = err.message;
    logger.error(`⚠ ${cfg.name} ESI poll failed:`, err.message, '— falling back to Fuzzwork');
    return pollFuzzworkHub(hubId);
  }

  scheduleNextHubPoll(hubId, backoff || !!hubMetas[hubId].lastError);
}

function scheduleNextHubPoll(hubId, backoff) {
  if (hubPollTimers[hubId]) { clearTimeout(hubPollTimers[hubId]); delete hubPollTimers[hubId]; }
  if (Date.now() - lastTradingRequestAt > TRADE_IDLE_STOP_MS) {
    hubPollRunning[hubId] = false;
    logger.info(`⏸ ${HUB_CONFIG[hubId].name} poller idle — pausing until next request`);
    return;
  }
  const meta = hubMetas[hubId];
  let delay = (meta.expiresAt || (Date.now() + TRADE_POLL_FALLBACK_MS)) - Date.now() + 5000;
  if (backoff) delay = Math.max(delay, 60_000);
  delay = Math.min(Math.max(delay, 15_000), 15 * 60_000);
  const pollFn = HUB_CONFIG[hubId].isStructure ? pollStructureHub : pollHubESI;
  hubPollTimers[hubId] = setTimeout(() => pollFn(hubId), delay);
}

/** Lazily start a hub's poller on first request for that hub.
 *  Staggers initial polls 90 s apart to avoid simultaneous Fuzzwork/ESI bursts. */
function ensureHubPollerRunning(hubId) {
  lastTradingRequestAt = Date.now();
  if (config.disableTradingPoller) return;
  if (hubPollRunning[hubId]) return;
  hubPollRunning[hubId] = true;

  const now = Date.now();
  const delay = Math.max(0, lastHubPollStartedAt + HUB_POLL_STAGGER_MS - now);
  lastHubPollStartedAt = now + delay;

  const pollFn = HUB_CONFIG[hubId].isStructure ? pollStructureHub : pollHubESI;
  if (delay > 0) {
    logger.info(`▶ ${HUB_CONFIG[hubId].name} poller starting (staggered ${Math.round(delay / 1000)}s)`);
    setTimeout(() => pollFn(hubId), delay);
  } else {
    logger.info(`▶ ${HUB_CONFIG[hubId].name} poller starting`);
    pollFn(hubId);
  }
}

// ── Authenticated structure market poller (Keepstar and future player structures) ──
async function pollStructureHub(hubId) {
  const cfg  = HUB_CONFIG[hubId];
  const meta = hubMetas[hubId];
  if (meta.fetching) return;

  const token = await getOrRefreshStructureToken();
  if (!token) {
    logger.info(`⏸ ${cfg.name} poller: no active token — will retry`);
    scheduleNextHubPoll(hubId, true); // backoff
    return;
  }

  meta.fetching = true;
  const started = Date.now();

  try {
    let page = 1, allOrders = [];
    while (true) {
      const r = await esiFetch(
        `https://esi.evetech.net/latest/markets/structures/${cfg.stationId}/` +
        `?datasource=tranquility&page=${page}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (r.status === 401 || r.status === 403) throw new Error(`Auth error ${r.status} — token may have expired`);
      if (!r.ok) throw new Error(`ESI structure market ${r.status}`);
      const data = await r.json();
      if (!data || data.length === 0) break;
      allOrders = allOrders.concat(data);
      const totalPages = parseInt(r.headers.get('x-pages') || '1', 10);
      if (page >= totalPages) break;
      page++;
      await new Promise(res => setTimeout(res, 100));
    }

    // Build book — same format as pollHubESI
    const agg = new Map();
    for (const o of allOrders) {
      let e = agg.get(o.type_id);
      if (!e) { e = { sells: [], buys: [] }; agg.set(o.type_id, e); }
      (o.is_buy_order ? e.buys : e.sells).push(o);
    }

    const newBook = new Map();
    for (const [typeId, e] of agg) {
      let bestSell = Infinity, bestBuy = 0;
      for (const o of e.sells) if (o.price < bestSell) bestSell = o.price;
      for (const o of e.buys)  if (o.price > bestBuy)  bestBuy  = o.price;
      if (bestSell === Infinity) bestSell = 0;
      let sellQtyTop = 0, buyQtyTop = 0;
      if (bestSell) for (const o of e.sells) if (o.price === bestSell) sellQtyTop += o.volume_remain;
      if (bestBuy)  for (const o of e.buys)  if (o.price === bestBuy)  buyQtyTop  += o.volume_remain;
      const spread    = (bestSell && bestBuy) ? bestSell - bestBuy : 0;
      const spreadPct = (bestSell && bestBuy) ? (spread / bestSell) * 100 : 0;
      newBook.set(typeId, { sell: bestSell, buy: bestBuy, spread, spreadPct, sellOrders: e.sells.length, buyOrders: e.buys.length, sellQtyTop, buyQtyTop });
    }

    hubBooks[hubId] = newBook;
    Object.assign(hubMetas[hubId], { updatedAt: Date.now(), expiresAt: Date.now() + TRADE_POLL_FALLBACK_MS, fetching: false, lastError: null, types: newBook.size });
    logger.info(`⟳ ${cfg.name} book refreshed — ${newBook.size} types in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    refreshHubNameMap(hubId, [...newBook.keys()]).catch(e => logger.error(`Name map error (${hubId}):`, e.message));

    // Persist snapshot
    setImmediate(() => {
      const snap = JSON.stringify(Object.fromEntries(newBook));
      persistHubSnapshot(hubId, snap);
    });

  } catch (err) {
    meta.fetching = false;
    meta.lastError = err.message;
    logger.error(`⚠ ${cfg.name} structure market poll failed:`, err.message);
  }

  scheduleNextHubPoll(hubId, !!hubMetas[hubId].lastError);
}

/**
 * Per-hub background enrichment: fetch ESI market history for items missing from the
 * volume table (item_history_prices for Jita; hub_history_prices for other hubs).
 * Only one hub enriches at a time (global `enrichRunning` lock) to protect the ESI budget.
 */
async function runHubHistoryEnrichment(hubId) {
  if (HUB_CONFIG[hubId].isStructure) return; // no ESI history endpoint for player structures
  if (enrichRunning) return;
  if (jobState.preComputeRunning) {
    hubEnrichPending[hubId] = true;
    logger.info(`⟳ ${HUB_CONFIG[hubId].name} history enrichment deferred — precompute active, will retry next poll`);
    return;
  }
  hubEnrichPending[hubId] = false;
  if (hubBooks[hubId].size === 0) return;
  enrichRunning = true;

  const cfg      = HUB_CONFIG[hubId];
  const isJita   = hubId === 'jita';
  const cutoff   = new Date(Date.now() - 23 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');

  try {
    let freshSet;
    if (isJita) {
      const fresh = await dbAll('SELECT type_id FROM item_history_prices WHERE updated_at > ?', [cutoff]);
      freshSet = new Set(fresh.map(r => r.type_id));
    } else {
      const fresh = await dbAll(
        'SELECT type_id FROM hub_history_prices WHERE region_id = ? AND updated_at > ?',
        [cfg.regionId, cutoff]
      );
      freshSet = new Set(fresh.map(r => r.type_id));
    }

    const toEnrich = [...hubBooks[hubId].keys()].filter(id => !freshSet.has(id));
    if (toEnrich.length === 0) {
      logger.info(`✓ ${cfg.name} history fully enriched`);
      enrichRunning = false;
      return;
    }

    logger.info(`⟳ ${cfg.name} history enrichment: ${toEnrich.length} items need ESI history`);
    let done = 0;
    let lastErrorRemain = 100;

    for (const typeId of toEnrich) {
      if (hubBooks[hubId].size === 0) break;

      try {
        const r = await esiFetch(
          `https://esi.evetech.net/latest/markets/${cfg.regionId}/history/?datasource=tranquility&type_id=${typeId}`
        );
        const errorRemain = parseInt(r.headers.get('x-esi-error-limit-remain') || '100', 10);
        lastErrorRemain = errorRemain;
        if (errorRemain < TRADE_MIN_ERROR_BUDGET || r.status === 420 || r.status >= 500) {
          logger.warn(`⚠ ${cfg.name} history enrichment pausing — ESI error budget low (${errorRemain} remain)`);
          await new Promise(res => setTimeout(res, 60_000));
          break;
        }
        if (r.ok) {
          const history = await r.json();
          if (isJita) {
            // Jita: store price + volume in existing item_history_prices table
            if (Array.isArray(history) && history.length > 0) {
              const recent   = history.slice(-30);
              const avgVol   = recent.reduce((s, d) => s + (d.volume  || 0), 0) / recent.length;
              const avgPrice = recent.reduce((s, d) => s + (d.average || 0), 0) / recent.length;
              await dbRun(
                `INSERT INTO item_history_prices (type_id, avg_30d_price, avg_30d_volume, sample_days, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(type_id) DO UPDATE SET
                   avg_30d_price = excluded.avg_30d_price, avg_30d_volume = excluded.avg_30d_volume,
                   sample_days = excluded.sample_days, updated_at = excluded.updated_at`,
                [typeId, avgPrice, avgVol, recent.length]
              );
              done++;
            } else {
              await dbRun(
                `INSERT INTO item_history_prices (type_id, avg_30d_price, avg_30d_volume, sample_days, updated_at)
                 VALUES (?, 0, 0, 0, datetime('now'))
                 ON CONFLICT(type_id) DO UPDATE SET updated_at = excluded.updated_at`,
                [typeId]
              );
            }
          } else {
            // Non-Jita: store only volume in hub_history_prices (price not needed for scan)
            const avgVol = (Array.isArray(history) && history.length > 0)
              ? history.slice(-30).reduce((s, d) => s + (d.volume || 0), 0) / Math.min(history.length, 30)
              : 0;
            await dbRun(
              `INSERT INTO hub_history_prices (type_id, region_id, avg_30d_volume, updated_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(type_id, region_id) DO UPDATE SET
                 avg_30d_volume = excluded.avg_30d_volume, updated_at = excluded.updated_at`,
              [typeId, cfg.regionId, avgVol]
            );
            if (avgVol > 0) done++;
          }
        }
      } catch (_) { /* non-fatal */ }

      const delayMs = lastErrorRemain < 30 ? 800 : lastErrorRemain < 50 ? 300 : 150;
      await new Promise(res => setTimeout(res, delayMs));
    }

    logger.info(`✓ ${cfg.name} history enrichment complete: ${done}/${toEnrich.length} items`);
  } finally {
    enrichRunning = false;
  }
}

/** Marks "someone is using trading data", so the idle-stop does not fire before the first real request arrives. */
function markTradingActivity() { lastTradingRequestAt = Date.now(); }

module.exports = {
  hubBooks, hubMetas, hubNameMaps, ensureHubPollerRunning, loadHubSnapshots, markTradingActivity,
};
