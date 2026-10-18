'use strict';
// CCP's industry reference data, fetched from ESI and cached: the adjusted prices that job fees are based on and
// the per-system cost indices.

const logger = require('./logger');
const { esiFetch } = require('./esi');
const { CACHE_TTL_MS, CACHE_TTL_ADJ_MS } = require('./cache');

// ── ESI adjusted-price cache ───────────────────────────────────────────────────
// ESI /markets/prices/ returns CCP's adjusted_price for every type_id.
// Used to compute Estimated Item Value (EIV) for manufacturing job fees.
// EIV = Σ(adjusted_price × ME-adjusted quantity) — does NOT use market prices.
// Refreshed every 6 hours (ESI updates once daily; we just stay fresh).
const adjustedPriceCache = { data: null, expiry: 0 };

async function fetchAdjustedPrices() {
  if (adjustedPriceCache.data && Date.now() < adjustedPriceCache.expiry) {
    return adjustedPriceCache.data;
  }
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await esiFetch(
      'https://esi.evetech.net/latest/markets/prices/?datasource=tranquility',
      { headers: { Accept: 'application/json' }, signal: ctrl.signal }
    );
    if (!res.ok) throw new Error(`ESI /markets/prices/ HTTP ${res.status}`);
    const items = await res.json();
    const map   = {};
    for (const item of items) {
      map[item.type_id] = item.adjusted_price ?? item.average_price ?? 0;
    }
    adjustedPriceCache.data   = map;
    adjustedPriceCache.expiry = Date.now() + CACHE_TTL_ADJ_MS;
    logger.info(`✓ ESI adjusted prices cached — ${Object.keys(map).length} types`);
    return map;
  } finally {
    clearTimeout(t);
  }
}

// ── ESI manufacturing system cost-index + name cache ──────────────────────────
// ESI /industry/systems/ returns the manufacturing SCI for every solar system.
// SCI × EIV = the "System Job Cost Fee" component of a manufacturing job.
// We also fetch system names (via /universe/names/ bulk lookup) so that
// /api/system-search can do instant local matching without calling ESI search.
// Refreshed every hour (CCP updates SCIs roughly every hour).
//
// costIndexCache.sciMap  : Map<system_id, cost_index>
// costIndexCache.nameMap : Map<name_lowercase, { system_id, system_name }>
const costIndexCache = { sciMap: null, nameMap: null, expiry: 0 };

async function fetchCostIndices() {
  if (costIndexCache.sciMap && Date.now() < costIndexCache.expiry) {
    return costIndexCache.sciMap;
  }

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 30000);
  let systems;
  try {
    const res = await esiFetch(
      'https://esi.evetech.net/latest/industry/systems/?datasource=tranquility',
      { headers: { Accept: 'application/json' }, signal: ctrl.signal }
    );
    if (!res.ok) throw new Error(`ESI /industry/systems/ HTTP ${res.status}`);
    systems = await res.json();
  } finally {
    clearTimeout(t);
  }

  // Build SCI map
  const sciMap = {};
  const systemIds = [];
  for (const sys of systems) {
    const mfg = sys.cost_indices.find(c => c.activity === 'manufacturing');
    if (mfg) {
      sciMap[sys.solar_system_id] = mfg.cost_index;
      systemIds.push(sys.solar_system_id);
    }
  }

  // Bulk-fetch system names in parallel batches of 1000 (ESI /universe/names/ limit).
  // This runs once per hour and gives us a fully local search index.
  const nameMap  = new Map(); // name_lower → { system_id, system_name }
  const BATCH    = 1000;
  const batches  = [];
  for (let i = 0; i < systemIds.length; i += BATCH) {
    batches.push(systemIds.slice(i, i + BATCH));
  }
  const nameResults = await Promise.all(
    batches.map(async (batch) => {
      try {
        const r = await esiFetch('https://esi.evetech.net/latest/universe/names/', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body:    JSON.stringify(batch),
        });
        return r.ok ? await r.json() : [];
      } catch { return []; }
    })
  );
  for (const batch of nameResults) {
    for (const item of batch) {
      if (item.category === 'solar_system') {
        nameMap.set(item.name.toLowerCase(), { system_id: item.id, system_name: item.name });
      }
    }
  }

  costIndexCache.sciMap  = sciMap;
  costIndexCache.nameMap = nameMap;
  costIndexCache.expiry  = Date.now() + CACHE_TTL_MS;
  logger.info(`✓ ESI cost indices + names cached — ${systemIds.length} systems`);
  return sciMap;
}

module.exports = { costIndexCache, fetchAdjustedPrices, fetchCostIndices };
