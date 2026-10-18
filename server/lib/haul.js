'use strict';
// Hauling costs: freight-provider fees, the cost of one leg by flat rate / per jump / service / self-haul, jump counts
// from ESI, and the two-leg (source hub -> build -> sell hub) total used by True Profit and the profit lists.

const logger = require('./logger');
const IM = require('./industry-math');
const { dbAll, dbGet } = require('./db');
const { esiFetch } = require('./esi');
const { HUB_SYSTEM_IDS } = require('./hubs');

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

module.exports = { HAUL_PROVIDERS, calcLegHaulCost, getJumpCount, calcHaulLegs };
