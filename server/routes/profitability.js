'use strict';
// Profitability analysis for owned blueprints: ranking, production chains, material breakdowns, ME research return on
// investment, per-blueprint profit, material stock checks and the appraisal tool.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const HP = require('../lib/hub-price');
const { dbAll, dbGet } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { CACHE_TTL_MS } = require('../lib/cache');
const { HUB_CONFIG, REGION_TO_HUB, VALID_REGIONS } = require('../lib/hubs');
const { hubBooks } = require('../lib/hub-pollers');
const market = require('../lib/market-cache'); // live values (historyPriceMap, ...) are read as market.<name>
const {
  regionPriceCache, setRegionPriceCache, getHubPrices, getRawHubPrices, getRawJitaPrices, fetchRegionPrices, kickRegionWarm, regionWarmingSet,
  blueprintMaterialsCache, productToBlueprintCache,
} = market;

const router = express.Router();

// CALCULATE PROFITABILITY - Server-side pre-calculation
// Returns only top N profitable items
router.post('/api/calculate-profitability', security.apiLimiter, async (req, res) => {
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
router.post('/api/production-chain', security.apiLimiter, async (req, res) => {
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

router.post('/api/material-breakdown', security.apiLimiter, async (req, res) => {
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

router.post('/api/me-research-roi', security.apiLimiter, async (req, res) => {
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

router.post('/api/analyze-blueprints', security.apiLimiter, async (req, res) => {
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
router.post('/api/blueprint-profits', security.apiLimiter, async (req, res) => {
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
router.post('/api/material-stock-check', security.apiLimiter, async (req, res) => {
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
router.post('/api/appraise', security.apiLimiter, (req, res) => {
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

module.exports = router;
