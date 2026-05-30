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
const crypto = require('crypto');  // built-in — AES-256-GCM token encryption + scrypt PIN hashing
const security = require('./forge-security');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust Cloudflared proxy
const PORT = process.env.PORT || 3000;

// ── ESI HTTP helper ───────────────────────────────────────────────────────────
// EVE ESI policy requires a descriptive User-Agent on every outbound request.
const ESI_USER_AGENT = 'FORGE Manufacturing Intelligence/1.5 (forge-ukc.com)';
function esiFetch(url, opts = {}) {
  // User-Agent is set LAST so callers cannot accidentally override the ESI-required header
  const headers = Object.assign({}, opts.headers || {}, { 'User-Agent': ESI_USER_AGENT });
  return fetch(url, Object.assign({}, opts, { headers }));
}

// ── Global process error handlers ────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('⚠ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠ Uncaught exception:', err);
  process.exit(1);
});

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
        // WAL mode: allows concurrent readers while a write is in progress.
        // Without this, the precompute/volume-copy UPDATE locks every incoming request.
        db.run('PRAGMA journal_mode=WAL', () => {
          db.run('PRAGMA synchronous=NORMAL', () => resolve());
        });
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
    await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_product ON precomputed_profits (product_id)`);
    console.log('✓ precomputed_profits migrated to multi-region schema');
  }

  // v1.2.0 migration: product_id index for fast volume copy
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_product ON precomputed_profits (product_id)`);

  // v1.2.0 migration: Industry settings per character
  await dbRun(`
    CREATE TABLE IF NOT EXISTS character_industry_settings (
      character_id           INTEGER PRIMARY KEY,
      system_id              INTEGER DEFAULT NULL,
      system_name            TEXT    DEFAULT NULL,
      structure_type_id      INTEGER DEFAULT NULL,   -- NULL = NPC station
      rig_ids                TEXT    DEFAULT '[]',   -- JSON array of rig type_ids
      facility_tax           REAL    DEFAULT 0.0,    -- 0.0–1.0 decimal (not %)
      material_region_id     INTEGER DEFAULT 10000002, -- hub where materials are sourced (default Jita)
      material_region_name   TEXT    DEFAULT 'Jita',
      updated_at             TEXT    NOT NULL DEFAULT ''
    )
  `);

  // v1.3.0 migration: material source hub columns (idempotent — ignored if already present)
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN material_region_id   INTEGER DEFAULT 10000002`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN material_region_name TEXT    DEFAULT 'Jita'`);    } catch (_) {}

  // v1.6.0 migration: haulage columns on industry settings + packaged_volume on items
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN haul_enabled  INTEGER DEFAULT 0`);   } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_haul_rate REAL DEFAULT 0`);     } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_haul_rate REAL DEFAULT 0`);     } catch (_) {}
  try { await dbRun(`ALTER TABLE items ADD COLUMN packaged_volume REAL DEFAULT NULL`);                        } catch (_) {}

  // v1.7.0 migration: haulage Phase 2 — method selectors, collateral, per-jump, flat total, self-haul
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_method       TEXT    DEFAULT 'user_defined'`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_method       TEXT    DEFAULT 'user_defined'`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_collateral   REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_collateral   REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_isk_per_jump REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_isk_per_jump REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_flat_total   REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_flat_total   REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_service_label TEXT   DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_service_label TEXT   DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_self_char_id  INTEGER DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_self_ship     TEXT    DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg1_self_fuel     REAL    DEFAULT 0`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_self_char_id  INTEGER DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_self_ship     TEXT    DEFAULT NULL`); } catch (_) {}
  try { await dbRun(`ALTER TABLE character_industry_settings ADD COLUMN leg2_self_fuel     REAL    DEFAULT 0`); } catch (_) {}

  // ── v1.4.0 Corp Feature migrations ─────────────────────────────────────────
  //
  // corp_config         — one row per corporation; stores encrypted director refresh token + PIN hash
  // corp_blueprints     — ESI corp blueprint cache (refreshed via director token)
  // corp_assets         — ESI corp asset cache
  // corp_jobs           — ESI corp industry job cache
  // corp_pin_sessions   — tracks which characters have successfully verified the PIN (24hr expiry)
  // corp_admin_access   — admin-whitelist: characters that bypass PIN entirely (dev/testing)
  //
  // Token encryption:  AES-256-GCM via Node built-in crypto (no extra dependencies)
  // PIN hashing:       crypto.scrypt (Node built-in; memory-hard; no extra dependencies)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_config (
      corp_id              INTEGER PRIMARY KEY,
      corp_name            TEXT    NOT NULL DEFAULT '',
      director_char_id     INTEGER NOT NULL,
      director_char_name   TEXT    NOT NULL DEFAULT '',
      enc_refresh_token    TEXT    NOT NULL,  -- AES-256-GCM ciphertext, base64
      token_iv             TEXT    NOT NULL,  -- 12-byte IV, hex
      token_tag            TEXT    NOT NULL,  -- 16-byte auth tag, hex
      pin_hash             TEXT    NOT NULL,  -- scrypt hash of 6-digit PIN, base64
      pin_salt             TEXT    NOT NULL,  -- 32-byte salt, hex
      last_refresh_at      TEXT    DEFAULT NULL,
      last_refresh_status  TEXT    DEFAULT NULL,
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_blueprints (
      item_id              INTEGER PRIMARY KEY,  -- ESI unique item_id for this blueprint instance
      corp_id              INTEGER NOT NULL,
      type_id              INTEGER NOT NULL,
      quantity             INTEGER DEFAULT 0,    -- -1 = singleton
      runs                 INTEGER DEFAULT -1,   -- -1 = BPO (infinite), ≥ 0 = BPC
      material_efficiency  INTEGER DEFAULT 0,
      time_efficiency      INTEGER DEFAULT 0,
      location_id          INTEGER,
      location_flag        TEXT,
      fetched_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_bp_corp   ON corp_blueprints (corp_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_bp_type   ON corp_blueprints (type_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_assets (
      item_id       INTEGER PRIMARY KEY,  -- ESI unique item_id
      corp_id       INTEGER NOT NULL,
      type_id       INTEGER NOT NULL,
      quantity      INTEGER DEFAULT 1,
      location_id   INTEGER,
      location_flag TEXT,
      is_singleton  INTEGER DEFAULT 0,
      fetched_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_assets_corp ON corp_assets (corp_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_assets_type ON corp_assets (type_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_jobs (
      job_id              INTEGER PRIMARY KEY,  -- ESI job_id
      corp_id             INTEGER NOT NULL,
      installer_id        INTEGER,
      installer_name      TEXT,                 -- resolved via ESI /universe/names/ at refresh time
      blueprint_id        INTEGER,
      blueprint_type_id   INTEGER,
      product_type_id     INTEGER,
      activity_id         INTEGER,
      runs                INTEGER,
      status              TEXT,
      start_date          TEXT,
      end_date            TEXT,
      duration            INTEGER,
      output_location_id  INTEGER,
      fetched_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // v1.4.0 patch: add installer_name if table already existed without it (idempotent)
  try { await dbRun(`ALTER TABLE corp_jobs ADD COLUMN installer_name TEXT`); } catch (_) {}

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_jobs_corp ON corp_jobs (corp_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_pin_sessions (
      character_id INTEGER PRIMARY KEY,  -- character who verified the PIN
      corp_id      INTEGER NOT NULL,
      verified_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT    NOT NULL       -- 24hr from verified_at
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_admin_access (
      character_id INTEGER PRIMARY KEY,  -- character bypasses PIN check entirely
      corp_id      INTEGER,              -- NULL = access all corps
      note         TEXT,                 -- admin note (e.g. "developer testing")
      added_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // v1.5.0 migration: 30-day average price table (historical price fallback)
  // Populated by volume enrichment; used when live order book has no sell/buy orders.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS item_history_prices (
      type_id      INTEGER PRIMARY KEY,
      avg_30d_price  REAL    DEFAULT 0,   -- mean of ESI daily 'average' over last 30 days
      avg_30d_volume REAL    DEFAULT 0,   -- mean daily volume
      sample_days    INTEGER DEFAULT 0,   -- how many days used in calculation
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_hist_prices_type ON item_history_prices (type_id)`);

  // v1.5.0: store avg_30d_price on precomputed_profits rows (for transparency/display)
  try { await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN avg_30d_price REAL DEFAULT NULL`); } catch (_) {}

  console.log('✓ Database migrations complete');
}

// ── Error sanitisation ────────────────────────────────────────────────────────
// Strips filesystem paths from error messages before sending to clients.
// SQLite errors include the full DB path (e.g. /home/gumpy54/forge-db/forge.db)
// which reveals server internals. Internal logging keeps the full message.
function clientErrMsg(err) {
  return (err.message || 'Internal server error')
    .replace(/\/[^\s"']+\.(db|js|json|sqlite)/gi, '[file]')
    .replace(/\/home\/[^\s"']+/gi, '[path]');
}

// ── Cache TTL ─────────────────────────────────────────────────────────────────
// Defined once so every expiry calculation stays in sync.
const CACHE_TTL_MS     = 60 * 60 * 1000;      // 1 hour
const CACHE_TTL_ADJ_MS = 6 * CACHE_TTL_MS;    // 6 hours — for ESI adjusted prices

// Simple cache with periodic sweep to prevent unbounded growth
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) { if (v.expiry < now) cache.delete(k); }
}, 15 * 60 * 1000).unref(); // .unref() so the timer doesn't prevent clean process exit

const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCached = (key, data, ttl = CACHE_TTL_MS) => {
  cache.set(key, { data, expiry: Date.now() + ttl });
};

// ── CORP CRYPTO HELPERS (v1.4.0) ────────────────────────────────────────────
//
// Token encryption: AES-256-GCM with a 32-byte key derived from FORGE_CORP_KEY
// (which must be at least 32 hex chars / 16 bytes raw; padded/hashed here).
// The 32-byte key is derived once at startup and reused — never sent over the wire.
//
// PIN hashing: crypto.scrypt — memory-hard, no extra npm packages needed.
//   N=16384, r=8, p=1, keylen=32 — appropriate for a 6-digit PIN with server-side
//   rate limiting as the primary anti-brute-force defence.

const CORP_ENCRYPTION_KEY = (() => {
  // Derive a fixed 32-byte key from FORGE_CORP_KEY (env var) via SHA-256.
  // If the env var is not set, the server still boots but corp setup will fail
  // loudly — this is intentional (don't silently use a predictable key).
  const raw = process.env.FORGE_CORP_KEY || '';
  if (!raw) {
    console.warn('⚠ FORGE_CORP_KEY not set — corp token encryption disabled. Set this env var before using corp features.');
    return null;
  }
  return crypto.createHash('sha256').update(raw).digest(); // 32-byte Buffer
})();

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns { ciphertext (base64), iv (hex), tag (hex) }.
 */
function encryptToken(plaintext) {
  if (!CORP_ENCRYPTION_KEY) throw new Error('FORGE_CORP_KEY not configured');
  const iv = crypto.randomBytes(12);   // 96-bit IV — recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', CORP_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv:         iv.toString('hex'),
    tag:        cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt a ciphertext string encrypted by encryptToken().
 * Throws if the auth tag doesn't match (tampered/corrupted data).
 */
function decryptToken(ciphertext, ivHex, tagHex) {
  if (!CORP_ENCRYPTION_KEY) throw new Error('FORGE_CORP_KEY not configured');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    CORP_ENCRYPTION_KEY,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ── CORP ESI HELPERS (v1.4.0) ────────────────────────────────────────────────

/**
 * Refresh the director's EVE access token using the stored encrypted refresh token.
 * Returns the new short-lived access_token string.
 * Updates corp_config with the new refresh token if one is issued (token rotation).
 */
async function refreshCorpAccessToken(corpId) {
  const config = await dbGet('SELECT * FROM corp_config WHERE corp_id = ?', [corpId]);
  if (!config) throw new Error(`No corp config for corp_id ${corpId}`);

  const refreshToken = decryptToken(
    config.enc_refresh_token,
    config.token_iv,
    config.token_tag
  );

  const clientId     = process.env.EVE_CLIENT_ID;
  const clientSecret = process.env.EVE_CLIENT_SECRET;
  const authHeader   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await esiFetch('https://login.eveonline.com/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authHeader}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Host':          'login.eveonline.com',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error || res.status}`);
  }

  // If EVE issues a new refresh token (token rotation), encrypt and store it
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    const enc = encryptToken(data.refresh_token);
    await dbRun(
      `UPDATE corp_config
         SET enc_refresh_token = ?, token_iv = ?, token_tag = ?, updated_at = datetime('now')
       WHERE corp_id = ?`,
      [enc.ciphertext, enc.iv, enc.tag, corpId]
    );
    console.log(`✓ Corp ${corpId}: refresh token rotated and re-encrypted`);
  }

  return data.access_token;
}

/**
 * Fetch all pages of a paginated ESI endpoint using the director's access token.
 * Returns a flat array of all results.
 */
async function esiCorpFetchAll(path, accessToken) {
  const results = [];
  for (let page = 1; page <= 200; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await esiFetch(`https://esi.evetech.net${path}${sep}datasource=tranquility&page=${page}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      if (res.status === 404 && page === 1) return []; // empty corp data
      throw new Error(`ESI ${path} page ${page} returned ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.length === 0) break;
    results.push(...data);
    const xPages = res.headers.get('x-pages');
    if (!xPages || page >= parseInt(xPages)) break;
    // Brief delay to respect ESI rate limits
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

/**
 * Refresh all cached corp data (blueprints, assets, jobs) from ESI.
 * Uses the stored director refresh token.  Called on demand and on a schedule.
 * Updates corp_config.last_refresh_* columns on completion.
 */
async function refreshCorpData(corpId) {
  console.log(`⟳ Corp ${corpId}: refreshing ESI data...`);
  try {
    const accessToken = await refreshCorpAccessToken(corpId);

    // ── Blueprints ───────────────────────────────────────────────────────────
    const bps = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/blueprints/`,
      accessToken
    );
    // Atomically replace with new data
    await dbRun('DELETE FROM corp_blueprints WHERE corp_id = ?', [corpId]);
    for (const bp of bps) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_blueprints
           (item_id, corp_id, type_id, quantity, runs,
            material_efficiency, time_efficiency, location_id, location_flag, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          bp.item_id, corpId, bp.type_id,
          bp.quantity   ?? 0,
          bp.runs       ?? -1,
          bp.material_efficiency ?? 0,
          bp.time_efficiency     ?? 0,
          bp.location_id   ?? null,
          bp.location_flag ?? null,
        ]
      );
    }
    console.log(`  ✓ Corp ${corpId}: ${bps.length} blueprints cached`);

    // ── Assets ───────────────────────────────────────────────────────────────
    const assets = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/assets/`,
      accessToken
    );
    await dbRun('DELETE FROM corp_assets WHERE corp_id = ?', [corpId]);
    for (const asset of assets) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_assets
           (item_id, corp_id, type_id, quantity, location_id, location_flag, is_singleton, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          asset.item_id, corpId, asset.type_id,
          asset.quantity     ?? 1,
          asset.location_id  ?? null,
          asset.location_flag ?? null,
          asset.is_singleton  ? 1 : 0,
        ]
      );
    }
    console.log(`  ✓ Corp ${corpId}: ${assets.length} assets cached`);

    // ── Industry Jobs ────────────────────────────────────────────────────────
    const jobs = await esiCorpFetchAll(
      `/latest/corporations/${corpId}/industry/jobs/?include_completed=false`,
      accessToken
    );

    // Resolve installer character names via ESI /universe/names/ (bulk POST, max 1000 IDs).
    // installer_id is a CHARACTER ID — it cannot be resolved from the items table.
    // ESI returns [{ id, name, category }]; we only keep category === 'character'.
    const installerIds = [...new Set(
      jobs.map(j => j.installer_id).filter(Boolean)
    )];
    const installerNames = {};  // { characterId: name }

    if (installerIds.length) {
      // ESI /universe/names/ accepts up to 1000 IDs per request
      const BATCH = 1000;
      for (let i = 0; i < installerIds.length; i += BATCH) {
        const batch = installerIds.slice(i, i + BATCH);
        try {
          const r = await esiFetch('https://esi.evetech.net/latest/universe/names/?datasource=tranquility', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(batch),
          });
          if (r.ok) {
            const names = await r.json();
            for (const entry of names) {
              if (entry.category === 'character') {
                installerNames[entry.id] = entry.name;
              }
            }
          } else {
            console.warn(`  ⚠ Corp ${corpId}: /universe/names/ returned ${r.status} for installer IDs`);
          }
        } catch (nameErr) {
          // Non-fatal — jobs still get stored, installer_name will be null
          console.warn(`  ⚠ Corp ${corpId}: installer name lookup failed — ${nameErr.message}`);
        }
      }
      console.log(`  ✓ Corp ${corpId}: resolved ${Object.keys(installerNames).length}/${installerIds.length} installer names`);
    }

    await dbRun('DELETE FROM corp_jobs WHERE corp_id = ?', [corpId]);
    for (const job of jobs) {
      await dbRun(
        `INSERT OR REPLACE INTO corp_jobs
           (job_id, corp_id, installer_id, installer_name,
            blueprint_id, blueprint_type_id, product_type_id,
            activity_id, runs, status, start_date, end_date, duration,
            output_location_id, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        [
          job.job_id,              corpId,
          job.installer_id        ?? null,
          job.installer_id ? (installerNames[job.installer_id] ?? null) : null,
          job.blueprint_id        ?? null,
          job.blueprint_type_id   ?? null,
          job.product_type_id     ?? null,
          job.activity_id         ?? null,
          job.runs                ?? null,
          job.status              ?? null,
          job.start_date          ?? null,
          job.end_date            ?? null,
          job.duration            ?? null,
          job.output_location_id  ?? null,
        ]
      );
    }
    console.log(`  ✓ Corp ${corpId}: ${jobs.length} active jobs cached`);

    // Update last_refresh timestamp
    await dbRun(
      `UPDATE corp_config
         SET last_refresh_at = datetime('now'), last_refresh_status = 'ok', updated_at = datetime('now')
       WHERE corp_id = ?`,
      [corpId]
    );
    console.log(`✓ Corp ${corpId}: ESI data refresh complete`);
    return { ok: true, blueprints: bps.length, assets: assets.length, jobs: jobs.length };

  } catch (err) {
    console.error(`❌ Corp ${corpId}: ESI refresh failed — ${err.message}`);
    await dbRun(
      `UPDATE corp_config
         SET last_refresh_status = ?, updated_at = datetime('now')
       WHERE corp_id = ?`,
      [`error: ${err.message.slice(0, 200)}`, corpId]
    ).catch(() => {});
    throw err;
  }
}

/**
 * Middleware: verify that the authed character has corp data access.
 * Access model (v1.5.2 — PIN removed):
 *   1. corp_admin_access entry (admin/dev whitelist) → immediate access
 *   2. Character has Director role in ESI for the configured corp → access
 *   3. Else → 403 NOT_DIRECTOR
 *
 * The ESI check calls /characters/{id}/roles/ with the character's own Bearer
 * token. Results are cached 5 minutes per character to avoid hammering ESI.
 * Falls back to director_char_id match when esi-characters.read_roles.v1 scope
 * has not yet been granted (users who haven't re-authed since the scope was added).
 *
 * Must be used AFTER security.verifyEveToken (which sets req.characterId).
 */

// Director role TTLs — stored in the general `cache` under "director:<characterId>"
const DIRECTOR_CACHE_TTL_MS      = 5 * 60 * 1000; // normal: 5 min
const DIRECTOR_CACHE_TTL_SHORT   = 60 * 1000;      // fallback/error: 1 min (re-check sooner)

/**
 * Resolve whether a character is a Director in the configured corp.
 * Results are stored in the general cache (key: "director:<characterId>") so no
 * separate Map or sweep timer is needed.
 */
async function checkIsDirector(characterId, bearerToken, configCorpId, directorCharId) {
  const cacheKey = `director:${characterId}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached.isDirector && cached.corpId === configCorpId;

  const headers = { Authorization: `Bearer ${bearerToken}` };
  let isDirector = false;
  let charCorpId = null;
  let cacheTtl   = DIRECTOR_CACHE_TTL_MS;

  try {
    const [rolesRes, charRes] = await Promise.all([
      esiFetch(
        `https://esi.evetech.net/latest/characters/${characterId}/roles/?datasource=tranquility`,
        { headers }
      ),
      esiFetch(
        `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
        { headers }
      ),
    ]);

    if (rolesRes.ok) {
      const rolesData = await rolesRes.json();
      isDirector = Array.isArray(rolesData.roles) && rolesData.roles.includes('Director');
    } else if (rolesRes.status === 403) {
      // esi-characters.read_corporation_roles.v1 not yet granted — fall back to setup director
      isDirector = characterId === directorCharId;
      cacheTtl   = DIRECTOR_CACHE_TTL_SHORT; // re-check sooner after re-auth
    }

    if (charRes.ok) {
      const charData = await charRes.json();
      charCorpId = charData.corporation_id;
    }
  } catch (esiErr) {
    console.warn(`ESI director check failed for ${characterId}:`, esiErr.message);
    // On connectivity error: allow only the setup director (fail safe)
    isDirector = characterId === directorCharId;
    charCorpId = configCorpId;
    cacheTtl   = DIRECTOR_CACHE_TTL_SHORT;
  }

  setCached(cacheKey, { isDirector, corpId: charCorpId }, cacheTtl);
  return isDirector && (charCorpId === null || charCorpId === configCorpId);
}

async function requireDirectorRole(req, res, next) {
  const characterId = req.characterId;
  if (!characterId) return res.status(401).json({ error: 'Not authenticated' });

  try {
    // 1. Admin/dev whitelist
    const adminRow = await dbGet(
      'SELECT 1 FROM corp_admin_access WHERE character_id = ?',
      [characterId]
    );
    if (adminRow) return next();

    // 2. Corp must be configured
    const config = await dbGet(
      'SELECT corp_id, director_char_id FROM corp_config LIMIT 1'
    );
    if (!config) {
      return res.status(404).json({ error: 'Corp not configured' });
    }

    // 3. Verify Director role via ESI
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Authorization required' });

    const allowed = await checkIsDirector(
      characterId, token, config.corp_id, config.director_char_id
    );
    if (allowed) return next();

    return res.status(403).json({
      error: 'Corp data access requires the Director role in the configured corporation.',
      code:  'NOT_DIRECTOR',
    });
  } catch (err) {
    console.error('requireDirectorRole error:', err.message);
    return res.status(500).json({ error: 'Access check failed' });
  }
}

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
      const res = await esiFetch(
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
      const res = await esiFetch(
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
      console.error("EVE OAuth error:", tokenData.error, tokenData.error_description);
      return res.status(400).json({ error: tokenData.error_description || "Token exchange failed" });
    }

    console.log("✓ EVE OAuth successful");
    // Return ONLY the access token — never send refresh_token to the client
    res.json({ access_token: tokenData.access_token });

  } catch (err) {
    console.error("OAuth error:", err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// JITA PRICES (Buy/Sell/Median) - Hourly Cache
// Per-region price cache (Map: regionId -> { prices, expiry })
// v0.9.4: Only Jita (10000002) is populated. v1.1 will populate multiple regions.
const regionPriceCache = new Map();

/** Write region prices to the cache with the standard 1-hour TTL. Single write point. */
function setRegionPriceCache(regionId, prices) {
  regionPriceCache.set(regionId, { prices, expiry: Date.now() + CACHE_TTL_MS });
}

// Tracks which regions have a background price-warm in flight (avoid duplicate fetches)
const regionWarmingSet = new Set();

// 30-day average prices from ESI market history.
// Used as tertiary fallback when live order book has no sell AND no buy orders.
// Populated at startup (from DB) and refreshed after every volume enrichment run.
// Key: typeId (integer), Value: avg 30-day trade price (ISK)
let historyPriceMap = new Map();

async function loadHistoryPriceMap() {
  try {
    const rows = await dbAll('SELECT type_id, avg_30d_price FROM item_history_prices WHERE avg_30d_price > 0');
    historyPriceMap = new Map(rows.map(r => [r.type_id, r.avg_30d_price]));
    console.log(`✓ History price map loaded — ${historyPriceMap.size} items`);
  } catch (err) {
    console.error('⚠ Failed to load history price map:', err.message);
  }
}

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
      setRegionPriceCache(10000002, value);
      jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
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
  // Inner try isolates a missing blueprint_skills table (returns true = allow through).
  // Outer try catches unexpected DB errors (returns false = exclude conservatively).
  try {
    let requirements = [];
    try {
      requirements = await dbAll(
        'SELECT skill_id, skill_level FROM blueprint_skills WHERE blueprint_id = ?',
        [blueprintId]
      );
    } catch (_skillErr) {
      // blueprint_skills table missing — no requirements known, allow all through
      return true;
    }

    if (!requirements.length) return true;

    // Build a skill_id → trained_level map for O(1) lookup
    const skillMap = {};
    for (const s of characterSkills) {
      skillMap[s.skill_id] = s.active_skill_level || 0;
    }

    for (const req of requirements) {
      if ((skillMap[req.skill_id] || 0) < req.skill_level) return false;
    }

    return true;
  } catch (err) {
    console.error('Skill check error:', err.message);
    return false; // conservative: exclude on unexpected error
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
    jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
    res.json({ prices });

  } catch (err) {
    console.error('Jita prices error:', err.message);
    if (jitaPricesCache) {
      return res.json({ prices: jitaPricesCache, stale: true });
    }
    res.status(500).json({ error: clientErrMsg(err), prices: {} });
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

// Hub region → main station solar system ID (for jump-count API and auto-zero haul legs)
const HUB_SYSTEM_IDS = {
  10000002: 30000142, // Jita IV – Moon 4 – Caldari Navy Assembly Plant
  10000043: 30002187, // Amarr VIII (Oris) – Emperor Family Academy
  10000032: 30002659, // Dodixie IX – Moon 20 – Federation Navy Assembly Plant
  10000042: 30002053, // Hek VIII – Moon 12 – Boundless Creation Factory
  10000030: 30002510, // Rens VI – Moon 8 – Brutor Tribe Treasury
  10000041: 30045331, // Syndicate – Poitot
};

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

async function getJumpCount(originId, destId) {
  if (!originId || !destId || originId === destId) return 0;
  const key = `${originId}:${destId}`;
  if (jumpCountCache.has(key)) return jumpCountCache.get(key);
  try {
    const url = `https://esi.evetech.net/latest/route/${originId}/${destId}/?datasource=tranquility`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'FORGE Manufacturing Intelligence/1.5' } });
    if (!resp.ok) { console.warn(`Jump count API ${resp.status} for ${originId}→${destId}`); return 0; }
    const route = await resp.json();
    const jumps = Array.isArray(route) ? Math.max(0, route.length - 1) : 0;
    jumpCountCache.set(key, jumps);
    return jumps;
  } catch (err) {
    console.warn(`Jump count fetch failed ${originId}→${destId}:`, err.message);
    return 0;
  }
}

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
      setRegionPriceCache(regionId, prices);
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
    setRegionPriceCache(regionId, prices);
    res.json({ regionId, prices });

  } catch (err) {
    console.error(`Region ${req.params.regionId} prices error:`, err.message);
    res.status(500).json({ error: clientErrMsg(err) });
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
    res.status(500).json({ error: clientErrMsg(err), items: {} });
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
    res.status(500).json({ error: clientErrMsg(err), blueprints: {} });
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
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Helper: Calculate material cost (checks if it can be manufactured)
// depth guard prevents infinite recursion on circular blueprint data
async function calculateMaterialCost(materialId, quantity, prices, depth = 0) {
  if (depth > 10) return (prices[materialId]?.buy || 0) * quantity;
  const bp = await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [materialId]);

  if (bp) {
    const subMats = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [bp.blueprint_id]
    );

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
    const safeItemName = itemName.slice(0, 100).replace(/[%_\\]/g, '\\$&');

    console.log(`⟳ Building production chain for: ${safeItemName}`);

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

    console.log(`✓ Production chain built for ${item.name}`);
    res.json({ chain });

  } catch (err) {
    console.error('Production chain error:', err.message);
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
    res.json({ error: clientErrMsg(err), blueprint: null });
  }
});

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

    // Get market history from ESI (not cached per-item to save memory)
    const JITA_REGION = 10000002;
    const historyRes = await esiFetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${typeId}`
    );

    let avg30dFromHistory = 0;
    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (Array.isArray(historyData) && historyData.length > 0) {
        // Calculate 30-day average BEFORE sorting — ESI returns history oldest-first,
        // so slice(-30) on the raw array gives the 30 most recent trading days.
        // IMPORTANT: must happen before .sort() which mutates the array in-place,
        // changing the order and making slice(-30) return the oldest days instead.
        const recent30 = historyData.slice(-30);
        if (recent30.length > 0) {
          avg30dFromHistory = recent30.reduce((sum, d) => sum + (d.average || 0), 0) / recent30.length;
        }

        // Sort descending then reverse for chronological chart display (last 90 days)
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

    // Sell-hub prices — used for the "Current Market" price display and profit calculation
    const sellPrices = regionPriceCache.get(regionId)?.prices || jitaPricesCache || {};
    // avg30d: prefer freshly-fetched history, fall back to cached map value
    const avg30d = avg30dFromHistory || historyPriceMap.get(typeId) || 0;
    if (sellPrices[typeId]) {
      itemDetails.currentPrice = {
        sell:   sellPrices[typeId].sell,
        buy:    sellPrices[typeId].buy,
        median: sellPrices[typeId].median,
        avg30d,
      };
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

    // Source-hub prices — used for material unit costs in the build analysis.
    // Falls back to sell prices when source == sell (or source cache is cold).
    const matPrices = (materialRegionId !== regionId)
      ? (regionPriceCache.get(materialRegionId)?.prices || sellPrices)
      : sellPrices;

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

          // Unit cost uses the source-hub SELL price (lowest ask) — the price a
          // manufacturer actually pays to buy materials immediately from the market.
          // Using .buy (highest bid) would understate costs; consistent with /api/true-cost.
          // Fallback chain: sell → buy → 30d avg → 0
          const matPrice = matPrices[mat.material_id];
          const matAvg30d = matPrice?.avg30d || historyPriceMap.get(mat.material_id) || 0;
          const unitCost = matPrice ? (matPrice.sell || matPrice.buy || matAvg30d || 0) : matAvg30d;
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

        // Calculate potential profit — sell price from sell hub, material cost from source hub.
        // Use 30d avg as fallback when no live sell orders exist (avoids showing zero revenue).
        const liveSellForBuild = itemDetails.currentPrice?.sell || 0;
        const avg30dForBuild   = itemDetails.currentPrice?.avg30d || 0;
        const sellPrice = liveSellForBuild || avg30dForBuild || 0;
        // Flag whether the profit was estimated from historical data (no live orders)
        const sellPriceSource = liveSellForBuild > 0 ? 'live' : (avg30dForBuild > 0 ? 'history_30d' : 'no_data');
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
          sellPriceSource,
          profit: profit,
          profitMargin: profitMargin
        };
      }
    }

    console.log(`✓ Item details fetched — ${itemDetails.name || typeId}${itemDetails.buildInfo ? ' (with build analysis)' : ''}`);
    res.json(itemDetails);

  } catch (err) {
    console.error("Item details error:", err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ANALYZE BLUEPRINTS - Calculate profitability/buildability for all user BPs
// Used by AI to get top profitable/buildable items
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
    if (!jitaPricesCache || Date.now() >= jitaPricesCacheExpiry) {
      console.log('⟳ Loading Jita prices for analysis...');
      try {
        const prices = await fetchRegionPrices(10000002); // The Forge (Jita)
        jitaPricesCache = prices;
        jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
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
app.get('/api/diagnose-t2/:characterId', security.apiLimiter, security.verifyEveToken, async (req, res) => {
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
    res.status(500).json({ error: clientErrMsg(err) });
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
    res.status(500).json({ error: clientErrMsg(err) });
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
                const diagRes = await fetch(`http://localhost:${PORT}/api/diagnose-t2/${characterId}`, {
                  headers: { Authorization: req.headers.authorization || '' },
                });
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
      content: [{ type: "text", text: `[System Error: ${clientErrMsg(err)}]` }],
      error: clientErrMsg(err)
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
  jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;

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
        setRegionPriceCache(regionId, prices);
        if (regionId === 10000002) {
          jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS; // keep compat accessor in sync
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

        // Sell price fallback: live sell → 30d avg → 0
        // Using avg30d when no live sell orders exist gives a realistic revenue estimate
        // rather than treating the item as worthless. The price_source column records
        // which fallback was used so the UI can flag it if needed.
        const liveSell   = prices[bp.product_id]?.sell || 0;
        const hist30d    = prices[bp.product_id]?.avg30d || 0;
        const sellPrice  = liveSell || hist30d || 0;
        const priceSource = liveSell > 0
          ? (regionId === 10000002 ? 'jita' : `region_${regionId}`)
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
             material_count, computed_at, price_source, activity_id, avg_30d_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          bp.blueprint_id, regionId, bp.product_id, bp.product_name || null,
          totalMatCost, sellPrice, buyPrice, profit, profitMargin,
          iskPerHour, bp.build_time || 0, materials.length, computedAt,
          priceSource, bp.activity_id || 1, hist30d || null
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
      console.log(`⟳ Fetching history for ${zeroSellItems.length} zero-sell-price items...`);
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
          console.error(`  ✗ Zero-sell history fetch failed for ${item.product_name}:`, err.message);
        }
      }
      console.log('✓ Zero-sell-price history pass complete');
    }

    // Reload the in-memory map so the next precompute run benefits immediately
    await loadHistoryPriceMap();

    // Copy volume/market data from Jita rows to all other region rows.
    // avg_daily_volume and market_group_id are item properties, not region-specific.
    if (enriched > 0) {
      console.log('⟳ Copying volume data from Jita to other regions...');
      // UPDATE ... FROM syntax (SQLite ≥3.33): computes Jita values once as a
      // derived table, then does a single-pass join — O(n) instead of the old
      // correlated-subquery approach which was O(n²) and held the write lock for
      // many seconds, freezing the site during precompute.
      await dbRun(`
        UPDATE precomputed_profits
        SET avg_daily_volume = jita.avg_daily_volume,
            market_group_id  = jita.market_group_id,
            liquidity_risk   = jita.liquidity_risk
        FROM (
          SELECT product_id, avg_daily_volume, market_group_id, liquidity_risk
          FROM   precomputed_profits
          WHERE  region_id = 10000002
            AND  avg_daily_volume IS NOT NULL
        ) AS jita
        WHERE precomputed_profits.product_id = jita.product_id
          AND precomputed_profits.region_id  != 10000002
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

    // Shared liquidity-risk filter (low_volume is a WARNING, not excluded)
    const riskFilter = `(
      liquidity_risk IS NULL
      OR liquidity_risk = ""
      OR liquidity_risk = "low_volume"
    )`;

    let results;

    if (!isCrossHub) {
      // ── Same-hub path (unchanged behaviour) ──────────────────────────────
      let whereConditions = ['region_id = ?', 'profit > ?', 'sell_price > 0'];
      const params = [regionId, minProfit];

      if (minVolume > 0) {
        whereConditions.push('(avg_daily_volume >= ? OR avg_daily_volume IS NULL)');
        params.push(minVolume);
      }
      if (!includeRisky) whereConditions.push(riskFilter);

      results = await dbAll(`
        SELECT blueprint_id, product_id, product_name, material_cost,
               sell_price, buy_price, profit, profit_margin, isk_per_hour,
               build_time, material_count, computed_at,
               avg_daily_volume, market_group_id, liquidity_risk
        FROM precomputed_profits
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY ${orderClause}
        LIMIT ?
      `, [...params, limit]);

    } else {
      // ── Cross-hub path: materials from sourceRegionId, sell in regionId ──
      // Self-join precomputed_profits: sell-hub row for revenue/metadata,
      // source-hub row for material cost.  Profit is recalculated in SQL so
      // filtering and sorting are always on the true cross-hub figure.
      let joinConditions = [
        `sell.region_id = ?`,
        `(sell.sell_price - src.material_cost) > ?`,
        `sell.sell_price > 0`,
      ];
      const params = [regionId, minProfit];

      if (minVolume > 0) {
        joinConditions.push('(sell.avg_daily_volume >= ? OR sell.avg_daily_volume IS NULL)');
        params.push(minVolume);
      }
      if (!includeRisky) {
        joinConditions.push(riskFilter.replace(/liquidity_risk/g, 'sell.liquidity_risk'));
      }

      results = await dbAll(`
        SELECT
          sell.blueprint_id,
          sell.product_id,
          sell.product_name,
          src.material_cost,
          sell.sell_price,
          sell.buy_price,
          (sell.sell_price - src.material_cost)                              AS profit,
          CASE WHEN sell.sell_price > 0
            THEN (sell.sell_price - src.material_cost) / sell.sell_price * 100
            ELSE 0 END                                                        AS profit_margin,
          CASE WHEN sell.build_time > 0
            THEN (sell.sell_price - src.material_cost) / (sell.build_time / 3600.0)
            ELSE 0 END                                                        AS isk_per_hour,
          sell.build_time,
          sell.material_count,
          sell.computed_at,
          sell.avg_daily_volume,
          sell.market_group_id,
          sell.liquidity_risk,
          COALESCE(sell.activity_id, 1) AS activity_id
        FROM precomputed_profits sell
        JOIN precomputed_profits src
          ON  src.blueprint_id = sell.blueprint_id
          AND src.region_id    = ?
        WHERE ${joinConditions.join(' AND ')}
        ORDER BY profit DESC
        LIMIT ?
      `,
      // sourceRegionId FIRST — binds JOIN's src.region_id = ? which precedes WHERE in SQL text
      [sourceRegionId, ...params, limit]);
    }

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
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// TOP PROFITABLE by Skills — filters top 50 by user's trained skills
// For Market Opportunities tab — shows only blueprints user can build
app.get('/api/top-profitable-by-skills', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId  = req.characterId;
    const sort         = req.query.sort || 'profit';
    const limit        = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset       = Math.max(parseInt(req.query.offset) || 0, 0);
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

    // Shared liquidity-risk filter (low_volume is a WARNING, not excluded)
    const riskFilter = `(
      liquidity_risk IS NULL
      OR liquidity_risk = ""
      OR liquidity_risk = "low_volume"
    )`;

    // Get user's skills from session cache
    const sessionKey  = `session:${characterId}`;
    const sessionData = getCached(sessionKey);

    if (!sessionData || !sessionData.skills || sessionData.skills.length === 0) {
      console.warn(`⚠ Skills not in session for character ${characterId} — returning unfiltered top-profitable`);

      // Fall back to the same cross-hub aware logic but without skill filtering
      const fbWhere  = isCrossHub
        ? [`sell.region_id = ?`, `(sell.sell_price - src.material_cost) > ?`, `sell.sell_price > 0`,
           `(sell.liquidity_risk IS NULL OR sell.liquidity_risk = "" OR sell.liquidity_risk = "low_volume")`]
        : [`region_id = ?`, `profit > ?`, `sell_price > 0`,
           `(liquidity_risk IS NULL OR liquidity_risk = "" OR liquidity_risk = "low_volume")`];

      const fbParams = [regionId, minProfit];

      const fbResults = await dbAll(
        isCrossHub
          ? `SELECT sell.blueprint_id, sell.product_id, sell.product_name,
                    src.material_cost, sell.sell_price, sell.buy_price,
                    (sell.sell_price - src.material_cost) AS profit,
                    CASE WHEN sell.sell_price > 0
                      THEN (sell.sell_price - src.material_cost) / sell.sell_price * 100
                      ELSE 0 END AS profit_margin,
                    CASE WHEN sell.build_time > 0
                      THEN (sell.sell_price - src.material_cost) / (sell.build_time / 3600.0)
                      ELSE 0 END AS isk_per_hour,
                    sell.build_time, sell.material_count, sell.computed_at,
                    sell.avg_daily_volume, sell.liquidity_risk, COALESCE(sell.activity_id,1) AS activity_id
             FROM precomputed_profits sell
             JOIN precomputed_profits src ON src.blueprint_id = sell.blueprint_id AND src.region_id = ?
             WHERE ${fbWhere.join(' AND ')}
             ORDER BY profit DESC LIMIT ?`
          : `SELECT blueprint_id, product_id, product_name, material_cost, sell_price, buy_price,
                    profit, profit_margin, isk_per_hour, build_time, material_count, computed_at,
                    avg_daily_volume, liquidity_risk, COALESCE(activity_id,1) AS activity_id
             FROM precomputed_profits
             WHERE ${fbWhere.join(' AND ')}
             ORDER BY profit DESC LIMIT ?`,
        // sourceRegionId must be FIRST — it binds the JOIN's src.region_id = ?
        // which appears before the WHERE clause in the SQL text.
        isCrossHub ? [sourceRegionId, ...fbParams, limit] : [...fbParams, limit]
      );

      const fbLastRun = await dbGet(`SELECT completed_at FROM precompute_runs ORDER BY id DESC LIMIT 1`);
      return res.json({
        results: fbResults,
        meta: { count: fbResults.length, sort, filter: 'unfiltered_skills_unavailable',
                lastComputed: fbLastRun?.completed_at || null,
                sourceRegionId, sellRegionId: regionId },
      });
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

    // Build candidate query — fetches 3× the needed count to survive skill filtering
    let candidates;

    if (!isCrossHub) {
      // ── Same-hub path (unchanged behaviour) ────────────────────────────
      let whereConditions = ['region_id = ?', 'profit > ?', 'sell_price > 0'];
      const params = [regionId, minProfit];

      if (minVolume > 0) {
        whereConditions.push('(avg_daily_volume >= ? OR avg_daily_volume IS NULL)');
        params.push(minVolume);
      }
      if (!includeRisky) whereConditions.push(riskFilter);

      candidates = await dbAll(`
        SELECT blueprint_id, product_id, product_name, material_cost,
               sell_price, buy_price, profit, profit_margin, isk_per_hour,
               build_time, material_count, computed_at,
               avg_daily_volume, market_group_id, liquidity_risk,
               COALESCE(activity_id, 1) AS activity_id,
               price_source, avg_30d_price
        FROM precomputed_profits
        WHERE ${whereConditions.join(' AND ')}
        ORDER BY ${orderClause}
        LIMIT ?
      `, [...params, (offset + limit) * 3]);

    } else {
      // ── Cross-hub path: materials from sourceRegionId, sell in regionId ─
      let joinConditions = [
        `sell.region_id = ?`,
        `(sell.sell_price - src.material_cost) > ?`,
        `sell.sell_price > 0`,
      ];
      const params = [regionId, minProfit];

      if (minVolume > 0) {
        joinConditions.push('(sell.avg_daily_volume >= ? OR sell.avg_daily_volume IS NULL)');
        params.push(minVolume);
      }
      if (!includeRisky) {
        joinConditions.push(riskFilter.replace(/liquidity_risk/g, 'sell.liquidity_risk'));
      }

      candidates = await dbAll(`
        SELECT
          sell.blueprint_id,
          sell.product_id,
          sell.product_name,
          src.material_cost,
          sell.sell_price,
          sell.buy_price,
          (sell.sell_price - src.material_cost)                              AS profit,
          CASE WHEN sell.sell_price > 0
            THEN (sell.sell_price - src.material_cost) / sell.sell_price * 100
            ELSE 0 END                                                        AS profit_margin,
          CASE WHEN sell.build_time > 0
            THEN (sell.sell_price - src.material_cost) / (sell.build_time / 3600.0)
            ELSE 0 END                                                        AS isk_per_hour,
          sell.build_time,
          sell.material_count,
          sell.computed_at,
          sell.avg_daily_volume,
          sell.market_group_id,
          sell.liquidity_risk,
          COALESCE(sell.activity_id, 1) AS activity_id,
          sell.price_source,
          sell.avg_30d_price
        FROM precomputed_profits sell
        JOIN precomputed_profits src
          ON  src.blueprint_id = sell.blueprint_id
          AND src.region_id    = ?
        WHERE ${joinConditions.join(' AND ')}
        ORDER BY profit DESC
        LIMIT ?
      `,
      // sourceRegionId must be FIRST — it binds the JOIN's src.region_id = ?
      // which appears before the WHERE clause in the SQL text.
      [sourceRegionId, ...params, (offset + limit) * 3]);
    }

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

    // ── Add haul_cost_per_unit to each result (Phase 2) ──────────────────────
    // Uses leg2 method + rate to estimate goods-out haul cost per unit of product.
    // Requires packaged_volume populated by sde-import.js.
    const haulSettings = await dbGet(
      'SELECT haul_enabled, leg2_method, leg2_haul_rate, leg2_isk_per_jump, leg2_flat_total, leg2_self_fuel, leg2_collateral, system_id FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const haulActive = !!(haulSettings?.haul_enabled);

    if (haulActive && results.length > 0) {
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

      for (const item of results) {
        const unitVol = volMap.get(item.product_id) || 0;
        if (unitVol > 0 && leg2Jumps > 0) {
          const r = calcLegHaulCost(leg2Cfg, unitVol, leg2Jumps, leg2Col);
          item.haul_cost_per_unit    = r.cost;
          item.haul_isk_per_m3       = r.effectiveIskPerM3;
          item.haul_volume_m3        = unitVol;
        } else {
          item.haul_cost_per_unit    = 0;
          item.haul_isk_per_m3       = 0;
          item.haul_volume_m3        = unitVol;
        }
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
    console.error('Top profitable by skills error:', err.message);
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
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
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
    console.error('Search profitable error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), results: [] });
  }
});

// Admin: Manually trigger pre-compute
app.post('/api/admin/precompute', security.adminLimiter, async (req, res) => {
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
app.get('/api/admin/precompute-status', security.adminLimiter, async (req, res) => {
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
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Admin: Manually trigger volume enrichment (v0.9.1)
app.post('/api/admin/volume-enrichment', security.adminLimiter, async (req, res) => {
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
app.get('/api/admin/ai-costs', security.adminLimiter, async (req, res) => {
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
    res.status(500).json({ error: clientErrMsg(err) });
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
      system_id:            null,
      system_name:          null,
      structure_type_id:    null,
      rig_ids:              '[]',
      facility_tax:         0,
      material_region_id:   10000002,
      material_region_name: 'Jita',
      haul_enabled:         0,
      // Phase 1 — flat rate fields (kept for backward compat)
      leg1_haul_rate:       0,
      leg2_haul_rate:       0,
      // Phase 2 — method + per-method params
      leg1_method:          'user_defined',
      leg2_method:          'user_defined',
      leg1_collateral:      0,
      leg2_collateral:      0,
      leg1_isk_per_jump:    0,
      leg2_isk_per_jump:    0,
      leg1_flat_total:      0,
      leg2_flat_total:      0,
      leg1_service_label:   null,
      leg2_service_label:   null,
      leg1_self_char_id:    null,
      leg1_self_ship:       null,
      leg1_self_fuel:       0,
      leg2_self_char_id:    null,
      leg2_self_ship:       null,
      leg2_self_fuel:       0,
    });
  } catch (err) {
    console.error('Industry settings GET error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── Sales-fee helpers (shared by /api/character-fee-rates and /api/true-cost) ──────────

/**
 * Extract a character's skill map and standings from the server-side session cache.
 * Returns safe defaults ({} and empty standing maps) when the session is missing.
 *
 * @param {number|string} characterId
 * @returns {{ skillMap: Object, standings: { factions: Object, corps: Object } }}
 */
function getCharacterSession(characterId) {
  const session   = getCached(`session:${characterId}`);
  const skillsArr = session?.skills   || [];
  const standings = session?.standings || { factions: {}, corps: {} };
  const skillMap  = {};
  skillsArr.forEach(s => { skillMap[Number(s.skill_id)] = s.active_skill_level || 0; });
  return { skillMap, standings };
}

/**
 * Calculate EVE broker fee and transaction tax rates for a character at a trade hub.
 *
 * Broker fee:
 *   max(1%, 3% − 0.3%×BrokerRelations − 0.03%×max(0,factionStanding) − 0.02%×max(0,corpStanding))
 * Transaction tax:
 *   max(0%, 7.5% × (1 − 11%×Accounting))
 *
 * @param {Object} skillMap  — { [skill_id]: level } from getCharacterSession
 * @param {Object} standings — { factions: {id: val}, corps: {id: val} }
 * @param {Object|undefined} hub — { faction_id, corp_id } from HUB_STANDINGS
 * @returns {{ brokerFeeRate, transactionTaxRate, brokerRelations, accounting, factionStanding, corpStanding }}
 */
function calcSalesFeeRates(skillMap, standings, hub) {
  const brokerRelations = skillMap[3446]  || 0;  // Broker Relations (skill_id 3446)
  const accounting      = skillMap[16622] || 0;  // Accounting       (skill_id 16622)
  const factionStanding = standings.factions[hub?.faction_id] || 0;
  const corpStanding    = standings.corps[hub?.corp_id]       || 0;

  const brokerFeeRate = Math.max(0.01,
    0.03
    - (0.003  * brokerRelations)
    - (0.0003 * Math.max(0, factionStanding))
    - (0.0002 * Math.max(0, corpStanding))
  );
  const transactionTaxRate = Math.max(0, 0.075 * (1 - 0.11 * accounting));

  return { brokerFeeRate, transactionTaxRate, brokerRelations, accounting, factionStanding, corpStanding };
}

// GET /api/character-fee-rates — return the character's fee rates for the given sell hub.
// Used by the client to recompute Market Opportunities profit/margin/ISK-hr with the same
// formula used by /api/true-cost, so both panels show consistent figures.
//
// Query params:
//   sellRegionId  — region to use for standings-based broker fee (default 10000002 = Jita)
//
// Response:
//   broker_fee_rate        — decimal (e.g. 0.025 for 2.5%)
//   transaction_tax_rate   — decimal (e.g. 0.0375)
//   sci                    — System Cost Index for the character's configured system (0 if unconfigured)
//   scc_rate               — always 0.02 (SCC surcharge, flat)
//   facility_tax           — decimal (e.g. 0.025 for 2.5%)
//   setup_configured       — true if industry system has been set
app.get('/api/character-fee-rates', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId  = req.characterId;
    const sellRegionId = VALID_REGIONS.includes(parseInt(req.query.sellRegionId))
      ? parseInt(req.query.sellRegionId)
      : 10000002;

    // ── Session: skills + standings ────────────────────────────────────────
    const { skillMap, standings } = getCharacterSession(characterId);

    // ── Industry settings (system + facility tax) ──────────────────────────
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const facilityTaxDecimal = (settings?.facility_tax || 0) / 100;
    const targetSystemId     = settings?.system_id || 30000142; // default: Jita IV

    // ── System Cost Index ──────────────────────────────────────────────────
    const costIndices = await fetchCostIndices();
    const sci         = costIndices[targetSystemId] || 0;

    // ── Sales fee rates ────────────────────────────────────────────────────
    const { brokerFeeRate, transactionTaxRate } =
      calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[sellRegionId]);

    res.json({
      broker_fee_rate:      brokerFeeRate,
      transaction_tax_rate: transactionTaxRate,
      sci,
      scc_rate:             0.02,
      facility_tax:         facilityTaxDecimal,
      setup_configured:     !!(settings?.system_id),
    });

  } catch (err) {
    console.error('Character fee rates error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// POST /api/industry-settings — save settings for the authed character.
// Accepts both manufacturing location fields (system, structure, rigs, tax) and
// the material source hub (material_region_id / material_region_name).
// Any subset of fields may be sent; omitted fields are preserved via ON CONFLICT DO UPDATE.
app.post('/api/industry-settings', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const {
      system_id, system_name,
      structure_type_id, rig_ids, facility_tax,
      material_region_id   = 10000002,
      material_region_name = 'Jita',
      haul_enabled         = false,
      // Phase 1 — flat rate (user_defined ISK/m³)
      leg1_haul_rate       = 0,
      leg2_haul_rate       = 0,
      // Phase 2 — method + per-method params
      leg1_method          = 'user_defined',
      leg2_method          = 'user_defined',
      leg1_collateral      = 0,
      leg2_collateral      = 0,
      leg1_isk_per_jump    = 0,
      leg2_isk_per_jump    = 0,
      leg1_flat_total      = 0,
      leg2_flat_total      = 0,
      leg1_service_label   = null,
      leg2_service_label   = null,
      leg1_self_char_id    = null,
      leg1_self_ship       = null,
      leg1_self_fuel       = 0,
      leg2_self_char_id    = null,
      leg2_self_ship       = null,
      leg2_self_fuel       = 0,
    } = req.body;

    // Validate: facility_tax must be 0–100
    const tax = Math.min(100, Math.max(0, parseFloat(facility_tax) || 0));

    // Validate material_region_id against the known hub whitelist
    const validMatRegion = VALID_REGIONS.includes(parseInt(material_region_id))
      ? parseInt(material_region_id)
      : 10000002;

    const VALID_METHODS = ['user_defined', 'red_frog', 'black_frog', 'pushx', 'self_haul'];
    const leg1Rate  = Math.max(0, parseFloat(leg1_haul_rate)    || 0);
    const leg2Rate  = Math.max(0, parseFloat(leg2_haul_rate)    || 0);
    const l1method  = VALID_METHODS.includes(leg1_method) ? leg1_method : 'user_defined';
    const l2method  = VALID_METHODS.includes(leg2_method) ? leg2_method : 'user_defined';

    await dbRun(`
      INSERT INTO character_industry_settings
        (character_id, system_id, system_name, structure_type_id,
         rig_ids, facility_tax, material_region_id, material_region_name,
         haul_enabled, leg1_haul_rate, leg2_haul_rate,
         leg1_method, leg2_method,
         leg1_collateral, leg2_collateral,
         leg1_isk_per_jump, leg2_isk_per_jump,
         leg1_flat_total, leg2_flat_total,
         leg1_service_label, leg2_service_label,
         leg1_self_char_id, leg1_self_ship, leg1_self_fuel,
         leg2_self_char_id, leg2_self_ship, leg2_self_fuel,
         updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        system_id            = excluded.system_id,
        system_name          = excluded.system_name,
        structure_type_id    = excluded.structure_type_id,
        rig_ids              = excluded.rig_ids,
        facility_tax         = excluded.facility_tax,
        material_region_id   = excluded.material_region_id,
        material_region_name = excluded.material_region_name,
        haul_enabled         = excluded.haul_enabled,
        leg1_haul_rate       = excluded.leg1_haul_rate,
        leg2_haul_rate       = excluded.leg2_haul_rate,
        leg1_method          = excluded.leg1_method,
        leg2_method          = excluded.leg2_method,
        leg1_collateral      = excluded.leg1_collateral,
        leg2_collateral      = excluded.leg2_collateral,
        leg1_isk_per_jump    = excluded.leg1_isk_per_jump,
        leg2_isk_per_jump    = excluded.leg2_isk_per_jump,
        leg1_flat_total      = excluded.leg1_flat_total,
        leg2_flat_total      = excluded.leg2_flat_total,
        leg1_service_label   = excluded.leg1_service_label,
        leg2_service_label   = excluded.leg2_service_label,
        leg1_self_char_id    = excluded.leg1_self_char_id,
        leg1_self_ship       = excluded.leg1_self_ship,
        leg1_self_fuel       = excluded.leg1_self_fuel,
        leg2_self_char_id    = excluded.leg2_self_char_id,
        leg2_self_ship       = excluded.leg2_self_ship,
        leg2_self_fuel       = excluded.leg2_self_fuel,
        updated_at           = excluded.updated_at
    `, [
      characterId,
      system_id         || null,
      system_name       || null,
      structure_type_id || null,
      JSON.stringify(Array.isArray(rig_ids) ? rig_ids : []),
      tax,
      validMatRegion,
      material_region_name || REGION_HUB_NAMES[validMatRegion] || 'Jita',
      haul_enabled ? 1 : 0,
      leg1Rate,
      leg2Rate,
      l1method, l2method,
      Math.max(0, parseFloat(leg1_collateral)   || 0),
      Math.max(0, parseFloat(leg2_collateral)   || 0),
      Math.max(0, parseFloat(leg1_isk_per_jump) || 0),
      Math.max(0, parseFloat(leg2_isk_per_jump) || 0),
      Math.max(0, parseFloat(leg1_flat_total)   || 0),
      Math.max(0, parseFloat(leg2_flat_total)   || 0),
      leg1_service_label || null,
      leg2_service_label || null,
      leg1_self_char_id  || null,
      leg1_self_ship     || null,
      Math.max(0, parseFloat(leg1_self_fuel)    || 0),
      leg2_self_char_id  || null,
      leg2_self_ship     || null,
      Math.max(0, parseFloat(leg2_self_fuel)    || 0),
      new Date().toISOString(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('Industry settings POST error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
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
// Body: { product_id, me, te, runs, regionId, materialRegionId }
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
    const {
      product_id,
      me             = 0,
      te             = 0,
      runs           = 1,
      regionId       = 10000002,  // sell hub (backward-compat param name)
      materialRegionId = regionId, // source hub — where materials are purchased
    } = req.body;

    // Validate both hub IDs against the known whitelist
    const sellRegionId = VALID_REGIONS.includes(parseInt(regionId))
      ? parseInt(regionId) : 10000002;
    const matRegionId  = VALID_REGIONS.includes(parseInt(materialRegionId))
      ? parseInt(materialRegionId) : sellRegionId;
    const characterId = req.characterId;

    if (!product_id) return res.status(400).json({ error: 'product_id required' });

    // ── Session: skills + standings ────────────────────────────────────────
    const { skillMap, standings } = getCharacterSession(characterId);

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

    // ── Market prices: source hub for materials, sell hub for revenue ────
    //
    // Source hub  (matRegionId)  — where the player buys raw materials
    // Sell hub    (sellRegionId) — where the finished goods are listed
    //
    // When both caches are warm, prices are exact.
    // When either is cold (e.g. first request after a restart), we fall back
    // to the precomputed DB row for that region (ME-scaled approximation) and
    // kick off a background warm so the next request gets live prices.
    const matEntry  = regionPriceCache.get(matRegionId);
    const sellEntry = regionPriceCache.get(sellRegionId);
    const matWarm   = !!(matEntry  && Date.now() < matEntry.expiry);
    const sellWarm  = !!(sellEntry && Date.now() < sellEntry.expiry);
    const pricesWarm = matWarm && sellWarm; // both must be warm for live flag

    // ── Material cost ─────────────────────────────────────────────────────
    let totalMaterialCost = 0;

    if (matWarm) {
      // Live source-hub prices — exact ME-adjusted quantities
      for (const mat of materials) {
        const matPrice = matEntry.prices[mat.material_id]?.sell || 0;
        const adjQty   = Math.max(1, Math.ceil(mat.quantity * meFactor)) * runs;
        totalMaterialCost += matPrice * adjQty;
      }
    } else {
      // Cold — fall back to precomputed DB value (ME=0, scaled by meFactor)
      const precompMat = await dbGet(
        'SELECT material_cost FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, matRegionId]
      );
      totalMaterialCost = ((precompMat?.material_cost || 0) * meFactor * runs);
      // Trigger background warm for source hub
      if (!regionWarmingSet.has(matRegionId)) {
        regionWarmingSet.add(matRegionId);
        fetchRegionPrices(matRegionId)
          .then(prices => setRegionPriceCache(matRegionId, prices))
          .catch(() => {})
          .finally(() => regionWarmingSet.delete(matRegionId));
      }
    }

    // ── Sell price ────────────────────────────────────────────────────────
    let unitSell = 0;

    if (sellWarm) {
      unitSell = sellEntry.prices[product_id]?.sell || 0;
    } else {
      // Cold — fall back to precomputed sell price for the sell hub
      const precompSell = await dbGet(
        'SELECT sell_price FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, sellRegionId]
      );
      unitSell = precompSell?.sell_price || 0;
      // Trigger background warm for sell hub (if not already warming)
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
    // Standings are looked up by sell hub — that is where the order is placed.
    const {
      brokerFeeRate, transactionTaxRate,
      brokerRelations, accounting, factionStanding, corpStanding,
    } = calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[sellRegionId]);

    const brokerFee      = sellPrice * brokerFeeRate;
    const transactionTax = sellPrice * transactionTaxRate;
    const totalSalesTax  = brokerFee + transactionTax;

    // ── Haulage (Box 5) — Phase 2 ─────────────────────────────────────────
    // Supports user_defined (ISK/m³, ISK/jump, flat), red_frog, black_frog,
    // pushx, and self_haul methods.
    // Requires packaged_volume in items table (populated by sde-import.js).
    // Silently returns 0 when volumes or rates are absent — no breaking change.
    const haulEnabled  = !!(settings?.haul_enabled);

    let leg1VolM3 = 0, leg2VolM3 = 0;
    let leg1Cost  = 0, leg2Cost  = 0;
    let leg1EffM3 = 0, leg2EffM3 = 0;
    let leg1Contracts = 1, leg2Contracts = 1;
    let leg1Jumps = 0, leg2Jumps = 0;

    if (haulEnabled) {
      // Determine system IDs for jump-count lookups
      const sourceHubSysId = HUB_SYSTEM_IDS[matRegionId]  || HUB_SYSTEM_IDS[10000002];
      const sellHubSysId   = HUB_SYSTEM_IDS[sellRegionId] || HUB_SYSTEM_IDS[10000002];
      const mfgSysId       = settings?.system_id || 30000142;

      // Fetch jump counts (cached permanently; only called once per unique pair)
      [leg1Jumps, leg2Jumps] = await Promise.all([
        getJumpCount(sourceHubSysId, mfgSysId),
        getJumpCount(mfgSysId, sellHubSysId),
      ]);

      // Build leg configs from settings
      const leg1Cfg = {
        method:       settings?.leg1_method        || 'user_defined',
        rate:         settings?.leg1_haul_rate      || 0,
        isk_per_jump: settings?.leg1_isk_per_jump   || 0,
        flat_total:   settings?.leg1_flat_total      || 0,
        self_fuel:    settings?.leg1_self_fuel       || 0,
        self_ship:    settings?.leg1_self_ship       || null,
      };
      const leg2Cfg = {
        method:       settings?.leg2_method        || 'user_defined',
        rate:         settings?.leg2_haul_rate      || 0,
        isk_per_jump: settings?.leg2_isk_per_jump   || 0,
        flat_total:   settings?.leg2_flat_total      || 0,
        self_fuel:    settings?.leg2_self_fuel       || 0,
        self_ship:    settings?.leg2_self_ship       || null,
      };
      const leg1Col = settings?.leg1_collateral || 0;
      const leg2Col = settings?.leg2_collateral || 0;

      // Leg 1: material volumes (all materials, ME-adjusted, × runs)
      const isLeg1Active = leg1Cfg.method !== 'user_defined'
        || leg1Cfg.rate > 0 || leg1Cfg.isk_per_jump > 0 || leg1Cfg.flat_total > 0;

      if (isLeg1Active && leg1Jumps > 0 && materials.length > 0) {
        const matIds = materials.map(m => m.material_id);
        const ph = matIds.map(() => '?').join(',');
        const volRows = await dbAll(
          `SELECT type_id, packaged_volume FROM items WHERE type_id IN (${ph})`, matIds
        );
        const volMap = new Map(volRows.map(r => [r.type_id, r.packaged_volume || 0]));
        for (const mat of materials) {
          const adjQty = Math.max(1, Math.ceil(mat.quantity * meFactor)) * runs;
          leg1VolM3 += (volMap.get(mat.material_id) || 0) * adjQty;
        }
        const l1result = calcLegHaulCost(leg1Cfg, leg1VolM3, leg1Jumps, leg1Col);
        leg1Cost = l1result.cost; leg1EffM3 = l1result.effectiveIskPerM3; leg1Contracts = l1result.contracts;
      } else if (isLeg1Active && leg1Jumps === 0 && leg1Cfg.method === 'self_haul') {
        // Self-haul with same-location — fuel cost still applies if entered
        const l1result = calcLegHaulCost(leg1Cfg, 1, 0, leg1Col);
        leg1Cost = l1result.cost;
      }

      // Leg 2: finished product volume × runs
      const isLeg2Active = leg2Cfg.method !== 'user_defined'
        || leg2Cfg.rate > 0 || leg2Cfg.isk_per_jump > 0 || leg2Cfg.flat_total > 0;

      if (isLeg2Active && leg2Jumps > 0) {
        const productVolRow = await dbGet(
          'SELECT packaged_volume FROM items WHERE type_id = ?', [product_id]
        );
        const productQty = (blueprint.product_quantity || 1) * runs;
        leg2VolM3 = (productVolRow?.packaged_volume || 0) * productQty;
        const l2result = calcLegHaulCost(leg2Cfg, leg2VolM3, leg2Jumps, leg2Col);
        leg2Cost = l2result.cost; leg2EffM3 = l2result.effectiveIskPerM3; leg2Contracts = l2result.contracts;
      } else if (isLeg2Active && leg2Jumps === 0 && leg2Cfg.method === 'self_haul') {
        const l2result = calcLegHaulCost(leg2Cfg, 1, 0, leg2Col);
        leg2Cost = l2result.cost;
      }
    }

    const totalHaulCost = leg1Cost + leg2Cost;
    const leg1Method = settings?.leg1_method || 'user_defined';
    const leg2Method = settings?.leg2_method || 'user_defined';

    // ── True profit ────────────────────────────────────────────────────────
    const trueProfit = sellPrice - brokerFee - transactionTax - totalMaterialCost - totalJobCost - totalHaulCost;
    const trueMargin = sellPrice > 0 ? (trueProfit / sellPrice) * 100 : 0;

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
        system_cost_bonuses:  0,
        facility_tax:         facilityTaxCost,
        scc_surcharge:        sccSurcharge,
        alpha_clone_tax:      0,
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

      // Box 5 — haulage (Phase 2)
      haul_cost: {
        total:                     totalHaulCost,
        leg1_cost:                 leg1Cost,
        leg2_cost:                 leg2Cost,
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

      // Box 4 + summary — true profit
      true_profit: trueProfit,
      true_margin: trueMargin,

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
      },
    });

  } catch (err) {
    console.error('True cost error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CORP API ENDPOINTS (v1.5.2 — Director-role access)
//
// Access model: characters with the EVE Director role in the configured corp
// may access all corp data. No PIN required. The requireDirectorRole middleware
// checks ESI /characters/{id}/roles/ and caches results for 5 minutes.
//
// Rate-limiting strategy:
//   - Data reads:   standard apiLimiter
//   - Admin ops:    admin key header replaces rate limit (no EVE token required)
//
// All data endpoints use: security.apiLimiter → security.verifyEveToken → requireDirectorRole
// ════════════════════════════════════════════════════════════════════════════

// ── Admin helper ────────────────────────────────────────────────────────────

/**
 * Validate X-Admin-Key header using a timing-safe comparison.
 * Returns true if the key matches FORGE_ADMIN_KEY.
 */
function isAdminRequest(req) {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  if (!adminKey) return false;
  const provided = req.headers['x-admin-key'] || '';
  if (provided.length !== adminKey.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminKey));
}

// ── GET /api/corp/status ─────────────────────────────────────────────────────
// Public (no EVE token needed) — lets the frontend know whether a corp has been
// set up so it can show the correct UI state.
app.get('/api/corp/status', security.apiLimiter, async (req, res) => {
  try {
    const config = await dbGet(
      'SELECT corp_id, corp_name, director_char_name, last_refresh_at, last_refresh_status FROM corp_config LIMIT 1'
    );
    if (!config) {
      return res.json({ configured: false });
    }
    res.json({
      configured:         true,
      corp_id:            config.corp_id,
      corp_name:          config.corp_name,
      director_char_name: config.director_char_name,
      last_refresh_at:    config.last_refresh_at,
      last_refresh_status: config.last_refresh_status,
    });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── POST /api/corp/setup ─────────────────────────────────────────────────────
// Admin-only (X-Admin-Key required).
// Body: { code, redirect_uri }
//
// Flow:
//  1. Validate admin key + inputs
//  2. Exchange EVE OAuth code for tokens (must have corp scopes)
//  3. Verify JWT to get character_id; look up corp_id from ESI
//  4. Encrypt refresh_token
//  5. Upsert corp_config
//  6. Trigger initial ESI data refresh in background
app.post('/api/corp/setup', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }

  const { code, redirect_uri } = req.body;

  if (!code || !redirect_uri) {
    return res.status(400).json({ error: 'Missing code or redirect_uri' });
  }
  if (!CORP_ENCRYPTION_KEY) {
    return res.status(500).json({ error: 'FORGE_CORP_KEY not configured on server' });
  }

  try {
    // 1. Exchange auth code for EVE tokens
    const clientId     = process.env.EVE_CLIENT_ID;
    const clientSecret = process.env.EVE_CLIENT_SECRET;
    const authHeader   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Host':          'login.eveonline.com',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirect_uri)}`,
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(400).json({ error: tokenData.error_description || 'Token exchange failed' });
    }

    const { access_token, refresh_token } = tokenData;
    if (!refresh_token) {
      return res.status(400).json({ error: 'No refresh token in response — ensure offline_access scope is granted' });
    }

    // 2. Verify token + get character info from EVE SSO
    const verifyRes = await fetch('https://login.eveonline.com/oauth/verify', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    const charInfo = await verifyRes.json();
    const characterId   = charInfo.CharacterID;
    const characterName = charInfo.CharacterName;

    if (!characterId) {
      return res.status(400).json({ error: 'Could not verify character from token' });
    }

    // 3. Confirm corp scopes are present
    const grantedScopes = (charInfo.Scopes || '').split(' ');
    const requiredScopes = [
      'esi-corporations.read_blueprints.v1',
      'esi-assets.read_corporation_assets.v1',
      'esi-industry.read_corporation_jobs.v1',
    ];
    const missingScopes = requiredScopes.filter(s => !grantedScopes.includes(s));
    if (missingScopes.length) {
      return res.status(400).json({
        error: `Missing required corp scopes: ${missingScopes.join(', ')}. ` +
               `Ensure the director authorized all corp scopes.`,
      });
    }

    // 4. Fetch character's corporation from ESI
    const charRes = await esiFetch(
      `https://esi.evetech.net/latest/characters/${characterId}/?datasource=tranquility`,
      { headers: { 'Authorization': `Bearer ${access_token}` } }
    );
    const charData = await charRes.json();
    const corpId   = charData.corporation_id;

    if (!corpId) {
      return res.status(400).json({ error: 'Could not determine corporation from ESI' });
    }

    // 5. Fetch corp name
    const corpRes  = await esiFetch(
      `https://esi.evetech.net/latest/corporations/${corpId}/?datasource=tranquility`
    );
    const corpData = await corpRes.json();
    const corpName = corpData.name || `Corp ${corpId}`;

    // 6. Encrypt refresh token
    const enc = encryptToken(refresh_token);

    // 7. Upsert corp_config (pin_hash/pin_salt kept as empty strings — no longer used)
    await dbRun(
      `INSERT INTO corp_config
         (corp_id, corp_name, director_char_id, director_char_name,
          enc_refresh_token, token_iv, token_tag,
          pin_hash, pin_salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', datetime('now'), datetime('now'))
       ON CONFLICT(corp_id) DO UPDATE SET
         corp_name           = excluded.corp_name,
         director_char_id    = excluded.director_char_id,
         director_char_name  = excluded.director_char_name,
         enc_refresh_token   = excluded.enc_refresh_token,
         token_iv            = excluded.token_iv,
         token_tag           = excluded.token_tag,
         updated_at          = datetime('now')`,
      [
        corpId, corpName, characterId, characterName,
        enc.ciphertext, enc.iv, enc.tag,
      ]
    );

    console.log(`✓ Corp ${corpId} (${corpName}) configured by ${characterName} (${characterId})`);

    // 8. Trigger initial ESI data refresh in background (non-blocking)
    refreshCorpData(corpId).catch(err =>
      console.error(`⚠ Initial corp data refresh failed: ${err.message}`)
    );

    res.json({
      ok:            true,
      corp_id:       corpId,
      corp_name:     corpName,
      director_name: characterName,
      message:       'Corp configured successfully. Initial data refresh started in background.',
    });

  } catch (err) {
    console.error('Corp setup error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── GET /api/corp/access-status ──────────────────────────────────────────────
// Returns whether the current character has Director access to corp data.
// Used by frontend to decide whether to show corp data or the "not a director" message.
app.get('/api/corp/access-status', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;

    // Admin whitelist
    const adminRow = await dbGet(
      'SELECT 1 FROM corp_admin_access WHERE character_id = ?', [characterId]
    );
    if (adminRow) return res.json({ hasAccess: true, method: 'admin' });

    // Corp must be configured
    const config = await dbGet(
      'SELECT corp_id, director_char_id FROM corp_config LIMIT 1'
    );
    if (!config) return res.json({ hasAccess: false });

    // Check Director role via ESI (uses same cache as requireDirectorRole)
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return res.json({ hasAccess: false });

    const isDirector = await checkIsDirector(
      characterId, token, config.corp_id, config.director_char_id
    );
    res.json({ hasAccess: isDirector, method: isDirector ? 'director' : undefined });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── GET /api/corp/blueprints ─────────────────────────────────────────────────
// Returns cached corp blueprints with item names joined.
// Query params: search (name filter), type (BPO|BPC|all), limit, offset
app.get('/api/corp/blueprints',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const config = await dbGet('SELECT corp_id, last_refresh_at FROM corp_config LIMIT 1');
      if (!config) return res.status(404).json({ error: 'Corp not configured' });

      const search = String(req.query.search || '').replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      const type   = req.query.type || 'all';   // BPO | BPC | all
      const limit  = Math.min(200, parseInt(req.query.limit  || '100') || 100);
      const offset = Math.max(0,   parseInt(req.query.offset || '0')   || 0);

      let whereClause = 'WHERE cb.corp_id = ?';
      const params = [config.corp_id];

      if (type === 'BPO') {
        whereClause += ' AND cb.runs = -1';
      } else if (type === 'BPC') {
        whereClause += ' AND cb.runs >= 0';
      }

      if (search) {
        whereClause += ' AND LOWER(COALESCE(i.name, "")) LIKE ?';
        params.push(`%${search.toLowerCase()}%`);
      }

      const blueprints = await dbAll(
        `SELECT
           cb.item_id, cb.type_id, cb.quantity, cb.runs,
           cb.material_efficiency AS me, cb.time_efficiency AS te,
           cb.location_id, cb.location_flag, cb.fetched_at,
           COALESCE(i.name, 'Item #' || cb.type_id) AS name,
           CASE WHEN cb.runs = -1 THEN 'BPO' ELSE 'BPC' END AS bp_type
         FROM corp_blueprints cb
         LEFT JOIN items i ON i.type_id = cb.type_id
         ${whereClause}
         ORDER BY i.name ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const total = await dbGet(
        `SELECT COUNT(*) AS n FROM corp_blueprints cb
         LEFT JOIN items i ON i.type_id = cb.type_id
         ${whereClause}`,
        params
      );

      res.json({
        blueprints,
        meta: {
          total:          total?.n ?? 0,
          limit,
          offset,
          last_refresh_at: config.last_refresh_at,
        },
      });
    } catch (err) {
      console.error('Corp blueprints error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── GET /api/corp/assets ─────────────────────────────────────────────────────
// Returns cached corp assets grouped by type_id (summed quantity).
// Query params: search, limit, offset
app.get('/api/corp/assets',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const config = await dbGet('SELECT corp_id, last_refresh_at FROM corp_config LIMIT 1');
      if (!config) return res.status(404).json({ error: 'Corp not configured' });

      const search = String(req.query.search || '').replace(/[^a-zA-Z0-9 '\-]/g, '').trim();
      const limit  = Math.min(500, parseInt(req.query.limit  || '200') || 200);
      const offset = Math.max(0,   parseInt(req.query.offset || '0')   || 0);

      let whereClause = 'WHERE ca.corp_id = ?';
      const params = [config.corp_id];

      if (search) {
        whereClause += ' AND LOWER(COALESCE(i.name, "")) LIKE ?';
        params.push(`%${search.toLowerCase()}%`);
      }

      // Group by type_id and sum quantities for an aggregated view
      const assets = await dbAll(
        `SELECT
           ca.type_id,
           COALESCE(i.name, 'Item #' || ca.type_id) AS name,
           SUM(ca.quantity) AS total_quantity,
           MIN(ca.fetched_at)  AS fetched_at
         FROM corp_assets ca
         LEFT JOIN items i ON i.type_id = ca.type_id
         ${whereClause}
         GROUP BY ca.type_id
         ORDER BY i.name ASC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      const total = await dbGet(
        `SELECT COUNT(DISTINCT ca.type_id) AS n
         FROM corp_assets ca
         LEFT JOIN items i ON i.type_id = ca.type_id
         ${whereClause}`,
        params
      );

      res.json({
        assets,
        meta: {
          total:          total?.n ?? 0,
          limit,
          offset,
          last_refresh_at: config.last_refresh_at,
        },
      });
    } catch (err) {
      console.error('Corp assets error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── GET /api/corp/jobs ───────────────────────────────────────────────────────
// Returns cached active corp industry jobs.
app.get('/api/corp/jobs',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const config = await dbGet('SELECT corp_id, last_refresh_at FROM corp_config LIMIT 1');
      if (!config) return res.status(404).json({ error: 'Corp not configured' });

      const jobs = await dbAll(
        // installer_id is a CHARACTER ID — cannot be joined against items (which holds type_ids).
        // installer_name is stored directly at refresh time via ESI /universe/names/ lookup.
        // product/blueprint names use items table correctly (type_id → type_id).
        `SELECT
           cj.job_id, cj.installer_id, cj.blueprint_id,
           cj.blueprint_type_id, cj.product_type_id,
           cj.activity_id, cj.runs, cj.status,
           cj.start_date, cj.end_date, cj.duration,
           cj.output_location_id, cj.fetched_at,
           COALESCE(prod.name, 'Item #' || cj.product_type_id)   AS product_name,
           COALESCE(bp.name,   'BP #'   || cj.blueprint_type_id) AS blueprint_name,
           COALESCE(cj.installer_name, 'Char #' || cj.installer_id) AS installer_name
         FROM corp_jobs cj
         LEFT JOIN items prod ON prod.type_id = cj.product_type_id
         LEFT JOIN items bp   ON bp.type_id   = cj.blueprint_type_id
         WHERE cj.corp_id = ?
         ORDER BY cj.end_date ASC`,
        [config.corp_id]
      );

      res.json({
        jobs,
        meta: { count: jobs.length, last_refresh_at: config.last_refresh_at },
      });
    } catch (err) {
      console.error('Corp jobs error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── POST /api/corp/refresh ───────────────────────────────────────────────────
// Manually trigger an ESI data refresh. Admin OR verified corp member can call this.
app.post('/api/corp/refresh',
  security.apiLimiter,
  security.verifyEveToken,
  requireDirectorRole,
  async (req, res) => {
    try {
      const config = await dbGet('SELECT corp_id FROM corp_config LIMIT 1');
      if (!config) return res.status(404).json({ error: 'Corp not configured' });

      // Run in background so the response returns immediately
      refreshCorpData(config.corp_id)
        .then(result => console.log(`✓ Manual corp refresh complete:`, result))
        .catch(err    => console.error(`⚠ Manual corp refresh failed: ${err.message}`));

      res.json({ ok: true, message: 'Corp data refresh started in background' });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// ── Admin: whitelist management ──────────────────────────────────────────────

// GET /api/corp/admin/whitelist — list all whitelisted characters
app.get('/api/corp/admin/whitelist', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });
  try {
    const rows = await dbAll('SELECT * FROM corp_admin_access ORDER BY added_at DESC');
    res.json({ whitelist: rows });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// POST /api/corp/admin/whitelist — add a character to the whitelist
// Body: { character_id, note? }
app.post('/api/corp/admin/whitelist', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });

  const { character_id, note } = req.body;
  if (!character_id || isNaN(parseInt(character_id))) {
    return res.status(400).json({ error: 'character_id must be a numeric EVE character ID' });
  }

  try {
    const config = await dbGet('SELECT corp_id FROM corp_config LIMIT 1');
    await dbRun(
      `INSERT INTO corp_admin_access (character_id, corp_id, note, added_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(character_id) DO UPDATE SET corp_id = excluded.corp_id, note = excluded.note`,
      [parseInt(character_id), config?.corp_id ?? null, note || null]
    );
    console.log(`✓ Corp admin whitelist: added character ${character_id} (${note || 'no note'})`);
    res.json({ ok: true, character_id: parseInt(character_id) });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// DELETE /api/corp/admin/whitelist/:characterId — remove from whitelist
app.delete('/api/corp/admin/whitelist/:characterId', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });

  const characterId = parseInt(req.params.characterId);
  if (isNaN(characterId)) return res.status(400).json({ error: 'Invalid character ID' });

  try {
    await dbRun('DELETE FROM corp_admin_access WHERE character_id = ?', [characterId]);
    console.log(`✓ Corp admin whitelist: removed character ${characterId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// Admin: delete corp config entirely (for reset/re-setup)
app.delete('/api/corp/admin/config', security.adminLimiter, async (req, res) => {
  if (!isAdminRequest(req)) return res.status(403).json({ error: 'Admin key required' });
  try {
    await dbRun('DELETE FROM corp_config');
    await dbRun('DELETE FROM corp_blueprints');
    await dbRun('DELETE FROM corp_assets');
    await dbRun('DELETE FROM corp_jobs');
    await dbRun('DELETE FROM corp_pin_sessions');
    console.log('✓ Corp config and all cached corp data deleted');
    res.json({ ok: true, message: 'Corp config deleted. Re-run corp setup to reconfigure.' });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// ── Scheduled corp data refresh ──────────────────────────────────────────────
// Runs every 4 hours to keep corp data current without hammering ESI.
// Only runs if a corp has been configured.
setInterval(async () => {
  try {
    const config = await dbGet('SELECT corp_id FROM corp_config LIMIT 1');
    if (!config) return; // no corp configured yet — nothing to refresh
    console.log(`⟳ Scheduled corp data refresh for corp ${config.corp_id}...`);
    await refreshCorpData(config.corp_id);
  } catch (err) {
    console.error(`⚠ Scheduled corp refresh failed: ${err.message}`);
  }
}, 4 * 60 * 60 * 1000); // every 4 hours

// START SERVER
initDatabase().then(async () => {
  // Run v0.9.0 migrations
  await runMigrations();

  // Load 30-day history price map from DB (populated by volume enrichment)
  await loadHistoryPriceMap();

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
