'use strict';
// The profit lists: top products per hub (all, and filtered by what the character can build), search, and the inter-hub
// arbitrage / haul views. All read from the pre-computed table.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const fetch = require('node-fetch');
const { buildTopProfitableQuery } = require('../lib/profit-query'); // hub prices: own orders first, Jita fallback (always tagged), order depth
const { dbAll, dbGet } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { getCached } = require('../lib/cache');
const { HUB_CONFIG, HUB_STANDINGS, HUB_STRUCTURE_FEES, HUB_SYSTEM_IDS, REGIONS, REGION_TO_HUB, VALID_REGIONS } = require('../lib/hubs');
const { getCharacterSession, calcSalesFeeRates } = require('../lib/character-session');
const { calcLegHaulCost, getJumpCount } = require('../lib/haul');
const { hubBooks } = require('../lib/hub-pollers');

const router = express.Router();

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

router.get('/api/top-profitable', security.apiLimiter, async (req, res) => {
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

router.get('/api/top-profitable-by-skills', security.apiLimiter, security.verifyEveToken, async (req, res) => {
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
router.get('/api/search-profitable', security.apiLimiter, async (req, res) => {
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
router.get('/api/inter-hub-arb', security.apiLimiter, async (req, res) => {
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
router.get('/api/inter-hub-item-profitable', security.apiLimiter, async (req, res) => {
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
router.get('/api/inter-hub-haul', security.apiLimiter, security.verifyEveToken, async (req, res) => {
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

module.exports = router;
