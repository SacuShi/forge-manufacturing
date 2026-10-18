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
const { buildTopProfitableQuery } = require('./lib/profit-query');   // hub prices: own orders first, Jita fallback (always tagged), order depth

// ── PATH-SENSITIVE LINES — DO NOT CHANGE TO RELATIVE PATHS ──────────────────
// PM2's cwd is unreliable. These three lines MUST use __dirname.
// Using bare relative paths causes a silent outage: server starts and responds
// 404/500 but env vars are missing. This has caused three production outages (June 2026).
// Do not 'simplify' these. Any agent or developer who removes __dirname here is wrong.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const config = require('./lib/config');
const logger = require('./lib/logger');
const { forwardRejectionsOn, createErrorHandler, clientErrMsg } = require('./lib/http-errors');
const database = require('./lib/db');
const { initDatabase, dbAll, dbGet, dbRun, dbTxMutex } = database;
const { runMigrations } = require('./lib/migrations');
const { getCached } = require('./lib/cache');
const {
  HUB_CONFIG, HUB_STRUCTURE_FEES, REGION_TO_HUB, VALID_REGIONS, REGIONS, HUB_STANDINGS, HUB_SYSTEM_IDS,
  
} = require('./lib/hubs');
const { calcLegHaulCost, getJumpCount } = require('./lib/haul');
const { DECRYPTORS, decryptorTypeIds } = require('./lib/invention');
const { CONTRACT_INGEST_REGION, ingestRegionContracts } = require('./lib/contracts');
const { runPreCompute } = require('./lib/precompute');
const { runVolumeEnrichment } = require('./lib/volume-enrichment');
const jobState = require('./lib/job-state'); // flags of the long-running background jobs
const market = require('./lib/market-cache'); // live values (historyPriceMap, name maps, jitaPricesCacheExpiry) are read as market.<name>
const { hubBooks, ensureHubPollerRunning, loadHubSnapshots, markTradingActivity } = require('./lib/hub-pollers');
const {
  warmAllRegions, loadHistoryPriceMap, loadGlobalItemNameMap,
  loadBlueprintMaterialsCache, blueprintMaterialsCache,
} = market;
const { refreshCorpData } = require('./lib/corp');
const {
  _ksTkPool, cacheStructureToken, pollKeepstarHistory, KS_POLL_INTERVAL_MS,
} = require('./lib/keepstar-token');
const {
  loadSkillSnapshots, getCharacterSession, calcSalesFeeRates,
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

// ── Item pages and blueprint profitability ────────────────────────────────────
app.use(require('./routes/items'));
app.use(require('./routes/profitability'));

// ── True Profit ───────────────────────────────────────────────────────────────
app.use(require('./routes/true-cost'));

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
