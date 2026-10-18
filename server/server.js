// F.O.R.G.E. Server v1.0.0.0
// All blueprint/item data from SQLite, not APIs
// Pre-computed profitability + 4-tier filtering with severity levels (CRITICAL vs WARNING)
// + Comprehensive security: auth, rate limiting, input validation

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const helmet = require('helmet');
const security = require('./forge-security');
const HP = require('./lib/hub-price');
const { buildTopProfitableQuery, orderFor } = require('./lib/profit-query');   // hub prices: own orders first, Jita fallback (always tagged), order depth
const IM = require('./lib/industry-math');  // shared manufacturing mechanics (rigs, ME, EIV, job cost, time)

// ── PATH-SENSITIVE LINES — DO NOT CHANGE TO RELATIVE PATHS ──────────────────
// PM2's cwd is unreliable. These three lines MUST use __dirname.
// Using bare relative paths causes a silent outage: server starts and responds
// 404/500 but env vars are missing. This has caused three production outages (June 2026).
// Do not 'simplify' these. Any agent or developer who removes __dirname here is wrong.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const config = require('./lib/config');
const logger = require('./lib/logger');
const { forwardRejectionsOn, createErrorHandler, clientErrMsg } = require('./lib/http-errors');
const { esiFetch } = require('./lib/esi');
const database = require('./lib/db');
const { initDatabase, dbAll, dbGet, dbRun } = database;
const { runMigrations } = require('./lib/migrations');
const { CACHE_TTL_MS, cache, getCached } = require('./lib/cache');
const {
  HUB_CONFIG, HUB_STRUCTURE_FEES, REGION_TO_HUB, VALID_REGIONS, REGIONS, HUB_STANDINGS, HUB_SYSTEM_IDS,
  KEEPSTAR_STRUCTURE_ID, KEEPSTAR_REGION_ID,
} = require('./lib/hubs');
const { fetchAdjustedPrices, fetchCostIndices } = require('./lib/esi-industry-data');
const jobState = require('./lib/job-state'); // flags of the long-running background jobs
const market = require('./lib/market-cache'); // live values (historyPriceMap, name maps, jitaPricesCacheExpiry) are read as market.<name>
const { hubBooks, ensureHubPollerRunning, loadHubSnapshots, markTradingActivity } = require('./lib/hub-pollers');
const {
  regionPriceCache, setRegionPriceCache, getHubPrices, getRawHubPrices, getRawJitaPrices, fetchRegionPrices,
  warmAllRegions, kickRegionWarm, regionWarmingSet, loadHistoryPriceMap, loadGlobalItemNameMap,
  loadBlueprintMaterialsCache, blueprintMaterialsCache, productToBlueprintCache,
} = market;
const { refreshCorpData } = require('./lib/corp');
const {
  _ksTkPool, cacheStructureToken, pollKeepstarHistory, KS_POLL_INTERVAL_MS,
} = require('./lib/keepstar-token');
const {
  loadSkillSnapshots, getCharacterSession, calcSalesFeeRates, INDUSTRY_IMPLANTS,
} = require('./lib/character-session');
{
  const missing = config.missingRecommended();
  if (missing.length) logger.warn(`⚠ Not configured (the features that need them will return errors): ${missing.join(', ')}`);
}

// ── Push notifications (web-push) ─────────────────────────────────────────────
// Must be after dotenv.config() so VAPID keys are available in process.env.
// null when web-push is not installed or VAPID keys are absent — all push
// endpoints degrade gracefully when this is null.
let webpush = null;
try {
  webpush = require('web-push');
  if (config.vapid.publicKey && config.vapid.privateKey) {
    webpush.setVapidDetails(
      'mailto:admin@forge-ukc.com',
      config.vapid.publicKey,
      config.vapid.privateKey
    );
    logger.info('✓ Push notifications: VAPID configured');
  } else {
    logger.warn('⚠ Push notifications: VAPID keys not set in .env — push disabled');
    webpush = null;
  }
} catch { logger.warn('⚠ Push notifications: web-push not installed — push disabled'); }

const app = express();
// Express 4 ignores rejected promises from async handlers; forward them to the error handler (registered last).
forwardRejectionsOn(app);
forwardRejectionsOn(express.Router);
app.set('trust proxy', 1); // Trust Cloudflared proxy
const PORT = config.port;

// ── Global process error handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('⚠ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('⚠ Uncaught exception:', err);
  process.exit(1);
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      connectSrc: ["'self'", "https://login.eveonline.com", "https://esi.evetech.net", "https://evetycoon.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS - restrict to your domain only
app.use(cors({
  origin: ['https://forge-ukc.com', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Viewer-Token']
}));

app.use(express.json({ limit: '5mb' })); // Allows session data upload (assets/blueprints)
app.use(express.static(path.join(__dirname, 'public'))); // __dirname required — see PATH-SENSITIVE comment above

// SQLite Database
const DB_PATH = path.join(__dirname, '../forge-db/forge.db');


// ── Haulage provider rate tables (Phase 2) ────────────────────────────────────
// Approximate published rates — versioned. Users should verify against provider
// websites for current pricing; these are embedded for quick calculation only.
const HAUL_PROVIDERS = {
  red_frog: {
    name:            'Red Frog',
    max_volume_m3:   860_000,
    max_collateral:  1_000_000_000,
    min_fee:         1_000_000,
    isk_per_m3:      400,
    collateral_rate: 0.005,    // 0.5%
    rates_as_of:     'Jun 2025',
    note:            'Highsec only',
  },
  black_frog: {
    name:            'Black Frog',
    max_volume_m3:   860_000,
    max_collateral:  10_000_000_000,
    min_fee:         1_500_000,
    isk_per_m3:      1_200,
    collateral_rate: 0.01,     // 1%
    rates_as_of:     'Jun 2025',
    note:            'Lowsec / Null / WH',
  },
  pushx: {
    name:            'PushX',
    max_volume_m3:   860_000,
    max_collateral:  1_500_000_000,
    min_fee:         1_000_000,
    isk_per_m3:      380,
    collateral_rate: 0.005,    // 0.5%
    rates_as_of:     'Jun 2025',
    note:            'Highsec + some lowsec/null',
  },
};

/**
 * Calculate the total haul fee for a contract hauler provider.
 * Handles splitting oversized loads into multiple contracts automatically.
 *
 * @param {string} provider - 'red_frog' | 'black_frog' | 'pushx'
 * @param {number} volumeM3
 * @param {number} collateral - declared cargo value in ISK (used for rate calc)
 * @returns {{ cost: number, effectiveIskPerM3: number, contracts: number }}
 */
function calcProviderFee(provider, volumeM3, collateral) {
  const p = HAUL_PROVIDERS[provider];
  if (!p || volumeM3 <= 0) return { cost: 0, effectiveIskPerM3: 0, contracts: 1 };
  const contracts    = Math.ceil(volumeM3 / p.max_volume_m3);
  const volPerCon    = volumeM3   / contracts;
  const collPerCon   = (collateral || 0) / contracts;
  const feePerCon    = Math.max(p.min_fee, p.isk_per_m3 * volPerCon + p.collateral_rate * collPerCon);
  const totalFee     = feePerCon * contracts;
  const effectiveM3  = totalFee / volumeM3;
  return { cost: totalFee, effectiveIskPerM3: effectiveM3, contracts };
}

/**
 * Calculate haulage cost for one leg given method and volumes.
 *
 * @param {Object} cfg - leg config from character_industry_settings
 * @param {number} volumeM3 - total m³ for this leg
 * @param {number} jumpCount - jumps between origin and destination
 * @param {number} collateral - ISK value declared (for contract providers)
 * @returns {{ cost: number, effectiveIskPerM3: number, contracts: number, method: string }}
 */
function calcLegHaulCost(cfg, volumeM3, jumpCount, collateral) {
  if (volumeM3 <= 0) return { cost: 0, effectiveIskPerM3: 0, contracts: 1, method: cfg.method };
  const method = cfg.method || 'user_defined';

  if (method === 'red_frog' || method === 'black_frog' || method === 'pushx') {
    const result = calcProviderFee(method, volumeM3, collateral || 0);
    return { ...result, method };
  }

  if (method === 'self_haul') {
    const fuelCost = cfg.self_fuel || 0;
    return {
      cost: fuelCost,
      effectiveIskPerM3: volumeM3 > 0 ? fuelCost / volumeM3 : 0,
      contracts: 1,
      method,
    };
  }

  // user_defined — use max of whichever pricing inputs are filled
  const rate     = cfg.rate       || 0;
  const perJump  = cfg.isk_per_jump || 0;
  const flat     = cfg.flat_total   || 0;

  const m3Cost   = rate    > 0 ? rate    * volumeM3           : 0;
  const jumpCost = perJump > 0 ? perJump * (jumpCount || 0)   : 0;

  // "most conservative" = highest of all filled inputs
  const candidates = [m3Cost, jumpCost, flat].filter((v) => v > 0);
  const cost = candidates.length > 0 ? Math.max(...candidates) : 0;

  return {
    cost,
    effectiveIskPerM3: volumeM3 > 0 ? cost / volumeM3 : rate,
    contracts: 1,
    method,
  };
}

// ── Jump-count helper ──────────────────────────────────────────────────────────
// EVE solar-system topology is static — cache jump counts permanently.
const jumpCountCache = new Map(); // key: 'originId:destId'

// Returns null when the route could not be determined (ESI error), so callers that must not
// treat "unknown" as "zero jumps" can tell the difference. getJumpCount keeps the old 0.
// Failures are remembered for a while (and concurrent lookups share one request): a saved system with
// no gate route, or an ESI outage, must not turn every True Profit request into several failing ESI
// calls — failed requests are what count against the shared per-IP error budget.
const jumpCountFailUntil = new Map();   // key -> ms timestamp until which a failed lookup is not retried
const jumpCountInFlight  = new Map();   // key -> Promise
async function getJumpCountStrict(originId, destId) {
  if (!originId || !destId || originId === destId) return 0;
  if (!Number.isSafeInteger(Number(originId)) || !Number.isSafeInteger(Number(destId))) return null;
  const key = `${originId}:${destId}`;
  if (jumpCountCache.has(key)) return jumpCountCache.get(key);
  if ((jumpCountFailUntil.get(key) || 0) > Date.now()) return null;
  if (jumpCountInFlight.has(key)) return jumpCountInFlight.get(key);
  const p = (async () => {
    try {
      const url = `https://esi.evetech.net/latest/route/${Number(originId)}/${Number(destId)}/?datasource=tranquility`;
      const resp = await esiFetch(url);
      if (!resp.ok) {
        logger.warn(`Jump count API ${resp.status} for ${originId}→${destId}`);
        // 404 = no such route (stays true for a long time); anything else may be transient
        jumpCountFailUntil.set(key, Date.now() + (resp.status === 404 ? 6 * 3600_000 : 5 * 60_000));
        return null;
      }
      const route = await resp.json();
      if (!Array.isArray(route)) { jumpCountFailUntil.set(key, Date.now() + 5 * 60_000); return null; }
      const jumps = Math.max(0, route.length - 1);
      jumpCountCache.set(key, jumps);
      return jumps;
    } catch (err) {
      logger.warn(`Jump count fetch failed ${originId}→${destId}:`, err.message);
      jumpCountFailUntil.set(key, Date.now() + 5 * 60_000);
      return null;
    } finally {
      jumpCountInFlight.delete(key);
    }
  })();
  jumpCountInFlight.set(key, p);
  return p;
}
async function getJumpCount(originId, destId) {
  return (await getJumpCountStrict(originId, destId)) ?? 0;
}


// Resolve type names via ESI for any type_ids missing from the items table.
// Saves resolved names back to the DB so subsequent calls are instant.
app.post('/api/resolve-type-names', security.apiLimiter, async (req, res) => {
  try {
    const { typeIds } = req.body;
    if (!Array.isArray(typeIds) || typeIds.length === 0) {
      return res.json({ names: {} });
    }

    const uniqueIds = [...new Set(typeIds.filter(id => Number.isInteger(id) && id > 0))].slice(0, 1000);

    // Check DB first
    const ph = uniqueIds.map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT type_id, name FROM items WHERE type_id IN (${ph}) AND name IS NOT NULL AND name != ''`,
      uniqueIds
    );

    const names = {};
    const foundIds = new Set();
    for (const row of rows) {
      names[row.type_id] = row.name;
      foundIds.add(row.type_id);
    }

    // ESI fallback for any still-missing ids
    const missingIds = uniqueIds.filter(id => !foundIds.has(id));
    if (missingIds.length > 0) {
      try {
        const esiRes = await esiFetch(
          'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(missingIds) }
        );
        if (esiRes.ok) {
          const esiItems = await esiRes.json();
          await dbTxMutex.lock();
          try {
            await dbRun('BEGIN TRANSACTION');
            for (const item of esiItems) {
              if (item.category === 'inventory_type' && item.name) {
                names[item.id] = item.name;
                // Persist to DB so future calls (and next /api/item-names load) get it from the table
                await dbRun(
                  `INSERT INTO items (type_id, name) VALUES (?, ?)
                   ON CONFLICT(type_id) DO UPDATE SET name = excluded.name
                     WHERE items.name IS NULL OR items.name = ''`,
                  [item.id, item.name]
                ).catch(() => {});
              }
            }
            await dbRun('COMMIT');
          } catch (txErr) {
            await dbRun('ROLLBACK').catch(() => {});
            throw txErr;
          } finally {
            dbTxMutex.unlock();
          }
          // Invalidate the item_names cache so the next /api/item-names reload includes new names
          if (missingIds.length > 0) cache.delete('item_names');
        }
      } catch (esiErr) {
        logger.warn('ESI name resolve fallback failed:', esiErr.message);
      }
    }

    res.json({ names });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err), names: {} });
  }
});


// CALCULATE PROFITABILITY - Server-side pre-calculation
// Returns only top N profitable items
app.post('/api/calculate-profitability', security.apiLimiter, async (req, res) => {
  try {
    const { ownedBlueprints, topN = 20 } = req.body;
    
    if (!ownedBlueprints || !Array.isArray(ownedBlueprints)) {
      return res.status(400).json({ error: "ownedBlueprints array required" });
    }

    logger.info(`⟳ Calculating profitability for ${ownedBlueprints.length} blueprints...`);

    const regionId = req.body.regionId || 10000002;
    const blueprintIds = ownedBlueprints.map(bp => bp.type_id);
    const results = [];
    const prices = regionPriceCache.get(regionId)?.prices || {};
    logger.info(`  Using region ${regionId} prices`);

    for (const bpId of blueprintIds) {
      const bp = await dbGet(`
        SELECT b.blueprint_id, b.product_id, b.product_quantity, b.build_time, i.name as product_name
        FROM blueprints b
        JOIN items i ON i.type_id = b.product_id
        WHERE b.blueprint_id = ?
      `, [bpId]);

      if (!bp) continue;

      // Get materials
      const materials = await dbAll(`
        SELECT bm.material_id, bm.quantity, i.name as material_name
        FROM blueprint_materials bm
        JOIN items i ON i.type_id = bm.material_id
        WHERE bm.blueprint_id = ?
      `, [bpId]);

      // Calculate material cost (with recursive manufacturing check)
      let totalMatCost = 0;
      const matDetails = [];

      for (const mat of materials) {
        const cost = await calculateMaterialCost(mat.material_id, mat.quantity, prices);
        totalMatCost += cost;
        matDetails.push({
          name: mat.material_name,
          quantity: mat.quantity,
          cost: cost
        });
      }

      const sellPrice = prices[bp.product_id]?.sell || 0;
      const productQuantity = bp.product_quantity || 1;
      const batchRevenue = sellPrice * productQuantity;
      const profit = batchRevenue - totalMatCost;
      const profitMargin = batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0;

      results.push({
        blueprintId: bpId,
        productId: bp.product_id,
        productName: bp.product_name,
        sellPrice: sellPrice,
        materialCost: totalMatCost,
        profit: profit,
        profitMargin: profitMargin,
        buildTime: bp.build_time,
        materials: matDetails
      });
    }

    results.sort((a, b) => b.profit - a.profit);
    const topResults = results.slice(0, topN);

    logger.info(`✓ Top ${topResults.length} most profitable calculated`);
    res.json({ profitable: topResults, total: results.length });

  } catch (err) {
    logger.error('Profitability error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Helper: Calculate material cost (checks if it can be manufactured)
// depth guard prevents infinite recursion on circular blueprint data
async function calculateMaterialCost(materialId, quantity, prices, depth = 0) {
  if (depth > 10) return (prices[materialId]?.buy || 0) * quantity;
  const blueprintId = productToBlueprintCache.get(materialId);
  const bp = blueprintId ? { blueprint_id: blueprintId } : null;

  if (bp) {
    const subMats = blueprintMaterialsCache.get(bp.blueprint_id) || [];

    let mfgCost = 0;
    for (const sub of subMats) {
      const subCost = await calculateMaterialCost(sub.material_id, sub.quantity, prices, depth + 1);
      mfgCost += subCost;
    }

    const buyCost = (prices[materialId]?.buy || 0) * quantity;
    return Math.min(mfgCost * quantity, buyCost);
  } else {
    return (prices[materialId]?.buy || 0) * quantity;
  }
}

// PRODUCTION CHAIN - Full recursive build tree
app.post('/api/production-chain', security.apiLimiter, async (req, res) => {
  try {
    const { itemName, ownedBlueprints } = req.body;

    if (!itemName || typeof itemName !== 'string') {
      return res.status(400).json({ error: "itemName required" });
    }

    // Sanitise: cap length and escape SQLite LIKE wildcards (%, _, \) to prevent
    // catastrophic backtracking on patterns like '%%%%...%%%%' (DoS via full-table scan).
    const safeItemName = itemName.slice(0, 100).replace(/[\x00-\x1f\x7f]/g, '').replace(/[%_\\]/g, '\\$&');

    logger.info(`⟳ Building production chain for: ${safeItemName}`);

    const item = await dbGet(
      "SELECT type_id, name FROM items WHERE name LIKE ? ESCAPE '\\' LIMIT 1",
      [`%${safeItemName}%`]
    );
    if (!item) {
      return res.json({ error: `Item "${itemName}" not found`, chain: null });
    }

    const bp = await dbGet('SELECT blueprint_id, product_quantity, build_time FROM blueprints WHERE product_id = ?', [item.type_id]);
    if (!bp) {
      return res.json({ error: `No blueprint produces "${itemName}"`, chain: null });
    }

    const ownedBpIds = ownedBlueprints ? ownedBlueprints.map(b => b.type_id) : [];
    const userOwns = ownedBpIds.includes(bp.blueprint_id);

    const materials = await dbAll(`
      SELECT bm.material_id, bm.quantity, i.name
      FROM blueprint_materials bm
      JOIN items i ON i.type_id = bm.material_id
      WHERE bm.blueprint_id = ?
    `, [bp.blueprint_id]);

    const prices = jitaPricesCache || {};
    const chain = {
      item: item.name,
      itemId: item.type_id,
      blueprintId: bp.blueprint_id,
      owned: userOwns,
      buildTime: bp.build_time,
      materials: []
    };

    for (const mat of materials) {
      const matChain = await buildMaterialChain(mat, prices, ownedBpIds);
      chain.materials.push(matChain);
    }

    chain.totalCost = chain.materials.reduce((sum, m) => sum + m.cost, 0);
    chain.sellPrice = prices[item.type_id]?.sell || 0;
    chain.productQuantity = bp.product_quantity || 1;
    chain.batchRevenue = chain.sellPrice * chain.productQuantity;
    chain.profit = chain.batchRevenue - chain.totalCost;

    logger.info(`✓ Production chain built for ${item.name}`);
    res.json({ chain });

  } catch (err) {
    logger.error('Production chain error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

async function buildMaterialChain(material, prices, ownedBpIds) {
  const matId = material.material_id;
  const quantity = material.quantity;
  const name = material.name;

  const bp = await dbGet('SELECT blueprint_id, build_time FROM blueprints WHERE product_id = ?', [matId]);

  if (bp) {
    const userOwns = ownedBpIds.includes(bp.blueprint_id);
    
    const subMats = await dbAll(`
      SELECT bm.material_id, bm.quantity, i.name
      FROM blueprint_materials bm
      JOIN items i ON i.type_id = bm.material_id
      WHERE bm.blueprint_id = ?
    `, [bp.blueprint_id]);

    let mfgCost = 0;
    const subChain = [];
    
    for (const subMat of subMats) {
      const sub = await buildMaterialChain(subMat, prices, ownedBpIds);
      mfgCost += sub.cost;
      subChain.push(sub);
    }

    mfgCost *= quantity;
    const buyCost = (prices[matId]?.buy || 0) * quantity;
    const cheaper = mfgCost < buyCost ? 'manufacture' : 'buy';
    const cost = Math.min(mfgCost, buyCost);

    return {
      materialId: matId,
      name: name,
      quantity: quantity,
      canManufacture: true,
      blueprintOwned: userOwns,
      manufactureCost: mfgCost,
      buyCost: buyCost,
      recommendation: cheaper,
      cost: cost,
      subMaterials: subChain
    };
  } else {
    const buyCost = (prices[matId]?.buy || 0) * quantity;
    return {
      materialId: matId,
      name: name,
      quantity: quantity,
      canManufacture: false,
      buyCost: buyCost,
      cost: buyCost
    };
  }
}

// ── MATERIAL BREAKDOWN (lazy, single-level chain drill-down) ──────────────────
// Powers the inline reaction/manufacturing chain tree in RightSidebar.
// Returns ONE level of the blueprint that produces `typeId`, with a per-unit
// build-vs-buy verdict for each sub-material. Sell-sourced prices keep this
// consistent with /api/item-details and /api/true-cost (sell → buy → avg30d → 0).
//
// Scope (v1): sub-levels are costed at ME 0 (reactions have no ME anyway, and
// manufactured intermediates are costed conservatively). The top-level item's
// effective ME is applied by the caller (RightSidebar) — not here.

// Cheapest per-UNIT market cost for a type (the price a manufacturer pays to buy now).
function unitMarketCost(typeId, prices) {
  const p = prices[typeId];
  // A purchase price is the cheapest SELL order: the hub's, or Jita's for what the hub doesn't stock (tagged by
  // unitMarketScope). A bid can't be bought from. The Jita 30-day average is only the last resort.
  if (p && p.sell) return p.sell;
  return market.historyPriceMap.get(typeId) || 0;
}
function unitMarketScope(typeId, prices) {
  const p = prices[typeId];
  if (p && p.sell) return p.sellScope === 'jita' ? 'jita' : 'hub';
  return market.historyPriceMap.get(typeId) ? 'history' : 'none';
}

// Recursively compute the cheapest per-UNIT cost to OBTAIN one unit of `typeId`:
// min(buy from market, build from sub-materials). Depth-capped to avoid cycles.
async function cheapestUnitCost(typeId, prices, depth = 0) {
  const buy = unitMarketCost(typeId, prices);
  if (depth >= 6) return buy;
  const bp = await dbGet(
    'SELECT blueprint_id, product_quantity FROM blueprints WHERE product_id = ?',
    [typeId]
  );
  if (!bp) return buy;
  const subs = blueprintMaterialsCache.get(bp.blueprint_id) || [];
  if (!subs.length) return buy;
  let total = 0;
  for (const s of subs) {
    total += (await cheapestUnitCost(s.material_id, prices, depth + 1)) * s.quantity;
  }
  const perUnit = total / (bp.product_quantity || 1);
  // If there is no market price (buy === 0), build cost is the only signal.
  return buy > 0 ? Math.min(buy, perUnit) : perUnit;
}

app.post('/api/material-breakdown', security.apiLimiter, async (req, res) => {
  try {
    const { typeId, regionId = 10000002, ownedBlueprints } = req.body;
    if (!typeId) return res.status(400).json({ error: 'Missing typeId' });

    // Sell-sourced prices for the chosen hub: its own orders, Jita's live sell for types it doesn't
    // stock (tagged sellScope 'jita'). A cold hub cache is not filled with Jita's whole map.
    const prices = getHubPrices(regionId);
    if (!prices) {
      kickRegionWarm(regionId); kickRegionWarm(10000002);
      return res.status(503).json({ error: 'Market prices are still loading — try again in a few seconds.', pricesWarm: false });
    }
    if (!getRawJitaPrices()) kickRegionWarm(10000002);

    // Blueprint that produces this type — activity_id tells us mfg (1) vs reaction (9).
    const bp = await dbGet(
      `SELECT blueprint_id, product_quantity, build_time, activity_id
       FROM blueprints WHERE product_id = ?`,
      [typeId]
    );
    if (!bp) {
      return res.json({ typeId, manufacturable: false, materials: [] });
    }

    const ownedBpIds = Array.isArray(ownedBlueprints)
      ? new Set(ownedBlueprints.map(b => b.type_id))
      : new Set();

    const mats = await dbAll(
      `SELECT bm.material_id, bm.quantity, i.name, i.pi_tier
       FROM blueprint_materials bm
       JOIN items i ON i.type_id = bm.material_id
       WHERE bm.blueprint_id = ?`,
      [bp.blueprint_id]
    );

    // Which sub-materials are themselves producible, via what activity, and by which BP?
    const subIds = mats.map(m => m.material_id);
    const subBpMap = {};       // material_id → activity_id (1=mfg, 9=reaction)
    const subBpIdMap = {};     // material_id → blueprint_id (to check user ownership)
    if (subIds.length) {
      const ph = subIds.map(() => '?').join(',');
      const rows = await dbAll(
        `SELECT product_id, blueprint_id, activity_id FROM blueprints WHERE product_id IN (${ph})`,
        subIds
      );
      rows.forEach(r => {
        subBpMap[r.product_id]   = r.activity_id ?? 1;
        subBpIdMap[r.product_id] = r.blueprint_id;
      });
    }

    const materials = [];
    for (const m of mats) {
      const buyPerUnit  = unitMarketCost(m.material_id, prices);
      const canMfg      = Object.prototype.hasOwnProperty.call(subBpMap, m.material_id);
      // Only recurse for build cost when it's actually producible.
      const buildPerUnit = canMfg ? await cheapestUnitCost(m.material_id, prices) : null;
      const recommendation = (canMfg && buildPerUnit != null && buyPerUnit > 0)
        ? (buildPerUnit < buyPerUnit ? 'build' : 'buy')
        : (canMfg && buyPerUnit === 0 ? 'build' : 'buy');

      materials.push({
        materialId:      m.material_id,
        name:            m.name,
        quantity:        m.quantity,            // raw qty per blueprint run (ME 0)
        unitCost:        buyPerUnit,            // buy-from-market unit price
        buyPricePerUnit: buyPerUnit,
        priceScope:      unitMarketScope(m.material_id, prices),   // 'hub' | 'jita' (hub lists none) | 'history' | 'none'
        mfgCostPerUnit:  buildPerUnit,          // cheapest build cost per unit (null if not producible)
        canManufacture:  canMfg,
        activityId:      canMfg ? subBpMap[m.material_id] : null, // 1=mfg, 9=reaction
        blueprintOwned:  canMfg && ownedBpIds.has(subBpIdMap[m.material_id]), // user owns this BP
        piTier:          m.pi_tier ?? null,
        recommendation,
      });
    }

    res.json({
      typeId,
      manufacturable:  true,
      activityId:      bp.activity_id ?? 1,    // activity of the node being expanded
      productQuantity: bp.product_quantity || 1,
      buildTime:       bp.build_time,
      materials,
    });
  } catch (err) {
    logger.error('Material breakdown error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── ME RESEARCH ROI RANKER (v1.11.0) ─────────────────────────────────────────
// For each owned BPO, computes the per-build ISK saving from researching the
// blueprint from its current ME up to a target ME (default 10), plus a research
// time estimate. Ranks blueprints so a builder knows which to research first.
//
// ISK saving math is exact (material qty delta × market price). Research time is
// an ESTIMATE: needs blueprints.research_time (SDE) — NULL until SDE import runs,
// in which case time fields are null and ranking falls back to ISK saving only.

// Per-ME-level base research seconds for a unit-rank blueprint (published CCP table).
// Time to research level n (from n-1 to n). Total ME0→ME10 ≈ 439k s (~5.1 days) at rank 1.
const ME_LEVEL_SECONDS = [
  0,        // index 0 (no level 0 research)
  105,      // ME1
  250,      // ME2
  595,      // ME3
  1414,     // ME4
  3360,     // ME5
  7980,     // ME6
  18960,    // ME7
  45050,    // ME8
  107000,   // ME9
  256000,   // ME10
];
const ME_LEVEL_SECONDS_L1 = ME_LEVEL_SECONDS[1]; // 105 — normaliser for the SDE base time

// Material quantity for ONE run at a given ME (matches /api/true-cost rounding).
function qtyAtME(baseQty, me) {
  return Math.max(1, Math.ceil(baseQty * Math.max(0, 1 - me / 100)));
}

app.post('/api/me-research-roi', security.apiLimiter, async (req, res) => {
  try {
    const {
      blueprints: ownedBps,
      regionId   = 10000002,
      targetME   = 10,
      metallurgy        = 0,   // ME-research skill: −5%/level
      advancedIndustry  = 0,   // all jobs: −3%/level
    } = req.body;

    if (!Array.isArray(ownedBps) || ownedBps.length === 0) {
      return res.json({ items: [], research_time_available: false });
    }

    const target = Math.min(10, Math.max(1, parseInt(targetME, 10) || 10));
    const prices = getHubPrices(regionId);
    if (!prices) {
      kickRegionWarm(regionId); kickRegionWarm(10000002);
      return res.status(503).json({ error: 'Market prices are still loading — try again in a few seconds.', pricesWarm: false });
    }
    if (!getRawJitaPrices()) kickRegionWarm(10000002);

    // Skill/structure time reduction (multiplicative, EVE-accurate stacking).
    const timeMult = Math.max(0, 1 - 0.05 * metallurgy) * Math.max(0, 1 - 0.03 * advancedIndustry);

    // Dedupe to owned BPOs (runs === -1), one entry per blueprint type, keep highest ME.
    const bpoByType = new Map();
    for (const b of ownedBps) {
      if (!b || b.runs !== -1) continue;
      const cur = bpoByType.get(b.type_id);
      if (!cur || (b.material_efficiency ?? 0) > cur.me) {
        bpoByType.set(b.type_id, { typeId: b.type_id, me: b.material_efficiency ?? 0 });
      }
    }
    if (bpoByType.size === 0) {
      return res.json({ items: [], research_time_available: false });
    }

    let researchTimeAvailable = false;
    const items = [];

    for (const { typeId, me } of bpoByType.values()) {
      if (me >= target) continue; // already at/above target — nothing to research

      const bp = await dbGet(
        `SELECT blueprint_id, product_id, product_quantity, build_time, activity_id, research_time
         FROM blueprints WHERE blueprint_id = ?`,
        [typeId]
      );
      if (!bp || bp.activity_id === 9) continue; // reactions can't be ME-researched

      const mats = await dbAll(
        `SELECT bm.material_id, bm.quantity, i.name
         FROM blueprint_materials bm JOIN items i ON i.type_id = bm.material_id
         WHERE bm.blueprint_id = ?`,
        [bp.blueprint_id]
      );
      if (!mats.length) continue;

      // Material cost for ONE run at current ME vs target ME (sell-sourced).
      let costNow = 0, costTarget = 0;
      for (const m of mats) {
        const unit = unitMarketCost(m.material_id, prices);
        costNow    += unit * qtyAtME(m.quantity, me);
        costTarget += unit * qtyAtME(m.quantity, target);
      }
      const savingPerRun = costNow - costTarget;
      if (savingPerRun <= 0 && costNow === 0) continue; // no price data — skip noise

      const pctSaving = costNow > 0 ? (savingPerRun / costNow) * 100 : 0;

      // Research time estimate (current ME → target ME).
      let researchTimeSec = null;
      if (bp.research_time != null && bp.research_time > 0) {
        researchTimeAvailable = true;
        let levelsSum = 0;
        for (let lvl = me + 1; lvl <= target; lvl++) levelsSum += ME_LEVEL_SECONDS[lvl] || 0;
        // Scale the rank-1 table by this blueprint's base research time, apply skills.
        researchTimeSec = Math.round((bp.research_time / ME_LEVEL_SECONDS_L1) * levelsSum * timeMult);
      }

      const productName = mats.length // resolve product name from items table
        ? (await dbGet('SELECT name FROM items WHERE type_id = ?', [bp.product_id]))?.name
        : null;

      items.push({
        blueprintTypeId: typeId,
        productId:       bp.product_id,
        productName:     productName || `Item #${bp.product_id}`,
        currentME:       me,
        targetME:        target,
        matCostNow:      costNow,
        matCostTarget:   costTarget,
        savingPerRun,
        pctSaving,
        productQuantity: bp.product_quantity || 1,
        researchTimeSec, // null when SDE research_time not yet imported
      });
    }

    items.sort((a, b) => b.savingPerRun - a.savingPerRun);

    res.json({
      items,
      research_time_available: researchTimeAvailable,
      target_me: target,
      region_id: regionId,
    });
  } catch (err) {
    logger.error('ME research ROI error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// GET JITA PRICE - Single item price lookup from cache
// Used by AI tool to query prices on-demand
app.post('/api/get-price', security.apiLimiter, async (req, res) => {
  try {
    const { itemName, typeId } = req.body;
    
    if (!itemName && !typeId) {
      return res.status(400).json({ error: "itemName or typeId required" });
    }
    
    let targetTypeId = typeId;
    
    // If item name provided, find type_id
    if (itemName && !typeId) {
      const item = await dbGet(
        'SELECT type_id FROM items WHERE name LIKE ? LIMIT 1',
        [`%${itemName}%`]
      );
      
      if (!item) {
        return res.json({ error: `Item "${itemName}" not found`, price: null });
      }
      
      targetTypeId = item.type_id;
    }
    
    // Get price from cache
    const regionId = req.query.regionId || 10000002;
    const prices = regionPriceCache.get(regionId)?.prices || {};
    const priceData = prices[targetTypeId];
    
    if (!priceData) {
      return res.json({ 
        error: "Price not available in cache",
        itemName: itemName,
        typeId: targetTypeId,
        price: null 
      });
    }
    
    logger.info(`✓ Price lookup: ${itemName || targetTypeId} → ${priceData.sell} ISK`);
    
    res.json({
      itemName: itemName,
      typeId: targetTypeId,
      sell: priceData.sell,
      buy: priceData.buy,
      median: priceData.median
    });
    
  } catch (err) {
    logger.error('Price lookup error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// GET BLUEPRINT - Query any blueprint from database
// Used by AI to get materials for any item
app.post('/api/get-blueprint', security.apiLimiter, async (req, res) => {
  // Ensure JSON response even on catastrophic failure
  try {
    const { itemName, productId } = req.body;
    
    if (!itemName && !productId) {
      return res.json({ error: "itemName or productId required", blueprint: null });
    }
    
    let targetProductId = productId;
    
    // If item name provided, find product_id
    if (itemName && !productId) {
      const item = await dbGet(
        'SELECT type_id FROM items WHERE name LIKE ? LIMIT 1',
        [`%${itemName}%`]
      );
      
      if (!item) {
        return res.json({ 
          error: `Item "${itemName}" not found in database`,
          blueprint: null 
        });
      }
      
      targetProductId = item.type_id;
    }
    
    // Get blueprint for this product
    const blueprint = await dbGet(
      'SELECT blueprint_id, product_id, product_quantity, build_time FROM blueprints WHERE product_id = ?',
      [targetProductId]
    );
    
    if (!blueprint) {
      return res.json({
        error: `No blueprint found for this item`,
        itemName: itemName,
        productId: targetProductId,
        blueprint: null
      });
    }
    
    // Get materials
    const materials = blueprintMaterialsCache.get(blueprint.blueprint_id) || [];

    // Get item names and prices for materials
    const materialsWithDetails = await Promise.all(
      materials.map(async (mat) => {
        let matItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [mat.material_id]);
        let matName;
        
        // If not in database, try to fetch from ESI
        if (!matItem) {
          try {
            const esiRes = await esiFetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
            if (esiRes.ok) {
              const esiData = await esiRes.json();
              matName = esiData.name || `Unknown Item ${mat.material_id}`;
              
              // Optionally cache it in database for next time
              await dbRun(
                'INSERT OR IGNORE INTO items (type_id, name) VALUES (?, ?)',
                [mat.material_id, matName]
              );
            } else {
              matName = `Unknown Item ${mat.material_id}`;
            }
          } catch (err) {
            matName = `Item ID ${mat.material_id}`;
          }
        } else {
          matName = matItem.name;
        }
        
        const matPrice = jitaPricesCache ? jitaPricesCache[mat.material_id] : null;
        
        return {
          materialId: mat.material_id,
          name: matName,
          quantity: mat.quantity,
          unitCost: matPrice ? (matPrice.sell || matPrice.buy || 0) : 0,
          totalCost: matPrice ? (matPrice.sell || matPrice.buy || 0) * mat.quantity : 0
        };
      })
    );
    
    const totalCost = materialsWithDetails.reduce((sum, m) => sum + m.totalCost, 0);
    const productPrice = jitaPricesCache ? jitaPricesCache[targetProductId] : null;
    const sellPrice = productPrice ? productPrice.median : 0;
    const productQuantity = blueprint.product_quantity || 1;
    const batchRevenue = sellPrice * productQuantity;
    const profit = batchRevenue - totalCost;

    logger.info(`✓ Blueprint lookup: ${itemName || targetProductId} → ${materials.length} materials`);

    res.json({
      blueprintId: blueprint.blueprint_id,
      productId: blueprint.product_id,
      productQuantity: productQuantity,
      buildTime: blueprint.build_time,
      materials: materialsWithDetails,
      totalCost: totalCost,
      sellPrice: sellPrice,
      profit: profit,
      profitMargin: batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0
    });
    
  } catch (err) {
    logger.error('Blueprint lookup error:', err.message);
    res.json({ error: clientErrMsg(err), blueprint: null });
  }
});


async function fetchItemPriceHistory(typeId, regionId) {
  if (regionId === KEEPSTAR_REGION_ID) {
    const ksRows = await dbAll(
      `SELECT date, avg_sell, min_sell, max_sell, order_count
         FROM structure_market_history
        WHERE structure_id = ? AND type_id = ?
        ORDER BY date DESC LIMIT 90`,
      [KEEPSTAR_STRUCTURE_ID, typeId]
    );
    if (ksRows.length > 0) {
      const recent30 = ksRows.slice(0, 30);
      const avg30dFromHistory = recent30.reduce((s, r) => s + (r.avg_sell || 0), 0) / recent30.length;
      const priceHistory = ksRows.reverse().map(r => ({
        date:       r.date,
        average:    r.avg_sell,
        highest:    r.max_sell,
        lowest:     r.min_sell,
        orderCount: r.order_count,
      }));
      return { avg30dFromHistory, priceHistory, priceHistorySource: 'keepstar' };
    }
  } else {
    const JITA_REGION = 10000002;
    const historyRes = await esiFetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${typeId}`
    );
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (Array.isArray(historyData) && historyData.length > 0) {
        // Calculate 30-day average BEFORE sorting — ESI returns history oldest-first,
        // so slice(-30) on the raw array gives the 30 most recent trading days.
        // IMPORTANT: must happen before .sort() which mutates the array in-place,
        // changing the order and making slice(-30) return the oldest days instead.
        const recent30 = historyData.slice(-30);
        const avg30dFromHistory = recent30.length > 0
          ? recent30.reduce((sum, d) => sum + (d.average || 0), 0) / recent30.length
          : 0;
        const priceHistory = historyData
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 90)
          .reverse()
          .map(day => ({
            date:       day.date,
            average:    day.average,
            highest:    day.highest,
            lowest:     day.lowest,
            volume:     day.volume,
            orderCount: day.order_count,
          }));
        return { avg30dFromHistory, priceHistory, priceHistorySource: null };
      }
    }
  }
  return { avg30dFromHistory: 0, priceHistory: null, priceHistorySource: null };
}

async function buildMaterialAnalysis({ typeId, assets, ownedBlueprints, matRegionId, currentPrice }) {
  // Raw (un-overlaid) hub and Jita maps: purchases are priced from the hub's own orders first and
  // the remainder from Jita, using order depth (lib/hub-price.js). A cold hub cache is "loading",
  // never a reason to quote Jita under the hub's name.
  const rawHub  = getRawHubPrices(matRegionId);
  const rawJita = getRawJitaPrices();
  const hubIsJita = matRegionId === 10000002;
  const blueprint = await dbGet(
    'SELECT blueprint_id, product_quantity, build_time FROM blueprints WHERE product_id = ?',
    [typeId]
  );
  if (!blueprint) return null;

  const userOwnsBlueprint = ownedBlueprints.some(bp => bp.type_id === blueprint.blueprint_id);
  const materials = blueprintMaterialsCache.get(blueprint.blueprint_id) || [];

  const assetQuantities = {};
  assets.forEach(asset => {
    assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
  });

  // Single bulk query: which materials are themselves manufacturable?
  const matIds = materials.map(m => m.material_id);
  const manufSet = new Set();
  if (matIds.length > 0) {
    const ph = matIds.map(() => '?').join(',');
    const manufRows = await dbAll(
      `SELECT DISTINCT product_id FROM blueprints WHERE product_id IN (${ph})`, matIds
    );
    manufRows.forEach(r => manufSet.add(r.product_id));
  }

  // Single bulk query: material names + PI tier
  const nameMap = {}, piTierMap = {};
  if (matIds.length > 0) {
    const ph = matIds.map(() => '?').join(',');
    const nameRows = await dbAll(
      `SELECT type_id, name, pi_tier FROM items WHERE type_id IN (${ph})`, matIds
    );
    nameRows.forEach(r => {
      nameMap[r.type_id] = r.name;
      if (r.pi_tier != null) piTierMap[r.type_id] = r.pi_tier;
    });
  }

  const materialAnalysis = [];
  let totalCost = 0;
  let canBuild = true;

  for (const mat of materials) {
    const userHas  = assetQuantities[mat.material_id] || 0;
    const needed   = mat.quantity;
    const shortage = Math.max(0, needed - userHas);

    let matName = nameMap[mat.material_id];
    if (!matName) {
      try {
        const esiRes = await esiFetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
        if (esiRes.ok) {
          const esiData = await esiRes.json();
          matName = esiData.name || `Unknown Material ${mat.material_id}`;
          await dbRun('INSERT OR IGNORE INTO items (type_id, name) VALUES (?, ?)', [mat.material_id, matName]);
        } else {
          matName = `Unknown Material ${mat.material_id}`;
        }
      } catch (_) {
        matName = `Item #${mat.material_id}`;
      }
    }

    // Supply = the hub's sell depth + Jita's, in a JSON-safe form the browser walks with the same
    // algorithm (so any quantity — ME-adjusted needs, owned stock, shortfall — is priced
    // consistently). unitCost/unitScope describe a single unit, for simple displays.
    const supply = (rawHub && (hubIsJita || rawJita))
      ? HP.describeSupply({ hubPrices: rawHub, jitaPrices: rawJita, typeId: mat.material_id, hubIsJita,
                            history: market.historyPriceMap.get(mat.material_id) || 0 })
      : null;
    const one = supply ? HP.priceFromSupply(supply, 1) : null;
    const unitCost  = one ? one.unit : 0;
    const needCost  = supply ? HP.priceFromSupply(supply, needed) : null;
    const itemCost  = needCost ? needCost.cost : 0;
    totalCost += itemCost;

    materialAnalysis.push({
      materialId:     mat.material_id,
      name:           matName,
      needed,
      have:           userHas,
      shortage,
      unitCost,
      unitScope:      one ? one.scope : null,       // 'hub' | 'jita' | 'history' | 'none'
      totalCost:      itemCost,
      shortfallCost:  supply ? HP.priceFromSupply(supply, shortage).cost : 0,
      supply,                                        // depth for client-side pricing of other quantities
      canManufacture: manufSet.has(mat.material_id),
      piTier:         piTierMap[mat.material_id] ?? null,
    });

    if (shortage > 0) canBuild = false;
  }

  // Sell price for profit calc — sell hub. Use 30d avg fallback when no live orders.
  const liveSell = currentPrice?.sell || 0;
  const avg30d   = currentPrice?.avg30d || 0;
  const sellPrice = liveSell || avg30d || 0;
  const sellPriceSource = liveSell > 0 ? (currentPrice?.sellScope === 'jita' ? 'jita_fallback' : 'live')
                                        : (avg30d > 0 ? 'history_30d' : 'no_data');
  const productQuantity = blueprint.product_quantity || 1;
  const batchRevenue    = sellPrice * productQuantity;
  const profit          = batchRevenue - totalCost;
  const profitMargin    = batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0;

  return {
    canBuild:         userOwnsBlueprint && canBuild,
    blueprintOwned:   userOwnsBlueprint,
    blueprintId:      blueprint.blueprint_id,
    productQuantity,
    buildTime:        blueprint.build_time,
    materials:        materialAnalysis,
    pricesWarm:       !!(rawHub && (hubIsJita || rawJita)),
    totalCost,
    sellPrice,
    sellPriceSource,
    profit,
    profitMargin,
  };
}

async function fetchInventionData(typeId, matPrices, sellPrices) {
  const blueprintForInv = await dbGet(
    'SELECT blueprint_id FROM blueprints WHERE product_id = ?', [typeId]
  );
  if (!blueprintForInv) return {};

  const result = {};

  // Is this a T2 item? Find parent T1 blueprint via blueprint_invention.
  const invParent = await dbGet(`
    SELECT bi.t1_blueprint_id, bi.probability, bi.output_runs, i.name AS t1_name
      FROM blueprint_invention bi
      LEFT JOIN items i ON i.type_id = bi.t1_blueprint_id
     WHERE bi.t2_blueprint_id = ?
     LIMIT 1
  `, [blueprintForInv.blueprint_id]);

  if (invParent) {
    const dcMats = await dbAll(`
      SELECT im.material_id, im.quantity, i.name
        FROM invention_materials im
        LEFT JOIN items i ON i.type_id = im.material_id
       WHERE im.t1_blueprint_id = ?
    `, [invParent.t1_blueprint_id]);

    const datacores = dcMats.map(m => {
      const p = matPrices[m.material_id];
      const unitPrice = p?.sell || p?.buy || 0;
      return {
        materialId:      m.material_id,
        name:            m.name || `Material ${m.material_id}`,
        quantity:        m.quantity,
        unitPrice,
        totalPerAttempt: unitPrice * m.quantity,
        priceScope:      p?.sellScope === 'jita' ? 'jita' : 'hub',
      };
    });

    const baseProbability  = invParent.probability;
    const expectedAttempts = 1 / baseProbability;
    const costPerAttempt   = datacores.reduce((s, d) => s + d.totalPerAttempt, 0);

    result.inventionInfo = {
      t1BlueprintId:   invParent.t1_blueprint_id,
      t1BlueprintName: invParent.t1_name,
      baseProbability,
      expectedAttempts,
      outputRuns:      invParent.output_runs,
      perBpcCost:      costPerAttempt * expectedAttempts,
      datacores,
    };
  }

  // Is this a T1 item with T2 invention outcomes?
  const t2Links = await dbAll(`
    SELECT bi.t2_blueprint_id, bi.probability, bi.output_runs, b.product_id, i.name
      FROM blueprint_invention bi
      JOIN blueprints b ON b.blueprint_id = bi.t2_blueprint_id
      LEFT JOIN items i ON i.type_id = b.product_id
     WHERE bi.t1_blueprint_id = ?
     ORDER BY i.name
  `, [blueprintForInv.blueprint_id]);

  if (t2Links.length > 0) {
    const dcMats = await dbAll(`
      SELECT im.material_id, im.quantity, i.name
        FROM invention_materials im
        LEFT JOIN items i ON i.type_id = im.material_id
       WHERE im.t1_blueprint_id = ?
    `, [blueprintForInv.blueprint_id]);

    const datacores = dcMats.map(m => {
      const p = matPrices[m.material_id];
      const unitPrice = p?.sell || p?.buy || 0;
      return {
        materialId:      m.material_id,
        name:            m.name || `Material ${m.material_id}`,
        quantity:        m.quantity,
        unitPrice,
        totalPerAttempt: unitPrice * m.quantity,
        priceScope:      p?.sellScope === 'jita' ? 'jita' : 'hub',
      };
    });

    const dcCostPerAttempt = datacores.reduce((s, d) => s + d.totalPerAttempt, 0);

    result.inventionDatacores = datacores;
    result.inventionOptions   = t2Links.map(link => {
      const t2Sell     = sellPrices[link.product_id]?.sell || 0;
      const perBpcCost = dcCostPerAttempt / link.probability;
      return {
        t2BlueprintId:    link.t2_blueprint_id,
        t2ProductId:      link.product_id,
        t2Name:           link.name || `T2 Item ${link.product_id}`,
        t2SellPrice:      t2Sell,
        baseProbability:  link.probability,
        expectedAttempts: 1 / link.probability,
        outputRuns:       link.output_runs,
        perBpcCost,
      };
    });
  }

  return result;
}

// ITEM DETAILS - For right panel with build analysis
app.post('/api/item-details', security.apiLimiter, async (req, res) => {
  try {
    const {
      typeId,
      assets,
      ownedBlueprints,
      regionId         = 10000002,  // sell hub — drives displayed current price
      materialRegionId = regionId,  // source hub — drives material unit costs in build analysis
    } = req.body;

    if (!typeId) {
      return res.status(400).json({ error: "Missing typeId" });
    }

    // Get from database first
    const item = await dbGet('SELECT name, description, icon_url, volume, mass FROM items WHERE type_id = ?', [typeId]);
    
    const itemDetails = item ? {
      name: item.name,
      description: item.description,
      iconUrl: item.icon_url,
      volume: item.volume,
      mass: item.mass
    } : {};

    // Get market history — from structure_market_history for Keepstar, ESI for all others
    const { avg30dFromHistory, priceHistory, priceHistorySource } = await fetchItemPriceHistory(typeId, regionId);
    if (priceHistory) {
      itemDetails.priceHistory = priceHistory;
      if (priceHistorySource) itemDetails.priceHistorySource = priceHistorySource;
    }

    // Sell-hub prices — used for the "Current Market" price display and profit calculation.
    // The hub's own orders; Jita's live lowest sell only for what the hub has none of (tagged
    // sellScope 'jita'). A cold cache is never filled with Jita's whole map: it is warmed in the
    // background and the client is told (pricesWarm:false) to ask again.
    const sellPrices = getHubPrices(regionId) || {};
    const sellWarm   = !!getHubPrices(regionId);
    // avg30d: prefer freshly-fetched history, fall back to cached map value
    const avg30d = avg30dFromHistory || market.historyPriceMap.get(typeId) || 0;
    const jitaReady = !!getRawJitaPrices();
    if (!sellWarm || !jitaReady || (materialRegionId !== regionId && !getHubPrices(materialRegionId))) {
      itemDetails.pricesWarm = false;
      for (const rid of new Set([regionId, materialRegionId, 10000002])) kickRegionWarm(rid);
    } else {
      itemDetails.pricesWarm = true;
    }
    if (sellWarm && sellPrices[typeId]) {
      itemDetails.currentPrice = {
        sell:   sellPrices[typeId].sell,
        buy:    sellPrices[typeId].buy,
        median: sellPrices[typeId].median,
        avg30d,
        // 'jita' = the hub has none listed, so this is Jita's live lowest sell (not the hub's)
        sellScope: sellPrices[typeId].sellScope === 'jita' ? 'jita' : 'hub',
      };
    } else if (!sellWarm) {
      // Cold cache: this hub's own last precompute row (never another hub's data)
      const pre = await dbGet(
        'SELECT sell_price, buy_price, price_source FROM precomputed_profits WHERE product_id = ? AND region_id = ? LIMIT 1',
        [typeId, regionId]
      );
      if (pre) itemDetails.currentPrice = { sell: pre.sell_price || 0, buy: pre.buy_price || 0, median: pre.sell_price || 0, avg30d,
                                            sellScope: pre.price_source === 'jita_fallback' ? 'jita' : 'hub' };
    } else if (avg30d > 0) {
      // No live orders but we have historical trade data — expose it so True Profit
      // can use a realistic price rather than showing zero revenue
      itemDetails.currentPrice = {
        sell:   0,
        buy:    0,
        median: avg30d,
        avg30d,
      };
    }

    // Source-hub prices (with Jita fallback for types the hub has no sell order for) — used for
    // the invention datacore costs. Material purchase costs use depth-aware pricing below.
    const matPrices = (materialRegionId !== regionId)
      ? (getHubPrices(materialRegionId) || {})
      : sellPrices;

    // BUILD ANALYSIS (if assets and blueprints provided)
    if (assets && ownedBlueprints) {
      const buildInfo = await buildMaterialAnalysis({ typeId, assets, ownedBlueprints, matRegionId: materialRegionId, currentPrice: itemDetails.currentPrice });
      if (buildInfo) itemDetails.buildInfo = buildInfo;
    }

    // ── Invention data (always, no auth required, uses base probability) ────
    Object.assign(itemDetails, await fetchInventionData(typeId, matPrices, sellPrices));

    // v1.12.0 — contract pricing for contract-only / thin-market items.
    // Prefer the requested region; fall back to The Forge (the only ingested
    // region in v1) so capitals/faction gear still get a price + honest label.
    try {
      let cp = await dbGet('SELECT * FROM contract_prices WHERE type_id = ? AND region_id = ?', [typeId, regionId]);
      let cpRegion = regionId;
      if (!cp && regionId !== CONTRACT_INGEST_REGION) {
        cp = await dbGet('SELECT * FROM contract_prices WHERE type_id = ? AND region_id = ?', [typeId, CONTRACT_INGEST_REGION]);
        cpRegion = CONTRACT_INGEST_REGION;
      }
      if (cp && cp.sample_count > 0) {
        itemDetails.contractPricing = {
          regionId:    cpRegion,
          regionName:  REGIONS[cpRegion]?.name || `Region ${cpRegion}`,
          low:         cp.low,
          high:        cp.high,
          median:      cp.median,
          suggested:   cp.suggested,
          sampleCount: cp.sample_count,
          source:      cp.source,
          computedAt:  cp.computed_at,
          rationale:   contractRationale(cp),
        };
      }
    } catch (_) { /* contract pricing is best-effort — never block item details */ }

    logger.info(`✓ Item details fetched — ${itemDetails.name || typeId}${itemDetails.buildInfo ? ' (with build analysis)' : ''}`);
    res.json(itemDetails);

  } catch (err) {
    logger.error("Item details error:", err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ANALYZE BLUEPRINTS - Calculate profitability/buildability for all user BPs
// Used by AI to get top profitable/buildable items
// Resolves an owned blueprint entry to a full profitability analysis: buildability,
// material shortages, and profit margin. Returns { result } or { skipped: {type_id, name} }.
async function analyzeOwnedBlueprint({ bp, assetQuantities }) {
  // Strategy 1: look up by blueprint_id = ESI type_id (works for T1 + T2 if SDE has them)
  let blueprint = await dbGet(
    'SELECT blueprint_id, product_id, product_quantity, build_time FROM blueprints WHERE blueprint_id = ?',
    [bp.type_id]
  );

  // Strategy 2: for T2 BPCs the DB may index by product_id instead — try reverse lookup
  if (!blueprint) {
    // Look up what this type_id produces via the items table
    const bpItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [bp.type_id]);
    const bpName = bpItem?.name || '';
    // Strip " Blueprint" suffix to get product name, then look up product type_id
    if (bpName.toLowerCase().includes('blueprint')) {
      const productName = bpName.replace(/ Blueprint$/i, '').trim();
      const productItem = await dbGet('SELECT type_id FROM items WHERE name = ? COLLATE NOCASE', [productName]);
      if (productItem) {
        blueprint = await dbGet(
          'SELECT blueprint_id, product_id, product_quantity, build_time FROM blueprints WHERE product_id = ?',
          [productItem.type_id]
        );
      }
    }
  }

  if (!blueprint) {
    // Log skipped blueprints for diagnosis
    const bpItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [bp.type_id]);
    return { skipped: { type_id: bp.type_id, name: bpItem?.name || `Unknown #${bp.type_id}` } };
  }

  // Get product name and tech tier from meta_level (populated by sde-import.js)
  const product = await dbGet('SELECT name, meta_level FROM items WHERE type_id = ?', [blueprint.product_id]);
  const productName = product?.name ?? null;
  const metaLevel   = product?.meta_level ?? 0;
  const techTier    = metaLevel === 2 ? 'T3' : metaLevel === 1 ? 'T2' : 'T1';

  // Get materials
  const materials = blueprintMaterialsCache.get(blueprint.blueprint_id) || [];

  // Calculate costs and buildability
  let totalCost = 0;
  let canBuild = true;
  const materialDetails = [];

  for (const mat of materials) {
    const userHas = assetQuantities[mat.material_id] || 0;
    const needed = mat.quantity;
    const shortage = Math.max(0, needed - userHas);

    const matPrice = jitaPricesCache ? jitaPricesCache[mat.material_id] : null;
    const unitCost = matPrice ? (matPrice.sell || matPrice.buy || 0) : 0;
    totalCost += unitCost * needed;

    if (shortage > 0) canBuild = false;

    materialDetails.push({
      materialId: mat.material_id,
      needed: needed,
      have: userHas,
      shortage: shortage
    });
  }

  // Get sell price - use MEDIAN instead of sell for more realistic pricing
  const productPrice = jitaPricesCache ? jitaPricesCache[blueprint.product_id] : null;
  const sellPrice = productPrice ? productPrice.median : 0;
  const productQuantity = blueprint.product_quantity || 1;
  const batchRevenue = sellPrice * productQuantity;
  const profit = batchRevenue - totalCost;
  const profitMargin = batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0;

  return {
    result: {
      blueprintId: blueprint.blueprint_id,
      productId: blueprint.product_id,
      productName: productName,
      productQuantity: productQuantity,
      buildTime: blueprint.build_time,
      totalCost: totalCost,
      sellPrice: sellPrice,
      profit: profit,
      profitMargin: profitMargin,
      canBuild: canBuild,
      materialCount: materials.length,
      materials: materialDetails,
      metaLevel,
      techTier,
    },
  };
}

// Filters (optionally to buildable-only), sorts by the requested criterion, and
// annotates each result with completionPct (% of required materials already owned).
function sortAndAnnotateBlueprintResults({ results, buildableOnly, sortBy }) {
  let filtered = buildableOnly ? results.filter(r => r.canBuild) : results;

  switch (sortBy) {
    case 'profit':
      filtered.sort((a, b) => b.profit - a.profit);
      break;
    case 'cost':
      filtered.sort((a, b) => b.totalCost - a.totalCost);
      break;
    case 'time':
      filtered.sort((a, b) => b.buildTime - a.buildTime);
      break;
    case 'materials':
      filtered.sort((a, b) => b.materialCount - a.materialCount);
      break;
    case 'margin':
      filtered.sort((a, b) => b.profitMargin - a.profitMargin);
      break;
    case 'completion':
      // Sort by % of required materials already owned — useful for "closest to build-ready"
      filtered.sort((a, b) => {
        const pctA = a.materials.length === 0 ? 1 : a.materials.reduce((s, m) => s + Math.min(m.have / m.needed, 1), 0) / a.materials.length;
        const pctB = b.materials.length === 0 ? 1 : b.materials.reduce((s, m) => s + Math.min(m.have / m.needed, 1), 0) / b.materials.length;
        return pctB - pctA;
      });
      break;
    default:
      filtered.sort((a, b) => b.profit - a.profit);
  }

  // Add completion % to each result so AI can report it
  filtered.forEach(r => {
    r.completionPct = r.materials.length === 0 ? 100
      : Math.round(r.materials.reduce((s, m) => s + Math.min(m.have / m.needed, 1), 0) / r.materials.length * 100);
  });

  return filtered;
}

app.post('/api/analyze-blueprints', security.apiLimiter, async (req, res) => {
  try {
    const { ownedBlueprints, assets, sortBy = 'profit', limit = 20, buildableOnly = false } = req.body;

    if (!ownedBlueprints || !Array.isArray(ownedBlueprints)) {
      return res.status(400).json({ error: "ownedBlueprints array required" });
    }

    if (!assets || !Array.isArray(assets)) {
      return res.status(400).json({ error: "assets array required" });
    }

    // WAIT FOR PRICE CACHE TO LOAD (if not already loaded)
    // This ensures we always return real prices, never 0 ISK
    if (!jitaPricesCache || Date.now() >= market.jitaPricesCacheExpiry) {
      logger.info('⟳ Loading Jita prices for analysis...');
      try {
        const prices = await fetchRegionPrices(10000002); // The Forge (Jita)
        jitaPricesCache = prices;
        market.jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
      } catch (err) {
        logger.error('⚠ Failed to load prices, proceeding with cached/zero prices:', err.message);
      }
    }

    logger.info(`⟳ Analyzing ${ownedBlueprints.length} blueprints...`);

    // Group assets by type_id for quick lookup
    const assetQuantities = {};
    assets.forEach(asset => {
      assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
    });

    // Analyze each blueprint
    const results = [];
    const skipped = [];

    for (const bp of ownedBlueprints) {
      const { result, skipped: skippedItem } = await analyzeOwnedBlueprint({ bp, assetQuantities });
      if (skippedItem) { skipped.push(skippedItem); continue; }
      results.push(result);
    }

    const filtered = sortAndAnnotateBlueprintResults({ results, buildableOnly, sortBy });

    // Return top N results
    const topResults = filtered.slice(0, limit);

    logger.info(`✓ Blueprint analysis complete — ${results.length} found, ${skipped.length} skipped, Top ${topResults.length} results (sorted by ${sortBy})`);
    if (skipped.length > 0) {
      logger.info(`  ⚠ Skipped (not in blueprints DB): ${skipped.map(s => s.name).join(', ')}`);
    }

    res.json({
      total: results.length,
      buildable: results.filter(r => r.canBuild).length,
      skipped: skipped.length,
      skippedNames: skipped.map(s => s.name),
      results: topResults
    });
    
  } catch (err) {
    logger.error('❌ Blueprint analysis error:', err.message);
    logger.error('Stack:', err.stack);
    // Return proper error response with 500 status
    return res.status(500).json({
      error: `Analysis failed: ${err.message}`,
      total: 0,
      buildable: 0,
      results: []
    });
  }
});


// ── POST /api/blueprint-profits (v1.15.0) ────────────────────────────────────
// Per-blueprint profitability for the "My Blueprints" tab, from the same
// precomputed_profits data that powers Market Opportunities. Body:
//   { blueprintTypeIds: number[], regionId?: number, assets?: EsiAsset[], walletISK?: number }
// Returns a map keyed by blueprint type_id (= blueprint_id):
//   { [bpTypeId]: { profit, margin, iskPerHour, sellPrice, materialCost, buildTime, canBuildNow? } }
//
// v1.33.0 — canBuildNow: when assets + walletISK are supplied, cross-references
// each blueprint's ME0 (worst-case, single-run) material list against owned
// assets. Any shortage is priced at the live source-hub sell price; canBuildNow
// is true when that shortfall cost is within the character's current wallet
// balance (covers both "already stocked" and "can afford to top up now").
// Only computed when the region's live price cache is warm — otherwise omitted
// (a background warm is kicked off so a retry a few seconds later succeeds).
app.post('/api/blueprint-profits', security.apiLimiter, async (req, res) => {
  try {
    const { blueprintTypeIds, regionId, assets, walletISK } = req.body;
    if (!Array.isArray(blueprintTypeIds) || blueprintTypeIds.length === 0) return res.json({});

    const region = VALID_REGIONS.includes(parseInt(regionId)) ? parseInt(regionId) : 10000002;
    const limited = blueprintTypeIds.slice(0, 2000);

    const checkBuildable = Array.isArray(assets) && typeof walletISK === 'number';
    const priceEntry = regionPriceCache.get(region);
    // Same lenient read as sellPrices in /api/item-details (regionPriceCache.get(...)?.prices):
    // a technically-expired-but-present cache entry is still far better than refusing to
    // answer, since canBuildNow is a best-effort signal, not a financial figure. Only kick
    // off a background warm-up when the entry is genuinely missing or actually expired —
    // the computation itself proceeds as long as ANY price data is present.
    const pricesAvailable = !!(priceEntry && priceEntry.prices);
    // The hub's own orders, with Jita's lowest sell for types it doesn't stock.
    const shortfallPrices = pricesAvailable ? HP.withJitaFallback(priceEntry.prices, getRawJitaPrices()) : {};
    const isExpired = !priceEntry || Date.now() >= priceEntry.expiry;
    if (checkBuildable && isExpired && !regionWarmingSet.has(region)) {
      regionWarmingSet.add(region);
      fetchRegionPrices(region)
        .then(prices => setRegionPriceCache(region, prices))
        .catch(() => {})
        .finally(() => regionWarmingSet.delete(region));
    }
    const assetQuantities = {};
    if (checkBuildable) {
      for (const a of assets) {
        assetQuantities[a.type_id] = (assetQuantities[a.type_id] || 0) + a.quantity;
      }
    }

    const out = {};
    const CHUNK = 900; // stay under SQLite host-parameter limit
    for (let i = 0; i < limited.length; i += CHUNK) {
      const slice = limited.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      const rows = await dbAll(
        `SELECT blueprint_id, profit, profit_margin, isk_per_hour,
                sell_price, material_cost, build_time, liquidity_risk
         FROM precomputed_profits
         WHERE region_id = ? AND blueprint_id IN (${ph})`,
        [region, ...slice]
      );

      let matsByBp = null;
      if (checkBuildable && pricesAvailable) {
        matsByBp = new Map();
        for (const bpId of slice) {
          const mats = blueprintMaterialsCache.get(bpId);
          if (mats) matsByBp.set(bpId, mats);
        }
      }

      for (const r of rows) {
        out[r.blueprint_id] = {
          profit:        r.profit,
          margin:        r.profit_margin,
          iskPerHour:    r.isk_per_hour,
          sellPrice:     r.sell_price,
          materialCost:  r.material_cost,
          buildTime:     r.build_time,
          liquidityRisk: r.liquidity_risk,
        };

        if (matsByBp) {
          const mats = matsByBp.get(r.blueprint_id) || [];
          let shortfallCost = 0;
          for (const m of mats) {
            const have     = assetQuantities[m.material_id] || 0;
            const shortage = Math.max(0, m.quantity - have);
            if (shortage > 0) {
              shortfallCost += (shortfallPrices[m.material_id]?.sell || 0) * shortage;
            }
          }
          out[r.blueprint_id].canBuildNow = shortfallCost <= walletISK;
        }
      }
    }
    // Meta flag (not a blueprint_id — safe alongside numeric keys) so the client can
    // silently retry once the background warm finishes, same pattern as /api/true-cost's
    // prices_warm. Only relevant when a buildability check was actually requested.
    if (checkBuildable) out._meta = { canBuildDataWarm: pricesAvailable };
    res.json(out);
  } catch (err) {
    logger.error('❌ Blueprint profits error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── POST /api/material-stock-check (v1.33.3) ─────────────────────────────────
// Live per-material sell-order check for the RightSidebar's shortfall banner.
// Scoped ONLY to the materials a specific item is actually missing (typically
// under ~20), unlike the region-wide regionPriceCache which only stores a
// single best price with no depth. Body:
//   { materials: [{ materialId, needed }], regionId, walletISK }
// For each material: fetches live sell orders for JUST that type_id (cheap —
// filtered server-side by ESI, not a full-region page scan), sorts by price,
// and walks the book to find the real cost of buying `needed` units (accurate
// even when the cheapest single order doesn't cover the whole shortage).
//
// Verdict:
//   'ok'      — every material's shortage is covered by live stock, and the
//                real walked-book cost is within walletISK.
//   'mixed'   — one or more materials do NOT have enough stock to cover their
//                own shortage — named specifically so the client can qualify
//                the message rather than silently claim buildability.
//   'blocked' — stock covers everything, but the total cost exceeds walletISK.
app.post('/api/material-stock-check', security.apiLimiter, async (req, res) => {
  try {
    const { materials, regionId, walletISK } = req.body;
    if (!Array.isArray(materials) || materials.length === 0) {
      return res.json({ verdict: 'ok', totalCost: 0, wallet: walletISK || 0, materials: [] });
    }

    const region = VALID_REGIONS.includes(parseInt(regionId)) ? parseInt(regionId) : 10000002;
    const wallet = typeof walletISK === 'number' ? walletISK : 0;
    // Defensive cap — no blueprint in the SDE has anywhere near this many distinct materials
    const limited = materials.slice(0, 40);

    // Answered from the same cached order depth the prices come from (the hub's own sell orders —
    // station-first for the empire hubs, the structure's orders for C-J6MT), so it agrees with the
    // price shown and needs no ESI calls. (It used to query region orders per item, which cannot
    // work for a player structure: every C-J6MT material came back "limited stock".)
    const rawHub  = getRawHubPrices(region);
    const rawJita = getRawJitaPrices();
    if (!rawJita && region !== 10000002) kickRegionWarm(10000002);
    if (!rawHub) {
      // cold cache — warm it in the background; the client asks again
      kickRegionWarm(region);
      return res.json({ pricesWarm: false });
    }
    const hubIsJita = region === 10000002;

    const results = limited.map((m) => {
      const materialId = parseInt(m.materialId);
      const needed = Math.max(0, Math.floor(m.needed) || 0);
      if (!materialId || needed <= 0) {
        return { materialId, needed: 0, availableQty: 0, orderCount: 0, cost: 0, covered: true, importQty: 0, importCost: 0, scope: 'hub' };
      }
      const sup = HP.describeSupply({ hubPrices: rawHub, jitaPrices: rawJita, typeId: materialId, hubIsJita,
                                      history: market.historyPriceMap.get(materialId) || 0 });
      const hubOnly = HP.priceFromSupply({ ...sup, jita: null, hubIsJita: true, history: 0 }, needed);   // the hub alone
      const full    = HP.priceFromSupply(sup, needed);                                                   // hub + Jita for the rest
      const availableQty = sup.hub ? (sup.hub.total === null ? needed : sup.hub.total) : 0;
      return {
        materialId, needed,
        availableQty,                                   // units the hub has for sale
        orderCount: 0,
        cost:       hubOnly.hubCost,                    // real cost of the units the hub can supply, walking its book
        covered:    availableQty >= needed,             // the hub alone can fill it
        importQty:  full.jitaQty + full.unfilledQty,    // units that have to come from Jita
        importCost: full.jitaCost + full.unfilledCost,
        scope:      full.scope,
        shortStock: full.shortStock,
      };
    });

    const thin      = results.filter(r => !r.covered);
    // Full cost of the purchase: what the hub supplies plus what is imported from Jita.
    const totalCost = results.reduce((s, r) => s + r.cost + r.importCost, 0);

    let verdict;
    if (thin.length > 0) verdict = 'mixed';
    else if (totalCost > wallet) verdict = 'blocked';
    else verdict = 'ok';

    res.json({ verdict, totalCost, wallet, materials: results, pricesWarm: true });
  } catch (err) {
    logger.error('❌ Material stock check error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── Item Appraisal ───────────────────────────────────────────────────────────
// Returns per-item sell/buy prices from the live hub book.
// Items can arrive with typeId (from Assets selection) or name-only (paste).
// Name-based lookups do a linear scan of globalItemNameMap (~90k items, fast enough
// for the small lists (≤200) an appraisal request will ever contain).
app.post('/api/appraise', security.apiLimiter, (req, res) => {
  try {
    const { items, regionId } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' });
    }
    const rid = parseInt(regionId, 10);
    if (!rid) return res.status(400).json({ error: 'regionId required' });

    const hubId = REGION_TO_HUB[rid];
    if (!hubId) return res.status(400).json({ error: `Unknown regionId: ${rid}` });

    const book = hubBooks[hubId];
    if (!book || book.size === 0) {
      return res.status(503).json({ error: 'Hub price data not yet available — try again in a few seconds' });
    }

    const hub = HUB_CONFIG[hubId];
    const limited = items.slice(0, 200);
    const result = [];
    let totalSell = 0, totalBuy = 0;

    for (const raw of limited) {
      let typeId = parseInt(raw.typeId, 10) || 0;
      const qty = Math.max(1, parseInt(raw.qty, 10) || 1);
      const suppliedName = typeof raw.name === 'string' ? raw.name.trim() : '';

      // Resolve name → typeId for paste items (O(1) reverse-map lookup)
      if (!typeId && suppliedName) {
        typeId = market.globalNameToTypeId.get(suppliedName.toLowerCase()) || 0;
      }

      const name = (typeId && market.globalItemNameMap.get(typeId)) || suppliedName || `#${typeId}`;
      const entry = typeId ? book.get(typeId) : null;
      const sell = entry?.sell ?? 0;
      const buy  = entry?.buy  ?? 0;

      result.push({ typeId: typeId || 0, name, qty, sell, buy, sellTotal: sell * qty, buyTotal: buy * qty });
      totalSell += sell * qty;
      totalBuy  += buy  * qty;
    }

    res.json({ items: result, totalSell, totalBuy, hubName: hub.name, hubId });
  } catch (err) {
    logger.error('❌ Appraise error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// SESSION DATA CACHING

// ── Blueprint icon pre-warmer ─────────────────────────────────────────────────
// Called fire-and-forget after /api/session-data caches blueprints.
// Fetches bp/bpc variant icons from CCP's CDN and saves them to the icon-cache
// directory so the first visit to the Blueprints tab serves from disk (~0ms)
// instead of hammering CCP in parallel for every blueprint at once.
{
  const fs            = require('fs');
  const ICON_CACHE    = path.join(__dirname, 'icon-cache');
  const CCP_CDN_ICONS = 'https://images.evetech.net';
  fs.mkdirSync(ICON_CACHE, { recursive: true });

  // Fetch one icon; resolve regardless of success so pool continues.
  async function fetchOneIcon(typeId, variant) {
    const filename  = `${typeId}_32_${variant}.png`;
    const cachePath = path.join(ICON_CACHE, filename);
    if (fs.existsSync(cachePath)) return; // already cached
    try {
      const ctrl    = new AbortController();
      const timer   = setTimeout(() => ctrl.abort(), 8000);
      const res     = await fetch(`${CCP_CDN_ICONS}/types/${typeId}/${variant}?size=32`, {
        signal:  ctrl.signal,
        headers: { 'User-Agent': 'FORGE Manufacturing Intelligence / forge-ukc.com' },
      });
      clearTimeout(timer);
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFile(cachePath, buf, () => {});
    } catch (_) { /* timeout or network — skip silently */ }
  }

  // Warm icons for all unique blueprint typeIds, both bp and bpc variants.
  // Concurrency-limited to 16 parallel fetches — high enough to clear a large
  // blueprint collection quickly, low enough to stay polite to CCP's CDN.
  global.warmBlueprintIcons = async function warmBlueprintIcons(blueprints) {
    if (!Array.isArray(blueprints) || blueprints.length === 0) return;
    const typeIds = [...new Set(blueprints.map(b => b.type_id).filter(Boolean))];
    const CONCURRENCY = 16;
    // Build work list: prefer the correct variant per typeId but always warm both
    // since the Blueprints tab can show BPO and BPC copies of the same typeId.
    const tasks = typeIds.flatMap(id => [
      () => fetchOneIcon(id, 'bp'),
      () => fetchOneIcon(id, 'bpc'),
    ]);
    // Run in fixed-size sliding window
    let i = 0;
    async function worker() {
      while (i < tasks.length) {
        const task = tasks[i++];
        await task();
      }
    }
    const pool = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker);
    await Promise.all(pool);
    logger.info(`[icon-warm] Warmed ${typeIds.length} blueprint types (${tasks.length} variants)`);
  };
}

// Lets the frontend kick off blueprint icon warming as soon as the ESI blueprints
// fetch resolves (early in login), instead of waiting for the full /api/session-data
// POST at the end of login. Responds immediately; warming continues fire-and-forget.
// This closes the race where a user opens the Blueprints tab before icons are cached.
app.post('/api/warm-blueprint-icons', security.apiLimiter, security.verifyEveToken, (req, res) => {
  const { blueprints } = req.body;
  res.json({ ok: true });
  global.warmBlueprintIcons(blueprints).catch(() => {});
});


// PRE-COMPUTATION ENGINE (v0.9.0)
// Calculates profitability for ALL blueprints, stores in DB
// Replaces real-time AI calculations for common queries

// ── DB transaction mutex ──────────────────────────────────────────────────────
// SQLite rejects concurrent BEGIN TRANSACTION calls with
// "cannot start a transaction within a transaction".
// All background jobs must acquire this lock before BEGIN and release after
// COMMIT/ROLLBACK. SELECT reads are unaffected — no lock needed for reads.
class DbTxMutex {
  constructor() { this._locked = false; this._queue = []; }
  lock() {
    if (!this._locked) { this._locked = true; return Promise.resolve(); }
    return new Promise(resolve => this._queue.push(resolve));
  }
  unlock() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._locked = false;
    }
  }
}
const dbTxMutex = new DbTxMutex();


// ── CONTRACT PRICE INGEST (v1.12.0) ──────────────────────────────────────────
// Builds a per-region price index from public single-item exchange contracts, so
// True Profit / the sidebar can price contract-only items (capitals, faction gear)
// that have no market sell orders. Runs weekly — contract-only stock is slow-moving.
//
// v1 scope: The Forge only (where ~all capital/BPC contracts live); single-item,
// non-BPC sell contracts only (BPC value depends on runs/ME, so it's excluded to
// avoid misleading flat medians — residual/bundle pricing is a future enhancement).

const CONTRACT_INGEST_REGION = 10000002; // The Forge (Jita)

function medianAsc(a) {
  const n = a.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function percentileAsc(a, p) {
  const n = a.length;
  if (!n) return 0;
  return a[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
}
// Run async `fn` over `items` with bounded concurrency (keeps ESI load polite).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx]); } catch (_) { /* tolerate per-item failure */ }
    }
  });
  await Promise.all(workers);
}

// Human, truthful rationale derived from the sample — no fabricated game events.
function contractRationale(row) {
  const { low, high, sample_count: n } = row;
  const spread = low > 0 ? (high - low) / low : 0;
  if (n <= 2) return `Only ${n} contract${n === 1 ? '' : 's'} listed in-region — thin market, treat this as indicative.`;
  if (spread > 1.5) return `${n} contracts with a wide spread — suggested near the low-median to actually move it.`;
  if (spread < 0.25) return `Tight cluster of ${n} contracts — confident price.`;
  return `${n} contracts listed — suggested near the median for a sale within roughly a week.`;
}

async function ingestRegionContracts(regionId = CONTRACT_INGEST_REGION) {
  if (jobState.contractIngestRunning) return { status: 'skipped', reason: 'already_running' };
  jobState.contractIngestRunning = true;
  const start = Date.now();
  try {
    // 1. Page all public contracts; keep item_exchange sells (price > 0).
    const contracts = [];
    let page = 1, pages = 1;
    do {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/contracts/public/${regionId}/?datasource=tranquility&page=${page}`
      );
      if (!res.ok) break;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const c of data) {
        if (c.type === 'item_exchange' && c.price > 0) contracts.push(c);
      }
      pages = parseInt(res.headers.get('x-pages') || '1', 10);
      page++;
      await new Promise(r => setTimeout(r, 60));
    } while (page <= pages);

    logger.info(`⟳ Contract ingest ${regionId}: ${contracts.length} item_exchange sells across ${pages} pages`);

    // 2. Fetch items per contract (bounded concurrency). Keep single-item, non-BPC,
    //    no-swap sells; record unit price = contract price / quantity.
    const samples = new Map(); // type_id → [unitPrice, …]
    let processed = 0, singles = 0;
    await mapLimit(contracts, 20, async (c) => {
      processed++;
      const res = await esiFetch(
        `https://esi.evetech.net/latest/contracts/public/items/${c.contract_id}/?datasource=tranquility`
      );
      if (!res.ok) return; // 404 = contract expired between calls
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) return;
      if (items.some(it => !it.is_included)) return; // a swap (wants items back) — skip
      const incl = items.filter(it => it.is_included);
      if (incl.length !== 1) return;                 // bundle — skip in v1
      const it = incl[0];
      if (it.is_blueprint_copy) return;              // BPC value depends on runs/ME — skip
      const qty = it.quantity > 0 ? it.quantity : 1;
      const unit = c.price / qty;
      if (!isFinite(unit) || unit <= 0) return;
      if (!samples.has(it.type_id)) samples.set(it.type_id, []);
      samples.get(it.type_id).push(unit);
      singles++;
    });

    // 3. Aggregate (outlier-filtered) and upsert — clean slate for the region.
    await dbRun('DELETE FROM contract_prices WHERE region_id = ?', [regionId]);
    const now = new Date().toISOString();
    let written = 0;
    await dbTxMutex.lock();
    try {
      await dbRun('BEGIN TRANSACTION');
      for (const [typeId, prices] of samples) {
        const sorted = prices.slice().sort((a, b) => a - b);
        const med0 = medianAsc(sorted);
        // Drop obvious scams / mispriced bundles: keep within [0.3×, 4×] of the median.
        const filtered = sorted.filter(p => p >= med0 * 0.3 && p <= med0 * 4);
        if (filtered.length === 0) continue;
        const low  = filtered[0];
        const high = filtered[filtered.length - 1];
        const med  = medianAsc(filtered);
        const n    = filtered.length;
        const spread = low > 0 ? (high - low) / low : 0;
        // Wide + well-sampled → lean toward the 35th percentile (price to actually sell).
        const suggested = (n >= 5 && spread > 1.0) ? percentileAsc(filtered, 0.35) : med;
        await dbRun(
          `INSERT OR REPLACE INTO contract_prices
             (type_id, region_id, low, high, median, suggested, sample_count, source, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'single', ?)`,
          [typeId, regionId, low, high, med, suggested, n, now]
        );
        written++;
      }
      await dbRun('COMMIT');
    } catch (txErr) {
      await dbRun('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbTxMutex.unlock();
    }

    const secs = ((Date.now() - start) / 1000).toFixed(0);
    logger.info(`✓ Contract ingest ${regionId}: ${written} items priced from ${singles} single-item contracts (${processed} fetched) in ${secs}s`);
    return { status: 'completed', region_id: regionId, items_priced: written, single_contracts: singles, contracts_fetched: processed };
  } catch (err) {
    logger.error('Contract ingest error:', err.message);
    return { status: 'error', error: err.message };
  } finally {
    jobState.contractIngestRunning = false;
  }
}

async function runPreCompute() {
  if (jobState.preComputeRunning) {
    logger.info('⚠ Pre-compute already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  jobState.preComputeRunning = true;
  const startTime = Date.now();
  let runId;

  try {
    // Log the run — inside try so a DB failure here resets preComputeRunning via finally
    const run = await dbRun(
      `INSERT INTO precompute_runs (started_at, status) VALUES (datetime('now'), 'running')`
    );
    runId = run.lastID;
    logger.info('═══════════════════════════════════════════');
    logger.info('⟳ PRE-COMPUTE JOB STARTING');
    logger.info('═══════════════════════════════════════════');

    // Step 1: Load all blueprints and materials into memory once (shared across all regions)
    const allBlueprints = await dbAll(`
      SELECT b.blueprint_id, b.product_id, b.product_quantity, b.build_time,
             COALESCE(b.activity_id, 1) AS activity_id, i.name AS product_name
      FROM blueprints b
      LEFT JOIN items i ON i.type_id = b.product_id
    `);

    const allMaterials = await dbAll(`
      SELECT blueprint_id, material_id, quantity
      FROM blueprint_materials
    `);

    // Group materials by blueprint_id for O(1) lookup
    const materialsByBp = {};
    for (const mat of allMaterials) {
      if (!materialsByBp[mat.blueprint_id]) materialsByBp[mat.blueprint_id] = [];
      materialsByBp[mat.blueprint_id].push(mat);
    }

    // Build a product_id → blueprint_id map for recursive cost checks
    const bpByProduct = {};
    for (const bp of allBlueprints) {
      bpByProduct[bp.product_id] = bp.blueprint_id;
    }

    logger.info(`⟳ Processing ${allBlueprints.length} blueprints × ${VALID_REGIONS.length} regions...`);

    // Step 2: For each market region, fetch prices and compute profitability
    let totalProcessed = 0;
    const computedAt = new Date().toISOString();

    for (const regionId of VALID_REGIONS) {
      logger.info(`⟳ Region ${regionId}: fetching prices...`);

      let prices;
      try {
        prices = await fetchRegionPrices(regionId);
        setRegionPriceCache(regionId, prices);
        if (regionId === 10000002) {
          market.jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS; // keep compat accessor in sync
        } else {
          // Each hub is priced from its OWN sell orders; for types it has none of, Jita's live
          // lowest sell (tagged sellScope 'jita', stored as price_source 'jita_fallback').
          prices = HP.withJitaFallback(prices, getRawJitaPrices());
        }
      } catch (err) {
        logger.error(`⚠ Region ${regionId}: price fetch failed, skipping — ${err.message}`);
        continue;
      }

      await dbTxMutex.lock();
      let regionProcessed = 0;
      try {
      await dbRun('BEGIN TRANSACTION');

      for (const bp of allBlueprints) {
        const materials = materialsByBp[bp.blueprint_id] || [];
        let totalMatCost = 0;

        for (const mat of materials) {
          totalMatCost += calculateMaterialCostSync(
            mat.material_id, mat.quantity, prices, materialsByBp, bpByProduct
          );
        }

        // Sell price fallback: live sell → 30d avg → 0
        // Using avg30d when no live sell orders exist gives a realistic revenue estimate
        // rather than treating the item as worthless. The price_source column records
        // which fallback was used so the UI can flag it if needed.
        const liveSell   = prices[bp.product_id]?.sell || 0;
        const hist30d    = prices[bp.product_id]?.avg30d || 0;
        const sellPrice  = liveSell || hist30d || 0;
        const priceSource = liveSell > 0
          ? (prices[bp.product_id]?.sellScope === 'jita' ? 'jita_fallback'
              : (regionId === 10000002 ? 'jita' : `region_${regionId}`))
          : (hist30d > 0 ? 'history_30d' : 'no_data');
        const buyPrice  = prices[bp.product_id]?.buy  || 0;
        const productQuantity = bp.product_quantity || 1;
        const batchRevenue = sellPrice * productQuantity;
        const profit = batchRevenue - totalMatCost;
        const profitMargin = batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0;

        const buildTimeHours = (bp.build_time || 1) / 3600;
        const iskPerHour = buildTimeHours > 0 ? profit / buildTimeHours : 0;

        await dbRun(`
          INSERT INTO precomputed_profits
            (blueprint_id, region_id, product_id, product_name, material_cost, sell_price,
             buy_price, profit, profit_margin, isk_per_hour, build_time,
             material_count, computed_at, price_source, activity_id, avg_30d_price, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(blueprint_id, region_id) DO UPDATE SET
            product_id     = excluded.product_id,
            product_name   = excluded.product_name,
            material_cost  = excluded.material_cost,
            sell_price     = excluded.sell_price,
            buy_price      = excluded.buy_price,
            profit         = excluded.profit,
            profit_margin  = excluded.profit_margin,
            isk_per_hour   = excluded.isk_per_hour,
            build_time     = excluded.build_time,
            material_count = excluded.material_count,
            computed_at    = excluded.computed_at,
            price_source   = excluded.price_source,
            activity_id    = excluded.activity_id,
            avg_30d_price  = excluded.avg_30d_price,
            run_id         = excluded.run_id
        `, [
          bp.blueprint_id, regionId, bp.product_id, bp.product_name || null,
          totalMatCost, sellPrice, buyPrice, profit, profitMargin,
          iskPerHour, bp.build_time || 0, materials.length, computedAt,
          priceSource, bp.activity_id || 1, hist30d || null, runId
        ]);

        regionProcessed++;
      }

      await dbRun('COMMIT');
      } catch (txErr) {
        await dbRun('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dbTxMutex.unlock();
      }
      totalProcessed += regionProcessed;
      logger.info(`✓ Region ${regionId}: ${regionProcessed} blueprints processed`);
    }

    // Build cross-hub strategy table — but only if Jita data was successfully written.
    // A Jita ESI failure leaves zero rows with region_id=10000002 for this run_id; the
    // INNER JOIN would then produce zero rows and the stale-row DELETE would wipe everything.
    const jitaCount = await dbGet(
      'SELECT COUNT(*) AS cnt FROM precomputed_profits WHERE region_id = 10000002 AND run_id = ?',
      [runId]
    );
    if (!jitaCount || jitaCount.cnt === 0) {
      // No Jita data: clean stale profits (standalone — no strategies write to stay consistent with)
      await dbRun(`DELETE FROM precomputed_profits WHERE run_id IS NULL OR run_id != ?`, [runId]);
      logger.warn('⚠ Skipping strategies build — no Jita data this run (Jita ESI fetch may have failed). Existing strategies preserved.');
    } else {
    // Jita data OK: clean profits + rebuild strategies in one transaction so both tables
    // stay consistent — if the strategies INSERT throws, the profits DELETE rolls back too.
    logger.info('⟳ Building cross-hub strategy table...');
    await dbTxMutex.lock();
    try {
    await dbRun('BEGIN TRANSACTION');
    await dbRun(`DELETE FROM precomputed_profits WHERE run_id IS NULL OR run_id != ?`, [runId]);
    await dbRun(`
      INSERT OR REPLACE INTO precomputed_strategies
        (blueprint_id, sell_region_id, product_id, product_name, product_qty,
         sell_price, buy_price, build_time, avg_daily_volume,
         local_mat_cost, local_profit, local_margin, local_isk_per_hour,
         jita_mat_cost, jita_profit, jita_margin, jita_isk_per_hour,
         computed_at, run_id)
      WITH base AS (
        SELECT
          s.blueprint_id,
          s.region_id                                                          AS sell_region_id,
          s.product_id,
          s.product_name,
          s.sell_price,
          s.buy_price,
          s.build_time,
          s.avg_daily_volume,
          s.material_cost                                                      AS local_mat_cost,
          s.profit                                                             AS local_profit,
          s.profit_margin                                                      AS local_margin,
          s.isk_per_hour                                                       AS local_isk_per_hour,
          j.material_cost                                                      AS jita_mat_cost,
          s.computed_at,
          MAX(1, CAST(ROUND(
            (s.profit + s.material_cost) / NULLIF(s.sell_price, 0)
          ) AS INTEGER))                                                       AS product_qty
        FROM precomputed_profits s
        JOIN precomputed_profits j
          ON  j.blueprint_id = s.blueprint_id
          AND j.region_id    = 10000002
          AND j.run_id       = ?
        WHERE s.run_id = ?
          AND COALESCE(s.price_source, '') != 'jita_fallback'
      )
      SELECT
        blueprint_id,
        sell_region_id,
        product_id,
        product_name,
        product_qty,
        sell_price,
        buy_price,
        build_time,
        avg_daily_volume,
        local_mat_cost,
        local_profit,
        local_margin,
        local_isk_per_hour,
        jita_mat_cost,
        sell_price * product_qty - jita_mat_cost                              AS jita_profit,
        CASE WHEN sell_price * product_qty > 0
          THEN (sell_price * product_qty - jita_mat_cost)
               / (sell_price * product_qty) * 100
          ELSE 0 END                                                           AS jita_margin,
        CASE WHEN build_time > 0
          THEN (sell_price * product_qty - jita_mat_cost) / (build_time / 3600.0)
          ELSE 0 END                                                           AS jita_isk_per_hour,
        computed_at,
        ?                                                                      AS run_id
      FROM base
    `, [runId, runId, runId]);
    await dbRun(`DELETE FROM precomputed_strategies WHERE run_id IS NULL OR run_id != ?`, [runId]);
    await dbRun('COMMIT');
    } catch (txErr) {
      await dbRun('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbTxMutex.unlock();
    }
    logger.info('✓ Cross-hub strategy table built');
    } // end Jita-guard block

    // Volume / liquidity labels follow each row's current price source, so refresh them whenever the rows were rewritten
    // (the scheduled run also chains the Jita volume enrichment afterwards, which does the same).
    try { await applyRegionVolumeAndLiquidity(); }
    catch (e) { logger.error('⚠ Hub volume/liquidity pass failed:', e.message); }

    const durationSec = (Date.now() - startTime) / 1000;

    // Update run record
    await dbRun(`
      UPDATE precompute_runs
      SET completed_at = datetime('now'),
          blueprints_processed = ?,
          duration_seconds = ?,
          status = 'completed'
      WHERE id = ?
    `, [totalProcessed, durationSec, runId]);

    logger.info('═══════════════════════════════════════════');
    logger.info(`✓ PRE-COMPUTE COMPLETE`);
    logger.info(`  Blueprints × Regions: ${totalProcessed}`);
    logger.info(`  Duration: ${durationSec.toFixed(1)}s`);
    logger.info('═══════════════════════════════════════════');

    return { status: 'completed', processed: totalProcessed, durationSec };

  } catch (err) {
    // Rollback on failure
    try { await dbRun('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }

    if (runId) {
      await dbRun(`
        UPDATE precompute_runs
        SET completed_at = datetime('now'),
            status = 'failed',
            error = ?
        WHERE id = ?
      `, [err.message, runId]);
    }

    logger.error('❌ Pre-compute failed:', err.message);
    return { status: 'failed', error: err.message };
  } finally {
    jobState.preComputeRunning = false;
  }
}

/**
 * Best available market price for a type from a region prices map.
 * Priority: sell (lowest ask) → buy (highest bid) → 30-day avg → 0.
 *
 * This is the single source of truth for price resolution across:
 *   • material cost calculation (calculateMaterialCostSync)
 *   • sell revenue estimation (precompute job)
 * Never read prices[id].buy directly — always call resolvePrice().
 */
function resolvePrice(prices, typeId) {
  return prices[typeId]?.sell || prices[typeId]?.buy || prices[typeId]?.avg30d || 0;
}

// Synchronous material cost calculation using in-memory data.
// Avoids per-item DB queries during pre-compute (performance critical).
//
// IMPORTANT: always use the SELL price (lowest ask) for material costs.
// The sell price is what you pay to buy materials immediately from sell orders.
// The buy price (highest bid) is what you receive when selling — irrelevant here.
// Using buy prices understates material costs for wide-spread items (e.g. capital
// components), making the precomputed profit wildly optimistic.
//
// Price fallback chain: sell → buy → avg30d → 0 (via resolvePrice)
function calculateMaterialCostSync(materialId, quantity, prices, materialsByBp, bpByProduct, depth = 0) {
  // Prevent infinite recursion on circular blueprint references
  if (depth > 10) return resolvePrice(prices, materialId) * quantity;

  const subBpId = bpByProduct[materialId];
  if (subBpId) {
    // This material can be manufactured. Compute raw-material cost for 1 sub-run,
    // then compare against buying it outright — take whichever is cheaper.
    const subMats = materialsByBp[subBpId] || [];
    let mfgCostPerRun = 0;
    for (const sub of subMats) {
      mfgCostPerRun += calculateMaterialCostSync(
        sub.material_id, sub.quantity, prices, materialsByBp, bpByProduct, depth + 1
      );
    }
    // Cost to buy `quantity` units from market vs cost to manufacture
    const buyCost = resolvePrice(prices, materialId) * quantity;
    const mfgCost = mfgCostPerRun * quantity;
    return Math.min(mfgCost, buyCost);
  }

  return resolvePrice(prices, materialId) * quantity;
}

// VOLUME ENRICHMENT JOB (v0.9.1)
// Fetches market history + market_group_id for top profitable items
// Runs incrementally to respect ESI rate limits


/**
 * 4-tier liquidity classification for one row, from THAT row's own prices and volume.
 * (Previously computed from the Jita row and copied to every hub, so a hub's label described
 * Jita's spread and Jita's volume.)
 */
function classifyLiquidity({ marketGroupId, sellPrice, materialCost, buyPrice, avgVolume }) {
  // TIER 1: Contract-only items (cannot be sold on market)
  if (marketGroupId === null) return 'contract_only';
  // TIER 2: Margin cap (500% maximum - anything beyond is likely scam/phantom)
  if (materialCost > 0 && (sellPrice / materialCost) > 5.0) return 'extreme_margin';
  // TIER 3: Volume requirements (tiered by price)
  if (sellPrice < 100000000 && avgVolume < 10) return 'low_volume';                              // <100M ISK needs 10+ units/day
  if (sellPrice >= 100000000 && sellPrice < 1000000000 && avgVolume < 5) return 'low_volume';   // 100M-1B ISK needs 5+ units/day
  if (sellPrice >= 1000000000 && avgVolume < 2) return 'low_volume';                            // >1B ISK needs 2+ units/day
  // TIER 4: Spread sanity check
  if (buyPrice === 0 && sellPrice > 10000000) return 'no_buy_orders';                            // >10M ISK with no buy orders = suspicious
  if (materialCost > 0 && ((sellPrice - materialCost) / sellPrice) > 0.9) return 'suspicious_spread';  // >90% spread is unusual
  return null;
}

/**
 * Every non-Jita hub row gets ITS OWN daily volume (hub_history_prices: ESI history for the
 * empire hubs, FORGE's quantity-drop estimate for C-J6MT) and a liquidity label computed from its
 * own prices. Only where the hub has no volume data does Jita's volume appear, tagged
 * volume_source = 'jita' so the UI says so. Rows priced at Jita (the hub lists none) use Jita's
 * volume and Jita's bids, because that is where the sale would happen.
 */
async function applyRegionVolumeAndLiquidity() {
  const jitaRows = await dbAll(
    `SELECT product_id, avg_daily_volume, market_group_id, buy_price
       FROM precomputed_profits WHERE region_id = 10000002`
  );
  const jitaBy = new Map(jitaRows.map(r => [r.product_id, r]));
  let updated = 0;

  for (const regionId of VALID_REGIONS) {
    if (regionId === 10000002) continue;
    const volRows = await dbAll(
      'SELECT type_id, avg_30d_volume FROM hub_history_prices WHERE region_id = ? AND avg_30d_volume > 0', [regionId]
    );
    const hubVol = new Map(volRows.map(r => [r.type_id, r.avg_30d_volume]));
    const rows = await dbAll(
      `SELECT blueprint_id, product_id, sell_price, buy_price, material_cost, price_source
         FROM precomputed_profits WHERE region_id = ?`, [regionId]
    );

    await dbTxMutex.lock();
    try {
      await dbRun('BEGIN TRANSACTION');
      for (const r of rows) {
        const j = jitaBy.get(r.product_id);
        const soldAtJita = r.price_source === 'jita_fallback';
        const hv  = soldAtJita ? null : hubVol.get(r.product_id);
        // Jita not enriched yet for this product: its market group (marketable or not) is unknown, so no
        // liquidity label — but this hub's OWN volume is still worth recording.
        if (!j || j.avg_daily_volume == null) {
          if (hv != null) {
            await dbRun(
              `UPDATE precomputed_profits SET avg_daily_volume = ?, volume_source = 'hub' WHERE blueprint_id = ? AND region_id = ?`,
              [hv, r.blueprint_id, regionId]
            );
            updated++;
          }
          continue;
        }
        const vol = hv != null ? hv : j.avg_daily_volume;
        const src = hv != null ? 'hub' : 'jita';
        const liq = classifyLiquidity({
          marketGroupId: j.market_group_id ?? null,
          sellPrice: r.sell_price, materialCost: r.material_cost,
          buyPrice: soldAtJita ? (j.buy_price || 0) : (r.buy_price || 0),
          avgVolume: vol || 0,
        });
        await dbRun(
          `UPDATE precomputed_profits
              SET avg_daily_volume = ?, market_group_id = ?, liquidity_risk = ?, volume_source = ?
            WHERE blueprint_id = ? AND region_id = ?`,
          [vol, j.market_group_id ?? null, liq, src, r.blueprint_id, regionId]
        );
        updated++;
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      dbTxMutex.unlock();
    }
  }
  return updated;
}

async function runVolumeEnrichment() {
  if (jobState.volumeEnrichmentRunning) {
    logger.info('⚠ Volume enrichment already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  jobState.volumeEnrichmentRunning = true;
  const startTime = Date.now();

  try {
    logger.info('═══════════════════════════════════════════');
    logger.info('⟳ VOLUME ENRICHMENT STARTING');
    logger.info('═══════════════════════════════════════════');

    const JITA_REGION = 10000002;
    
    // Get top items from Jita that don't have volume data yet (or need refresh).
    // Volume history comes from Jita ESI — enrich Jita rows, then copy to other regions.
    const itemsToEnrich = await dbAll(`
      SELECT product_id, product_name, sell_price, buy_price, material_cost
      FROM precomputed_profits
      WHERE region_id = 10000002
        AND profit > 0 AND sell_price > 0
        AND (avg_daily_volume IS NULL OR avg_daily_volume = 0)
      ORDER BY profit DESC
      LIMIT 2000
    `);

    if (itemsToEnrich.length === 0) {
      logger.info('✓ No items need enrichment');
      // Prices moved since the last run, so every hub's own volume/liquidity labels are refreshed anyway.
      try { await applyRegionVolumeAndLiquidity(); } catch (e) { logger.error('⚠ Hub volume/liquidity pass failed:', e.message); }
      jobState.volumeEnrichmentRunning = false;
      return { status: 'completed', enriched: 0, message: 'All items already enriched' };
    }

    logger.info(`⟳ Enriching ${itemsToEnrich.length} items...`);

    let enriched = 0;
    let errors = 0;
    let contractOnlyCount = 0;
    let extremeMarginCount = 0;
    let lowVolumeCount = 0;
    let suspiciousSpreadCount = 0;
    let noBuyOrdersCount = 0;

    for (const item of itemsToEnrich) {
      try {
        // Fetch market history for volume data AND 30-day average price
        const historyRes = await esiFetch(
          `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${item.product_id}`
        );

        let avgVolume = 0;
        let avg30dPrice = 0;
        let sampleDays = 0;
        if (historyRes.ok) {
          const history = await historyRes.json();
          if (Array.isArray(history) && history.length > 0) {
            // Calculate 30-day average (or less if not enough data)
            const recentHistory = history.slice(-30);
            sampleDays = recentHistory.length;
            const totalVolume = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
            avgVolume = sampleDays > 0 ? totalVolume / sampleDays : 0;
            // 30-day average of the daily trade-weighted average price
            // ESI 'average' = volume-weighted mean of actual transactions for that day
            const totalPrice = recentHistory.reduce((sum, day) => sum + (day.average || 0), 0);
            avg30dPrice = sampleDays > 0 ? totalPrice / sampleDays : 0;
          }
        }

        // Persist historical average price so the precompute job can use it as a fallback
        if (avg30dPrice > 0) {
          await dbRun(`
            INSERT INTO item_history_prices (type_id, avg_30d_price, avg_30d_volume, sample_days, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(type_id) DO UPDATE SET
              avg_30d_price  = excluded.avg_30d_price,
              avg_30d_volume = excluded.avg_30d_volume,
              sample_days    = excluded.sample_days,
              updated_at     = excluded.updated_at
          `, [item.product_id, avg30dPrice, avgVolume, sampleDays]);

          // Also stamp it on the precomputed_profits row for display/audit
          await dbRun(`
            UPDATE precomputed_profits
            SET avg_30d_price = ?
            WHERE product_id = ? AND region_id = 10000002
          `, [avg30dPrice, item.product_id]);
        }

        // Fetch market_group_id to detect non-marketable items
        const typeRes = await esiFetch(
          `https://esi.evetech.net/latest/universe/types/${item.product_id}/?datasource=tranquility`
        );

        let marketGroupId = null;
        if (typeRes.ok) {
          const typeData = await typeRes.json();
          marketGroupId = typeData.market_group_id || null;
        }

        // Determine liquidity risk using 4-tier system
        const liquidityRisk = classifyLiquidity({
          marketGroupId, sellPrice: item.sell_price, materialCost: item.material_cost,
          buyPrice: item.buy_price, avgVolume,
        });

        // Update Jita row only — copy to other regions after the loop
        await dbRun(`
          UPDATE precomputed_profits
          SET avg_daily_volume = ?,
              market_group_id = ?,
              liquidity_risk = ?
          WHERE product_id = ? AND region_id = 10000002
        `, [avgVolume, marketGroupId, liquidityRisk, item.product_id]);

        enriched++;

        // Count risk types (summary logging)
        if (liquidityRisk === 'contract_only') contractOnlyCount++;
        else if (liquidityRisk === 'extreme_margin') extremeMarginCount++;
        else if (liquidityRisk === 'low_volume') lowVolumeCount++;
        else if (liquidityRisk === 'no_buy_orders') noBuyOrdersCount++;
        else if (liquidityRisk === 'suspicious_spread') suspiciousSpreadCount++;

        // ESI rate limit: 150 requests/sec burst, sustained ~20/sec
        // Conservative: 1 request per 100ms = 10/sec sustained
        await new Promise(r => setTimeout(r, 100));

      } catch (err) {
        logger.error(`  ✗ Error enriching ${item.product_name}:`, err.message);
        errors++;
      }
    }

    // Second pass: items with sell_price = 0 that were excluded from the main loop.
    // These need historical averages most urgently — without them they appear as
    // "no revenue, infinite loss" which is misleading when there IS trade history.
    const zeroSellItems = await dbAll(`
      SELECT DISTINCT pp.product_id, pp.product_name
      FROM precomputed_profits pp
      WHERE pp.region_id = 10000002
        AND pp.sell_price = 0
        AND NOT EXISTS (
          SELECT 1 FROM item_history_prices ihp WHERE ihp.type_id = pp.product_id
        )
      LIMIT 300
    `);

    if (zeroSellItems.length > 0) {
      logger.info(`⟳ Fetching history for ${zeroSellItems.length} zero-sell-price items...`);
      for (const item of zeroSellItems) {
        try {
          const histRes = await esiFetch(
            `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${item.product_id}`
          );
          if (histRes.ok) {
            const history = await histRes.json();
            if (Array.isArray(history) && history.length > 0) {
              const recent = history.slice(-30);
              const sampleDays = recent.length;
              const avgVol = recent.reduce((s, d) => s + (d.volume || 0), 0) / sampleDays;
              const avgPrice = recent.reduce((s, d) => s + (d.average || 0), 0) / sampleDays;
              if (avgPrice > 0) {
                await dbRun(`
                  INSERT INTO item_history_prices (type_id, avg_30d_price, avg_30d_volume, sample_days, updated_at)
                  VALUES (?, ?, ?, ?, datetime('now'))
                  ON CONFLICT(type_id) DO UPDATE SET
                    avg_30d_price  = excluded.avg_30d_price,
                    avg_30d_volume = excluded.avg_30d_volume,
                    sample_days    = excluded.sample_days,
                    updated_at     = excluded.updated_at
                `, [item.product_id, avgPrice, avgVol, sampleDays]);

                // Also update precomputed_profits rows directly so this cycle's
                // data is correct immediately — without this, items stay hidden
                // (sell_price = 0, filtered out) until the next precompute cycle
                // runs (up to 6 hours away). Update all regions — historical price
                // is hub-agnostic (we only have Jita history but it's the best proxy).
                await dbRun(`
                  UPDATE precomputed_profits
                  SET sell_price    = ?,
                      profit        = ? - material_cost,
                      profit_margin = CASE WHEN ? > 0
                                       THEN (? - material_cost) / ? * 100
                                       ELSE 0 END,
                      isk_per_hour  = CASE WHEN build_time > 0
                                       THEN (? - material_cost) / (build_time / 3600.0)
                                       ELSE 0 END,
                      price_source  = 'history_30d',
                      avg_30d_price = ?
                  WHERE product_id = ? AND sell_price = 0
                `, [
                  avgPrice,
                  avgPrice, avgPrice, avgPrice, avgPrice, avgPrice,
                  avgPrice,
                  item.product_id
                ]);
              }
            }
          }
          await new Promise(r => setTimeout(r, 100));
        } catch (err) {
          logger.error(`  ✗ Zero-sell history fetch failed for ${item.product_name}:`, err.message);
        }
      }
      logger.info('✓ Zero-sell-price history pass complete');
    }

    // Reload the in-memory map so the next precompute run benefits immediately
    await loadHistoryPriceMap();

    // Per-hub volume + liquidity (own data first, Jita's only where a hub has none — tagged).
    try {
      const n = await applyRegionVolumeAndLiquidity();
      logger.info(`✓ Hub volume/liquidity applied to ${n} rows`);
    } catch (e) {
      logger.error('⚠ Hub volume/liquidity pass failed:', e.message);
    }

    const durationSec = (Date.now() - startTime) / 1000;

    logger.info('═══════════════════════════════════════════');
    logger.info(`✓ VOLUME ENRICHMENT COMPLETE`);
    logger.info(`  Enriched: ${enriched} items`);
    logger.info(`  Errors: ${errors}`);
    logger.info(`  Filtered: ${contractOnlyCount + extremeMarginCount + lowVolumeCount + suspiciousSpreadCount + noBuyOrdersCount} total`);
    logger.info(`    - Contract-only: ${contractOnlyCount}`);
    logger.info(`    - Extreme margin (>500%): ${extremeMarginCount}`);
    logger.info(`    - Low volume: ${lowVolumeCount}`);
    logger.info(`    - No buy orders: ${noBuyOrdersCount}`);
    logger.info(`    - Suspicious spread: ${suspiciousSpreadCount}`);
    logger.info(`  Duration: ${durationSec.toFixed(1)}s`);
    logger.info('═══════════════════════════════════════════');

    jobState.volumeEnrichmentRunning = false;
    return { status: 'completed', enriched, errors, durationSec };

  } catch (err) {
    logger.error('❌ Volume enrichment failed:', err.message);
    jobState.volumeEnrichmentRunning = false;
    return { status: 'failed', error: err.message };
  }
}

// PRE-COMPUTED PROFITABILITY API (v0.9.0)
// Serves data from DB — zero AI tokens
async function fetchTopProfitableResults({ isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, limit }) {
  const { sql, params } = buildTopProfitableQuery({ isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, limit });
  return dbAll(sql, params);
}

async function fetchTopProfitableMeta({ regionId }) {
  const lastRun = await dbGet(`
    SELECT completed_at, blueprints_processed, duration_seconds, status
    FROM precompute_runs
    ORDER BY id DESC LIMIT 1
  `);

  // Count items by risk category (4-tier system)
  const riskCounts = await dbGet(`
    SELECT
      COUNT(CASE WHEN liquidity_risk IS NULL OR liquidity_risk = '' THEN 1 END) as safe,
      COUNT(CASE WHEN liquidity_risk = 'contract_only' THEN 1 END) as tier1_contract_only,
      COUNT(CASE WHEN liquidity_risk = 'extreme_margin' THEN 1 END) as tier2_extreme_margin,
      COUNT(CASE WHEN liquidity_risk = 'low_volume' THEN 1 END) as tier3_low_volume,
      COUNT(CASE WHEN liquidity_risk = 'no_buy_orders' THEN 1 END) as tier4_no_buy_orders,
      COUNT(CASE WHEN liquidity_risk = 'suspicious_spread' THEN 1 END) as tier4_suspicious_spread
    FROM precomputed_profits WHERE profit > 0 AND region_id = ?
  `, [regionId]);

  return { lastRun, riskCounts };
}

app.get('/api/top-profitable', security.apiLimiter, async (req, res) => {
  try {
    const sort        = req.query.sort || 'profit';
    const limit       = Math.min(parseInt(req.query.limit) || 20, 100);
    const minProfit   = parseFloat(req.query.minProfit) || 0;
    // parseFloat(undefined) returns NaN; NaN !== undefined is always true, so the
    // ternary must check the raw query string, not the parsed float.
    const minVolume   = req.query.minVolume !== undefined ? parseFloat(req.query.minVolume) : 5;
    const includeRisky = req.query.includeRisky === 'true';

    // Sell hub — where finished goods are listed for sale
    const regionId = VALID_REGIONS.includes(parseInt(req.query.regionId))
      ? parseInt(req.query.regionId) : 10000002;

    // Source hub — where raw materials are purchased.
    // Defaults to the sell hub when not supplied (preserves existing behaviour).
    const sourceRegionId = VALID_REGIONS.includes(parseInt(req.query.sourceRegionId))
      ? parseInt(req.query.sourceRegionId) : regionId;

    const isCrossHub = sourceRegionId !== regionId;

    // Validate sort column to prevent SQL injection
    const allowedSorts = {
      profit:      'profit DESC',
      margin:      'profit_margin DESC',
      isk_per_hour:'isk_per_hour DESC',
      cost:        'material_cost ASC',
      sell_price:  'sell_price DESC',
    };
    const orderClause = allowedSorts[sort] || allowedSorts.profit;

    const results = await fetchTopProfitableResults({
      isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, limit,
    });

    const { lastRun, riskCounts } = await fetchTopProfitableMeta({ regionId });

    res.json({
      results,
      meta: {
        count: results.length,
        sort,
        minProfit,
        minVolume,
        includeRisky,
        lastComputed: lastRun?.completed_at || null,
        lastRunStatus: lastRun?.status || 'never',
        riskBreakdown: riskCounts
      }
    });

  } catch (err) {
    logger.error('Top profitable error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// TOP PROFITABLE by Skills — filters top 50 by user's trained skills
// For Market Opportunities tab — shows only blueprints user can build
async function fetchUnfilteredTopProfitable({ isCrossHub, regionId, sourceRegionId, minProfit, limit, sort }) {
  // Same cross-hub-aware query as the skill-filtered list, without the skill filter.
  const { sql, params } = buildTopProfitableQuery({ isCrossHub, regionId, sourceRegionId, minProfit, limit });
  const fbResults = await dbAll(sql, params);

  const fbLastRun = await dbGet(`SELECT completed_at FROM precompute_runs ORDER BY id DESC LIMIT 1`);
  return {
    results: fbResults,
    meta: { count: fbResults.length, sort, filter: 'unfiltered_skills_unavailable',
            lastComputed: fbLastRun?.completed_at || null,
            sourceRegionId, sellRegionId: regionId },
  };
}

async function fetchTopProfitableCandidates({ isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, poolSize }) {
  const { sql, params } = buildTopProfitableQuery({ isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, limit: poolSize });
  return dbAll(sql, params);
}

// Bulk skill filter — loads skill requirements for ALL candidates in ONE query,
// then filters in-memory, keeping buildable items in profit order and applying offset/limit.
async function filterBuildableBySkills({ candidates, characterSkills, offset, limit }) {
  const bpIds = candidates.map(c => c.blueprint_id);
  const reqMap = new Map(); // blueprint_id → [{ skill_id, skill_level }]
  try {
    // Chunk the IN(...) to stay under SQLite's host-parameter limit (999 on older builds).
    const CHUNK = 900;
    for (let i = 0; i < bpIds.length; i += CHUNK) {
      const slice = bpIds.slice(i, i + CHUNK);
      const ph = slice.map(() => '?').join(',');
      const reqRows = await dbAll(
        `SELECT blueprint_id, skill_id, skill_level FROM blueprint_skills WHERE blueprint_id IN (${ph})`,
        slice
      );
      for (const r of reqRows) {
        const arr = reqMap.get(r.blueprint_id);
        if (arr) arr.push(r); else reqMap.set(r.blueprint_id, [r]);
      }
    }
  } catch (_) {
    // blueprint_skills table missing — leave reqMap empty → everything allowed through.
  }

  const skillMap = {};
  for (const s of characterSkills) skillMap[s.skill_id] = s.active_skill_level || 0;

  // A blueprint is buildable if every required skill is trained to the needed level.
  // No known requirements → allow through (matches canBuildBlueprint behaviour).
  const meetsSkillReqs = (bpId) => {
    const reqs = reqMap.get(bpId);
    if (!reqs || reqs.length === 0) return true;
    return reqs.every(r => (skillMap[r.skill_id] || 0) >= r.skill_level);
  };

  const results = [];
  let skipped = 0;
  for (const item of candidates) {
    if (!meetsSkillReqs(item.blueprint_id)) continue;
    if (skipped < offset) { skipped++; continue; }
    results.push(item);
    if (results.length >= limit) break;
  }
  return results;
}

// Adds haul_cost_per_unit / haul_isk_per_m3 / haul_volume_m3 to each result (Phase 2).
// Uses leg2 method + rate to estimate goods-out haul cost per unit of product.
// Requires packaged_volume populated by sde-import.js. Mutates results in place.
async function applyHaulCostPerUnit({ results, characterId, regionId }) {
  const haulSettings = await dbGet(
    'SELECT haul_enabled, leg2_method, leg2_haul_rate, leg2_isk_per_jump, leg2_flat_total, leg2_self_fuel, leg2_collateral, system_id FROM character_industry_settings WHERE character_id = ?',
    [characterId]
  );
  const haulActive = !!(haulSettings?.haul_enabled);
  if (!haulActive || results.length === 0) return;

  const productIds = [...new Set(results.map(r => r.product_id))];
  const ph = productIds.map(() => '?').join(',');
  const volRows = await dbAll(
    `SELECT type_id, packaged_volume FROM items WHERE type_id IN (${ph})`, productIds
  );
  const volMap = new Map(volRows.map(r => [r.type_id, r.packaged_volume || 0]));

  // Jump count for leg2 (mfg system → sell hub)
  const mfgSysId     = haulSettings?.system_id || 30000142;
  const sellHubSysId = HUB_SYSTEM_IDS[regionId] || HUB_SYSTEM_IDS[10000002];
  const leg2Jumps    = await getJumpCount(mfgSysId, sellHubSysId);

  const leg2Cfg = {
    method:       haulSettings?.leg2_method       || 'user_defined',
    rate:         haulSettings?.leg2_haul_rate     || 0,
    isk_per_jump: haulSettings?.leg2_isk_per_jump  || 0,
    flat_total:   haulSettings?.leg2_flat_total    || 0,
    self_fuel:    haulSettings?.leg2_self_fuel     || 0,
  };
  const leg2Col = haulSettings?.leg2_collateral || 0;

  // A row priced at Jita (its hub lists none) is sold at Jita, so its outbound freight runs there.
  const toJita = regionId !== 10000002 && results.some(r => r.price_source === 'jita_fallback');
  const leg2JumpsJita = toJita ? await getJumpCount(mfgSysId, HUB_SYSTEM_IDS[10000002]) : 0;

  for (const item of results) {
    const unitVol = volMap.get(item.product_id) || 0;
    const rowJumps = item.price_source === 'jita_fallback' && regionId !== 10000002 ? leg2JumpsJita : leg2Jumps;
    if (unitVol > 0 && rowJumps > 0) {
      const r = calcLegHaulCost(leg2Cfg, unitVol, rowJumps, leg2Col);
      item.haul_cost_per_unit = r.cost;
      item.haul_isk_per_m3    = r.effectiveIskPerM3;
      item.haul_volume_m3     = unitVol;
    } else {
      item.haul_cost_per_unit = 0;
      item.haul_isk_per_m3    = 0;
      item.haul_volume_m3     = unitVol;
    }
  }
}

app.get('/api/top-profitable-by-skills', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId  = req.characterId;
    const sort         = req.query.sort || 'profit';
    const limit        = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset       = Math.min(Math.max(parseInt(req.query.offset) || 0, 0), 100000);
    const minProfit    = parseFloat(req.query.minProfit) || 0;
    // parseFloat(undefined) returns NaN; NaN !== undefined is always true, so the
    // ternary must check the raw query string, not the parsed float.
    const minVolume    = req.query.minVolume !== undefined ? parseFloat(req.query.minVolume) : 5;
    const includeRisky = req.query.includeRisky === 'true';

    // Sell hub — where finished goods are listed for sale
    const regionId = VALID_REGIONS.includes(parseInt(req.query.regionId))
      ? parseInt(req.query.regionId) : 10000002;

    // Source hub — where raw materials are purchased.
    // Defaults to the sell hub when not supplied (preserves existing behaviour).
    const sourceRegionId = VALID_REGIONS.includes(parseInt(req.query.sourceRegionId))
      ? parseInt(req.query.sourceRegionId) : regionId;

    const isCrossHub = sourceRegionId !== regionId;

    // Get user's skills from session cache
    const sessionKey  = `session:${characterId}`;
    const sessionData = getCached(sessionKey);

    if (!sessionData || !sessionData.skills || sessionData.skills.length === 0) {
      logger.warn(`⚠ Skills not in session for character ${characterId} — returning unfiltered top-profitable`);
      const payload = await fetchUnfilteredTopProfitable({ isCrossHub, regionId, sourceRegionId, minProfit, limit, sort });
      return res.json(payload);
    }

    const characterSkills = sessionData.skills || [];

    // Validate sort column to prevent SQL injection
    const allowedSorts = {
      profit:       'profit DESC',
      margin:       'profit_margin DESC',
      isk_per_hour: 'isk_per_hour DESC',
      cost:         'material_cost ASC',
      sell_price:   'sell_price DESC',
    };
    const orderClause = allowedSorts[sort] || allowedSorts.profit;

    // Candidate pool size. New/low-skill characters can build only a small fraction
    // of the top-profit items, so we must scan DEEP enough to still find `limit`
    // buildable items (and not miss buildable T1 items ranked far down the profit
    // list). Bulk skill-filtering below keeps this cheap regardless of pool size.
    const poolSize = Math.min(Math.max((offset + limit) * 10, 1000), 5000);

    const candidates = await fetchTopProfitableCandidates({
      isCrossHub, regionId, sourceRegionId, minProfit, minVolume, includeRisky, orderClause, poolSize,
    });

    const results = await filterBuildableBySkills({ candidates, characterSkills, offset, limit });

    await applyHaulCostPerUnit({ results, characterId, regionId });

    logger.debug(`✓ Top ${results.length} profitable items (filtered by skills for character ${characterId})`);

    // Get last run info
    const lastRun = await dbGet(`
      SELECT completed_at, blueprints_processed, duration_seconds, status
      FROM precompute_runs
      ORDER BY id DESC LIMIT 1
    `);

    res.json({
      results,
      meta: {
        count:         results.length,
        sort,
        minProfit,
        minVolume,
        includeRisky,
        filter:        'by_skills',
        skillsLoaded:  characterSkills.length,
        lastComputed:  lastRun?.completed_at || null,
        lastRunStatus: lastRun?.status || 'never',
        offset,
        hasMore:       results.length >= limit,
        // Hub context — lets the client know which hubs produced these figures
        sellRegionId:   regionId,
        sourceRegionId: sourceRegionId,
        isCrossHub:     isCrossHub,
      },
    });

  } catch (err) {
    logger.error('Top profitable by skills error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// Search pre-computed data by item name
app.get('/api/search-profitable', security.apiLimiter, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const includeRisky = req.query.includeRisky === 'true';
    const rawRegion    = parseInt(req.query.regionId || '10000002', 10);
    const regionId     = VALID_REGIONS.includes(rawRegion) ? rawRegion : 10000002;

    // Sanitise: only allow alphanumeric, spaces, hyphens, apostrophes
    const sanitised = query.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50);

    // Build WHERE clause
    let whereConditions = ['region_id = ?', 'product_name LIKE ?'];
    const params = [regionId, `%${sanitised}%`];

    // Exclude CRITICAL risks only (not low_volume)
    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL
        OR liquidity_risk = ''
        OR liquidity_risk = 'low_volume'
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    const results = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk, price_source
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY profit DESC
      LIMIT 30
    `, params);

    res.json({ results, query: sanitised, regionId, includeRisky });

  } catch (err) {
    logger.error('Search profitable error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// Inter-hub arbitrage: items where buying sell orders at hub A and filling
// buy orders at hub B yields a net profit after sales tax.
// No auth required — all prices are pre-computed public data.
app.get('/api/inter-hub-arb', security.apiLimiter, async (req, res) => {
  try {
    const rawBuy  = parseInt(req.query.buyHub  || '10000002', 10);
    const rawSell = parseInt(req.query.sellHub || '10000043', 10);
    const buyHub  = VALID_REGIONS.includes(rawBuy)  ? rawBuy  : 10000002;
    const sellHub = VALID_REGIONS.includes(rawSell) ? rawSell : 10000043;

    if (buyHub === sellHub) {
      return res.status(400).json({ error: 'Buy hub and sell hub must be different' });
    }

    const minMargin = Math.max(0, parseFloat(req.query.minMargin || '5'));
    const limit     = Math.min(200, parseInt(req.query.limit || '100', 10));
    const offset    = Math.max(0, parseInt(req.query.offset || '0', 10));

    const allowedSorts = {
      est_daily_profit: 'est_daily_profit DESC NULLS LAST',
      net_profit:       'net_profit DESC',
      net_margin_pct:   'net_margin_pct DESC',
      isk_per_m3:       'isk_per_m3 DESC NULLS LAST',
      avg_daily_volume: 'avg_daily_volume DESC NULLS LAST',
    };
    const rawSort  = req.query.sortBy || 'est_daily_profit';
    const orderBy  = allowedSorts[rawSort] || allowedSorts.est_daily_profit;

    // 3.375% sales tax at Accounting V: 1 − 0.075×(1−0.11×5) = 0.96625 (was a
    // hand-typed 0.964/3.6% that didn't match calcSalesFeeRates — fixed 17 Sept
    // 2026). Broker fee not included — user fills existing buy orders.
    const TAX = 0.96625;

    const rows = await dbAll(`
      SELECT
        p1.product_id,
        p1.product_name,
        p1.region_id                          AS buy_region_id,
        p2.region_id                          AS sell_region_id,
        MIN(p1.sell_price)                    AS buy_at,
        MAX(p2.buy_price)                     AS sell_into,
        MAX(p2.buy_price) - MIN(p1.sell_price)          AS gross_spread,
        (MAX(p2.buy_price) - MIN(p1.sell_price)) / MIN(p1.sell_price) * 100  AS gross_margin_pct,
        MAX(p2.buy_price) * ${TAX} - MIN(p1.sell_price) AS net_profit,
        (MAX(p2.buy_price) * ${TAX} - MIN(p1.sell_price)) / MIN(p1.sell_price) * 100 AS net_margin_pct,
        COALESCE(i.packaged_volume, 0)         AS volume_m3,
        CASE WHEN COALESCE(i.packaged_volume, 0) > 0
          THEN (MAX(p2.buy_price) * ${TAX} - MIN(p1.sell_price)) / i.packaged_volume
          ELSE NULL END                        AS isk_per_m3,
        COALESCE(MAX(p1.avg_daily_volume), MAX(p2.avg_daily_volume)) AS avg_daily_volume,
        CASE WHEN COALESCE(MAX(p1.avg_daily_volume), MAX(p2.avg_daily_volume)) IS NOT NULL
          THEN COALESCE(MAX(p1.avg_daily_volume), MAX(p2.avg_daily_volume))
               * (MAX(p2.buy_price) * ${TAX} - MIN(p1.sell_price))
          ELSE NULL END                        AS est_daily_profit
      FROM precomputed_profits p1
      JOIN precomputed_profits p2
        ON p1.product_id = p2.product_id
       AND p1.region_id  = ?
       AND p2.region_id  = ?
      LEFT JOIN items i ON i.type_id = p1.product_id
      WHERE p1.sell_price > 0
        AND COALESCE(p1.price_source, '') != 'jita_fallback'   -- a Jita price standing in for a hub with no stock isn't an arbitrage source
        AND p2.buy_price  > 0
        AND (p2.buy_price * ${TAX} - p1.sell_price) / p1.sell_price * 100 >= ?
      GROUP BY p1.product_id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [buyHub, sellHub, minMargin, limit, offset]);

    const buyHubName  = REGIONS[buyHub]?.hub  || `Region ${buyHub}`;
    const sellHubName = REGIONS[sellHub]?.hub || `Region ${sellHub}`;

    // Build regionId → hubId reverse map for live order-book lookup
    const regionToHubId = {};
    for (const [hubId, cfg] of Object.entries(HUB_CONFIG)) {
      regionToHubId[cfg.regionId] = hubId;
    }
    const buyHubId  = regionToHubId[buyHub];
    const sellHubId = regionToHubId[sellHub];
    const buyBook   = buyHubId  ? hubBooks[buyHubId]  : null;
    const sellBook  = sellHubId ? hubBooks[sellHubId] : null;

    const enriched = rows.flatMap(r => {
      const buyEntry  = buyBook?.get(r.product_id)  ?? null;
      const sellEntry = sellBook?.get(r.product_id) ?? null;
      // If the hub book exists and confirms 0 buy orders at the sell hub, skip — no market to sell into
      if (sellEntry && sellEntry.buyOrders === 0) return [];
      return [{
        ...r,
        buy_hub_name:       buyHubName,
        sell_hub_name:      sellHubName,
        sell_orders_at_buy: buyEntry  ? buyEntry.sellOrders  : null,
        sell_vol_at_buy:    buyEntry  ? buyEntry.sellQtyTop  : null,
        buy_orders_at_sell: sellEntry ? sellEntry.buyOrders  : null,
        buy_vol_at_sell:    sellEntry ? sellEntry.buyQtyTop  : null,
      }];
    });

    res.json({
      results: enriched,
      buy_hub:    buyHubName,
      sell_hub:   sellHubName,
      count:      enriched.length,
      offset,
      has_more:   rows.length === limit,
      min_margin: minMargin,
      sort_by:    rawSort,
    });
  } catch (err) {
    logger.error('Inter-hub arb error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// Profitable buy orders at a hub for a specific item.
// Fetches raw ESI buy orders for the item in the hub's region, filters to those
// at the hub's main station AND priced above the break-even cost
// (buy_at + all fees = sell_into − net_profit), and returns count + total volume_remain.
// Station-scoped to match the Fuzzwork aggregated data FORGE uses for prices.
// Note: Keepstar (structure) orders cannot be fetched via public ESI — returns 501.
app.get('/api/inter-hub-item-profitable', security.apiLimiter, async (req, res) => {
  try {
    const typeId    = parseInt(req.query.typeId, 10);
    const regionId  = parseInt(req.query.regionId, 10);
    const breakEven = parseFloat(req.query.breakEven);
    if (!typeId || !regionId || isNaN(breakEven))
      return res.status(400).json({ error: 'typeId, regionId, and breakEven are required' });

    const hubId = REGION_TO_HUB[regionId];
    const hub   = hubId ? HUB_CONFIG[hubId] : null;
    if (!hub)
      return res.status(400).json({ error: `No hub configured for regionId ${regionId}` });
    if (hub.isStructure)
      return res.status(501).json({ error: 'Profitable orders not available for player structures — ESI structure markets require authentication.' });

    // Prefer the in-memory buy order book (populated by pollHubESI — same snapshot as
    // the trade breakdown figures). Fall back to a live ESI call only if the book
    // was loaded from Fuzzwork (which doesn't provide per-order detail).
    const bookEntry = hubBooks[hubId]?.get(typeId);
    if (bookEntry?.buyOrderBook) {
      const profitable = bookEntry.buyOrderBook.filter(o => o.p > breakEven);
      return res.json({
        profitableOrderCount: profitable.length,
        totalVolumeRemain:    profitable.reduce((s, o) => s + o.v, 0),
        totalAtStation:       bookEntry.buyOrders,
        breakEven,
        source: 'book',
      });
    }

    // Fuzzwork-sourced book — no per-order data. Fall back to live ESI.
    let allOrders = [];
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(
        `https://esi.evetech.net/latest/markets/${regionId}/orders/?order_type=buy&type_id=${typeId}&page=${page}&datasource=tranquility`,
        { headers: { 'User-Agent': 'FORGE EVE Manufacturing Tool' } }
      );
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allOrders = allOrders.concat(batch);
      if (batch.length < 1000) break;
    }
    const atStation = allOrders.filter(o => o.location_id === hub.stationId);
    const profitable = atStation.filter(o => o.price > breakEven);

    res.json({
      profitableOrderCount: profitable.length,
      totalVolumeRemain:    profitable.reduce((s, o) => s + o.volume_remain, 0),
      totalAtStation:       atStation.length,
      breakEven,
      source: 'live',
    });
  } catch (err) {
    logger.error('❌ inter-hub-item-profitable error:', err.message);
    res.status(500).json({ error: 'ESI fetch failed' });
  }
});

// Inter-Hub Haul cost per unit — uses the character's Leg 2 haul config and
// jump count between the two hubs' solar systems.
app.get('/api/inter-hub-haul', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const typeId     = parseInt(req.query.typeId, 10);
    const rawBuy     = parseInt(req.query.buyHub  || '10000002', 10);
    const rawSell    = parseInt(req.query.sellHub || '10000043', 10);
    const collateral = Math.max(0, parseFloat(req.query.collateral || '0'));
    if (!typeId) return res.status(400).json({ error: 'typeId required' });

    const buyHub  = VALID_REGIONS.includes(rawBuy)  ? rawBuy  : 10000002;
    const sellHub = VALID_REGIONS.includes(rawSell) ? rawSell : 10000043;

    const characterId = req.characterId;

    // Skills + standings — needed for accurate fee rates
    const { skillMap, standings } = getCharacterSession(characterId);
    const { brokerFeeRate, transactionTaxRate, brokerRelations, accounting } =
      calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[sellHub], HUB_STRUCTURE_FEES[sellHub] ?? null);

    const settings = await dbGet(
      `SELECT interhub_haul_enabled, interhub_method, interhub_haul_rate, interhub_isk_per_jump,
              interhub_flat_total, interhub_self_fuel, interhub_collateral, interhub_service_label
       FROM character_industry_settings WHERE character_id = ?`,
      [characterId]
    );

    const feeFields = {
      transaction_tax_rate: transactionTaxRate,
      broker_fee_rate:      brokerFeeRate,
      accounting_level:     accounting,
      broker_relations:     brokerRelations,
    };

    if (!settings?.interhub_haul_enabled) {
      return res.json({ haul_enabled: false, haul_cost: 0, method: 'none',
        method_label: 'Not configured', service_label: null, contracts: 0, jumps: 0,
        volume_m3: 0, effective_isk_per_m3: 0, ...feeFields });
    }

    const itemRow  = await dbGet('SELECT packaged_volume FROM items WHERE type_id = ?', [typeId]);
    const volumeM3 = itemRow?.packaged_volume || 0;

    const buySysId  = HUB_SYSTEM_IDS[buyHub]  || HUB_SYSTEM_IDS[10000002];
    const sellSysId = HUB_SYSTEM_IDS[sellHub] || HUB_SYSTEM_IDS[10000043];
    const jumps = await getJumpCount(buySysId, sellSysId);

    const legCfg = {
      method:       settings.interhub_method       || 'user_defined',
      rate:         settings.interhub_haul_rate     || 0,
      isk_per_jump: settings.interhub_isk_per_jump  || 0,
      flat_total:   settings.interhub_flat_total    || 0,
      self_fuel:    settings.interhub_self_fuel     || 0,
    };
    const col    = settings.interhub_collateral > 0 ? settings.interhub_collateral : collateral;
    const result = calcLegHaulCost(legCfg, volumeM3, jumps, col);

    const methodLabel = legCfg.method === 'red_frog'   ? 'Red Frog'
                      : legCfg.method === 'black_frog'  ? 'Black Frog'
                      : legCfg.method === 'pushx'       ? 'PushX'
                      : legCfg.method === 'self_haul'   ? 'Self Haul'
                      : settings.interhub_service_label || 'User Defined';

    res.json({
      haul_enabled:         true,
      method:               legCfg.method,
      method_label:         methodLabel,
      service_label:        settings.interhub_service_label || null,
      haul_cost:            result.cost,
      effective_isk_per_m3: result.effectiveIskPerM3,
      contracts:            result.contracts,
      jumps,
      volume_m3:            volumeM3,
      ...feeFields,
    });
  } catch (err) {
    logger.error('Inter-hub haul error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Admin: Manually trigger pre-compute
app.post('/api/admin/precompute', security.adminLimiter, async (req, res) => {
  // Simple API key auth for admin endpoints
  const adminKey = config.adminKey;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runPreCompute();

  if (jobState.preComputeRunning) {
    res.json({ message: 'Pre-compute job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});

// Admin: Manually trigger contract price ingest (v1.12.0). Runs in background.
app.post('/api/admin/contract-ingest', security.adminLimiter, async (req, res) => {
  const adminKey = config.adminKey;
  if (!adminKey || req.headers['x-admin-key'] !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const raw = parseInt(req.body?.regionId, 10);
  const regionId = VALID_REGIONS.includes(raw) ? raw : CONTRACT_INGEST_REGION;
  ingestRegionContracts(regionId).then(r => logger.info('Contract ingest result:', r));
  res.json({ status: 'started', region_id: regionId });
});

// Admin: View pre-compute run history
app.get('/api/admin/precompute-status', security.adminLimiter, async (req, res) => {
  const adminKey = config.adminKey;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const runs = await dbAll(`
      SELECT * FROM precompute_runs
      ORDER BY id DESC LIMIT 10
    `);

    const totalBlueprints = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits'
    );

    const profitable = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE profit > 0'
    );

    const enriched = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE avg_daily_volume IS NOT NULL'
    );

    const risky = await dbGet(
      `SELECT COUNT(*) as count FROM precomputed_profits WHERE liquidity_risk IS NOT NULL AND liquidity_risk != ''`
    );

    res.json({
      runs,
      summary: {
        totalPrecomputed: totalBlueprints?.count || 0,
        profitable: profitable?.count || 0,
        enriched: enriched?.count || 0,
        risky: risky?.count || 0,
        isRunning: jobState.preComputeRunning
      }
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Admin: Manually trigger volume enrichment (v0.9.1)
app.post('/api/admin/volume-enrichment', security.adminLimiter, async (req, res) => {
  const adminKey = config.adminKey;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runVolumeEnrichment();

  if (jobState.volumeEnrichmentRunning) {
    res.json({ message: 'Volume enrichment job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});


// HEALTH CHECK
app.get('/health', async (req, res) => {
  let lastPrecompute = null;
  try {
    lastPrecompute = await dbGet(
      `SELECT completed_at, status, blueprints_processed
       FROM precompute_runs ORDER BY id DESC LIMIT 1`
    );
  } catch (_) { /* table may not exist yet */ }

  let enrichmentStats = null;
  try {
    enrichmentStats = await dbGet(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN avg_daily_volume IS NOT NULL THEN 1 END) as enriched,
        COUNT(CASE WHEN liquidity_risk IS NOT NULL AND liquidity_risk != '' THEN 1 END) as risky
      FROM precomputed_profits WHERE profit > 0
    `);
  } catch (_) { /* column may not exist yet */ }

  res.json({ 
    status: "ok",
    version: "1.0.0.0",
    uptime: process.uptime(),
    database: database.db ? "connected" : "disconnected",
    precompute: {
      lastRun: lastPrecompute?.completed_at || null,
      lastStatus: lastPrecompute?.status || 'never',
      blueprintsProcessed: lastPrecompute?.blueprints_processed || 0,
      isRunning: jobState.preComputeRunning
    },
    volumeEnrichment: {
      total: enrichmentStats?.total || 0,
      enriched: enrichmentStats?.enriched || 0,
      risky: enrichmentStats?.risky || 0,
      isRunning: jobState.volumeEnrichmentRunning
    },
    priceCache: {
      loaded: !!jitaPricesCache,
      items: jitaPricesCache ? Object.keys(jitaPricesCache).length : 0
    }
  });
});


// POST /api/true-cost — calculate full True Profit for an item with all fees
// Body: { product_id, me, te, runs, regionId, materialRegionId }
//
// Calculation is fully local — no external API calls during the request:
//   • Material quantities  → blueprint_materials table (already in DB)
//   • Adjusted prices      → ESI /markets/prices/ (cached 6 h, warmed on first use)
//   • System Cost Index    → ESI /industry/systems/ (cached 1 h, warmed on first use)
//   • Sell price           → regionPriceCache (populated by precompute job)
//   • Sales fees           → character skills + standings (session cache)
//
// Rig and structure bonuses live in lib/industry-math.js, driven by lib/industry-data/*.json
// (generated from the SDE + ESI dogma by gen-industry-data.js). The old hand-maintained
// RIG_ME_BONUSES table was additive, ignored system security and applied every rig to every
// product; test-industry-math.js now checks the Mfg Setup rig catalog against the game data.

// Invention probability rigs for Upwell structures.
// In EVE, invention probability is primarily skill-based. Structure rigs affect
// invention job TIME and JOB FEE, not base probability. This map exists for
// future verified rig type_ids — leave empty until confirmed from EVE SDE.
// When verified, add: typeId: bonusAsDecimal  (e.g. 0.015 = +1.5% flat bonus)
const RIG_INVENTION_PROBABILITY = {
  // Example (VERIFY before activating): 99999: 0.015,
};

// Encryption Methods skill IDs — weighted at ÷40 in the invention formula.
// Science skills (any other activity=8 skill) are weighted at ÷30.
// Formula: P = base × (1 + enc/40 + sci1/30 + sci2/30) × decryptorMult
// Source: https://wiki.eveuniversity.org/Invention
// Verified 17 Sept 2026 against live ESI (/universe/types/{id}/). Three entries
// were fabricated (same "unverified hand-typed ids" pattern as the rig-catalog
// bug): 3407 doesn't exist in the SDE at all; 3410 is actually Astrogeology
// (mining skill); 3411 is actually Cybernetics (implant skill) — neither has
// anything to do with invention. The Amarr/Caldari comments were also swapped
// on the two real entries. Removed the three fake ones, fixed the swap, and
// added the two real Encryption Methods skills this set was missing entirely
// (Triglavian and Upwell — both currently obtainable, used for Triglavian/
// Upwell-structure invention jobs).
const ENCRYPTION_SKILL_IDS = new Set([
  21790, // Caldari Encryption Methods
  23087, // Amarr Encryption Methods
  23121, // Gallente Encryption Methods
  21791, // Minmatar Encryption Methods
  3408,  // Sleeper Encryption Methods
  52308, // Triglavian Encryption Methods
  55025, // Upwell Encryption Methods
]);

// Invention decryptors: probability multiplier (%), run modifier, ME modifier, TE modifier.
// Source: https://wiki.eveuniversity.org/Invention
const DECRYPTORS = {
  none:                   { name: null,                          probMult:   0, runs: 0, me:  0, te:  0 },
  accelerant:             { name: 'Accelerant Decryptor',        probMult:  20, runs: 1, me:  2, te: 10 },
  attainment:             { name: 'Attainment Decryptor',        probMult:  80, runs: 4, me: -1, te:  4 },
  augmentation:           { name: 'Augmentation Decryptor',      probMult: -40, runs: 9, me: -2, te:  2 },
  optimized_attainment:   { name: 'Optimized Attainment Decryptor',   probMult:  90, runs: 2, me:  1, te: -2 },
  optimized_augmentation: { name: 'Optimized Augmentation Decryptor', probMult: -10, runs: 7, me:  2, te:  0 },
  parity:                 { name: 'Parity Decryptor',            probMult:  50, runs: 3, me:  1, te: -2 },
  process:                { name: 'Process Decryptor',           probMult:  10, runs: 0, me:  3, te:  6 },
  symmetry:               { name: 'Symmetry Decryptor',          probMult:   0, runs: 2, me:  1, te:  8 },
};
// type_id for each decryptor — populated at startup from the items table
const decryptorTypeIds = {};

// Job cost formula (EVE manufacturing) — implemented in lib/industry-math.js:
//   materialMult    = (1 − blueprintME/100) × structureMult × Π(covering rigs: 1 − bonus × secMult/100)
//   qty[mat]        = max(runs, ceil(round(baseQty × runs × materialMult, 2)))   (once per job)
//   EIV             = Σ(BASE ME-0 qty[mat] × adjusted_price[mat]) × runs        (ME does NOT lower EIV)
//   System Job Cost = EIV × SCI × structureCostMult
//   SCC Surcharge   = EIV × 4%     (verified 17 Sept 2026 against CCP's own
//                     "Exploration & Industry Balance Rework" dev blog, 18 Jul
//                     2025: the 4%→2% cut applies ONLY to ME/TE blueprint
//                     research jobs — manufacturing and invention stayed at
//                     4%. This code previously applied 2% to manufacturing
//                     too, undercharging job cost — and therefore overstating
//                     True Profit — on every single manufacturing calculation
//                     in the app by ~2% of EIV.)
//   Facility Tax    = EIV × facility_tax_rate
//   Total Job Cost  = System Job Cost + SCC Surcharge + Facility Tax

// materialSourcing (from /api/true-cost) says how many units of each material come from the buy
// hub and how many are imported from Jita; imports travel a separate Jita → build-system leg
// ("legJ"), costed with the user's Leg 1 haulage settings (there is no separate Jita setting).
async function calcHaulLegs({ haulEnabled, settings, matRegionId, sellRegionId, materials, meFactor, blueprint, product_id, runs, materialSourcing = null }) {
  const zero = { leg1Cost: 0, leg2Cost: 0, leg1VolM3: 0, leg2VolM3: 0,
                 leg1EffM3: 0, leg2EffM3: 0, leg1Contracts: 1, leg2Contracts: 1,
                 leg1Jumps: 0, leg2Jumps: 0,
                 legJCost: 0, legJVolM3: 0, legJJumps: 0, legJRouteKnown: true,
                 leg1RouteKnown: true, leg2RouteKnown: true };
  if (!haulEnabled) return zero;

  const sourceHubSysId = HUB_SYSTEM_IDS[matRegionId]  || HUB_SYSTEM_IDS[10000002];
  const sellHubSysId   = HUB_SYSTEM_IDS[sellRegionId] || HUB_SYSTEM_IDS[10000002];
  const mfgSysId       = settings?.system_id || 30000142;

  // null = the route couldn't be looked up (ESI error / no gate route): reported, never silently "0 jumps"
  const [leg1JumpsRaw, leg2JumpsRaw] = await Promise.all([
    getJumpCountStrict(sourceHubSysId, mfgSysId),
    getJumpCountStrict(mfgSysId, sellHubSysId),
  ]);
  const leg1RouteKnown = leg1JumpsRaw !== null, leg2RouteKnown = leg2JumpsRaw !== null;
  const leg1Jumps = leg1JumpsRaw ?? 0, leg2Jumps = leg2JumpsRaw ?? 0;

  const leg1Cfg = {
    method:       settings?.leg1_method       || 'user_defined',
    rate:         settings?.leg1_haul_rate     || 0,
    isk_per_jump: settings?.leg1_isk_per_jump  || 0,
    flat_total:   settings?.leg1_flat_total    || 0,
    self_fuel:    settings?.leg1_self_fuel     || 0,
    self_ship:    settings?.leg1_self_ship     || null,
  };
  const leg2Cfg = {
    method:       settings?.leg2_method       || 'user_defined',
    rate:         settings?.leg2_haul_rate     || 0,
    isk_per_jump: settings?.leg2_isk_per_jump  || 0,
    flat_total:   settings?.leg2_flat_total    || 0,
    self_fuel:    settings?.leg2_self_fuel     || 0,
    self_ship:    settings?.leg2_self_ship     || null,
  };
  const leg1Col = settings?.leg1_collateral || 0;
  const leg2Col = settings?.leg2_collateral || 0;

  let leg1VolM3 = 0, leg2VolM3 = 0;
  let leg1Cost  = 0, leg2Cost  = 0;
  let leg1EffM3 = 0, leg2EffM3 = 0;
  let leg1Contracts = 1, leg2Contracts = 1;

  const isLeg1Active = leg1Cfg.method !== 'user_defined'
    || leg1Cfg.rate > 0 || leg1Cfg.isk_per_jump > 0 || leg1Cfg.flat_total > 0;

  // Import leg (Jita → build system): units the buy hub can't supply, costed with the Leg 1 settings.
  let legJCost = 0, legJVolM3 = 0, legJJumps = 0, legJRouteKnown = true;
  let importVolM3 = 0;

  if (isLeg1Active && materials.length > 0 && (leg1Jumps > 0 || (materialSourcing && matRegionId !== 10000002))) {
    const matIds = materials.map(m => m.material_id);
    const ph     = matIds.map(() => '?').join(',');
    const volRows = await dbAll(
      `SELECT type_id, packaged_volume FROM items WHERE type_id IN (${ph})`, matIds
    );
    const volMap = new Map(volRows.map(r => [r.type_id, r.packaged_volume || 0]));
    const srcById = materialSourcing ? new Map(materialSourcing.map(s => [s.material_id, s])) : null;
    for (const m of IM.jobMaterials(materials, runs, meFactor)) {
      const vol = volMap.get(m.material_id) || 0;
      const src = srcById && srcById.get(m.material_id);
      if (src) {
        // Units imported from Jita (and any shortfall neither market lists) travel from Jita; EVERYTHING
        // else travels from the buy hub — including items nobody lists (priced at the 30-day average) and,
        // when the buy hub IS Jita, a shortfall at the last visible price. Nothing travels for free.
        const external = matRegionId === 10000002 ? 0 : (src.jita_qty + src.unfilled_qty);
        importVolM3 += vol * external;
        leg1VolM3   += vol * Math.max(0, src.qty - external);
      } else {
        leg1VolM3 += vol * m.qty;
      }
    }
    // The declared collateral is one amount for the whole shopping list: share it by volume between the buy-hub
    // leg and the Jita import leg instead of charging it in full on both.
    const legTotalVol = leg1VolM3 + importVolM3;
    const hubColl = legTotalVol > 0 ? leg1Col * (leg1VolM3 / legTotalVol) : leg1Col;
    const impColl = legTotalVol > 0 ? leg1Col * (importVolM3 / legTotalVol) : 0;
    if (leg1Jumps > 0) {
      const l1 = calcLegHaulCost(leg1Cfg, leg1VolM3, leg1Jumps, hubColl);
      leg1Cost = l1.cost; leg1EffM3 = l1.effectiveIskPerM3; leg1Contracts = l1.contracts;
    }

    if (importVolM3 > 0 && matRegionId !== 10000002) {
      const jJumps = await getJumpCountStrict(HUB_SYSTEM_IDS[10000002], mfgSysId);
      if (jJumps === null) {
        legJRouteKnown = false;       // route lookup failed — freight left out, and the UI says so
      } else if (jJumps > 0) {
        const lJ = calcLegHaulCost(leg1Cfg, importVolM3, jJumps, impColl);
        legJCost = lJ.cost; legJVolM3 = importVolM3; legJJumps = jJumps;
      }
    }
  }
  if (isLeg1Active && leg1Jumps === 0 && leg1Cfg.method === 'self_haul' && (!materialSourcing || leg1VolM3 > 0)) {
    leg1Cost = calcLegHaulCost(leg1Cfg, 1, 0, leg1Col).cost;
  }

  const isLeg2Active = leg2Cfg.method !== 'user_defined'
    || leg2Cfg.rate > 0 || leg2Cfg.isk_per_jump > 0 || leg2Cfg.flat_total > 0;

  if (isLeg2Active && leg2Jumps > 0) {
    const productVolRow = await dbGet(
      'SELECT packaged_volume FROM items WHERE type_id = ?', [product_id]
    );
    const productQty = (blueprint.product_quantity || 1) * runs;
    leg2VolM3 = (productVolRow?.packaged_volume || 0) * productQty;
    const l2 = calcLegHaulCost(leg2Cfg, leg2VolM3, leg2Jumps, leg2Col);
    leg2Cost = l2.cost; leg2EffM3 = l2.effectiveIskPerM3; leg2Contracts = l2.contracts;
  } else if (isLeg2Active && leg2Jumps === 0 && leg2Cfg.method === 'self_haul') {
    leg2Cost = calcLegHaulCost(leg2Cfg, 1, 0, leg2Col).cost;
  }

  return { leg1Cost, leg2Cost, leg1VolM3, leg2VolM3, leg1EffM3, leg2EffM3, leg1Contracts, leg2Contracts, leg1Jumps, leg2Jumps,
           legJCost, legJVolM3, legJJumps, legJRouteKnown, leg1RouteKnown, leg2RouteKnown };
}

async function calcInventionCost({
  invParent, decr, decryptor_type, skillMap, settings, targetSystemId,
  adjustedPrices, costIndices, matWarm, matEntry, runs, invention_prob_bonus,
}) {
  if (!invParent) return null;

  const invRigIds   = JSON.parse(settings?.invention_rig_ids || '[]');
  const invSystemId = settings?.invention_system_id || targetSystemId;
  // No dedicated invention-facility-tax setting exists (invention_system_id
  // is the only invention-specific location field), so reuse the same
  // facility_tax the user set for manufacturing — same fallback pattern as
  // invSystemId above. Previously this was omitted entirely (0%), understating
  // invention job cost for anyone building at a taxed player structure.
  const invFacilityTaxDecimal = (settings?.facility_tax || 0) / 100;

  // P = base × (1 + enc/40 + sci1/30 + sci2/30) × decryptorMult + rigBonus + probBonus
  // Source: https://wiki.eveuniversity.org/Invention
  const invSkills = await dbAll(
    'SELECT skill_id FROM blueprint_skills WHERE blueprint_id = ? AND activity_id = 8',
    [invParent.t1_blueprint_id]
  );
  const encSkill    = invSkills.find(s => ENCRYPTION_SKILL_IDS.has(s.skill_id));
  const sciSkills   = invSkills.filter(s => !ENCRYPTION_SKILL_IDS.has(s.skill_id));
  const encLevel    = encSkill ? (skillMap[encSkill.skill_id] || 0) : 0;
  const sciBonus    = sciSkills.reduce((sum, s) => sum + (skillMap[s.skill_id] || 0) / 30, 0);
  const encBonus    = encLevel / 40;
  const skillFactor = 1 + sciBonus + encBonus;

  const rigBonus      = invRigIds.reduce((sum, id) => sum + (RIG_INVENTION_PROBABILITY[id] || 0), 0);
  const decryptorMult = 1 + decr.probMult / 100;
  const probBonus     = (invention_prob_bonus || 0) / 100;

  const effectiveProb = Math.min(1.0,
    invParent.probability * skillFactor * decryptorMult + rigBonus + probBonus
  );
  const expectedAttempts        = 1 / effectiveProb;
  const skillLevels             = invSkills.map(s => ({ skillId: s.skill_id, level: skillMap[s.skill_id] || 0 }));
  const outputRunsWithDecryptor = (invParent.output_runs || 1) + decr.runs;

  const invMats = await dbAll(`
    SELECT im.material_id, im.quantity, i.name
      FROM invention_materials im
      LEFT JOIN items i ON i.type_id = im.material_id
     WHERE im.t1_blueprint_id = ?
  `, [invParent.t1_blueprint_id]);

  // Datacores and decryptors are bought at the source hub; anything it doesn't stock is priced at
  // Jita's live lowest sell (tagged), never at a buy order, which can't be bought from.
  const invPrices = matWarm ? HP.withJitaFallback(matEntry.prices, getRawJitaPrices()) : null;
  let dcCostPerAttempt = 0;
  const datacores = [];
  for (const m of invMats) {
    const p         = invPrices ? invPrices[m.material_id] : null;
    const unitPrice = p?.sell || p?.buy || 0;     // a bid is only a last resort when nobody sells it
    const total     = unitPrice * m.quantity;
    dcCostPerAttempt += total;
    datacores.push({ materialId: m.material_id, name: m.name || `Mat ${m.material_id}`, quantity: m.quantity, unitPrice, totalPerAttempt: total, priceScope: p?.sellScope === 'jita' ? 'jita' : (p?.sell ? 'hub' : (p?.buy ? 'buy_order' : 'none')) });
  }

  let decryptorCostPerAttempt = 0;
  const decryptorTypeId = decryptorTypeIds[decryptor_type] || null;
  if (decryptorTypeId) {
    const dp = invPrices ? invPrices[decryptorTypeId] : null;
    decryptorCostPerAttempt = dp?.sell || dp?.buy || 0;
  }

  let invEiv = 0;
  for (const m of invMats) invEiv += (adjustedPrices[m.material_id] || 0) * m.quantity;
  const invSci           = costIndices[invSystemId] || 0;
  const invJobPerAttempt = invEiv * invSci + invEiv * 0.04 + invEiv * invFacilityTaxDecimal; // system cost + SCC surcharge (4% — invention isn't ME/TE research, so the Jul 2025 research-only cut to 2% doesn't apply; see the "Job cost formula" comment above calcHaulLegs) + facility tax

  const perBpcCost = (dcCostPerAttempt + decryptorCostPerAttempt + invJobPerAttempt) * expectedAttempts;
  const amortize   = (cost) => (cost * expectedAttempts / outputRunsWithDecryptor) * runs;
  const totalInvCost       = (perBpcCost / outputRunsWithDecryptor) * runs;
  const totalDcCost        = amortize(dcCostPerAttempt);
  const totalDecryptorCost = amortize(decryptorCostPerAttempt);
  const totalInvJobCost    = amortize(invJobPerAttempt);

  return {
    total:                      totalInvCost,
    per_bpc_cost:               perBpcCost,
    effective_probability:      effectiveProb,
    base_probability:           invParent.probability,
    skill_factor:               skillFactor,
    skill_bonus:                sciBonus + encBonus,
    rig_bonus:                  rigBonus,
    prob_bonus:                 probBonus,
    expected_attempts:          expectedAttempts,
    datacores_cost:             totalDcCost,
    job_cost:                   totalInvJobCost,
    decryptor_cost:             totalDecryptorCost,
    dc_cost_per_attempt:        dcCostPerAttempt,
    decryptor_cost_per_attempt: decryptorCostPerAttempt,
    job_cost_per_attempt:       invJobPerAttempt,
    decryptor_type:             decryptor_type || 'none',
    decryptor:                  { ...decr, output_runs: outputRunsWithDecryptor },
    output_runs:                outputRunsWithDecryptor,
    datacores,
    skills:                     skillLevels,
  };
}

app.post('/api/true-cost', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const {
      product_id,
      me: meRaw      = 0,
      te: teRaw      = 0,
      runs: runsRaw  = 1,
      regionId       = 10000002,  // sell hub (backward-compat param name)
      materialRegionId = regionId, // source hub — where materials are purchased
      // v1.17.1 — implant set to apply to the ISK/hr calc. DEFAULT = none.
      // The client passes the type_ids of the clone/implant set the user explicitly
      // selected; otherwise True Profit reflects NO implants (honest default).
      implants: selectedImplants = [],
      // v1.35.0 — invention decryptor + manual probability bonus
      decryptor_type        = 'none',
      invention_prob_bonus  = 0,   // flat percentage-point bonus (e.g. 5 = +5 pp)
    } = req.body;

    // Numeric inputs are clamped once, here, so materials, EIV, job cost, revenue and build time all
    // use the SAME job size (a fractional/zero/negative `runs` used to scale only some of them).
    const runs = Math.min(1_000_000, Math.max(1, Math.floor(Number(runsRaw)) || 1));
    const me   = Math.max(-100, Math.min(100, Number(meRaw) || 0));
    const te   = Math.max(-100, Math.min(100, Number(teRaw) || 0));

    // Validate both hub IDs against the known whitelist
    const sellRegionId = VALID_REGIONS.includes(parseInt(regionId))
      ? parseInt(regionId) : 10000002;
    const matRegionId  = VALID_REGIONS.includes(parseInt(materialRegionId))
      ? parseInt(materialRegionId) : sellRegionId;
    const characterId = req.characterId;

    if (!product_id) return res.status(400).json({ error: 'product_id required' });

    // ── Session: skills + standings ────────────────────────────────────────
    const { skillMap, standings, skillsSource, skillsUpdatedAt } = getCharacterSession(characterId);
    // Implant set is whatever the client explicitly selected (default none).
    const implants = Array.isArray(selectedImplants) ? selectedImplants : [];

    // ── Industry settings (system, structure, rigs, facility tax) ──────────
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const rigIds            = JSON.parse(settings?.rig_ids || '[]');
    const facilityTaxDecimal = (settings?.facility_tax || 0) / 100;
    const targetSystemId     = settings?.system_id || 30000142; // default: Jita IV

    // ── Blueprint materials from DB ────────────────────────────────────────
    const blueprint = await dbGet(
      'SELECT blueprint_id, product_quantity, build_time, COALESCE(activity_id, 1) AS activity_id FROM blueprints WHERE product_id = ?',
      [product_id]
    );
    if (!blueprint) {
      return res.status(404).json({ error: `No blueprint found for product ${product_id}` });
    }
    // Reaction formulas (activity 9) run in refineries, not engineering complexes: the structure's
    // material/cost/time bonuses and the Industry skill don't apply (same rule as the Queue Planner).
    const isReaction = blueprint.activity_id === 9;
    const materials = blueprintMaterialsCache.get(blueprint.blueprint_id) || [];

    // ── T2 check (early — needed to select correct ME/TE base before EIV calc) ──
    // Invented T2 BPCs always start at ME -4, TE -4 in EVE regardless of T1 BPO research.
    // The decryptor modifies these values; the client-sent me/te from BPO research is irrelevant.
    const invParent = await dbGet(
      'SELECT t1_blueprint_id, probability, output_runs FROM blueprint_invention WHERE t2_blueprint_id = ?',
      [blueprint.blueprint_id]
    );
    const decr = DECRYPTORS[decryptor_type] || DECRYPTORS.none;
    const T2_BPC_BASE_ME = -4;
    const T2_BPC_BASE_TE = -4;
    const baseME = invParent ? T2_BPC_BASE_ME + decr.me : me;
    const baseTE = invParent ? T2_BPC_BASE_TE + decr.te : te;

    // ── Build modifiers: blueprint ME × structure × the rigs that cover THIS product ──
    // Shared mechanics in lib/industry-math.js (values from CCP's dogma data). Each rig's bonus is
    // its own attribute × the system-security multiplier, applies only to the product families
    // its description lists, and every factor multiplies (no additive summing).
    const productRow = await dbGet('SELECT group_id FROM items WHERE type_id = ?', [product_id]);
    const sysRow     = settings?.system_id
      ? await dbGet('SELECT security_status FROM sde_systems WHERE system_id = ?', [settings.system_id])
      : null;
    const setup      = IM.describeSetup({
      structureTypeId: settings?.structure_type_id || null,
      rigIds,
      systemSecurity:  sysRow ? sysRow.security_status : null,
    });
    const mods       = isReaction
      ? { family: null, familyKnown: true, appliedRigs: [], matMult: 1, timeMult: 1, costMult: 1 }
      : IM.modifiersForProduct(setup, productRow?.group_id);
    const bpMeMult   = IM.blueprintMeMult(baseME);
    const meFactor   = bpMeMult * mods.matMult;          // total material multiplier for this job
    const effectiveME = (1 - meFactor) * 100;            // combined % reduction (display)
    const structureMeBonus = (setup.structure && !isReaction) ? (1 - setup.structure.matMult) * 100 : 0;
    const rigMeBonus = mods.appliedRigs.reduce((sum, r) => sum + r.usedMatPct, 0);

    // ── Adjusted prices + cost indices (ESI, cached) ──────────────────────
    // These calls return instantly when cache is warm; first call ~2–5 s each.
    const [adjustedPrices, costIndices] = await Promise.race([
      Promise.all([fetchAdjustedPrices(), fetchCostIndices()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ESI price fetch timeout')), 60000)),
    ]);

    // ── EIV: CCP's job-fee base is the BASE (ME 0) quantity × adjusted price, not the
    // ME-reduced quantity (EVE University "Manufacturing" → Total job cost).
    const eiv = IM.estimatedItemValue(materials, runs, adjustedPrices);

    // ── Manufacturing job cost = EIV × (SCI × structure cost bonus + facility tax + SCC) ──
    const sci            = costIndices[targetSystemId] || 0;
    const jc             = IM.jobCost({ eiv, sci, costMult: mods.costMult, facilityTaxDecimal });
    const systemJobCost  = jc.system;
    const sccSurcharge   = jc.scc;
    const facilityTaxCost = jc.facility;
    const totalJobCost   = jc.total;

    // ── Prices: LIVE, and the SAME live source the materials/shortfall list uses ──
    // v1.19.2 — the per-item panel is the decision moment, so it uses CURRENT market
    // prices (regionPriceCache, sell-sourced) for both material cost and sell price —
    // identical to the materials list and the "to buy" shortfall, so the whole panel
    // agrees with itself and reflects the market right now.
    //   • Source hub (matRegionId)  — where the player buys raw materials
    //   • Sell hub   (sellRegionId) — where the finished goods are listed
    // The Market Opportunities table / AI deliberately use the (6-hourly) precompute
    // "Est." baseline for cross-item ranking — that's a labelled estimate, not this.
    // When a region cache is cold (e.g. just after a restart) we temporarily fall back
    // to the precompute row, flag prices_warm=false, and warm in the background; the
    // client silently retries so the figure upgrades to live within ~15s.
    const matEntry  = regionPriceCache.get(matRegionId);
    const sellEntry = regionPriceCache.get(sellRegionId);
    const matWarm   = !!(matEntry  && Date.now() < matEntry.expiry);
    const sellWarm  = !!(sellEntry && Date.now() < sellEntry.expiry);
    const pricesWarm = matWarm && sellWarm;

    // Material cost — live source-hub (station-first) sell prices × the job's real material
    // quantities (single rounding per job, ≥ 1 per run).
    let totalMaterialCost = 0;
    // How each material was priced: from the hub's own sell orders, imported from Jita for
    // whatever the hub can't supply, or short on both. Drives the notices and the Jita haul leg.
    const materialSourcing = [];
    const rawHubPrices  = matWarm ? getRawHubPrices(matRegionId) : null;
    const rawJitaPrices = getRawJitaPrices();
    if (!rawJitaPrices && matRegionId !== 10000002) kickRegionWarm(10000002);   // imports can't be priced until Jita is loaded
    if (matWarm) {
      for (const m of IM.jobMaterials(materials, runs, meFactor)) {
        const pb = HP.priceBuy({
          hubPrices: rawHubPrices, jitaPrices: rawJitaPrices,
          typeId: m.material_id, qty: m.qty, hubIsJita: matRegionId === 10000002,
          history: market.historyPriceMap.get(m.material_id) || 0,   // last resort only; tagged scope 'history'
        });
        totalMaterialCost += pb.cost;
        materialSourcing.push({
          material_id: m.material_id, qty: m.qty, scope: pb.scope,
          hub_qty: pb.hubQty, jita_qty: pb.jitaQty, unfilled_qty: pb.unfilledQty,
          unit_cost: pb.unit, cost: pb.cost, hub_cost: pb.hubCost, import_cost: pb.jitaCost + pb.unfilledCost,
          approx: pb.approx, short_stock: pb.shortStock,
        });
      }
    } else {
      // Cold — temporary precompute fallback (ME-scaled) + background warm.
      const precompMat = await dbGet(
        'SELECT material_cost FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, matRegionId]
      );
      totalMaterialCost = (precompMat?.material_cost || 0) * meFactor * runs;
      if (!regionWarmingSet.has(matRegionId)) {
        regionWarmingSet.add(matRegionId);
        fetchRegionPrices(matRegionId)
          .then(prices => setRegionPriceCache(matRegionId, prices))
          .catch(() => {})
          .finally(() => regionWarmingSet.delete(matRegionId));
      }
    }

    // Sell price — live sell-hub price, precompute fallback when cold.
    let unitSell = 0;
    // 'hub'/'region' = the sell hub's own lowest sell; 'jita' = the hub has none listed, so the
    // estimate is Jita's lowest sell (and the sale is assumed to happen at Jita); null = unknown.
    let sellScope = null;
    let sellOrdersSeen = null;      // units listed at the sell hub (thin-book notice)
    let sellHubBuy = 0;             // that hub's highest buy order
    if (sellWarm) {
      const sp = getHubPrices(sellRegionId)?.[product_id];
      unitSell  = sp?.sell || 0;
      sellScope = sp ? (sp.sellScope || null) : null;
      sellHubBuy = getRawHubPrices(sellRegionId)?.[product_id]?.buy || 0;
      const sd = HP.depthFor(getRawHubPrices(sellRegionId), product_id);
      sellOrdersSeen = sd && Number.isFinite(sd.total) ? sd.total : null;
    } else {
      const precompSell = await dbGet(
        'SELECT sell_price FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, sellRegionId]
      );
      unitSell = precompSell?.sell_price || 0;
      if (!regionWarmingSet.has(sellRegionId)) {
        regionWarmingSet.add(sellRegionId);
        fetchRegionPrices(sellRegionId)
          .then(prices => setRegionPriceCache(sellRegionId, prices))
          .catch(() => {})
          .finally(() => regionWarmingSet.delete(sellRegionId));
      }
    }

    const productUnits = (blueprint.product_quantity || 1) * runs;
    const sellPrice    = unitSell * productUnits;

    // ── Sales fees (broker fee + transaction tax) ─────────────────────────
    // Standings are looked up by sell hub — that is where the order is placed. If the sell hub
    // has none listed and the price is Jita's, the sale (and its fees and freight) is at Jita.
    const sellFromJita = sellScope === 'jita';
    const feeRegionId  = sellFromJita ? 10000002 : sellRegionId;
    const {
      brokerFeeRate, transactionTaxRate,
      brokerRelations, accounting, factionStanding, corpStanding,
    } = calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[feeRegionId], HUB_STRUCTURE_FEES[feeRegionId] ?? null);

    const brokerFee      = sellPrice * brokerFeeRate;
    const transactionTax = sellPrice * transactionTaxRate;
    const totalSalesTax  = brokerFee + transactionTax;

    // ── Haulage (Box 5) — Phase 2 ─────────────────────────────────────────
    // Supports user_defined (ISK/m³, ISK/jump, flat), red_frog, black_frog,
    // pushx, and self_haul methods.
    // Requires packaged_volume in items table (populated by sde-import.js).
    // Silently returns 0 when volumes or rates are absent — no breaking change.
    const haulEnabled = !!(settings?.haul_enabled);
    const { leg1Cost, leg2Cost, leg1VolM3, leg2VolM3, leg1EffM3, leg2EffM3,
            leg1Contracts, leg2Contracts, leg1Jumps, leg2Jumps,
            legJCost, legJVolM3, legJJumps, legJRouteKnown, leg1RouteKnown, leg2RouteKnown } =
      await calcHaulLegs({ haulEnabled, settings, matRegionId, sellRegionId: feeRegionId, materials, meFactor, blueprint, product_id, runs,
                           materialSourcing: matWarm ? materialSourcing : null });
    const totalHaulCost = leg1Cost + leg2Cost + legJCost;
    const leg1Method = settings?.leg1_method || 'user_defined';
    const leg2Method = settings?.leg2_method || 'user_defined';

    // ── Invention overhead (T2 items only) ────────────────────────────────
    const inventionCostData = await calcInventionCost({
      invParent, decr, decryptor_type, skillMap, settings, targetSystemId,
      adjustedPrices, costIndices, matWarm, matEntry, runs, invention_prob_bonus,
    });
    const inventionTotal = inventionCostData?.total || 0;

    // ── True profit ────────────────────────────────────────────────────────
    const trueProfit = sellPrice - brokerFee - transactionTax - totalMaterialCost - totalJobCost - totalHaulCost - inventionTotal;
    const trueMargin = sellPrice > 0 ? (trueProfit / sellPrice) * 100 : 0;

    // ── Effective build time + ISK/hr (v1.17.0) ───────────────────────────
    // Manufacturing time stacks multiplicatively: TE × Industry × Advanced
    // Industry × structure TE bonus × Beancounter (BX) implant. This is where
    // industry implants actually affect profitability (throughput), not material cost.
    const baseBuildSeconds   = (blueprint.build_time || 0) * runs;
    const industryLvl        = skillMap[3380] || 0;          // Industry: -4%/lvl mfg time
    const advIndustryLvl     = skillMap[3388] || 0;          // Advanced Industry: -3%/lvl all jobs
    const structureTeBonus   = (setup.structure && !isReaction) ? (1 - setup.structure.timeMult) * 100 : 0;
    // Best manufacturing-time implant the character has plugged in (if any).
    const mfgImplant = isReaction ? null : ((implants || [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'mfg_time')
      .sort((a, b) => b.pct - a.pct)[0] || null);
    // Skills + blueprint TE + structure and the rigs covering this product (their TE bonus
    // was previously ignored) + implant, via the shared module. Science skills the blueprint
    // requires each cut manufacturing time 1%/level. Reactions: Reactions skill + Advanced Industry only.
    const requiredSkills = isReaction ? [] : await dbAll(
      'SELECT skill_id FROM blueprint_skills WHERE blueprint_id = ? AND activity_id = 1',
      [blueprint.blueprint_id]
    );
    const timeMult = isReaction
      ? IM.reactionTimeMultiplier({ skillMap })
      : IM.timeMultiplier({
          skillMap, requiredSkills, blueprintTe: baseTE || 0,
          modsTimeMult: mods.timeMult, implantPct: mfgImplant ? mfgImplant.pct : 0,
        });

    const effectiveBuildSeconds = baseBuildSeconds * timeMult;
    const buildHours  = effectiveBuildSeconds / 3600;
    const iskPerHour  = buildHours > 0 ? trueProfit / buildHours : 0;

    // Reprocessing implant (informational — FORGE prices materials at market, not reprocess yield)
    const reprocImplant = (implants || [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'reprocessing')
      .sort((a, b) => b.pct - a.pct)[0] || null;

    const STRUCTURE_LABELS = { 35825: 'Raitaru', 35826: 'Azbel', 35827: 'Sotiyo' };
    const structureLabel = settings?.structure_type_id
      ? (STRUCTURE_LABELS[settings.structure_type_id] || 'Engineering Complex')
      : 'NPC Station';

    res.json({
      product_id,
      runs,
      sell_price: sellPrice,

      // Box 1 — materials (source hub sell price, ME-adjusted)
      total_material_cost: totalMaterialCost,

      // Box 2 — manufacturing fees
      mfg_fees: {
        total:                totalJobCost,
        system_cost_index:    systemJobCost,
        system_cost_bonuses:  0,   // placeholder — structure/rig cost bonuses not yet modelled
        facility_tax:         facilityTaxCost,
        scc_surcharge:        sccSurcharge,
        alpha_clone_tax:      0,   // Alpha clones pay extra 2% but FORGE only targets Omega
        estimated_item_value: eiv,
        effective_me_pct:     effectiveME,  // for tooltip display
      },

      // Box 3 — sales fees
      sales_tax: {
        total:                    totalSalesTax,
        broker_fee:               brokerFee,
        broker_fee_rate:          brokerFeeRate,
        broker_relations_level:   brokerRelations,
        faction_standing:         factionStanding,
        corp_standing:            corpStanding,
        transaction_tax:          transactionTax,
        transaction_tax_rate:     transactionTaxRate,
        accounting_level:         accounting,
      },

      // Box 5 — haulage (Phase 2)
      haul_cost: {
        total:                     totalHaulCost,
        leg1_cost:                 leg1Cost,
        leg2_cost:                 leg2Cost,
        // Import leg: Jita → build system for what the buy hub can't supply (Leg 1 settings).
        import_leg_cost:           legJCost,
        import_leg_volume_m3:      legJVolM3,
        import_leg_jumps:          legJJumps,
        import_leg_route_known:    legJRouteKnown,
        leg1_route_known:          leg1RouteKnown,
        leg2_route_known:          leg2RouteKnown,
        leg2_configured:           haulEnabled && (leg2Method !== 'user_defined'
                                     || (settings?.leg2_haul_rate || 0) > 0 || (settings?.leg2_isk_per_jump || 0) > 0
                                     || (settings?.leg2_flat_total || 0) > 0),
        haul_enabled:              haulEnabled,
        leg1_configured:           haulEnabled && (leg1Method !== 'user_defined'
                                     || (settings?.leg1_haul_rate || 0) > 0 || (settings?.leg1_isk_per_jump || 0) > 0
                                     || (settings?.leg1_flat_total || 0) > 0),
        leg1_volume_m3:            leg1VolM3,
        leg2_volume_m3:            leg2VolM3,
        // Phase 1 compat: leg1_rate / leg2_rate = raw ISK/m³ from user_defined
        leg1_rate:                 settings?.leg1_haul_rate || 0,
        leg2_rate:                 settings?.leg2_haul_rate || 0,
        // Phase 2 fields
        leg1_method:               leg1Method,
        leg2_method:               leg2Method,
        leg1_jumps:                leg1Jumps,
        leg2_jumps:                leg2Jumps,
        leg1_isk_per_m3_effective: leg1EffM3,
        leg2_isk_per_m3_effective: leg2EffM3,
        leg1_contracts:            leg1Contracts,
        leg2_contracts:            leg2Contracts,
        leg1_collateral:           settings?.leg1_collateral || 0,
        leg2_collateral:           settings?.leg2_collateral || 0,
        leg1_service_label:        settings?.leg1_service_label || null,
        leg2_service_label:        settings?.leg2_service_label || null,
        leg1_self_ship:            settings?.leg1_self_ship || null,
        leg2_self_ship:            settings?.leg2_self_ship || null,
        provider_rates_as_of:      leg1Method in HAUL_PROVIDERS || leg2Method in HAUL_PROVIDERS
                                     ? (HAUL_PROVIDERS[leg1Method] || HAUL_PROVIDERS[leg2Method])?.rates_as_of
                                     : null,
      },

      // Box 4b — invention overhead (T2 items only; null for T1/reaction products)
      invention_cost: inventionCostData,

      // Box 4 + summary — true profit
      true_profit: trueProfit,
      true_margin: trueMargin,

      // Throughput — effective build time + ISK/hr (v1.17.0).
      // Where industry implants actually affect profitability.
      time: {
        base_build_seconds:      baseBuildSeconds,
        effective_build_seconds: Math.round(effectiveBuildSeconds),
        isk_per_hour:            iskPerHour,
        te_pct:                  te || 0,
        industry_level:          industryLvl,
        advanced_industry_level: advIndustryLvl,
        structure_te_bonus_pct:  structureTeBonus,
        time_multiplier:         timeMult,   // blueprint TE × skills (incl. science) × structure × applicable rigs × implant
        mfg_implant:    mfgImplant   ? { name: mfgImplant.name,   pct: mfgImplant.pct }   : null,
        reproc_implant: reprocImplant ? { name: reprocImplant.name, pct: reprocImplant.pct } : null,
      },

      region_id:        regionId,
      prices_warm:      pricesWarm,
      setup_configured: !!(settings?.system_id),
      manufacturing_setup: {
        system_id:          settings?.system_id         || null,
        system_name:        settings?.system_name       || 'Not configured — using Jita IV',
        structure_type_id:  settings?.structure_type_id || null,
        structure_label:    structureLabel,
        rig_ids:            rigIds,
        facility_tax_pct:   settings?.facility_tax      || 0,
        sci_raw:            sci,
        // Effective ME breakdown (v1.9.3)
        // For T2 items blueprint_me = T2 BPC base ME (-4) + decryptor.me; for T1 = researched BPO ME.
        is_t2:              !!invParent,
        blueprint_me:       baseME,         // combined T2 BPC ME (base + decryptor); T1 = researched BPO ME
        t2_base_me:         invParent ? T2_BPC_BASE_ME : null,
        decryptor_me_bonus: invParent ? decr.me : null,
        structure_me_bonus: structureMeBonus,
        rig_me_bonus:       rigMeBonus,
        effective_me:       effectiveME,
        // Real mechanics (lib/industry-math.js): the one multiplier every material quantity uses,
        // and exactly which saved rigs applied to this product with their true (security-scaled) stats.
        material_multiplier: meFactor,
        structure_cost_mult: mods.costMult,
        system_security:     sysRow ? sysRow.security_status : null,
        security_class:      setup.secClass,
        security_known:      setup.securityKnown,
        product_family:      mods.family,
        product_family_known: mods.familyKnown,
        invalid_rig_ids:     setup.invalidRigIds,
        ignored_rig_ids:     setup.ignoredRigIds,   // real rigs that can't apply (wrong size / NPC station / over 3)
        rigs: setup.rigs.map(r => {
          const ap = mods.appliedRigs.find(a => a.id === r.id);
          return {
            id: r.id, name: r.name, size: r.size,
            applies: !!ap,
            // what THIS item gets from the rig, at the system's security (0 when it doesn't cover the item)
            base_me_pct: ap ? ap.baseMatPct : (r.matPct || r.thukkerMatPct), eff_me_pct: ap ? ap.usedMatPct : 0,
            base_te_pct: r.timePct, eff_te_pct: ap ? ap.usedTimePct : 0,
            security_mult: r.secMult,
          };
        }),
      },

      // Data provenance — so the UI can say when a figure leans on an assumption.
      skills_source:     skillsSource,       // 'session' | 'snapshot' | 'none' (none ⇒ level-0 fees/times)
      skills_updated_at: skillsUpdatedAt,
      // Where the finished item's price came from: 'hub'/'region' = the sell hub's own lowest sell;
      // 'jita' = nothing listed at the sell hub, so Jita's lowest sell (and the sale is assumed at Jita).
      sell_price_scope:  sellWarm ? sellScope : null,
      sell_hub_id:       feeRegionId,
      sell_listing: sellWarm ? {
        units_listed:     sellOrdersSeen,           // units for sale at the sell hub (null = unknown)
        hub_highest_buy:  sellHubBuy,
        spread_ratio:     sellHubBuy > 0 ? (unitSell / sellHubBuy) : null,
      } : null,
      // Of the hub's OWN prices: how many were the hub station vs the region-wide fallback.
      material_price_scope: matWarm
        ? (() => {
            const ms = materials.map(m => rawHubPrices?.[m.material_id]?.sellScope);
            return { hub: ms.filter(x => x === 'hub').length, region: ms.filter(x => x === 'region').length };
          })()
        : null,
      // How each material was priced (hub own orders / imported from Jita / short on both).
      material_sourcing: matWarm ? {
        lines:        materialSourcing,
        jita_lines:   materialSourcing.filter(l => l.scope === 'jita').length,
        mixed_lines:  materialSourcing.filter(l => l.scope === 'mixed').length,
        short_lines:  materialSourcing.filter(l => l.short_stock).length,
        import_cost:  materialSourcing.reduce((a, l) => a + l.import_cost, 0),
        jita_unavailable: !rawJitaPrices && matRegionId !== 10000002,
      } : null,
    });

  } catch (err) {
    logger.error('True cost error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});


// ── Scheduled corp data refresh ──────────────────────────────────────────────
// Runs every 4 hours to keep corp data current without hammering ESI.
// Staggered 500ms apart per corp to avoid simultaneous ESI bursts.
setInterval(async () => {
  try {
    const configs = await dbAll('SELECT corp_id FROM corp_config');
    if (!configs.length) return;
    configs.forEach((cfg, i) => {
      setTimeout(async () => {
        try {
          logger.info(`⟳ Scheduled corp data refresh for corp ${cfg.corp_id}...`);
          await refreshCorpData(cfg.corp_id);
        } catch (err) {
          logger.error(`⚠ Scheduled corp refresh failed for corp ${cfg.corp_id}: ${err.message}`);
        }
      }, i * 500);
    });
  } catch (err) {
    logger.error(`⚠ Scheduled corp refresh failed: ${err.message}`);
  }
}, 4 * 60 * 60 * 1000); // every 4 hours

// ── Login and "Remember my characters" ────────────────────────────────────────
app.use(require('./routes/auth'));

// ── Session upload (assets, blueprints, skills, jobs) ─────────────────────────
app.use(require('./routes/session')({ cacheStructureToken }));

// ── Corp tab ──────────────────────────────────────────────────────────────────
app.use(require('./routes/corp'));

// ── Planetary Interaction and the Queue Planner ──────────────────────────────
app.use(require('./routes/pi'));
app.use(require('./routes/queue-planner'));

// ── AI advisor ────────────────────────────────────────────────────────────────
app.use(require('./routes/ai'));

// ── LP store, Keepstar, market prices ─────────────────────────────────────────
app.use(require('./routes/lp-store'));
app.use(require('./routes/keepstar'));
app.use(require('./routes/market'));

// ── Station trading ───────────────────────────────────────────────────────────
app.use(require('./routes/trading'));

// ── Small route modules (chat history, ticker config, location lookups, reference data) ──
app.use(require('./routes/chat-history'));
app.use(require('./routes/ticker'));
app.use(require('./routes/locations'));
app.use(require('./routes/reference-data'));

// ── Mfg Setup (industry settings, structure suggestions, fee rates) ───────────
app.use(require('./routes/industry-settings')({ blueprintMaterialsCache }));

// ── Push notification routes ──────────────────────────────────────────────────
const pushRoutes = require('./routes/push');
app.use(pushRoutes({ security, dbRun, dbAll, webpush }));

// ── PI Planner routes ──────────────────────────────────────────────────────────
const piPlannerRoutes = require('./routes/pi-planner');
app.use(piPlannerRoutes({ dbAll, dbGet, security }));

// ── Icon proxy (disk-cached EVE item icons) ───────────────────────────────────
const iconRoutes = require('./routes/icons');
app.use(iconRoutes({ security }));


// START SERVER
initDatabase(DB_PATH).then(async () => {
  // Run v0.9.0 migrations
  await runMigrations();

  // Load 30-day history price map from DB (populated by volume enrichment)
  await loadHistoryPriceMap();

  // Load static SDE caches — must run before loadHubSnapshots (refreshHubNameMap uses globalItemNameMap)
  await loadGlobalItemNameMap();
  await loadBlueprintMaterialsCache();
  await loadSkillSnapshots();

  // Resolve decryptor type_ids from items table for market price lookups
  const decryptorNames = Object.values(DECRYPTORS).map(d => d.name).filter(Boolean);
  if (decryptorNames.length) {
    const placeholders = decryptorNames.map(() => '?').join(',');
    const rows = await dbAll(`SELECT type_id, name FROM items WHERE name IN (${placeholders})`, decryptorNames);
    for (const row of rows) {
      const key = Object.keys(DECRYPTORS).find(k => DECRYPTORS[k].name === row.name);
      if (key) decryptorTypeIds[key] = row.type_id;
    }
    logger.info(`✓ Decryptor type IDs resolved: ${Object.keys(decryptorTypeIds).join(', ')}`);
  }

  // Load hub book snapshots so the trading scanner has instant data before the first live poll.
  await loadHubSnapshots();

  // Pre-warm all manufacturing region price caches so the first user request after restart
  // never hits prices_warm=false. Re-warm every 55 min to stay ahead of the 1-hour TTL.
  warmAllRegions().catch(err => logger.warn('⚠ Initial region price warm failed:', err.message));
  setInterval(() => {
    warmAllRegions().catch(err => logger.warn('⚠ Region price refresh failed:', err.message));
  }, 55 * 60 * 1000);

  // prevent idle-stop from firing before any real user request arrives.
  markTradingActivity();
  ensureHubPollerRunning('jita');

  // Keepstar history poller — run once at startup then every 4 hours
  pollKeepstarHistory();
  setInterval(pollKeepstarHistory, KS_POLL_INTERVAL_MS);

  app.use(createErrorHandler({ logger, clientErrMsg })); // must stay after every route

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`
╔════════════════════════════════════════════╗
║      F.O.R.G.E. Server v1.0.0.0 Running      ║
║     http://localhost:${PORT}               ║
║     Database: SQLite                        ║
║     Security: ENABLED ✓                     ║
║     Pre-Compute: ENABLED ✓                  ║
║     4-Tier + Severity: ENABLED ✓            ║
║     AI Tracking: ENABLED ✓                  ║
╚════════════════════════════════════════════╝
`);

    // Run pre-compute on startup (delayed 10s to let ESI warm up)
    setTimeout(() => {
      logger.info('⟳ Running initial pre-compute...');
      runPreCompute().then(result => {
        logger.info('✓ Initial pre-compute:', result.status);
        
        // After pre-compute completes, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            logger.info('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              logger.info('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              logger.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000); // 5 second delay after pre-compute
        }
      }).catch(err => {
        logger.error('⚠ Initial pre-compute failed:', err.message);
      });
    }, 10000);

    // Schedule pre-compute every 6 hours
    // (Daily would be fine, but 6-hourly keeps prices fresher without ESI abuse)
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      logger.info('⟳ Scheduled pre-compute starting...');
      runPreCompute().then(result => {
        logger.info('✓ Scheduled pre-compute:', result.status);
        
        // After scheduled pre-compute, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            logger.info('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              logger.info('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              logger.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000);
        }
      }).catch(err => {
        logger.error('⚠ Scheduled pre-compute failed:', err.message);
      });
    }, SIX_HOURS);

    // ── Contract price ingest — weekly (contract-only stock is slow-moving) ──
    const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
    // Initial run 30s after start, only if the cache is empty or older than a week.
    setTimeout(async () => {
      try {
        const row  = await dbGet('SELECT MAX(computed_at) AS last FROM contract_prices WHERE region_id = ?', [CONTRACT_INGEST_REGION]);
        const last = row?.last ? Date.parse(row.last) : 0;
        if (!last || (Date.now() - last) > ONE_WEEK) {
          logger.info('⟳ Running initial contract ingest...');
          ingestRegionContracts().then(r => logger.info('✓ Initial contract ingest:', r.status));
        } else {
          logger.info(`✓ Contract prices fresh (computed ${row.last}) — skipping initial ingest`);
        }
      } catch (err) {
        logger.error('⚠ Contract ingest startup check failed:', err.message);
      }
    }, 30000);
    setInterval(() => {
      logger.info('⟳ Scheduled weekly contract ingest...');
      ingestRegionContracts()
        .then(r => logger.info('✓ Weekly contract ingest:', r.status))
        .catch(err => logger.error('⚠ Weekly contract ingest failed:', err.message));
    }, ONE_WEEK).unref();

    // Push job completion checker — polls every 5 minutes for finished industry jobs
    if (webpush) {
      setInterval(() => {
        pushRoutes.checkJobCompletions({ dbRun, dbAll, webpush })
          .catch(err => logger.error('⚠ Push job check failed:', err.message));
      }, 5 * 60 * 1000).unref();
      logger.info('✓ Push notification job checker: running every 5 minutes');
    }
  });

  // Error handler must be after all routes
  app.use(security.errorHandler);
  
}).catch(err => {
  logger.error('Failed to start server:', err.message);
  process.exit(1);
});
