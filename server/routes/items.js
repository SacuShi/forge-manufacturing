'use strict';
// Item pages: type-name lookups, a single item's price and blueprint, and the full item panel (build, buy, invent, sell).

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const HP = require('../lib/hub-price');
const { dbAll, dbGet, dbRun, dbTxMutex } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { clientErrMsg } = require('../lib/http-errors');
const { cache } = require('../lib/cache');
const { REGIONS, KEEPSTAR_STRUCTURE_ID, KEEPSTAR_REGION_ID } = require('../lib/hubs');
const { CONTRACT_INGEST_REGION, contractRationale } = require('../lib/contracts');
const market = require('../lib/market-cache'); // live values (historyPriceMap, ...) are read as market.<name>
const {
  regionPriceCache, getHubPrices, getRawHubPrices, getRawJitaPrices, kickRegionWarm,
  blueprintMaterialsCache,
} = market;

const router = express.Router();

// Resolve type names via ESI for any type_ids missing from the items table.
// Saves resolved names back to the DB so subsequent calls are instant.
router.post('/api/resolve-type-names', security.apiLimiter, async (req, res) => {
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

// GET JITA PRICE - Single item price lookup from cache
// Used by AI tool to query prices on-demand
router.post('/api/get-price', security.apiLimiter, async (req, res) => {
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
router.post('/api/get-blueprint', security.apiLimiter, async (req, res) => {
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
router.post('/api/item-details', security.apiLimiter, async (req, res) => {
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

module.exports = router;
