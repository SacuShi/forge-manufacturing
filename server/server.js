// F.O.R.G.E. Server v1.0.0.0
// All blueprint/item data from SQLite, not APIs
// Pre-computed profitability + 4-tier filtering with severity levels (CRITICAL vs WARNING)
// + Comprehensive security: auth, rate limiting, input validation

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const helmet = require('helmet');
const security = require('./forge-security');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust Cloudflared proxy
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://login.eveonline.com", "https://esi.evetech.net", "https://evetycoon.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: ["'self'", "data:"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS - restrict to your domain only
app.use(cors({
  origin: ['https://forge-ukc.com', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '5mb' })); // Allows session data upload (assets/blueprints)
app.use(express.static('public'));

// SQLite Database
const DB_PATH = path.join(__dirname, '../forge-db/forge.db');
let db;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ Database not found. Run seed script first:');
        console.log('   mkdir -p ../forge-db');
        console.log('   cd ../forge-db && node seed.js');
        reject(err);
      } else {
        console.log('✓ Connected to SQLite database');
        resolve();
      }
    });
  });
}

// Database helpers
const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

// DATABASE MIGRATION (v0.9.0)
async function runMigrations() {
  console.log('⟳ Running database migrations...');

  // Pre-computed profitability table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS precomputed_profits (
      blueprint_id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      material_cost REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      buy_price REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      profit_margin REAL DEFAULT 0,
      isk_per_hour REAL DEFAULT 0,
      build_time INTEGER DEFAULT 0,
      material_count INTEGER DEFAULT 0,
      computed_at TEXT NOT NULL,
      price_source TEXT DEFAULT 'jita',
      avg_daily_volume REAL DEFAULT NULL,
      market_group_id INTEGER DEFAULT NULL,
      liquidity_risk TEXT DEFAULT NULL
    )
  `);

  // Index for common queries
  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_profit
    ON precomputed_profits (profit DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_margin
    ON precomputed_profits (profit_margin DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_isk_hr
    ON precomputed_profits (isk_per_hour DESC)
  `);

  // AI usage tracking table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      query_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_ai_usage_date
    ON ai_usage (created_at)
  `);

  // Pre-compute metadata table (tracks job runs)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS precompute_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      blueprints_processed INTEGER DEFAULT 0,
      duration_seconds REAL DEFAULT 0,
      status TEXT DEFAULT 'running',
      error TEXT
    )
  `);

  // meta_level on items (populated by sde-import.js)
  try { await dbRun(`ALTER TABLE items ADD COLUMN meta_level INTEGER DEFAULT 0`); } catch (_) {}

  // activity_id on blueprints (1=manufacturing, 9=reaction — populated by sde-import.js)
  try { await dbRun(`ALTER TABLE blueprints ADD COLUMN activity_id INTEGER DEFAULT 1`); } catch (_) {}

  // activity_id on precomputed_profits
  try { await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN activity_id INTEGER DEFAULT 1`); } catch (_) {}

  // v0.9.1 migration: Add volume/market columns to existing tables
  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN avg_daily_volume REAL DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN market_group_id INTEGER DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN liquidity_risk TEXT DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  // v1.1 migration: Multi-region precomputed profits
  // Recreate table with composite PRIMARY KEY (blueprint_id, region_id).
  // Data is ephemeral — the precompute job repopulates immediately after restart.
  const hasRegionId = await dbGet(
    `SELECT 1 FROM pragma_table_info('precomputed_profits') WHERE name = 'region_id'`
  );
  if (!hasRegionId) {
    console.log('⟳ v1.1 migration: recreating precomputed_profits with multi-region schema...');
    await dbRun('DROP TABLE IF EXISTS precomputed_profits');
    await dbRun(`
      CREATE TABLE precomputed_profits (
        blueprint_id    INTEGER NOT NULL,
        region_id       INTEGER NOT NULL DEFAULT 10000002,
        product_id      INTEGER NOT NULL,
        product_name    TEXT,
        material_cost   REAL    DEFAULT 0,
        sell_price      REAL    DEFAULT 0,
        buy_price       REAL    DEFAULT 0,
        profit          REAL    DEFAULT 0,
        profit_margin   REAL    DEFAULT 0,
        isk_per_hour    REAL    DEFAULT 0,
        build_time      INTEGER DEFAULT 0,
        material_count  INTEGER DEFAULT 0,
        computed_at     TEXT    NOT NULL DEFAULT '',
        price_source    TEXT    DEFAULT 'jita',
        avg_daily_volume REAL   DEFAULT NULL,
        market_group_id  INTEGER DEFAULT NULL,
        liquidity_risk   TEXT   DEFAULT NULL,
        activity_id      INTEGER DEFAULT 1,
        PRIMARY KEY (blueprint_id, region_id)
      )
    `);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_profit  ON precomputed_profits (region_id, profit DESC)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_margin  ON precomputed_profits (region_id, profit_margin DESC)`);
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_isk_hr  ON precomputed_profits (region_id, isk_per_hour DESC)`);
    console.log('✓ precomputed_profits migrated to multi-region schema');
  }

  // v1.2.0 migration: Industry settings per character
  await dbRun(`
    CREATE TABLE IF NOT EXISTS character_industry_settings (
      character_id           INTEGER PRIMARY KEY,
      system_id              INTEGER DEFAULT NULL,
      system_name            TEXT    DEFAULT NULL,
      structure_type_id      INTEGER DEFAULT NULL,   -- NULL = NPC station
      rig_ids                TEXT    DEFAULT '[]',   -- JSON array of rig type_ids
      facility_tax           REAL    DEFAULT 0.0,    -- 0.0–1.0 decimal (not %)
      updated_at             TEXT    NOT NULL DEFAULT ''
    )
  `);

  console.log('✓ Database migrations complete');
}

// Simple cache
const cache = new Map();
const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCached = (key, data, ttl = 3600000) => {
  cache.set(key, { data, expiry: Date.now() + ttl });
};

// PAGINATED REGION PRICE FETCHER
// Fetches complete order book from ESI for any region (handles pagination)
async function fetchRegionPrices(regionId) {
  console.log(`⟳ Fetching prices for region ${regionId}...`);
  const startTime = Date.now();

  const buyOrders = [];
  const sellOrders = [];

  // Fetch all pages of sell orders
  for (let page = 1; page <= 200; page++) {
    try {
      const res = await fetch(
        `https://esi.evetech.net/latest/markets/${regionId}/orders/` +
        `?datasource=tranquility&order_type=sell&page=${page}`
      );
      if (!res.ok) {
        console.warn(`⚠ Sell orders page ${page} returned ${res.status}, stopping pagination`);
        break;
      }
      const data = await res.json();
      if (!data || data.length === 0) break;
      sellOrders.push(...data);
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`⚠ Error fetching sell orders page ${page}:`, err.message);
      break;
    }
  }

  // Fetch all pages of buy orders
  for (let page = 1; page <= 200; page++) {
    try {
      const res = await fetch(
        `https://esi.evetech.net/latest/markets/${regionId}/orders/` +
        `?datasource=tranquility&order_type=buy&page=${page}`
      );
      if (!res.ok) {
        console.warn(`⚠ Buy orders page ${page} returned ${res.status}, stopping pagination`);
        break;
      }
      const data = await res.json();
      if (!data || data.length === 0) break;
      buyOrders.push(...data);
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`⚠ Error fetching buy orders page ${page}:`, err.message);
      break;
    }
  }

  // Process into prices map
  const prices = {};

  sellOrders.forEach(o => {
    if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
    if (o.price < prices[o.type_id].sell) prices[o.type_id].sell = o.price;
  });

  buyOrders.forEach(o => {
    if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
    if (o.price > prices[o.type_id].buy) prices[o.type_id].buy = o.price;
  });

  // Apply outlier filtering and calculate median
  Object.keys(prices).forEach(typeId => {
    const p = prices[typeId];
    if (p.sell === Infinity) p.sell = 0;
    if (p.buy > 0 && p.sell > p.buy * 5) {
      const marginPercent = ((p.sell / p.buy) - 1) * 100;
      console.warn(`⚠ Outlier filtered: typeId ${typeId} margin=${marginPercent.toFixed(0)}% (max 500%)`);
      p.median = p.buy;
    } else if (p.buy === 0 && p.sell > 100000000) {
      console.warn(`⚠ No-bid outlier: typeId ${typeId} sell=${p.sell} (no buy orders, likely scam)`);
      p.median = p.sell * 0.1;
    } else {
      p.median = (p.sell + p.buy) / 2;
    }
  });

  const durationMs = Date.now() - startTime;
  console.log(`✓ Region ${regionId} prices loaded — ${Object.keys(prices).length} items ` +
              `(${buyOrders.length} buy orders, ${sellOrders.length} sell orders) ` +
              `in ${(durationMs / 1000).toFixed(1)}s`);

  return prices;
}

// EVE OAUTH
app.post('/api/eve-token', security.authLimiter, async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: "Missing code or redirect_uri" });
    }

    const clientId = process.env.EVE_CLIENT_ID;
    const clientSecret = process.env.EVE_CLIENT_SECRET;

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'login.eveonline.com'
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirect_uri)}`
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("EVE OAuth error:", tokenData);
      return res.status(400).json({ error: tokenData.error_description || "Token exchange failed" });
    }

    console.log("✓ EVE OAuth successful");
    res.json(tokenData);

  } catch (err) {
    console.error("OAuth error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// JITA PRICES (Buy/Sell/Median) - Hourly Cache
// Per-region price cache (Map: regionId -> { prices, expiry })
// v0.9.4: Only Jita (10000002) is populated. v1.1 will populate multiple regions.
const regionPriceCache = new Map();

// Backwards-compatible accessor for existing code
// jitaPricesCache points to the Jita entry in regionPriceCache
let jitaPricesCacheExpiry = 0; // Keep this for now, used by existing code

Object.defineProperty(global, 'jitaPricesCache', {
  get: () => {
    const entry = regionPriceCache.get(10000002);
    return entry ? entry.prices : null;
  },
  set: (value) => {
    if (value === null) {
      regionPriceCache.delete(10000002);
    } else {
      regionPriceCache.set(10000002, {
        prices: value,
        expiry: Date.now() + (60 * 60 * 1000)
      });
      jitaPricesCacheExpiry = Date.now() + (60 * 60 * 1000);
    }
  },
  configurable: true
});

// SKILL CHECKING HELPER
/**
 * Check if a character can build a blueprint given their trained skills.
 * Returns true only if the character meets ALL skill requirements.
 * characterSkills: Array<{ skill_id, active_skill_level }>
 * blueprintId: blueprint_id from the blueprints table
 */
async function canBuildBlueprint(characterSkills, blueprintId) {
  try {
      let requirements = [];
    try {
      requirements = await dbAll(
        'SELECT skill_id, skill_level FROM blueprint_skills WHERE blueprint_id = ?',
        [blueprintId]
      );
    } catch (skillErr) {
      // Table missing — treat as no requirements (allow all blueprints through)
      return true;
    }

    if (!requirements || requirements.length === 0) return true;

    const skillMap = {};
    characterSkills.forEach(s => {
      skillMap[s.skill_id] = s.active_skill_level || 0;
    });

    for (const req of requirements) {
      const charLevel = skillMap[req.skill_id] || 0;
      if (charLevel < req.skill_level) {
        return false;
      }
    }

    return true;
  } catch (err) {
    console.error('Skill check error:', err.message);
    return false;
  }
}

app.get('/api/jita-prices', security.apiLimiter, async (req, res) => {
  try {
    if (jitaPricesCache && Date.now() < jitaPricesCacheExpiry) {
      console.log(`✓ Jita prices (cached) — ${Object.keys(jitaPricesCache).length} items`);
      return res.json({ prices: jitaPricesCache });
    }

    const prices = await fetchRegionPrices(10000002); // The Forge (Jita)
    jitaPricesCache = prices;
    jitaPricesCacheExpiry = Date.now() + 3600000;
    res.json({ prices });

  } catch (err) {
    console.error('Jita prices error:', err.message);
    if (jitaPricesCache) {
      return res.json({ prices: jitaPricesCache, stale: true });
    }
    res.status(500).json({ error: err.message, prices: {} });
  }
});

const VALID_REGIONS = [
  10000002, // Jita
  10000043, // Amarr
  10000032, // Dodixie
  10000042, // Hek
  10000030, // Rens
  10000041  // Syndicate
];

// Human-readable names for the AI and formatting
const REGION_HUB_NAMES = {
  10000002: 'Jita',
  10000043: 'Amarr',
  10000032: 'Dodixie',
  10000042: 'Hek',
  10000030: 'Rens',
  10000041: 'Syndicate',
};

// NPC corp + faction standings that affect broker fees at each trade hub.
// Used by /api/true-cost to calculate the character-specific broker fee rate.
// corp_id  = NPC corporation that owns the station
// faction_id = NPC faction associated with that hub's space
const HUB_STANDINGS = {
  10000002: { corp_id: 1000035, faction_id: 500001 }, // Jita — Caldari Navy / Caldari State
  10000043: { corp_id: 1000082, faction_id: 500003 }, // Amarr — Imperial Navy / Amarr Empire
  10000032: { corp_id: 1000049, faction_id: 500004 }, // Dodixie — Federation Navy / Gallente Federation
  10000042: { corp_id: 1000070, faction_id: 500002 }, // Hek — Brutor Tribe / Minmatar Republic
  10000030: { corp_id: 1000006, faction_id: 500002 }, // Rens — Brutor Tribe / Minmatar Republic
  10000041: { corp_id: 1000462, faction_id: 500010 }, // Syndicate — Intaki Syndicate (null-sec, no faction bonus)
};

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
    const res = await fetch(
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
    adjustedPriceCache.expiry = Date.now() + 6 * 3600000;
    console.log(`✓ ESI adjusted prices cached — ${Object.keys(map).length} types`);
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
    const res = await fetch(
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
        const r = await fetch('https://esi.evetech.net/latest/universe/names/', {
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
  costIndexCache.expiry  = Date.now() + 3600000;
  console.log(`✓ ESI cost indices + names cached — ${systemIds.length} systems`);
  return sciMap;
}

// Maps EVE skill_id → EVE Ref API query param name.
// Kept for reference — skills affect manufacturing TIME, not job COST.
// Broker Relations (3446) and Accounting (16622) DO affect sales fees (calculated locally).
const SKILL_PARAM_MAP = {
  3380:  'industry',
  3388:  'advanced_industry',
  3397:  'amarr_starship_engineering',
  3396:  'caldari_starship_engineering',
  3395:  'gallente_starship_engineering',
  3394:  'minmatar_starship_engineering',
  11452: 'electromagnetic_physics',
  11453: 'electronic_engineering',
  11454: 'graviton_physics',
  11455: 'high_energy_physics',
  11441: 'hydromagnetic_physics',
  11443: 'laser_physics',
  11442: 'mechanical_engineering',
  11444: 'molecular_engineering',
  11529: 'nanite_engineering',
  11446: 'nuclear_physics',
  11445: 'plasma_physics',
  11448: 'quantum_physics',
  11450: 'rocket_science',
  20424: 'sleeper_technology',
  28164: 'takmahl_technology',
  3392:  'jury_rigging',
  26224: 'capital_ship_construction',
  3400:  'capital_components',
  21790: 'drug_manufacturing',
  3398:  'ammunition_manufacturing',
  3399:  'drones',
  3393:  'mechanics',
  11395: 'frigate_construction',
  11396: 'destroyer_construction',
  11397: 'cruiser_construction',
  11398: 'battlecruiser_construction',
  11399: 'battleship_construction',
  3401:  'outpost_construction',
  11085: 'core_subsystem_technology',
  11086: 'defensive_subsystem_technology',
  11087: 'offensive_subsystem_technology',
  11088: 'propulsion_subsystem_technology',
  52307: 'triglavian_quantum_engineering',
  53280: 'mutagenic_stabilization',
};

/**
 * Returns live buy/sell prices for a single typeId across all 6 trade hubs.
 * Uses regionPriceCache when fresh; fetches + caches if stale or missing.
 * Used by the AI get_price_comparison tool.
 */
async function getItemPricesAllRegions(typeId) {
  const results = [];

  for (const regionId of VALID_REGIONS) {
    let entry = regionPriceCache.get(regionId);
    if (!entry || Date.now() >= entry.expiry) {
      // fetchRegionPrices returns prices but doesn't cache — store explicitly
      const prices = await fetchRegionPrices(regionId);
      regionPriceCache.set(regionId, { prices, expiry: Date.now() + 3600000 });
      entry = regionPriceCache.get(regionId);
    }

    if (!entry) continue;

    const price = entry.prices[typeId];
    if (price) {
      results.push({
        hub_name:          REGION_HUB_NAMES[regionId],
        region_id:         regionId,
        buy_price:         price.buy  || 0,
        sell_price:        price.sell || 0,
        median_price:      price.median || 0,
        volume_available:  0,   // ESI order feed doesn't include volume per-hub
      });
    }
  }

  return results;
}

app.get('/api/prices/:regionId', security.apiLimiter, async (req, res) => {
  try {
    const regionId = parseInt(req.params.regionId);

    if (!VALID_REGIONS.includes(regionId)) {
      return res.status(400).json({ error: 'Invalid region ID' });
    }

    const entry = regionPriceCache.get(regionId);
    if (entry && Date.now() < entry.expiry) {
      console.log(`✓ Region ${regionId} prices (cached) — ${Object.keys(entry.prices).length} items`);
      return res.json({ regionId, prices: entry.prices });
    }

    console.log(`⟳ Fetching region ${regionId} prices from ESI...`);
    const prices = await fetchRegionPrices(regionId);
    regionPriceCache.set(regionId, { prices, expiry: Date.now() + 3600000 });
    res.json({ regionId, prices });

  } catch (err) {
    console.error(`Region ${req.params.regionId} prices error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ITEM NAMES DATABASE - From SQLite
app.get('/api/item-names', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('item_names');
    if (cached) {
      console.log(`✓ Item names (cached) — ${Object.keys(cached).length} items`);
      return res.json({ items: cached });
    }

    console.log('⟳ Loading item names from database...');
    // Load ALL items regardless of published flag — assets can contain containers,
    // mission items and legacy types that have published = 0 in the SDE.
    const rows = await dbAll('SELECT type_id, name FROM items WHERE name IS NOT NULL AND name != \'\'');
    
    const items = {};
    rows.forEach(row => {
      items[row.type_id] = row.name;
    });

    setCached('item_names', items, 86400000); // 24h
    console.log(`✓ Item names loaded — ${Object.keys(items).length} items`);
    res.json({ items });

  } catch (err) {
    console.error('Item names error:', err.message);
    res.status(500).json({ error: err.message, items: {} });
  }
});

// BLUEPRINT DATABASE - From SQLite with Materials
app.get('/api/blueprint-database', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('blueprint_db');
    if (cached) {
      console.log(`✓ Blueprint database (cached) — ${Object.keys(cached).length} blueprints`);
      return res.json({ blueprints: cached });
    }

    console.log('⟳ Loading blueprints from database...');
    
    // Get all blueprints (no JOINs - names resolved client-side)
    const bpRows = await dbAll(`
      SELECT blueprint_id, product_id, build_time
      FROM blueprints
    `);

    const blueprints = {};
    
    for (const bp of bpRows) {
      // Get materials for this blueprint
      const matRows = await dbAll(`
        SELECT material_id, quantity
        FROM blueprint_materials
        WHERE blueprint_id = ?
      `, [bp.blueprint_id]);

      blueprints[bp.blueprint_id] = {
        blueprintId: bp.blueprint_id,
        productId: bp.product_id,
        buildTime: bp.build_time,
        materials: matRows.map(m => ({
          typeId: m.material_id,
          quantity: m.quantity
        }))
      };
    }

    setCached('blueprint_db', blueprints, 86400000); // 24h
    console.log(`✓ Blueprint database loaded — ${Object.keys(blueprints).length} blueprints`);
    res.json({ blueprints });

  } catch (err) {
    console.error('Blueprint database error:', err.message);
    res.status(500).json({ error: err.message, blueprints: {} });
  }
});

// CALCULATE PROFITABILITY - Server-side pre-calculation
// Returns only top N profitable items
app.post('/api/calculate-profitability', async (req, res) => {
  try {
    const { ownedBlueprints, topN = 20 } = req.body;
    
    if (!ownedBlueprints || !Array.isArray(ownedBlueprints)) {
      return res.status(400).json({ error: "ownedBlueprints array required" });
    }

    console.log(`⟳ Calculating profitability for ${ownedBlueprints.length} blueprints...`);

    const regionId = req.body.regionId || 10000002;
    const blueprintIds = ownedBlueprints.map(bp => bp.type_id);
    const results = [];
    const prices = regionPriceCache.get(regionId)?.prices || {};
    console.log(`  Using region ${regionId} prices`);

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

    console.log(`✓ Top ${topResults.length} most profitable calculated`);
    res.json({ profitable: topResults, total: results.length });

  } catch (err) {
    console.error('Profitability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Calculate material cost (checks if it can be manufactured)
async function calculateMaterialCost(materialId, quantity, prices) {
  const bp = await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [materialId]);
  
  if (bp) {
    const subMats = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [bp.blueprint_id]
    );
    
    let mfgCost = 0;
    for (const sub of subMats) {
      const subCost = await calculateMaterialCost(sub.material_id, sub.quantity, prices);
      mfgCost += subCost;
    }
    
    const buyCost = (prices[materialId]?.buy || 0) * quantity;
    return Math.min(mfgCost * quantity, buyCost);
  } else {
    return (prices[materialId]?.buy || 0) * quantity;
  }
}

// PRODUCTION CHAIN - Full recursive build tree
app.post('/api/production-chain', async (req, res) => {
  try {
    const { itemName, ownedBlueprints } = req.body;

    if (!itemName) {
      return res.status(400).json({ error: "itemName required" });
    }

    console.log(`⟳ Building production chain for: ${itemName}`);

    const item = await dbGet('SELECT type_id, name FROM items WHERE name LIKE ? LIMIT 1', [`%${itemName}%`]);
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

    console.log(`✓ Production chain built for ${item.name}`);
    res.json({ chain });

  } catch (err) {
    console.error('Production chain error:', err.message);
    res.status(500).json({ error: err.message });
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

// GET JITA PRICE - Single item price lookup from cache
// Used by AI tool to query prices on-demand
app.post('/api/get-price', async (req, res) => {
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
    
    console.log(`✓ Price lookup: ${itemName || targetTypeId} → ${priceData.sell} ISK`);
    
    res.json({
      itemName: itemName,
      typeId: targetTypeId,
      sell: priceData.sell,
      buy: priceData.buy,
      median: priceData.median
    });
    
  } catch (err) {
    console.error('Price lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET BLUEPRINT - Query any blueprint from database
// Used by AI to get materials for any item
app.post('/api/get-blueprint', async (req, res) => {
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
    const materials = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [blueprint.blueprint_id]
    );
    
    // Get item names and prices for materials
    const materialsWithDetails = await Promise.all(
      materials.map(async (mat) => {
        let matItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [mat.material_id]);
        let matName;
        
        // If not in database, try to fetch from ESI
        if (!matItem) {
          try {
            const esiRes = await fetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
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
          unitCost: matPrice ? matPrice.buy : 0,
          totalCost: matPrice ? matPrice.buy * mat.quantity : 0
        };
      })
    );
    
    const totalCost = materialsWithDetails.reduce((sum, m) => sum + m.totalCost, 0);
    const productPrice = jitaPricesCache ? jitaPricesCache[targetProductId] : null;
    const sellPrice = productPrice ? productPrice.median : 0;
    const productQuantity = blueprint.product_quantity || 1;
    const batchRevenue = sellPrice * productQuantity;
    const profit = batchRevenue - totalCost;

    console.log(`✓ Blueprint lookup: ${itemName || targetProductId} → ${materials.length} materials`);

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
    console.error('Blueprint lookup error:', err.message);
    res.json({ error: err.message, blueprint: null });
  }
});

// ITEM DETAILS - For right panel with build analysis
app.post('/api/item-details', async (req, res) => {
  try {
    const { typeId, assets, ownedBlueprints, regionId = 10000002 } = req.body;
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

    // Get market history from ESI (not cached per-item to save memory)
    const JITA_REGION = 10000002;
    const historyRes = await fetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${typeId}`
    );

    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (Array.isArray(historyData) && historyData.length > 0) {
        const sorted = historyData
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 90)
          .reverse();
        
        itemDetails.priceHistory = sorted.map(day => ({
          date: day.date,
          average: day.average,
          highest: day.highest,
          lowest: day.lowest,
          volume: day.volume,
          orderCount: day.order_count
        }));
      }
    }

    // Add current market prices from cache (falls back to Jita if region not cached)
    const prices = regionPriceCache.get(regionId)?.prices || jitaPricesCache || {};
    if (prices[typeId]) {
      itemDetails.currentPrice = {
        sell: prices[typeId].sell,
        buy: prices[typeId].buy,
        median: prices[typeId].median
      };
    }

    // BUILD ANALYSIS (if assets and blueprints provided)
    if (assets && ownedBlueprints) {
      // Check if blueprint exists for this item
      const blueprint = await dbGet(
        'SELECT blueprint_id, product_quantity, build_time FROM blueprints WHERE product_id = ?',
        [typeId]
      );

      if (blueprint) {
        // User owns this blueprint?
        const userOwnsBlueprint = ownedBlueprints.some(bp => bp.type_id === blueprint.blueprint_id);

        // Get materials needed
        const materials = await dbAll(
          `SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?`,
          [blueprint.blueprint_id]
        );

        // Group user assets by type_id for quick lookup
        const assetQuantities = {};
        assets.forEach(asset => {
          assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
        });

        // Compare materials with assets
        const materialAnalysis = [];
        let totalCost = 0;
        let canBuild = true;

        // Single bulk query: which materials are themselves manufacturable?
        const matIds = materials.map(m => m.material_id);
        const manufSet = new Set();
        if (matIds.length > 0) {
          const ph = matIds.map(() => '?').join(',');
          const manufRows = await dbAll(
            `SELECT DISTINCT product_id FROM blueprints WHERE product_id IN (${ph})`,
            matIds
          );
          manufRows.forEach(r => manufSet.add(r.product_id));
        }

        // Single bulk query: material names
        const nameMap = {};
        if (matIds.length > 0) {
          const ph = matIds.map(() => '?').join(',');
          const nameRows = await dbAll(
            `SELECT type_id, name FROM items WHERE type_id IN (${ph})`,
            matIds
          );
          nameRows.forEach(r => { nameMap[r.type_id] = r.name; });
        }

        for (const mat of materials) {
          const userHas = assetQuantities[mat.material_id] || 0;
          const needed  = mat.quantity;
          const shortage = Math.max(0, needed - userHas);

          let matName = nameMap[mat.material_id];
          if (!matName) {
            // Fallback: ESI lookup and cache
            try {
              const esiRes = await fetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
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

          const matPrice = prices[mat.material_id];
          const unitCost = matPrice ? matPrice.buy : 0;
          const itemCost = unitCost * needed;
          totalCost += itemCost;

          materialAnalysis.push({
            materialId:     mat.material_id,
            name:           matName,
            needed,
            have:           userHas,
            shortage,
            unitCost,
            totalCost:      itemCost,
            shortfallCost:  unitCost * shortage,
            canManufacture: manufSet.has(mat.material_id),
          });

          if (shortage > 0) canBuild = false;
        }

        // Calculate potential profit
        const sellPrice = itemDetails.currentPrice ? itemDetails.currentPrice.sell : 0;
        const productQuantity = blueprint.product_quantity || 1;
        const batchRevenue = sellPrice * productQuantity;
        const profit = batchRevenue - totalCost;
        const profitMargin = batchRevenue > 0 ? (profit / batchRevenue) * 100 : 0;

        itemDetails.buildInfo = {
          canBuild: userOwnsBlueprint && canBuild,
          blueprintOwned: userOwnsBlueprint,
          blueprintId: blueprint.blueprint_id,
          productQuantity: productQuantity,
          buildTime: blueprint.build_time,
          materials: materialAnalysis,
          totalCost: totalCost,
          sellPrice: sellPrice,
          profit: profit,
          profitMargin: profitMargin
        };
      }
    }

    console.log(`✓ Item details fetched — ${itemDetails.name || typeId}${itemDetails.buildInfo ? ' (with build analysis)' : ''}`);
    res.json(itemDetails);

  } catch (err) {
    console.error("Item details error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ANALYZE BLUEPRINTS - Calculate profitability/buildability for all user BPs
// Used by AI to get top profitable/buildable items
app.post('/api/analyze-blueprints', async (req, res) => {
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
    if (!jitaPricesCache || Date.now() >= jitaPricesCacheExpiry) {
      console.log('⟳ Loading Jita prices for analysis...');
      try {
        const prices = await fetchRegionPrices(10000002); // The Forge (Jita)
        jitaPricesCache = prices;
        jitaPricesCacheExpiry = Date.now() + (60 * 60 * 1000); // 1 hour
      } catch (err) {
        console.error('⚠ Failed to load prices, proceeding with cached/zero prices:', err.message);
      }
    }
    
    console.log(`⟳ Analyzing ${ownedBlueprints.length} blueprints...`);
    
    // Group assets by type_id for quick lookup
    const assetQuantities = {};
    assets.forEach(asset => {
      assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
    });
    
    // Analyze each blueprint
    const results = [];
    const skipped = [];

    for (const bp of ownedBlueprints) {
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
        skipped.push({ type_id: bp.type_id, name: bpItem?.name || `Unknown #${bp.type_id}` });
        continue;
      }

      // Get product name and tech tier from meta_level (populated by sde-import.js)
      const product = await dbGet('SELECT name, meta_level FROM items WHERE type_id = ?', [blueprint.product_id]);
      const productName = product?.name ?? null;
      const metaLevel   = product?.meta_level ?? 0;
      const techTier    = metaLevel === 2 ? 'T3' : metaLevel === 1 ? 'T2' : 'T1';
      
      // Get materials
      const materials = await dbAll(
        'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
        [blueprint.blueprint_id]
      );
      
      // Calculate costs and buildability
      let totalCost = 0;
      let canBuild = true;
      const materialDetails = [];
      
      for (const mat of materials) {
        const userHas = assetQuantities[mat.material_id] || 0;
        const needed = mat.quantity;
        const shortage = Math.max(0, needed - userHas);
        
        const matPrice = jitaPricesCache ? jitaPricesCache[mat.material_id] : null;
        const unitCost = matPrice ? matPrice.buy : 0;
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

      results.push({
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
      });
    }
    
    // Filter buildable only if requested
    let filtered = buildableOnly ? results.filter(r => r.canBuild) : results;
    
    // Sort by requested criteria
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
    
    // Return top N results
    const topResults = filtered.slice(0, limit);

    console.log(`✓ Blueprint analysis complete — ${results.length} found, ${skipped.length} skipped, Top ${topResults.length} results (sorted by ${sortBy})`);
    if (skipped.length > 0) {
      console.log(`  ⚠ Skipped (not in blueprints DB): ${skipped.map(s => s.name).join(', ')}`);
    }

    res.json({
      total: results.length,
      buildable: results.filter(r => r.canBuild).length,
      skipped: skipped.length,
      skippedNames: skipped.map(s => s.name),
      results: topResults
    });
    
  } catch (err) {
    console.error('❌ Blueprint analysis error:', err.message);
    console.error('Stack:', err.stack);
    // Return proper error response with 500 status
    return res.status(500).json({
      error: `Analysis failed: ${err.message}`,
      total: 0,
      buildable: 0,
      results: []
    });
  }
});

// DIAGNOSE T2 BLUEPRINTS — checks session BPCs against the database
app.get('/api/diagnose-t2/:characterId', security.apiLimiter, async (req, res) => {
  try {
    const { characterId } = req.params;
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);

    if (!sessionData) {
      return res.status(400).json({ error: 'No session found — refresh the page first' });
    }

    const { blueprints } = sessionData;
    const report = { total: blueprints.length, bpc: 0, bpo: 0, inDb: [], notInDb: [], t2InDb: [], t2NotInDb: [] };

    for (const bp of blueprints) {
      const isBpc = bp.quantity > 0;
      if (isBpc) report.bpc++; else report.bpo++;

      // Look up blueprint item name; resolve product via name strip
      const bpItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [bp.type_id]);
      const bpName = bpItem?.name || `#${bp.type_id}`;
      const productName = bpName.replace(/ Blueprint$/i, '').trim();

      // Single product lookup — gives us meta_level (T2 check) AND type_id (fallback DB lookup)
      const productItem = bpName.toLowerCase().includes('blueprint')
        ? await dbGet('SELECT type_id, meta_level FROM items WHERE name = ? COLLATE NOCASE', [productName])
        : null;
      const bpIsT2 = (productItem?.meta_level ?? 0) === 1;

      // Check if it's in blueprints table (by blueprint_id, then by product_id)
      const inDb = await dbGet('SELECT blueprint_id FROM blueprints WHERE blueprint_id = ?', [bp.type_id]);
      let inDbFallback = null;
      if (!inDb && productItem?.type_id) {
        inDbFallback = await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [productItem.type_id]);
      }

      const found = !!(inDb || inDbFallback);
      const entry = { type_id: bp.type_id, name: bpName, is_t2: bpIsT2, is_bpc: isBpc, found_via: inDb ? 'blueprint_id' : inDbFallback ? 'product_id' : null };

      if (found) {
        report.inDb.push(entry);
        if (bpIsT2) report.t2InDb.push(entry);
      } else {
        report.notInDb.push(entry);
        if (bpIsT2) report.t2NotInDb.push(entry);
      }
    }

    report.summary = `${report.inDb.length}/${report.total} blueprints found in DB. T2: ${report.t2InDb.length} found, ${report.t2NotInDb.length} missing.`;
    console.log(`🔍 T2 Diagnose for ${characterId}: ${report.summary}`);
    res.json(report);
  } catch (err) {
    console.error('❌ T2 diagnose error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET BLUEPRINT METADATA (meta_level per blueprint type_id)
app.post('/api/blueprint-metadata', security.apiLimiter, async (req, res) => {
  try {
    const { blueprintTypeIds } = req.body;
    if (!Array.isArray(blueprintTypeIds) || blueprintTypeIds.length === 0) {
      return res.json({});
    }

    // Single bulk query — items.meta_level populated by sde-import.js
    const limited = blueprintTypeIds.slice(0, 500);
    const placeholders = limited.map(() => '?').join(',');
    const rows = await new Promise((res, rej) =>
      db.all(`SELECT type_id, meta_level FROM items WHERE type_id IN (${placeholders})`, limited, (e, r) => e ? rej(e) : res(r))
    );

    const metadata = {};
    limited.forEach(id => { metadata[id] = 0; });
    rows.forEach(r => { metadata[r.type_id] = r.meta_level ?? 0; });

    res.json(metadata);
  } catch (err) {
    console.error('❌ Blueprint metadata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// AI CHAT - Anthropic proxy with function calling
app.post('/api/ai-chat',
  security.aiLimiter,
  security.verifyEveToken,
  security.validateAiChatInput,
  async (req, res) => {
  try {
    const { messages, context, maxTokens = 2000 } = req.body;
    const characterId = req.characterId;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Load session data from cache
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);
    
    console.log(`🔍 AI Chat - Character: ${characterId}, Session Key: ${sessionKey}, Cache Hit: ${!!sessionData}`);
    
    if (!sessionData) {
      console.error(`❌ No session data found for character ${characterId}`);
      return res.status(400).json({ 
        error: "No session data found. Please refresh the page to reload your character data.",
        code: "SESSION_EXPIRED"
      });
    }

    console.log(`✓ Session data loaded: ${sessionData.assets?.length || 0} assets, ${sessionData.blueprints?.length || 0} blueprints`);

    const { assets, blueprints, prices, wallet, jobs, skills } = sessionData;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    // ── Build rich player context from session cache ────────────────────────
    // The frontend sends no context field — we build it server-side from the
    // cached session so the AI always has live character data.
    const bpoCount = blueprints.filter(b => b.quantity === -1).length;
    const bpcCount = blueprints.filter(b => b.quantity > 0).length;

    // Resolve top asset names from DB (up to 30 most-held stacks)
    const assetsByQty = [...assets].sort((a, b) => b.quantity - a.quantity).slice(0, 30);
    const assetTypeIds = assetsByQty.map(a => a.type_id);
    let assetNameMap = {};
    if (assetTypeIds.length > 0) {
      const placeholders = assetTypeIds.map(() => '?').join(',');
      const nameRows = await dbAll(
        `SELECT type_id, name FROM items WHERE type_id IN (${placeholders})`,
        assetTypeIds
      );
      nameRows.forEach(r => { assetNameMap[r.type_id] = r.name; });
    }
    const assetSummary = assetsByQty
      .map(a => `${assetNameMap[a.type_id] || `#${a.type_id}`}: ${a.quantity.toLocaleString()}`)
      .join(', ');

    // Resolve job product names
    const jobSummary = jobs.length === 0 ? 'None' : jobs.slice(0, 20).map(j => {
      const activity = j.activity_id === 1 ? 'Mfg' : j.activity_id === 9 ? 'Reaction'
        : j.activity_id === 8 ? 'Invention' : j.activity_id === 5 ? 'Copy'
        : j.activity_id === 3 ? 'TE Research' : j.activity_id === 4 ? 'ME Research' : 'Job';
      return `${j.product_name || j.blueprint_type_id} ×${j.runs} [${activity}]`;
    }).join('; ');

    // Note: skills are now available and passed to the server.
    // Future use: for filtering blueprints by skill requirements in Market Opportunities
    const skillCount = (skills && skills.length) || 0;

    const builtContext = [
      `Wallet: ${(wallet / 1e9).toFixed(2)}B ISK`,
      `Blueprints: ${blueprints.length} total (${bpoCount} BPOs, ${bpcCount} BPCs)`,
      `Assets: ${assets.length} stacks — top holdings: ${assetSummary}`,
      `Active jobs (${jobs.length}): ${jobSummary}`,
      `Skills trained: ${skillCount}`,
    ].join('\n');

    // Tool definitions for AI
    const tools = [
      {
        name: "get_blueprint",
        description: "Get blueprint materials + costs for any item. Resolves names from IDs.",
        input_schema: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Item name (e.g. Drake, Vulture)"
            },
            productId: {
              type: "number",
              description: "Type ID (use when productName is null)"
            }
          }
        }
      },
      {
        name: "analyze_blueprints",
        description: "Analyze user's blueprints for profitability/buildability. Each result includes techTier and completionPct. Use for: what can I build, most profitable, T2 chains closest to completing. Report skippedNames to user if non-zero.",
        input_schema: {
          type: "object",
          properties: {
            sortBy: {
              type: "string",
              enum: ["profit", "cost", "time", "materials", "margin", "completion"],
              description: "Sort by: profit, cost, time, materials, margin, completion (use completion for 'T2 chains I can almost build')"
            },
            limit: {
              type: "number",
              description: "Number of results (default 20, max 50)"
            },
            buildableOnly: {
              type: "boolean",
              description: "Only show buildable items"
            }
          },
          required: ["sortBy"]
        }
      },
      {
        name: "get_price",
        description: "Get current Jita price for any item not already in context.",
        input_schema: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Item name"
            }
          },
          required: ["itemName"]
        }
      },
      {
        name: "get_active_jobs",
        description: "Get player's active industry jobs. Use for: active jobs, job queue, reactions running, time remaining.",
        input_schema: {
          type: "object",
          properties: {
            activityFilter: {
              type: "string",
              enum: ["all", "manufacturing", "reaction", "invention", "research", "copying"],
              description: "Filter by activity (default: all)"
            }
          }
        }
      },
      {
        name: "get_precomputed",
        description: "PREFERRED. Pre-computed profitability for mfg + reactions. Use FIRST for profit/market/ISK-hour questions. activity_id: 1=mfg, 9=reaction. Fall back to analyze_blueprints only for asset-specific buildability. Supports regionId for hub-specific queries.",
        input_schema: {
          type: "object",
          properties: {
            sort: {
              type: "string",
              enum: ["profit", "margin", "isk_per_hour"],
              description: "Sort: profit | margin | isk_per_hour"
            },
            limit: {
              type: "number",
              description: "Result count (default 20, max 100)"
            },
            search: {
              type: "string",
              description: "Search by item name"
            },
            minProfit: {
              type: "number",
              description: "Min profit in ISK"
            },
            includeRisky: {
              type: "boolean",
              description: "Include risky/low-volume items"
            },
            activityType: {
              type: "string",
              enum: ["all", "manufacturing", "reaction"],
              description: "all | manufacturing | reaction"
            },
            regionId: {
              type: "number",
              description: "Market hub region ID (default 10000002 = Jita). Use for hub-specific profit questions: Jita=10000002, Amarr=10000043, Dodixie=10000032, Hek=10000042, Rens=10000030, Syndicate=10000041"
            }
          },
          required: ["sort"]
        }
      },
      {
        name: "diagnose_blueprints",
        description: "Diagnose which blueprints exist in DB vs missing. Use when T2 results absent or user reports missing BPCs.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "get_t2_blueprints",
        description: "List all player T2 blueprints (meta_level=1). Use for: list my T2 BPCs/BPOs. Use analyze_blueprints for buildability filtering.",
        input_schema: {
          type: "object",
          properties: {
            sort: {
              type: "string",
              enum: ["name", "quantity"],
              description: "name | quantity"
            }
          }
        }
      },
      {
        name: "compare_markets",
        description: "Compare manufacturing profit for a specific item across ALL trade hubs. Shows profit for two strategies per hub: (A) local materials + local sell, (B) Jita materials + hub sell price. Use when user asks: where should I sell this, which hub is best for X, compare Jita vs Amarr for X, should I buy materials in Jita and sell in Amarr, cross-hub strategy questions.",
        input_schema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Product or blueprint name to compare across hubs (partial match supported, e.g. 'Rifter', 'Drake')"
            }
          },
          required: ["query"]
        }
      },
      {
        name: "get_price_comparison",
        description: "Compare buy and sell prices for ANY item across all 6 trade hubs (Jita, Amarr, Dodixie, Hek, Rens, Syndicate). Returns prices sorted cheapest-to-buy and highest-to-sell, plus arbitrage opportunity. Use proactively whenever the user asks about item prices, where to buy or sell anything (especially raw materials, minerals, loot, commodities), price differences between hubs, or trade opportunities. Unlike compare_markets (which is for manufactured goods), this works for any tradeable item.",
        input_schema: {
          type: "object",
          properties: {
            item_name: {
              type: "string",
              description: "Name of the item to price-check (e.g. 'Veldspaar', 'Tritanium', 'Morphite', 'Megacyte', 'Rifter')"
            }
          },
          required: ["item_name"]
        }
      }
    ];

    // Trim history to last 30 messages
    let conversationMessages = messages.slice(-10);

    // Max 5 tool-use iterations to prevent infinite loops
    const maxIterations = 5;
    let iteration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    while (iteration < maxIterations) {
      iteration++;

      const requestBody = {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: FORGE_STATIC_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" }
          },
          {
            type: "text",
            text: `Current player context:\n${builtContext}`
          }
        ],
        messages: conversationMessages,
        tools: tools
      };

      console.log(`🤖 AI request (iteration ${iteration})`);

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31"
        },
        body: JSON.stringify(requestBody)
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        console.error("AI error:", data.error?.message);
        return res.json({ 
          content: [{ type: "text", text: `[API Error: ${data.error?.message || "AI request failed"}]` }],
          error: data.error?.message || "AI request failed"
        });
      }

      // Accumulate token usage across iterations (v0.9.0)
      if (data.usage) {
        totalInputTokens += data.usage.input_tokens || 0;
        totalOutputTokens += data.usage.output_tokens || 0;
        totalCacheCreationTokens += data.usage.cache_creation_input_tokens || 0;
        totalCacheReadTokens += data.usage.cache_read_input_tokens || 0;
      }

      // Check if AI used tools
      const toolUses = data.content.filter(block => block.type === "tool_use");

      if (toolUses.length === 0) {
        // No tools used - final answer
        console.log("✓ AI response generated (no tools)");

        // Track cumulative AI usage (v0.9.0)
        trackAiUsage(characterId, requestBody.model, {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cache_creation_input_tokens: totalCacheCreationTokens,
          cache_read_input_tokens: totalCacheReadTokens
        });

        return res.json(data);
      }

      // AI used tools - execute them
      console.log(`🔧 AI used ${toolUses.length} tool(s)`);

      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)}...)`);

        let toolResult;

        try {
          switch (toolUse.name) {
            case "get_active_jobs": {
              const actFilter = toolUse.input.activityFilter || 'all';
              const activityIds = { manufacturing: [1], reaction: [9], invention: [8], research: [3,4], copying: [5] };
              const allowedIds = activityIds[actFilter];
              const filteredJobs = allowedIds
                ? jobs.filter(j => allowedIds.includes(j.activity_id))
                : jobs;
              const actLabel = id => ({ 1:'Manufacturing',3:'TE Research',4:'ME Research',5:'Copying',8:'Invention',9:'Reaction',11:'Rev.Eng' }[id] || `Activity ${id}`);
              toolResult = {
                total: filteredJobs.length,
                jobs: filteredJobs.map(j => ({
                  product: j.product_name || `Blueprint #${j.blueprint_type_id}`,
                  activity: actLabel(j.activity_id),
                  runs: j.runs,
                  status: j.status,
                  remaining: j.remaining,
                  done: j.done,
                }))
              };
              break;
            }

            case "get_blueprint":
              const bpRes = await fetch(`http://localhost:${PORT}/api/get-blueprint`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemName: toolUse.input.itemName })
              });
              toolResult = await bpRes.json();
              break;

            case "analyze_blueprints":
              const analyzeRes = await fetch(`http://localhost:${PORT}/api/analyze-blueprints`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ownedBlueprints: blueprints || [],  // Fixed: use blueprints from session cache
                  assets: assets || [],
                  sortBy: toolUse.input.sortBy || "profit",
                  limit: toolUse.input.limit || 20,
                  buildableOnly: toolUse.input.buildableOnly || false
                })
              });
              toolResult = await analyzeRes.json();
              break;

            case "get_price":
              const priceRes = await fetch(`http://localhost:${PORT}/api/get-price`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemName: toolUse.input.itemName })
              });
              toolResult = await priceRes.json();
              break;

            case "get_precomputed":
              try {
                const pcSort         = toolUse.input.sort || 'profit';
                const pcLimit        = Math.min(toolUse.input.limit || 20, 100);
                const pcMinProfit    = toolUse.input.minProfit || 0;
                const pcSearch       = toolUse.input.search;
                const pcIncludeRisky = toolUse.input.includeRisky || false;
                const pcActivity     = toolUse.input.activityType || 'all';
                // Allow AI to query a specific hub; default Jita
                const pcRegionId     = VALID_REGIONS.includes(toolUse.input.regionId)
                                       ? toolUse.input.regionId
                                       : 10000002;
                const pcHubName      = REGION_HUB_NAMES[pcRegionId] || 'Jita';

                const allowedSorts = {
                  profit: 'profit DESC',
                  margin: 'profit_margin DESC',
                  isk_per_hour: 'isk_per_hour DESC'
                };
                const pcOrder = allowedSorts[pcSort] || allowedSorts.profit;

                // Activity filter
                const activityFilter = pcActivity === 'reaction'
                  ? 'COALESCE(activity_id,1) = 9'
                  : pcActivity === 'manufacturing'
                  ? 'COALESCE(activity_id,1) = 1'
                  : null;

                let pcResults;
                if (pcSearch) {
                  const sanitised = pcSearch.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50);

                  let whereConditions = ['region_id = ?', 'product_name LIKE ?', 'profit > ?'];
                  const params = [pcRegionId, `%${sanitised}%`, pcMinProfit];
                  if (activityFilter) whereConditions.push(activityFilter);

                  // Exclude CRITICAL risks only (not low_volume)
                  if (!pcIncludeRisky) {
                    whereConditions.push(`(
                      liquidity_risk IS NULL
                      OR liquidity_risk = ""
                      OR liquidity_risk = "low_volume"
                    )`);
                  }

                  const whereClause = whereConditions.join(' AND ');

                  pcResults = await dbAll(`
                    SELECT product_name, material_cost, sell_price, profit,
                           profit_margin, isk_per_hour, avg_daily_volume, liquidity_risk,
                           COALESCE(activity_id,1) as activity_id
                    FROM precomputed_profits
                    WHERE ${whereClause}
                    ORDER BY ${pcOrder} LIMIT ?
                  `, [...params, pcLimit]);
                } else {
                  let whereConditions = ['region_id = ?', 'profit > ?', 'sell_price > 0'];
                  const params = [pcRegionId, pcMinProfit];

                  if (activityFilter) whereConditions.push(activityFilter);

                  // Exclude CRITICAL risks only (not low_volume)
                  if (!pcIncludeRisky) {
                    whereConditions.push(`(
                      liquidity_risk IS NULL
                      OR liquidity_risk = ""
                      OR liquidity_risk = "low_volume"
                    )`);
                  }

                  const whereClause = whereConditions.join(' AND ');

                  pcResults = await dbAll(`
                    SELECT product_name, material_cost, sell_price, profit,
                           profit_margin, isk_per_hour, avg_daily_volume, liquidity_risk,
                           COALESCE(activity_id,1) as activity_id
                    FROM precomputed_profits
                    WHERE ${whereClause}
                    ORDER BY ${pcOrder} LIMIT ?
                  `, [...params, pcLimit]);
                }

                toolResult = {
                  results: pcResults,
                  count: pcResults.length,
                  sort: pcSort,
                  hub: pcHubName,
                  regionId: pcRegionId,
                  source: 'precomputed'
                };
              } catch (pcErr) {
                toolResult = { error: pcErr.message, results: [] };
              }
              break;

            case "compare_markets": {
              try {
                const cmQuery = (toolUse.input.query || '').replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 80);
                if (!cmQuery) {
                  toolResult = { error: 'query parameter is required' };
                  break;
                }

                // Self-join: sell region × Jita (for Jita-materials strategy)
                // qty is derived from the sell region's own coherent precomputed data
                const rows = await dbAll(`
                  SELECT
                    sell.region_id,
                    sell.product_id,
                    sell.product_name,
                    sell.sell_price,
                    sell.buy_price,
                    sell.material_cost   AS local_material_cost,
                    sell.profit          AS local_profit,
                    sell.profit_margin   AS local_margin,
                    sell.isk_per_hour    AS local_isk_per_hour,
                    sell.build_time,
                    sell.avg_daily_volume,
                    jita.material_cost   AS jita_material_cost,
                    CAST(ROUND(
                      (sell.profit + sell.material_cost) / NULLIF(sell.sell_price, 0)
                    ) AS INTEGER)        AS product_qty
                  FROM precomputed_profits sell
                  JOIN precomputed_profits jita
                    ON  jita.blueprint_id = sell.blueprint_id
                    AND jita.region_id    = 10000002
                  WHERE sell.product_name LIKE ?
                  ORDER BY sell.region_id
                `, [`%${cmQuery}%`]);

                if (!rows.length) {
                  toolResult = { error: `No precomputed data found for "${cmQuery}". Try a shorter or different name.` };
                  break;
                }

                // Group by product (query might match multiple items)
                const byProduct = {};
                for (const row of rows) {
                  const key = row.product_id;
                  if (!byProduct[key]) byProduct[key] = { product_name: row.product_name, hubs: [] };
                  const qty = Math.max(1, row.product_qty || 1);
                  const buildHrs = (row.build_time || 0) / 3600;

                  // Strategy B: Jita materials → this hub sell
                  const jitaMatRevenue = row.sell_price * qty;
                  const jitaMatProfit  = jitaMatRevenue - row.jita_material_cost;
                  const jitaMatMargin  = jitaMatRevenue > 0 ? (jitaMatProfit / jitaMatRevenue) * 100 : 0;
                  const jitaMatIskPH   = buildHrs > 0 ? jitaMatProfit / buildHrs : 0;

                  byProduct[key].hubs.push({
                    hub:          REGION_HUB_NAMES[row.region_id] || `Region ${row.region_id}`,
                    regionId:     row.region_id,
                    sellPrice:    row.sell_price,
                    productQty:   qty,
                    avgDailyVol:  row.avg_daily_volume,
                    // Strategy A: buy materials locally, sell locally
                    localMaterials: {
                      materialCost: row.local_material_cost,
                      profit:       row.local_profit,
                      margin:       parseFloat(row.local_margin?.toFixed(1) ?? 0),
                      iskPerHour:   row.local_isk_per_hour,
                    },
                    // Strategy B: buy materials in Jita, sell in this hub
                    jitaMaterials: {
                      materialCost: row.jita_material_cost,
                      profit:       jitaMatProfit,
                      margin:       parseFloat(jitaMatMargin.toFixed(1)),
                      iskPerHour:   jitaMatIskPH,
                    },
                  });
                }

                // For each product, find the best hub for each strategy
                const products = Object.values(byProduct).slice(0, 3); // cap at 3 matching items
                for (const prod of products) {
                  const bestJita  = prod.hubs.reduce((best, h) => h.jitaMaterials.profit  > best.jitaMaterials.profit  ? h : best, prod.hubs[0]);
                  const bestLocal = prod.hubs.reduce((best, h) => h.localMaterials.profit > best.localMaterials.profit ? h : best, prod.hubs[0]);
                  prod.recommendation = {
                    bestJitaMaterialsStrategy: {
                      sellHub:     bestJita.hub,
                      profit:      bestJita.jitaMaterials.profit,
                      margin:      bestJita.jitaMaterials.margin,
                      iskPerHour:  bestJita.jitaMaterials.iskPerHour,
                      summary:     `Buy materials in Jita, sell in ${bestJita.hub} — ${bestJita.jitaMaterials.margin.toFixed(1)}% margin`
                    },
                    bestLocalStrategy: {
                      sellHub:     bestLocal.hub,
                      profit:      bestLocal.localMaterials.profit,
                      margin:      bestLocal.localMaterials.margin,
                      iskPerHour:  bestLocal.localMaterials.iskPerHour,
                      summary:     `Buy and sell locally in ${bestLocal.hub} — ${bestLocal.localMaterials.margin.toFixed(1)}% margin`
                    }
                  };
                }

                toolResult = {
                  query: cmQuery,
                  note: 'local_materials = buy and sell at same hub. jita_materials = buy inputs at Jita, sell finished goods at listed hub.',
                  products,
                };
              } catch (cmErr) {
                toolResult = { error: cmErr.message };
              }
              break;
            }

            case "diagnose_blueprints": {
              try {
                const diagRes = await fetch(`http://localhost:${PORT}/api/diagnose-t2/${characterId}`);
                const diagData = await diagRes.json();
                toolResult = {
                  summary: diagData.summary,
                  total_blueprints: diagData.total,
                  found_in_db: diagData.inDb?.length || 0,
                  missing_from_db: diagData.notInDb?.length || 0,
                  t2_found: diagData.t2InDb?.length || 0,
                  t2_missing: diagData.t2NotInDb?.length || 0,
                  missing_names: (diagData.notInDb || []).map(b => b.name),
                  t2_missing_names: (diagData.t2NotInDb || []).map(b => b.name),
                  note: diagData.t2NotInDb?.length > 0
                    ? `${diagData.t2NotInDb.length} T2 blueprint(s) not in the SDE database — their chain data cannot be analysed until the database is updated.`
                    : 'All T2 blueprints found in database.'
                };
              } catch (diagErr) {
                toolResult = { error: diagErr.message };
              }
              break;
            }

            case "get_t2_blueprints": {
              try {
                const t2Sort = toolUse.input.sort || 'name';
                const bpList = blueprints || [];

                // Single bulk query — items.meta_level=1 means T2
                const typeIds = bpList.map(b => b.type_id);
                let t2TypeIds = new Set();
                let nameMap   = {};

                if (typeIds.length > 0) {
                  const ph = typeIds.map(() => '?').join(',');
                  const rows = await new Promise((rs, rj) =>
                    db.all(`SELECT type_id, name, meta_level FROM items WHERE type_id IN (${ph})`, typeIds, (e, r) => e ? rj(e) : rs(r))
                  );
                  rows.forEach(r => {
                    nameMap[r.type_id] = r.name;
                    if ((r.meta_level ?? 0) === 1) t2TypeIds.add(r.type_id);
                  });
                }

                let t2Blueprints = bpList
                  .filter(bp => t2TypeIds.has(bp.type_id))
                  .map(bp => ({ type_id: bp.type_id, name: nameMap[bp.type_id] || `Blueprint #${bp.type_id}`, quantity: bp.quantity }));

                if (t2Sort === 'quantity') {
                  t2Blueprints.sort((a, b) => b.quantity - a.quantity);
                } else {
                  t2Blueprints.sort((a, b) => a.name.localeCompare(b.name));
                }

                toolResult = {
                  total: t2Blueprints.length,
                  total_blueprints: bpList.length,
                  blueprints: t2Blueprints.map(bp => ({
                    name: bp.name,
                    type_id: bp.type_id,
                    owned: bp.quantity === -1 ? 'BPO' : 'BPC',
                    quantity: bp.quantity === -1 ? 'Infinite (BPO)' : `${bp.quantity} copy${bp.quantity !== 1 ? 's' : ''}`
                  })),
                  summary: `Found ${t2Blueprints.length} T2 blueprints out of ${bpList.length} total`
                };
              } catch (t2Err) {
                toolResult = { error: t2Err.message, blueprints: [] };
              }
              break;
            }

            case "get_price_comparison": {
              try {
                const itemName = (toolUse.input.item_name || '').trim();
                if (!itemName) {
                  toolResult = { error: 'item_name is required' };
                  break;
                }

                // Case-insensitive exact lookup first, then partial match
                let item = await dbGet(
                  'SELECT type_id, name FROM items WHERE LOWER(name) = LOWER(?)',
                  [itemName]
                );
                if (!item) {
                  // Try partial match for common shorthand (e.g. "Trit" → "Tritanium")
                  item = await dbGet(
                    'SELECT type_id, name FROM items WHERE LOWER(name) LIKE LOWER(?) LIMIT 1',
                    [`%${itemName}%`]
                  );
                }

                if (!item) {
                  toolResult = { error: `Item "${itemName}" not found. Check spelling or try a more specific name.` };
                  break;
                }

                const priceData = await getItemPricesAllRegions(item.type_id);

                if (priceData.length === 0) {
                  toolResult = { error: `No live price data found for ${item.name} across any hub. It may not be actively traded.` };
                  break;
                }

                // Sort: cheapest sell price first (best place to buy), highest buy price first (best place to sell)
                const bySellPrice = [...priceData].sort((a, b) => a.sell_price - b.sell_price);
                const byBuyPrice  = [...priceData].sort((a, b) => b.buy_price  - a.buy_price);

                const bestToBuyAt  = bySellPrice[0];   // lowest ask = cheapest to buy from
                const bestToSellAt = byBuyPrice[0];    // highest bid = best place to sell into

                const arbitrage = bestToSellAt.buy_price - bestToBuyAt.sell_price;

                toolResult = {
                  item_name:   item.name,
                  type_id:     item.type_id,
                  note:        'buy_price = highest buy order (what you sell into). sell_price = lowest sell order (what you buy from).',
                  all_hubs:    priceData,
                  cheapest_to_buy_from: {
                    hub:        bestToBuyAt.hub_name,
                    sell_price: bestToBuyAt.sell_price,
                    summary:    `Buy in ${bestToBuyAt.hub_name} at ${bestToBuyAt.sell_price.toLocaleString()} ISK`,
                  },
                  best_to_sell_into: {
                    hub:       bestToSellAt.hub_name,
                    buy_price: bestToSellAt.buy_price,
                    summary:   `Sell in ${bestToSellAt.hub_name} at ${bestToSellAt.buy_price.toLocaleString()} ISK`,
                  },
                  arbitrage_opportunity: arbitrage > 0
                    ? `Buy in ${bestToBuyAt.hub_name} (${bestToBuyAt.sell_price.toLocaleString()} ISK), sell in ${bestToSellAt.hub_name} (${bestToSellAt.buy_price.toLocaleString()} ISK) = +${arbitrage.toLocaleString()} ISK/unit margin`
                    : 'No profitable arbitrage between hubs at current prices.',
                };
              } catch (pcErr) {
                toolResult = { error: pcErr.message };
              }
              break;
            }

            default:
              toolResult = { error: `Unknown tool: ${toolUse.name}` };
          }
        } catch (err) {
          toolResult = { error: err.message };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Add assistant's tool use and tool results to conversation
      conversationMessages.push({
        role: "assistant",
        content: data.content
      });

      conversationMessages.push({
        role: "user",
        content: toolResults
      });

      // Loop back to call AI again with tool results
    }

    // If we hit max iterations, return what we have
    console.warn("⚠ Max tool iterations reached");
    trackAiUsage(characterId, 'claude-sonnet-4-6', {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreationTokens,
      cache_read_input_tokens: totalCacheReadTokens
    });
    return res.json({ 
      content: [{ type: "text", text: "I encountered an issue processing your request. Please try again." }] 
    });

  } catch (err) {
    console.error("AI chat error:", err.message);
    res.json({ 
      content: [{ type: "text", text: `[System Error: ${err.message}]` }],
      error: err.message 
    });
  }
});

// SESSION DATA CACHING

// Store character session data (assets, blueprints, prices, etc.)
// This avoids sending 2-3MB with every AI request
app.post('/api/session-data',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const { assets, blueprints, prices, wallet, jobs, skills, standings } = req.body;

      // Validate data exists
      if (!assets || !blueprints) {
        return res.status(400).json({ error: 'Missing required session data' });
      }

      // Store in cache with 2-hour expiry
      const sessionKey = `session:${characterId}`;
      
      console.log(`💾 Caching session data - Character: ${characterId}, Key: ${sessionKey}`);
      console.log(`   Assets: ${assets.length}, Blueprints: ${blueprints.length}, Prices: ${Object.keys(prices || {}).length}`);

      // v0.9.4: Discover player-owned structures from asset locations
      // Structure IDs are int64 (> 2^31-1), NPC stations are int32
      const INT32_MAX = 2147483647;
      const structureIds = new Set();

      if (assets && Array.isArray(assets)) {
        assets.forEach(asset => {
          if (asset.location_id && asset.location_id > INT32_MAX) {
            structureIds.add(asset.location_id);
          }
        });
      }

      if (jobs && Array.isArray(jobs)) {
        jobs.forEach(job => {
          if (job.facility_id && job.facility_id > INT32_MAX) {
            structureIds.add(job.facility_id);
          }
        });
      }

      console.log(`✓ Discovered ${structureIds.size} accessible structures`);

      setCached(sessionKey, {
        assets,
        blueprints,
        prices: prices || {},
        wallet: wallet || 0,
        jobs: jobs || [],
        skills: skills || [],
        standings: standings || { factions: {}, corps: {} },
        accessibleStructures: Array.from(structureIds),
        cachedAt: new Date().toISOString()
      }, 7200000); // 2 hours

      console.log(`✓ Session data cached successfully for character ${characterId}`);
      
      // Verify it was cached
      const verify = getCached(sessionKey);
      if (!verify) {
        console.error(`❌ CACHE VERIFICATION FAILED - Data not retrievable immediately after caching!`);
      } else {
        console.log(`✓ Cache verification passed - ${verify.assets.length} assets retrievable`);
      }
      
      res.json({ success: true, expiresIn: 7200 });
    } catch (error) {
      console.error('Session data error:', error);
      res.status(500).json({ error: 'Failed to cache session data' });
    }
  }
);

// Get cached session data (for debugging)
app.get('/api/session-data/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const sessionKey = `session:${characterId}`;
      const sessionData = getCached(sessionKey);

      if (!sessionData) {
        return res.status(404).json({ error: 'No cached session data found' });
      }

      res.json({
        cached: true,
        cachedAt: sessionData.cachedAt,
        assets: sessionData.assets?.length || 0,
        blueprints: sessionData.blueprints?.length || 0
      });
    } catch (error) {
      console.error('Get session error:', error);
      res.status(500).json({ error: 'Failed to retrieve session data' });
    }
  }
);

// CHAT HISTORY (Authenticated)

// Save chat message (authenticated)
app.post('/api/save-message',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  security.validateChatMessage,
  async (req, res) => {
    try {
      const { role, content, conversationId } = req.body;
      const characterId = req.characterId; // From verified token
      
      await dbRun(
        'INSERT INTO chat_history (character_id, role, content, conversation_id) VALUES (?, ?, ?, ?)',
        [characterId, role, content, conversationId || 'default']
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error('Save message error:', error);
      res.status(500).json({ error: 'Failed to save message' });
    }
  }
);

// Get chat history (authenticated, character must match token)
app.get('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId; // From verified token
      
      const messages = await dbAll(
        `SELECT role, content, timestamp 
         FROM chat_history 
         WHERE character_id = ? 
         ORDER BY timestamp DESC 
         LIMIT 200`,
        [characterId]
      );
      
      res.json(messages.reverse());
    } catch (error) {
      console.error('Get history error:', error);
      res.status(500).json({ error: 'Failed to load history' });
    }
  }
);

// Clear chat history (authenticated)
app.delete('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      
      await dbRun(
        'DELETE FROM chat_history WHERE character_id = ?',
        [characterId]
      );
      
      res.json({ success: true, message: 'Chat history cleared' });
    } catch (error) {
      console.error('Clear history error:', error);
      res.status(500).json({ error: 'Failed to clear history' });
    }
  }
);

// Invalidate session cache (call when user's data changes)
app.post('/api/invalidate-session',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const sessionKey = `session:${characterId}`;
      
      cache.delete(sessionKey);
      console.log(`✓ Session cache invalidated for character ${characterId}`);
      
      res.json({ 
        success: true, 
        message: 'Session cache cleared - will reload on next AI request' 
      });
    } catch (error) {
      console.error('Invalidate session error:', error);
      res.status(500).json({ error: 'Failed to invalidate session' });
    }
  }
);

// PRE-COMPUTATION ENGINE (v0.9.0)
// Calculates profitability for ALL blueprints, stores in DB
// Replaces real-time AI calculations for common queries

let preComputeRunning = false;

async function ensureJitaPrices() {
  if (jitaPricesCache && Date.now() < jitaPricesCacheExpiry) {
    return jitaPricesCache;
  }

  const prices = await fetchRegionPrices(10000002); // The Forge (Jita)

  // Update the shared cache so other endpoints benefit too
  jitaPricesCache = prices;
  jitaPricesCacheExpiry = Date.now() + 3600000;

  return prices;
}

async function runPreCompute() {
  if (preComputeRunning) {
    console.log('⚠ Pre-compute already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  preComputeRunning = true;
  const startTime = Date.now();

  // Log the run
  const run = await dbRun(
    `INSERT INTO precompute_runs (started_at, status) VALUES (datetime('now'), 'running')`
  );
  const runId = run.lastID;

  try {
    console.log('═══════════════════════════════════════════');
    console.log('⟳ PRE-COMPUTE JOB STARTING');
    console.log('═══════════════════════════════════════════');

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

    console.log(`⟳ Processing ${allBlueprints.length} blueprints × ${VALID_REGIONS.length} regions...`);

    // Step 2: For each market region, fetch prices and compute profitability
    let totalProcessed = 0;
    const computedAt = new Date().toISOString();

    for (const regionId of VALID_REGIONS) {
      console.log(`⟳ Region ${regionId}: fetching prices...`);

      let prices;
      try {
        prices = await fetchRegionPrices(regionId);
        regionPriceCache.set(regionId, { prices, expiry: Date.now() + 3600000 });
        if (regionId === 10000002) {
          jitaPricesCacheExpiry = Date.now() + 3600000; // keep compat accessor in sync
        }
      } catch (err) {
        console.error(`⚠ Region ${regionId}: price fetch failed, skipping — ${err.message}`);
        continue;
      }

      await dbRun('BEGIN TRANSACTION');
      await dbRun('DELETE FROM precomputed_profits WHERE region_id = ?', [regionId]);

      let regionProcessed = 0;

      for (const bp of allBlueprints) {
        const materials = materialsByBp[bp.blueprint_id] || [];
        let totalMatCost = 0;

        for (const mat of materials) {
          totalMatCost += calculateMaterialCostSync(
            mat.material_id, mat.quantity, prices, materialsByBp, bpByProduct
          );
        }

        const sellPrice = prices[bp.product_id]?.sell || 0;
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
             material_count, computed_at, price_source, activity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          bp.blueprint_id, regionId, bp.product_id, bp.product_name || null,
          totalMatCost, sellPrice, buyPrice, profit, profitMargin,
          iskPerHour, bp.build_time || 0, materials.length, computedAt,
          regionId === 10000002 ? 'jita' : `region_${regionId}`,
          bp.activity_id || 1
        ]);

        regionProcessed++;
      }

      await dbRun('COMMIT');
      totalProcessed += regionProcessed;
      console.log(`✓ Region ${regionId}: ${regionProcessed} blueprints processed`);
    }

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

    console.log('═══════════════════════════════════════════');
    console.log(`✓ PRE-COMPUTE COMPLETE`);
    console.log(`  Blueprints × Regions: ${totalProcessed}`);
    console.log(`  Duration: ${durationSec.toFixed(1)}s`);
    console.log('═══════════════════════════════════════════');

    preComputeRunning = false;
    return { status: 'completed', processed: totalProcessed, durationSec };

  } catch (err) {
    // Rollback on failure
    try { await dbRun('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }

    await dbRun(`
      UPDATE precompute_runs
      SET completed_at = datetime('now'),
          status = 'failed',
          error = ?
      WHERE id = ?
    `, [err.message, runId]);

    console.error('❌ Pre-compute failed:', err.message);
    preComputeRunning = false;
    return { status: 'failed', error: err.message };
  }
}

// Synchronous material cost calculation using in-memory data
// Avoids per-item DB queries during pre-compute (performance critical)
function calculateMaterialCostSync(materialId, quantity, prices, materialsByBp, bpByProduct, depth = 0) {
  // Prevent infinite recursion on circular references
  if (depth > 10) {
    return (prices[materialId]?.buy || 0) * quantity;
  }

  const subBpId = bpByProduct[materialId];
  if (subBpId) {
    const subMats = materialsByBp[subBpId] || [];
    let mfgCost = 0;
    for (const sub of subMats) {
      mfgCost += calculateMaterialCostSync(
        sub.material_id, sub.quantity, prices, materialsByBp, bpByProduct, depth + 1
      );
    }
    const buyCost = (prices[materialId]?.buy || 0) * quantity;
    return Math.min(mfgCost * quantity, buyCost);
  }

  return (prices[materialId]?.buy || 0) * quantity;
}

// VOLUME ENRICHMENT JOB (v0.9.1)
// Fetches market history + market_group_id for top profitable items
// Runs incrementally to respect ESI rate limits

let volumeEnrichmentRunning = false;

async function runVolumeEnrichment() {
  if (volumeEnrichmentRunning) {
    console.log('⚠ Volume enrichment already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  volumeEnrichmentRunning = true;
  const startTime = Date.now();

  try {
    console.log('═══════════════════════════════════════════');
    console.log('⟳ VOLUME ENRICHMENT STARTING');
    console.log('═══════════════════════════════════════════');

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
      console.log('✓ No items need enrichment');
      volumeEnrichmentRunning = false;
      return { status: 'completed', enriched: 0, message: 'All items already enriched' };
    }

    console.log(`⟳ Enriching ${itemsToEnrich.length} items...`);

    let enriched = 0;
    let errors = 0;
    let contractOnlyCount = 0;
    let extremeMarginCount = 0;
    let lowVolumeCount = 0;
    let suspiciousSpreadCount = 0;
    let noBuyOrdersCount = 0;

    for (const item of itemsToEnrich) {
      try {
        // Fetch market history for volume data
        const historyRes = await fetch(
          `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${item.product_id}`
        );

        let avgVolume = 0;
        if (historyRes.ok) {
          const history = await historyRes.json();
          if (Array.isArray(history) && history.length > 0) {
            // Calculate 30-day average (or less if not enough data)
            const recentHistory = history.slice(-30);
            const totalVolume = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
            avgVolume = recentHistory.length > 0 ? totalVolume / recentHistory.length : 0;
          }
        }

        // Fetch market_group_id to detect non-marketable items
        const typeRes = await fetch(
          `https://esi.evetech.net/latest/universe/types/${item.product_id}/?datasource=tranquility`
        );

        let marketGroupId = null;
        if (typeRes.ok) {
          const typeData = await typeRes.json();
          marketGroupId = typeData.market_group_id || null;
        }

        // Determine liquidity risk using 4-tier system
        let liquidityRisk = null;
        
        // TIER 1: Contract-only items (cannot be sold on market)
        if (marketGroupId === null) {
          liquidityRisk = 'contract_only';
        }
        // TIER 2: Margin cap (500% maximum - anything beyond is likely scam/phantom)
        else if (item.material_cost > 0 && (item.sell_price / item.material_cost) > 5.0) {
          liquidityRisk = 'extreme_margin';
        }
        // TIER 3: Volume requirements (tiered by price)
        else if (item.sell_price < 100000000 && avgVolume < 10) {
          liquidityRisk = 'low_volume'; // <100M ISK needs 10+ units/day
        } else if (item.sell_price >= 100000000 && item.sell_price < 1000000000 && avgVolume < 5) {
          liquidityRisk = 'low_volume'; // 100M-1B ISK needs 5+ units/day
        } else if (item.sell_price >= 1000000000 && avgVolume < 2) {
          liquidityRisk = 'low_volume'; // >1B ISK needs 2+ units/day
        }
        // TIER 4: Spread sanity check
        else if (item.buy_price === 0 && item.sell_price > 10000000) {
          liquidityRisk = 'no_buy_orders'; // >10M ISK with no buy orders = suspicious
        } else if (item.material_cost > 0 && ((item.sell_price - item.material_cost) / item.sell_price) > 0.9) {
          liquidityRisk = 'suspicious_spread'; // >90% spread is unusual
        }

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
        console.error(`  ✗ Error enriching ${item.product_name}:`, err.message);
        errors++;
      }
    }

    // Copy volume/market data from Jita rows to all other region rows.
    // avg_daily_volume and market_group_id are item properties, not region-specific.
    if (enriched > 0) {
      console.log('⟳ Copying volume data from Jita to other regions...');
      await dbRun(`
        UPDATE precomputed_profits AS target
        SET avg_daily_volume = (
              SELECT p.avg_daily_volume FROM precomputed_profits p
              WHERE p.product_id = target.product_id AND p.region_id = 10000002
            ),
            market_group_id = (
              SELECT p.market_group_id FROM precomputed_profits p
              WHERE p.product_id = target.product_id AND p.region_id = 10000002
            ),
            liquidity_risk = (
              SELECT p.liquidity_risk FROM precomputed_profits p
              WHERE p.product_id = target.product_id AND p.region_id = 10000002
            )
        WHERE target.region_id != 10000002
          AND EXISTS (
            SELECT 1 FROM precomputed_profits p
            WHERE p.product_id = target.product_id
              AND p.region_id = 10000002
              AND p.avg_daily_volume IS NOT NULL
          )
      `);
      console.log('✓ Volume data copied to all regions');
    }

    const durationSec = (Date.now() - startTime) / 1000;

    console.log('═══════════════════════════════════════════');
    console.log(`✓ VOLUME ENRICHMENT COMPLETE`);
    console.log(`  Enriched: ${enriched} items`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Filtered: ${contractOnlyCount + extremeMarginCount + lowVolumeCount + suspiciousSpreadCount + noBuyOrdersCount} total`);
    console.log(`    - Contract-only: ${contractOnlyCount}`);
    console.log(`    - Extreme margin (>500%): ${extremeMarginCount}`);
    console.log(`    - Low volume: ${lowVolumeCount}`);
    console.log(`    - No buy orders: ${noBuyOrdersCount}`);
    console.log(`    - Suspicious spread: ${suspiciousSpreadCount}`);
    console.log(`  Duration: ${durationSec.toFixed(1)}s`);
    console.log('═══════════════════════════════════════════');

    volumeEnrichmentRunning = false;
    return { status: 'completed', enriched, errors, durationSec };

  } catch (err) {
    console.error('❌ Volume enrichment failed:', err.message);
    volumeEnrichmentRunning = false;
    return { status: 'failed', error: err.message };
  }
}

// PRE-COMPUTED PROFITABILITY API (v0.9.0)
// Serves data from DB — zero AI tokens
app.get('/api/top-profitable', security.apiLimiter, async (req, res) => {
  try {
    const sort = req.query.sort || 'profit';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const minProfit = parseFloat(req.query.minProfit) || 0;
    const minVolume = parseFloat(req.query.minVolume) !== undefined ? parseFloat(req.query.minVolume) : 5;
    const includeRisky = req.query.includeRisky === 'true';
    const regionId = VALID_REGIONS.includes(parseInt(req.query.regionId)) ? parseInt(req.query.regionId) : 10000002;

    // Validate sort column to prevent SQL injection
    const allowedSorts = {
      profit: 'profit DESC',
      margin: 'profit_margin DESC',
      isk_per_hour: 'isk_per_hour DESC',
      cost: 'material_cost ASC',
      sell_price: 'sell_price DESC'
    };

    const orderClause = allowedSorts[sort] || allowedSorts.profit;

    // Build WHERE clause with CRITICAL risk filtering only
    // low_volume is a WARNING (shown to user), not CRITICAL (excluded)
    let whereConditions = ['region_id = ?', 'profit > ?', 'sell_price > 0'];
    const params = [regionId, minProfit];

    // Apply volume filter (skip if volume data not available yet)
    if (minVolume > 0) {
      whereConditions.push('(avg_daily_volume >= ? OR avg_daily_volume IS NULL)');
      params.push(minVolume);
    }

    // Exclude CRITICAL risks only (not low_volume)
    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL 
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    const results = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ?
    `, [...params, limit]);

    // Get last run info
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
    console.error('Top profitable error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

// TOP PROFITABLE by Skills — filters top 50 by user's trained skills
// For Market Opportunities tab — shows only blueprints user can build
app.get('/api/top-profitable-by-skills', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const sort = req.query.sort || 'profit';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const minProfit = parseFloat(req.query.minProfit) || 0;
    const minVolume = parseFloat(req.query.minVolume) !== undefined ? parseFloat(req.query.minVolume) : 5;
    const includeRisky = req.query.includeRisky === 'true';
    const regionId = VALID_REGIONS.includes(parseInt(req.query.regionId)) ? parseInt(req.query.regionId) : 10000002;

    // Get user's skills from session cache
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);

    if (!sessionData || !sessionData.skills || sessionData.skills.length === 0) {
      console.warn(`⚠ Skills not in session for character ${characterId} — returning unfiltered top-profitable`);

      // Build same query as /api/top-profitable so the tab isn't blank
      const fbAllowedSorts = { profit: 'profit DESC', margin: 'profit_margin DESC', isk_per_hour: 'isk_per_hour DESC' };
      const fbOrder = fbAllowedSorts[sort] || fbAllowedSorts.profit;
      const fbWhere = ['region_id = ?', 'profit > ?', 'sell_price > 0', `(liquidity_risk IS NULL OR liquidity_risk = "" OR liquidity_risk = "low_volume")`];
      const fbParams = [regionId, minProfit];
      const fbResults = await dbAll(
        `SELECT blueprint_id, product_id, product_name, material_cost, sell_price, buy_price, profit, profit_margin, isk_per_hour, build_time, material_count, computed_at, avg_daily_volume, liquidity_risk, COALESCE(activity_id,1) as activity_id FROM precomputed_profits WHERE ${fbWhere.join(' AND ')} ORDER BY ${fbOrder} LIMIT ?`,
        [...fbParams, limit]
      );
      const fbLastRun = await dbGet(`SELECT completed_at FROM precompute_runs ORDER BY id DESC LIMIT 1`);
      return res.json({
        results: fbResults,
        meta: { count: fbResults.length, sort, filter: 'unfiltered_skills_unavailable', lastComputed: fbLastRun?.completed_at || null }
      });
    }

    const characterSkills = sessionData.skills || [];

    // Validate sort column
    const allowedSorts = {
      profit: 'profit DESC',
      margin: 'profit_margin DESC',
      isk_per_hour: 'isk_per_hour DESC',
      cost: 'material_cost ASC',
      sell_price: 'sell_price DESC'
    };

    const orderClause = allowedSorts[sort] || allowedSorts.profit;

    // Build WHERE clause
    let whereConditions = ['region_id = ?', 'profit > ?', 'sell_price > 0'];
    const params = [regionId, minProfit];

    if (minVolume > 0) {
      whereConditions.push('(avg_daily_volume >= ? OR avg_daily_volume IS NULL)');
      params.push(minVolume);
    }

    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get candidate items — 3× (offset + limit) to survive skill filtering
    const candidates = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk,
             COALESCE(activity_id, 1) as activity_id
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ?
    `, [...params, (offset + limit) * 3]);

    // Filter by skill requirements, skipping the first `offset` qualified items
    const results = [];
    let skipped = 0;
    for (const item of candidates) {
      const canBuild = await canBuildBlueprint(characterSkills, item.blueprint_id);
      if (canBuild) {
        if (skipped < offset) { skipped++; continue; }
        results.push(item);
        if (results.length >= limit) break;
      }
    }

    console.log(`✓ Top ${results.length} profitable items (filtered by skills for character ${characterId})`);

    // Get last run info
    const lastRun = await dbGet(`
      SELECT completed_at, blueprints_processed, duration_seconds, status
      FROM precompute_runs
      ORDER BY id DESC LIMIT 1
    `);

    res.json({
      results,
      meta: {
        count: results.length,
        sort,
        minProfit,
        minVolume,
        includeRisky,
        filter: 'by_skills',
        skillsLoaded: characterSkills.length,
        lastComputed: lastRun?.completed_at || null,
        lastRunStatus: lastRun?.status || 'never',
        offset,
        hasMore: results.length >= limit,
      }
    });

  } catch (err) {
    console.error('Top profitable by skills error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
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

    // Sanitise: only allow alphanumeric, spaces, hyphens, apostrophes
    const sanitised = query.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50);

    // Build WHERE clause
    let whereConditions = ['product_name LIKE ?'];
    const params = [`%${sanitised}%`];

    // Exclude CRITICAL risks only (not low_volume)
    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL 
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    const results = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY profit DESC
      LIMIT 20
    `, params);

    res.json({ results, query: sanitised, includeRisky });

  } catch (err) {
    console.error('Search profitable error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

// Admin: Manually trigger pre-compute
app.post('/api/admin/precompute', async (req, res) => {
  // Simple API key auth for admin endpoints
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runPreCompute();

  if (preComputeRunning) {
    res.json({ message: 'Pre-compute job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});

// Admin: View pre-compute run history
app.get('/api/admin/precompute-status', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
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
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE liquidity_risk IS NOT NULL AND liquidity_risk != ""'
    );

    res.json({
      runs,
      summary: {
        totalPrecomputed: totalBlueprints?.count || 0,
        profitable: profitable?.count || 0,
        enriched: enriched?.count || 0,
        risky: risky?.count || 0,
        isRunning: preComputeRunning
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Manually trigger volume enrichment (v0.9.1)
app.post('/api/admin/volume-enrichment', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runVolumeEnrichment();

  if (volumeEnrichmentRunning) {
    res.json({ message: 'Volume enrichment job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});

// AI COST TRACKING (v0.9.0)

// Sonnet 4.6 pricing (per million tokens, as of 2026)
const AI_PRICING = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 }
};

// FORGE AI SYSTEM PROMPT (static — cached server-side)
// Moving this here enables Anthropic prompt caching (90% token discount
// on repeat calls within 5 minutes)
const FORGE_STATIC_SYSTEM_PROMPT = `You are F.O.R.G.E. — a specialized EVE Online manufacturing intelligence advisor.

══ SCOPE ══
You ONLY answer questions about EVE Online:
- Manufacturing, industry, blueprints, production, T2/T3 chains
- Items, ships, modules, materials, components
- Market prices, profitability, ISK/hour
- Assets, inventory, active jobs, blueprint ownership
- EVE game mechanics related to industry

Politely refuse ALL non-EVE questions: "I'm specialized for EVE manufacturing only."

══ TOOLS (use these to answer questions — do not guess from memory) ══
1. get_precomputed(sort, limit, search, minProfit, includeRisky, activityType, regionId?)
   PREFERRED for profit/market questions. Pre-computed data per hub, fast, no cost.
   Use FIRST for: "what's profitable", "top items", "best ISK/hour", "best reactions", "top reactions to run".
   activityType: "all" (default) | "manufacturing" | "reaction"
   Results include activity_id: 1=manufacturing, 9=reaction.
   regionId: omit for Jita (default). Use hub IDs for hub-specific top lists:
     Jita=10000002 | Amarr=10000043 | Dodixie=10000032 | Hek=10000042 | Rens=10000030 | Syndicate=10000041
   Example: "What's most profitable to sell in Amarr?" → get_precomputed({ sort:"profit", regionId:10000043 })

2. compare_markets(query)
   Cross-hub profit comparison for a SPECIFIC item across ALL 6 trade hubs.
   Returns profit for two strategies per hub:
     A) local_materials — buy inputs AND sell at the same hub
     B) jita_materials  — buy inputs in Jita, sell finished goods at each hub
   Use for: "where should I sell X", "Jita vs Amarr for X", "best hub to sell Drake",
             "should I buy materials in Jita and sell in Amarr", "which market is best for X",
             "compare markets for X".
   PROACTIVELY use this whenever a user asks about a specific item AND mentions multiple hubs
   or asks where to sell. Present jita_materials strategy as it is almost always the better option.
   Always surface the recommendation.bestJitaMaterialsStrategy as your primary advice.

3. analyze_blueprints(sortBy, limit, buildableOnly)
   Analyzes the player's OWN blueprints against their assets.
   sortBy options: profit | margin | cost | time | materials | completion
   Use "completion" sort for: "T2 chains closest to finishing", "what can I almost build",
   "which blueprints am I closest to having all materials for".
   Returns completionPct (0-100) and techTier (T1/T2/T3) per item.
   Also returns skipped/skippedNames — blueprints not found in the SDE database.
   If skippedNames is non-empty, inform user: "Note: X blueprints weren't found in the database: [names]"

4. get_blueprint(itemName or productId)
   Detailed materials + costs for any single blueprint.
   Use when user asks about a specific item. Resolve productName: null via productId.

5. get_price(itemName)
   Live Jita price for any item not already in context.

6. get_active_jobs(activityFilter?)
   Returns the player's current industry job queue with time remaining.
   Use for: "what's building", "active jobs", "reactions running", "job queue".

7. get_t2_blueprints(sort?)
   Returns ALL T2 blueprints owned by the player (BPOs and BPCs, meta_level=1).
   Use for: "list my T2 blueprints", "show all T2 copies", "what T2 do I own".
   Returns total count, owned type (BPO/BPC), and quantity.

8. diagnose_blueprints()
   Checks which of the player's blueprints exist in the SDE database.
   Use when analyze_blueprints returns no T2 results, or user reports missing T2 data.
   Returns exact counts and names of T2 blueprints found vs missing from DB.
   If t2_missing > 0: explain the database gap clearly to the user and list the missing blueprint names.

9. get_price_comparison(item_name)
   Live buy/sell prices for ANY item across all 6 trade hubs.
   Use for: minerals, moon goo, raw materials, loot, commodities — anything the user wants to buy or sell.
   Unlike compare_markets (manufactured goods only), this works for any tradeable item.
   Returns: all_hubs prices, cheapest_to_buy_from, best_to_sell_into, arbitrage_opportunity.

   Triggers — use proactively, don't wait to be asked:
   - "Where should I sell my [item]?" → call tool, lead with best_to_sell_into
   - "Where can I buy [item]?" → call tool, lead with cheapest_to_buy_from + note sell_price is what you pay
   - "Compare [item] prices across hubs" → call tool, show all_hubs breakdown
   - "Is there arbitrage on [item]?" → call tool, show arbitrage_opportunity
   - "Best place to source minerals / moon goo" → call tool once per item mentioned
   - "What's Tritanium worth in Amarr?" → call tool, find Amarr entry in all_hubs

   When answering: lead with the direct recommendation, mention arbitrage if meaningful (> ~5% margin),
   call tool once per distinct item if multiple items are asked about.

Never show raw type IDs ("Item #12345") — always resolve names first.

══ PLAYER DATA ══
The "Current player context" block below contains live data from this session:
wallet, blueprint count (BPOs/BPCs), top asset holdings, and active jobs.
Use this as your baseline before calling tools. Call get_active_jobs for full job detail.

══ PRICING ══
- Tools return: sell (lowest ask), buy (highest bid), median (volume-weighted average)
- Use MEDIAN for profit estimates — it's most realistic
- Express profits as ranges: "between 15M–25M ISK depending on how you sell"
- For deep market data: https://evetycoon.com/market/[typeId]

══ PROFITABILITY STRATEGY ══
PRIMARY (lead with these):
- Highest absolute ISK profit AND margin combined
- Targets: 5M+ sell price, 30%+ margin, 10M+ profit per run

SECONDARY (mention after, frame as alternatives):
- High margin but lower value items (volume/passive income)
- "For high-volume passive income: ..."

DO NOT lead with items below 5M sell price or below 20% margin unless specifically asked.

══ RESPONSE FORMAT ══
For ALL manufacturing recommendations and analysis, use this structure:

1. Prose opening (2–3 sentences): context and recommendation
2. Bullet points for key metrics — bold the values:
   • Metric label: **value**
   • Keep each bullet to one line
   • Order: profit first, then margin, build time, ownership status
3. Optional closing action: "Ready to queue this?" or "Want other options?"

NEVER use table headers (--|--) or columnar formatting.
NEVER use bare numbers without labels.

Examples of CORRECT bullet format:
  • Profit per run: **47.2M ISK**
  • Profit margin: **28.3%**
  • ISK/hour: **12.8M**
  • Build time: **3h 45m**
  • Owned: **BPO** (unlimited runs)

Examples to AVOID:
  ✗ Profit | Margin | Time  (table headers)
  ✗ profit:47.2M,margin:28.3%  (no spaces, unreadable)
  ✗ Long paragraphs listing all metrics (use bullets for scanning)

══ ITEM NAME RULES ══
Always use FULL item names — they are used as clickable links in the UI.
  ✗ Trit → ✓ Tritanium
  ✗ MSE → ✓ Medium Shield Extender
  ✗ LSE → ✓ Large Shield Extender
  ✗ BPO → ✓ Blueprint Original
  ✗ BPC → ✓ Blueprint Copy

Keep answers under 300 words unless the user asks for detail.`;

async function trackAiUsage(characterId, model, usage) {
  try {
    const pricing = AI_PRICING[model] || { input: 3.00, output: 15.00 };

    const regularInputCost = (usage.input_tokens || 0)                               * pricing.input         / 1_000_000;
    const cacheWriteCost   = (usage.cache_creation_input_tokens || 0) * pricing.input * 1.25   / 1_000_000;
    const cacheReadCost    = (usage.cache_read_input_tokens || 0)     * pricing.input * 0.1    / 1_000_000;
    const outputCost       = (usage.output_tokens || 0)                               * pricing.output        / 1_000_000;

    const estimatedCost    = regularInputCost + cacheWriteCost + cacheReadCost + outputCost;
    const totalInputTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);

    await dbRun(`
      INSERT INTO ai_usage (character_id, model, input_tokens, output_tokens, estimated_cost)
      VALUES (?, ?, ?, ?, ?)
    `, [characterId, model, totalInputTokens, usage.output_tokens || 0, estimatedCost]);
  } catch (err) {
    console.error('AI usage tracking error:', err.message);
    // Non-fatal — don't break the response
  }
}

// Admin: View AI costs
app.get('/api/admin/ai-costs', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Today
    const today = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now')
    `);

    // Last 7 days
    const week = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
    `);

    // Last 30 days
    const month = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-30 days')
    `);

    // Daily breakdown (last 7 days)
    const daily = await dbAll(`
      SELECT date(created_at) as date,
             COUNT(*) as requests,
             SUM(estimated_cost) as cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
      GROUP BY date(created_at)
      ORDER BY date DESC
    `);

    res.json({ today, week, month, daily });

  } catch (err) {
    res.status(500).json({ error: err.message });
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
        COUNT(CASE WHEN liquidity_risk IS NOT NULL AND liquidity_risk != "" THEN 1 END) as risky
      FROM precomputed_profits WHERE profit > 0
    `);
  } catch (_) { /* column may not exist yet */ }

  res.json({ 
    status: "ok",
    version: "1.0.0.0",
    uptime: process.uptime(),
    database: db ? "connected" : "disconnected",
    precompute: {
      lastRun: lastPrecompute?.completed_at || null,
      lastStatus: lastPrecompute?.status || 'never',
      blueprintsProcessed: lastPrecompute?.blueprints_processed || 0,
      isRunning: preComputeRunning
    },
    volumeEnrichment: {
      total: enrichmentStats?.total || 0,
      enriched: enrichmentStats?.enriched || 0,
      risky: enrichmentStats?.risky || 0,
      isRunning: volumeEnrichmentRunning
    },
    priceCache: {
      loaded: !!jitaPricesCache,
      items: jitaPricesCache ? Object.keys(jitaPricesCache).length : 0
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v1.2.0 — INDUSTRY SETTINGS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/industry-settings — fetch saved settings for the authed character
app.get('/api/industry-settings', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    res.json(settings || {
      system_id: null, system_name: null,
      structure_type_id: null, rig_ids: '[]', facility_tax: 0,
    });
  } catch (err) {
    console.error('Industry settings GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/industry-settings — save settings for the authed character
app.post('/api/industry-settings', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const { system_id, system_name, structure_type_id, rig_ids, facility_tax } = req.body;

    // Validate: facility_tax must be 0–100
    const tax = Math.min(100, Math.max(0, parseFloat(facility_tax) || 0));

    await dbRun(`
      INSERT INTO character_industry_settings
        (character_id, system_id, system_name, structure_type_id, rig_ids, facility_tax, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        system_id          = excluded.system_id,
        system_name        = excluded.system_name,
        structure_type_id  = excluded.structure_type_id,
        rig_ids            = excluded.rig_ids,
        facility_tax       = excluded.facility_tax,
        updated_at         = excluded.updated_at
    `, [
      characterId, system_id || null, system_name || null,
      structure_type_id || null,
      JSON.stringify(Array.isArray(rig_ids) ? rig_ids : []),
      tax,
      new Date().toISOString(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Industry settings POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/system-search?q=<query> — autocomplete solar system names (local index)
// Uses the system name map built by fetchCostIndices() — no ESI search call needed.
// Prefix matches are ranked first; falls back to substring matches.
// Returns up to 10 results.
app.get('/api/system-search', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);

    // Warm the cache if needed (also triggers name lookup on first call)
    await fetchCostIndices();

    const nameMap = costIndexCache.nameMap;
    if (!nameMap || nameMap.size === 0) return res.json([]);

    const prefix    = [];
    const substring = [];

    for (const [nameLower, info] of nameMap) {
      if (nameLower.startsWith(q)) {
        prefix.push(info);
      } else if (nameLower.includes(q)) {
        substring.push(info);
      }
      // Early exit once we have enough results
      if (prefix.length >= 10) break;
    }

    // Prefix matches first (sorted alphabetically), then substring matches
    prefix.sort((a, b) => a.system_name.localeCompare(b.system_name));
    substring.sort((a, b) => a.system_name.localeCompare(b.system_name));

    const results = [...prefix, ...substring].slice(0, 10);
    res.json(results);
  } catch (err) {
    console.error('System search error:', err.message);
    res.json([]);
  }
});

// POST /api/true-cost — calculate full True Profit for an item with all fees
// Body: { product_id, me, te, runs, regionId }
//
// Calculation is fully local — no external API calls during the request:
//   • Material quantities  → blueprint_materials table (already in DB)
//   • Adjusted prices      → ESI /markets/prices/ (cached 6 h, warmed on first use)
//   • System Cost Index    → ESI /industry/systems/ (cached 1 h, warmed on first use)
//   • Sell price           → regionPriceCache (populated by precompute job)
//   • Sales fees           → character skills + standings (session cache)
//
// Job cost formula (EVE manufacturing):
//   EIV             = Σ(adjusted_price[mat] × ME-adjusted qty) × runs
//   System Job Cost = EIV × SCI
//   SCC Surcharge   = EIV × 2%     (reduced from 4% in the Legion update)
//   Facility Tax    = EIV × facility_tax_rate
//   Total Job Cost  = System Job Cost + SCC Surcharge + Facility Tax
app.post('/api/true-cost', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const { product_id, me = 0, te = 0, runs = 1, regionId = 10000002 } = req.body;
    const characterId = req.characterId;

    if (!product_id) return res.status(400).json({ error: 'product_id required' });

    // ── Session: skills + standings ────────────────────────────────────────
    const session   = getCached(`session:${characterId}`);
    const skillsArr = session?.skills   || [];
    const standings = session?.standings || { factions: {}, corps: {} };

    const skillMap = {};
    skillsArr.forEach(s => { skillMap[Number(s.skill_id)] = s.active_skill_level || 0; });

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
      'SELECT blueprint_id, product_quantity FROM blueprints WHERE product_id = ?',
      [product_id]
    );
    if (!blueprint) {
      return res.status(404).json({ error: `No blueprint found for product ${product_id}` });
    }
    const materials = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [blueprint.blueprint_id]
    );

    // ── Adjusted prices + cost indices (ESI, cached) ──────────────────────
    // These calls return instantly when cache is warm; first call ~2–5 s each.
    const [adjustedPrices, costIndices] = await Promise.all([
      fetchAdjustedPrices(),
      fetchCostIndices(),
    ]);

    // ── EIV (Estimated Item Value for job-fee calculation) ─────────────────
    // ME reduces required quantity per material.
    // Each material quantity is rounded UP (ceil), min 1.
    const meFactor = Math.max(0, 1 - me / 100);
    let eiv = 0;
    for (const mat of materials) {
      const adjPrice = adjustedPrices[mat.material_id] || 0;
      const adjQty   = Math.max(1, Math.ceil(mat.quantity * meFactor)) * runs;
      eiv += adjPrice * adjQty;
    }

    // ── Manufacturing job cost ─────────────────────────────────────────────
    const sci            = costIndices[targetSystemId] || 0;
    const systemJobCost  = eiv * sci;
    const sccSurcharge   = eiv * 0.02;         // 2% SCC surcharge (Legion update)
    const facilityTaxCost = eiv * facilityTaxDecimal;
    const totalJobCost   = systemJobCost + sccSurcharge + facilityTaxCost;

    // ── Material cost (market sell prices, Jita-sourced) ──────────────────
    // Use region price cache. Jita is the sourcing market for materials regardless
    // of where the player sells, so we always use region 10000002 for mat costs.
    const jitaEntry  = regionPriceCache.get(10000002);
    const jitaWarm   = !!(jitaEntry && Date.now() < jitaEntry.expiry);
    let totalMaterialCost = 0;
    for (const mat of materials) {
      const matPrice = jitaWarm ? (jitaEntry.prices[mat.material_id]?.sell || 0) : 0;
      const adjQty   = Math.max(1, Math.ceil(mat.quantity * meFactor)) * runs;
      totalMaterialCost += matPrice * adjQty;
    }

    // ── Sell price (selected region) ───────────────────────────────────────
    const regionEntry  = regionPriceCache.get(regionId);
    const pricesWarm   = !!(regionEntry && Date.now() < regionEntry.expiry);
    const unitSell     = pricesWarm ? (regionEntry.prices[product_id]?.sell || 0) : 0;
    const productUnits = (blueprint.product_quantity || 1) * runs;
    const sellPrice    = unitSell * productUnits;

    // ── Sales fees ─────────────────────────────────────────────────────────
    const hub             = HUB_STANDINGS[regionId];
    const brokerRelations = skillMap[3446]  || 0;
    const accounting      = skillMap[16622] || 0;
    const factionStanding = standings.factions[hub?.faction_id] || 0;
    const corpStanding    = standings.corps[hub?.corp_id]       || 0;

    // Broker fee: max(1%, 3% − 0.3%×BR − 0.03%×max(0,faction) − 0.02%×max(0,corp))
    const brokerFeeRate = Math.max(0.01,
      0.03
      - (0.003  * brokerRelations)
      - (0.0003 * Math.max(0, factionStanding))
      - (0.0002 * Math.max(0, corpStanding))
    );
    // Transaction tax: max(0%, 7.5% × (1 − 11%×Accounting))
    const transactionTaxRate = Math.max(0, 0.075 * (1 - 0.11 * accounting));

    const brokerFee      = sellPrice * brokerFeeRate;
    const transactionTax = sellPrice * transactionTaxRate;
    const totalSalesTax  = brokerFee + transactionTax;

    // ── True profit ────────────────────────────────────────────────────────
    const trueProfit = sellPrice - brokerFee - transactionTax - totalMaterialCost - totalJobCost;
    const trueMargin = sellPrice > 0 ? (trueProfit / sellPrice) * 100 : 0;

    const STRUCTURE_LABELS = { 35825: 'Raitaru', 35826: 'Azbel', 35827: 'Sotiyo' };
    const structureLabel = settings?.structure_type_id
      ? (STRUCTURE_LABELS[settings.structure_type_id] || 'Engineering Complex')
      : 'NPC Station';

    res.json({
      product_id,
      runs,
      sell_price: sellPrice,

      // Box 1 — materials (Jita market sell price, ME-adjusted)
      total_material_cost: totalMaterialCost,

      // Box 2 — manufacturing fees
      mfg_fees: {
        total:                totalJobCost,
        system_cost_index:    systemJobCost,       // EIV × SCI
        system_cost_bonuses:  0,                   // rig bonuses not yet category-matched
        facility_tax:         facilityTaxCost,
        scc_surcharge:        sccSurcharge,
        alpha_clone_tax:      0,                   // Omega accounts only
        estimated_item_value: eiv,
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

      // Box 4 — true profit
      true_profit: trueProfit,
      true_margin: trueMargin,

      // Context
      region_id:        regionId,
      prices_warm:      pricesWarm && jitaWarm,
      setup_configured: !!(settings?.system_id),
      manufacturing_setup: {
        system_id:          settings?.system_id         || null,
        system_name:        settings?.system_name       || 'Not configured — using Jita IV',
        structure_type_id:  settings?.structure_type_id || null,
        structure_label:    structureLabel,
        rig_ids:            rigIds,
        facility_tax_pct:   settings?.facility_tax      || 0,
        sci_raw:            sci,
      },
    });

  } catch (err) {
    console.error('True cost error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: err.message });
  }
});

// START SERVER
initDatabase().then(async () => {
  // Run v0.9.0 migrations
  await runMigrations();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
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
      console.log('⟳ Running initial pre-compute...');
      runPreCompute().then(result => {
        console.log('✓ Initial pre-compute:', result.status);
        
        // After pre-compute completes, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            console.log('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              console.log('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              console.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000); // 5 second delay after pre-compute
        }
      }).catch(err => {
        console.error('⚠ Initial pre-compute failed:', err.message);
      });
    }, 10000);

    // Schedule pre-compute every 6 hours
    // (Daily would be fine, but 6-hourly keeps prices fresher without ESI abuse)
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      console.log('⟳ Scheduled pre-compute starting...');
      runPreCompute().then(result => {
        console.log('✓ Scheduled pre-compute:', result.status);
        
        // After scheduled pre-compute, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            console.log('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              console.log('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              console.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000);
        }
      }).catch(err => {
        console.error('⚠ Scheduled pre-compute failed:', err.message);
      });
    }, SIX_HOURS);
  });

  // Error handler must be after all routes
  app.use(security.errorHandler);
  
}).catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
