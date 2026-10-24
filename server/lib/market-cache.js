'use strict';
// The server's shared in-memory market data: the per-region price cache (and how it is filled from ESI), the item
// name maps, the blueprint material maps, the 30-day average prices, and the `jitaPricesCache` global shim.
// Values that are REPLACED when reloaded (historyPriceMap, the name maps, jitaPricesCacheExpiry) are exposed as live
// getters: always read them as `market.historyPriceMap`, never copy them into a local variable at start-up.

const logger = require('./logger');
const HP = require('./hub-price');
const { dbAll } = require('./db');
const { esiFetch } = require('./esi');
const { CACHE_TTL_MS } = require('./cache');
const { VALID_REGIONS, REGIONS, REGION_TO_HUB, HUB_CONFIG, KEEPSTAR_STRUCTURE_ID, KEEPSTAR_REGION_ID } = require('./hubs');
const { getOrRefreshStructureToken } = require('./keepstar-token');

// PAGINATED REGION PRICE FETCHER
// Fetches complete order book from ESI for any region (handles pagination).
// Synthetic regionId 10099000 (Keepstar) is dispatched to fetchStructureMarketPrices().
async function fetchRegionPrices(regionId) {
  if (regionId === KEEPSTAR_REGION_ID) return fetchStructureMarketPrices();

  logger.info(`⟳ Fetching prices for region ${regionId}...`);
  const startTime = Date.now();

  const buyOrders = [];
  const sellOrders = [];

  // Fetch all pages of sell orders
  for (let page = 1; page <= 200; page++) {
    try {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/markets/${regionId}/orders/` +
        `?datasource=tranquility&order_type=sell&page=${page}`
      );
      if (!res.ok) throw new Error(`ESI returned ${res.status}`);
      const data = await res.json();
      if (!data || data.length === 0) break;
      sellOrders.push(...data);
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      // A partial book would price everything past the missing page as unlisted, so callers keep their last good prices.
      throw new Error(`Region ${regionId}: incomplete sell order book (page ${page}: ${err.message})`);
    }
  }

  // Fetch all pages of buy orders
  for (let page = 1; page <= 200; page++) {
    try {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/markets/${regionId}/orders/` +
        `?datasource=tranquility&order_type=buy&page=${page}`
      );
      if (!res.ok) throw new Error(`ESI returned ${res.status}`);
      const data = await res.json();
      if (!data || data.length === 0) break;
      buyOrders.push(...data);
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      throw new Error(`Region ${regionId}: incomplete buy order book (page ${page}: ${err.message})`);
    }
  }

  // Process into prices map.
  // For a trade hub, price at the hub STATION first: a region-wide lowest sell is often a
  // station you can't actually buy from or list against (measured gaps of 3–11% on Drake,
  // Caracal, 1MN Afterburner II, Megacyte). Items with no orders at the station fall back to
  // the region-wide best so they still price (sellScope/buyScope say which was used).
  const hubKey     = REGION_TO_HUB[regionId];
  const hubStation = hubKey && !HUB_CONFIG[hubKey].isStructure ? HUB_CONFIG[hubKey].stationId : null;
  const regionBest  = {};
  const stationBest = {};
  const slot = (map, id) => map[id] || (map[id] = { sell: Infinity, buy: 0 });
  // Order depth (units for sale per price level) alongside the lowest price: whether a hub can
  // supply the quantity a job needs is decided from this, not from the lowest price alone.
  const regionDepthAcc  = HP.makeDepthAccumulator();
  const stationDepthAcc = HP.makeDepthAccumulator();

  sellOrders.forEach(o => {
    const r = slot(regionBest, o.type_id);
    if (o.price < r.sell) r.sell = o.price;
    regionDepthAcc.add(o.type_id, o.price, o.volume_remain);
    if (hubStation && o.location_id === hubStation) {
      const s = slot(stationBest, o.type_id);
      if (o.price < s.sell) s.sell = o.price;
      stationDepthAcc.add(o.type_id, o.price, o.volume_remain);
    }
  });
  buyOrders.forEach(o => {
    const r = slot(regionBest, o.type_id);
    if (o.price > r.buy) r.buy = o.price;
    if (hubStation && o.location_id === hubStation) {
      const s = slot(stationBest, o.type_id);
      if (o.price > s.buy) s.buy = o.price;
    }
  });

  const prices = {};
  for (const typeId of Object.keys(regionBest)) {
    const r = regionBest[typeId];
    const s = stationBest[typeId];
    const stationSell = s && s.sell !== Infinity;
    const stationBuy  = s && s.buy > 0;
    prices[typeId] = {
      sell:       stationSell ? s.sell : r.sell,
      buy:        stationBuy  ? s.buy  : r.buy,
      sellScope:  hubStation ? (stationSell ? 'hub' : 'region') : 'region',
      buyScope:   hubStation ? (stationBuy  ? 'hub' : 'region') : 'region',
      regionSell: r.sell === Infinity ? 0 : r.sell,
    };
  }

  // Apply outlier filtering and calculate median
  let outlierMargin = 0, outlierNoBid = 0;
  Object.keys(prices).forEach(typeId => {
    const p = prices[typeId];
    if (p.sell === Infinity) p.sell = 0;
    if (p.buy > 0 && p.sell > p.buy * 5) {
      outlierMargin++;
      p.median = p.buy;
    } else if (p.buy === 0 && p.sell > 100000000) {
      outlierNoBid++;
      p.median = p.sell * 0.1;
    } else {
      p.median = (p.sell + p.buy) / 2;
    }
  });

  // Inject 30-day historical average as tertiary fallback (avg30d).
  // For items already in the order book, avg30d is attached as extra metadata.
  // For items with NO live orders at all, a stub entry is created so the
  // fallback chain (sell → buy → avg30d → 0) works everywhere downstream.
  //
  // Outlier cap: the outlier filter above only runs over live-order items.
  // Stub entries bypass it entirely, so we apply a sanity cap here:
  // avg30d is clamped to a maximum of 500× the item's buy price (when available),
  // or discarded if it is astronomically large (> 100T ISK — clearly corrupt).
  // This prevents a bad enrichment run from injecting scam-tier prices.
  const MAX_SANE_PRICE = 100_000_000_000_000; // 100 trillion ISK hard cap
  for (const [typeId, avg30d] of historyPriceMap) {
    if (avg30d <= 0 || avg30d > MAX_SANE_PRICE) continue; // drop corrupt values
    if (prices[typeId]) {
      // For live-order items, also validate against existing buy price
      const buy = prices[typeId].buy;
      if (buy > 0 && avg30d > buy * 500) continue; // extreme vs buy price → skip
      prices[typeId].avg30d = avg30d; // supplement live-order entry
    } else {
      // Item traded historically but has no live orders right now
      prices[typeId] = { sell: 0, buy: 0, median: avg30d, avg30d };
    }
  }

  const durationMs = Date.now() - startTime;
  const outlierNote = (outlierMargin + outlierNoBid) > 0
    ? `, ${outlierNoBid} no-bid + ${outlierMargin} margin outliers filtered` : '';
  logger.info(`✓ Region ${regionId} prices loaded — ${Object.keys(prices).length} items ` +
              `(${buyOrders.length} buy + ${sellOrders.length} sell orders` +
              `${outlierNote}) in ${(durationMs / 1000).toFixed(1)}s`);

  // Depth follows the same scope as the price: hub station orders when the station has any
  // sell order for the type, otherwise the region-wide book.
  const regionDepth  = regionDepthAcc.finish();
  const stationDepth = stationDepthAcc.finish();
  const depthOut = new Map();
  for (const [typeId, d] of regionDepth) {
    const s = stationBest[typeId];
    const useStation = s && s.sell !== Infinity && stationDepth.has(Number(typeId));
    depthOut.set(Number(typeId), useStation ? stationDepth.get(Number(typeId)) : d);
  }
  return HP.attachDepth(prices, depthOut);
}

// Fetch all orders from the C-J6MT Keepstar structure market and return a
// prices map in the same format as fetchRegionPrices() so the precompute loop
// is transparent to the data source.
async function fetchStructureMarketPrices() {
  const token = await getOrRefreshStructureToken();
  if (!token) throw new Error('No active alliance token and no stored refresh token — visit /api/ks-test-auth to authorise');

  logger.info(`⟳ Fetching Keepstar structure market (${KEEPSTAR_STRUCTURE_ID})...`);
  const startTime = Date.now();

  let page = 1, allOrders = [];
  while (true) {
    const r = await esiFetch(
      `https://esi.evetech.net/latest/markets/structures/${KEEPSTAR_STRUCTURE_ID}/` +
      `?datasource=tranquility&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (r.status === 401 || r.status === 403) {
      throw new Error(`ESI structure market auth error (${r.status}) — token may have expired`);
    }
    if (!r.ok) throw new Error(`ESI structure market ${r.status}`);
    const data = await r.json();
    if (!data || data.length === 0) break;
    allOrders = allOrders.concat(data);
    const totalPages = parseInt(r.headers.get('x-pages') || '1', 10);
    if (page >= totalPages) break;
    page++;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Aggregate to same {sell, buy, median} format as fetchRegionPrices
  const prices = {};
  const depthAcc = HP.makeDepthAccumulator();
  allOrders.forEach(o => {
    if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
    if (!o.is_buy_order && o.price < prices[o.type_id].sell) prices[o.type_id].sell = o.price;
    if ( o.is_buy_order && o.price > prices[o.type_id].buy)  prices[o.type_id].buy  = o.price;
    if (!o.is_buy_order) depthAcc.add(o.type_id, o.price, o.volume_remain);
  });

  const MAX_SANE_PRICE = 100_000_000_000_000;
  Object.values(prices).forEach(p => {
    if (p.sell === Infinity) p.sell = 0;
    if (p.buy > 0 && p.sell > p.buy * 5)       p.median = p.buy;
    else if (p.buy === 0 && p.sell > 100_000_000) p.median = p.sell * 0.1;
    else                                           p.median = (p.sell + p.buy) / 2;
  });

  // Enrich with historical 30d average (same module-level historyPriceMap used by fetchRegionPrices)
  for (const [typeId, avg30d] of historyPriceMap) {
    if (avg30d <= 0 || avg30d > MAX_SANE_PRICE) continue;
    if (prices[typeId]) {
      const buy = prices[typeId].buy;
      if (buy > 0 && avg30d > buy * 500) continue;
      prices[typeId].avg30d = avg30d;
    } else {
      prices[typeId] = { sell: 0, buy: 0, median: avg30d, avg30d };
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info(`✓ Keepstar market loaded — ${Object.keys(prices).length} types, ` +
              `${allOrders.length} orders in ${(durationMs / 1000).toFixed(1)}s`);
  return HP.attachDepth(prices, depthAcc.finish());
}

// JITA PRICES (Buy/Sell/Median) - Hourly Cache
// Per-region price cache (Map: regionId -> { prices, expiry })
// v0.9.4: Only Jita (10000002) is populated. v1.1 will populate multiple regions.
const regionPriceCache = new Map();

/** Write region prices to the cache with the standard 1-hour TTL. Single write point. */
function setRegionPriceCache(regionId, prices) {
  regionPriceCache.set(regionId, { prices, expiry: Date.now() + CACHE_TTL_MS });
}

/**
 * A hub's price map where each type the hub has no sell order for carries Jita's live lowest
 * sell, tagged sellScope 'jita' (see lib/hub-price.js). Null when the hub's cache is cold —
 * callers must treat that as "loading", never substitute Jita's whole map.
 */
function getHubPrices(regionId) {
  const entry = regionPriceCache.get(regionId);
  if (!entry) return null;
  return HP.withJitaFallback(entry.prices, regionPriceCache.get(10000002)?.prices || null);
}

/** The hub's own raw prices (no Jita fallback) + Jita's, for depth-aware purchase pricing. */
function getRawHubPrices(regionId) { return regionPriceCache.get(regionId)?.prices || null; }

function getRawJitaPrices()        { return regionPriceCache.get(10000002)?.prices || null; }

/**
 * Pre-warm price cache for all valid manufacturing regions.
 * Runs sequentially (not in parallel) to avoid simultaneous ESI hammering.
 * Skips regions that are already fresh (> 5 min remaining on TTL).
 * Keepstar (10099000) uses authenticated structure endpoints — skipped here.
 */
async function warmAllRegions() {
  for (const regionId of VALID_REGIONS) {
    if (regionId === 10099000) continue; // Keepstar uses auth — handled separately
    const entry = regionPriceCache.get(regionId);
    if (entry && (entry.expiry - Date.now()) > 5 * 60_000) continue; // still fresh
    if (regionWarmingSet.has(regionId)) continue; // already warming
    try {
      regionWarmingSet.add(regionId);
      const prices = await fetchRegionPrices(regionId);
      setRegionPriceCache(regionId, prices);
    } catch (err) {
      logger.warn(`⚠ warmAllRegions: region ${regionId} failed:`, err.message);
    } finally {
      regionWarmingSet.delete(regionId);
    }
  }
}

// Tracks which regions have a background price-warm in flight (avoid duplicate fetches)
const regionWarmingSet = new Set();

const regionWarmFailedAt = new Map();

/**
 * Start a background price warm-up for a hub whose cache is cold (or, with refreshStale, expired).
 * One at a time per hub, and a failed attempt is not retried for a minute — otherwise an ESI outage
 * would make every request re-trigger a full region fetch.
 */
function kickRegionWarm(regionId, { refreshStale = false } = {}) {
  const rid = Number(regionId);
  if (!VALID_REGIONS.includes(rid) || regionWarmingSet.has(rid)) return;
  const entry = regionPriceCache.get(rid);
  if (entry && (!refreshStale || Date.now() < entry.expiry)) return;
  if (Date.now() - (regionWarmFailedAt.get(rid) || 0) < 60_000) return;
  regionWarmingSet.add(rid);
  fetchRegionPrices(rid)
    .then(prices => setRegionPriceCache(rid, prices))
    .catch(() => { regionWarmFailedAt.set(rid, Date.now()); })
    .finally(() => regionWarmingSet.delete(rid));
}

// 30-day average prices from ESI market history.
// Used as tertiary fallback when live order book has no sell AND no buy orders.
// Populated at startup (from DB) and refreshed after every volume enrichment run.
// Key: typeId (integer), Value: avg 30-day trade price (ISK)
let historyPriceMap = new Map();

async function loadHistoryPriceMap() {
  try {
    const rows = await dbAll('SELECT type_id, avg_30d_price FROM item_history_prices WHERE avg_30d_price > 0');
    historyPriceMap = new Map(rows.map(r => [r.type_id, r.avg_30d_price]));
    logger.info(`✓ History price map loaded — ${historyPriceMap.size} items`);
  } catch (err) {
    logger.error('⚠ Failed to load history price map:', err.message);
  }
}

// ── Static SDE caches (loaded once at startup; never change between SDE imports) ──

// Global typeId→name map for all items. Replaces per-hub refreshHubNameMap DB queries.
let globalItemNameMap = new Map();

// Reverse map: lowercase name → typeId. Built alongside globalItemNameMap for O(1) appraise lookups.
let globalNameToTypeId = new Map();

async function loadGlobalItemNameMap() {
  try {
    const rows = await dbAll("SELECT type_id, name FROM items WHERE name IS NOT NULL AND name != ''");
    globalItemNameMap = new Map(rows.map(r => [r.type_id, r.name]));
    globalNameToTypeId = new Map(rows.map(r => [r.name.toLowerCase(), r.type_id]));
    logger.info(`✓ Global item name map loaded — ${globalItemNameMap.size} items`);
  } catch (err) {
    logger.error('⚠ Failed to load global item name map:', err.message);
  }
}

// Blueprint materials cache: blueprint_id -> [{material_id, quantity}]
// Populated from blueprint_materials (static SDE data, never changes between imports).
const blueprintMaterialsCache  = new Map();

const productToBlueprintCache  = new Map(); // product_id → blueprint_id (static SDE data)

async function loadBlueprintMaterialsCache() {
  try {
    const rows = await dbAll('SELECT blueprint_id, material_id, quantity FROM blueprint_materials');
    blueprintMaterialsCache.clear();
    for (const r of rows) {
      if (!blueprintMaterialsCache.has(r.blueprint_id))
        blueprintMaterialsCache.set(r.blueprint_id, []);
      blueprintMaterialsCache.get(r.blueprint_id).push({ material_id: r.material_id, quantity: r.quantity });
    }
    logger.info(`✓ Blueprint materials cache loaded — ${blueprintMaterialsCache.size} blueprints`);

    const bpRows = await dbAll('SELECT blueprint_id, product_id FROM blueprints WHERE product_id IS NOT NULL');
    productToBlueprintCache.clear();
    for (const r of bpRows) productToBlueprintCache.set(r.product_id, r.blueprint_id);
    logger.info(`✓ Product→blueprint cache loaded — ${productToBlueprintCache.size} entries`);
  } catch (err) {
    logger.error('⚠ Failed to load blueprint materials cache:', err.message);
  }
}

// ── IMPORTANT: jitaPricesCache global shim — DO NOT REMOVE ──────────────────
//
// `jitaPricesCache` is a virtual global property (defined via Object.defineProperty)
// that gives 15+ route handlers throughout this file a single short name for the
// Jita (region 10000002) price map.  It is the primary way the server looks up
// Jita prices internally — not just a leftover from the old /api/jita-prices route.
//
// Under the hood it is just a transparent alias for regionPriceCache.get(10000002)?.prices.
// Reading `jitaPricesCache` returns the live Jita price map from the unified cache.
// Writing `jitaPricesCache = prices` inserts the value into regionPriceCache and
// updates jitaPricesCacheExpiry so callers can check whether a refresh is needed.
//
// Removing or renaming this shim would break every handler that reads
// `jitaPricesCache` or `jitaPricesCacheExpiry` — including calculate-profitability,
// analyze-blueprints, item-details, queue-planner, PI market, and the AI tools.
// Retire only once all those handlers are rewritten to call regionPriceCache directly.
let jitaPricesCacheExpiry = 0; // TTL timestamp kept in sync by the shim's setter and runPreCompute

Object.defineProperty(global, 'jitaPricesCache', {
  get: () => {
    const entry = regionPriceCache.get(10000002);
    return entry ? entry.prices : null;
  },
  set: (value) => {
    if (value === null) {
      regionPriceCache.delete(10000002);
    } else {
      setRegionPriceCache(10000002, value);
      jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
    }
  },
  configurable: true
});

/**
 * Returns live buy/sell prices for a single typeId across all 6 trade hubs.
 * Uses regionPriceCache when fresh; fetches + caches if stale or missing.
 * Used by the AI get_price_comparison tool.
 */
async function getItemPricesAllRegions(typeId) {
  const results = [];

  for (const regionId of VALID_REGIONS) {
    try {
      let entry = regionPriceCache.get(regionId);
      if (!entry || Date.now() >= entry.expiry) {
        // fetchRegionPrices returns prices but doesn't cache — store explicitly
        const prices = await fetchRegionPrices(regionId);
        setRegionPriceCache(regionId, prices);
        entry = regionPriceCache.get(regionId);
      }

      if (!entry) continue;

      const price = entry.prices[typeId];
      if (price) {
        results.push({
          hub_name:          REGIONS[regionId]?.hub,
          region_id:         regionId,
          buy_price:         price.buy  || 0,
          sell_price:        price.sell || 0,
          median_price:      price.median || 0,
          volume_available:  0,   // ESI order feed doesn't include volume per-hub
        });
      }
    } catch (err) {
      logger.warn(`⚠ compare_markets: skipping region ${regionId} — ${err.message}`);
    }
  }

  return results;
}

module.exports = {
  regionPriceCache, setRegionPriceCache, getHubPrices, getRawHubPrices, getRawJitaPrices,
  fetchRegionPrices, fetchStructureMarketPrices, getItemPricesAllRegions,
  warmAllRegions, kickRegionWarm, regionWarmingSet,
  loadHistoryPriceMap, loadGlobalItemNameMap, loadBlueprintMaterialsCache,
  blueprintMaterialsCache, productToBlueprintCache,
  get historyPriceMap() { return historyPriceMap; },
  get globalItemNameMap() { return globalItemNameMap; },
  get globalNameToTypeId() { return globalNameToTypeId; },
  get jitaPricesCacheExpiry() { return jitaPricesCacheExpiry; },
  set jitaPricesCacheExpiry(value) { jitaPricesCacheExpiry = value; },
};
