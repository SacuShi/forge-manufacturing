'use strict';
// Schema creation and additive migrations. Run once at start-up; every statement is idempotent,
// so it is a no-op on a database that is already up to date.

const logger = require('./logger');
const { dbGet, dbRun, addColumn } = require('./db');

async function runMigrations() {
  // Core reference tables. sde-import.js fills them but never creates them, and the server needs them to start, so a
  // fresh install (e.g. a new Docker volume) could not boot. IF NOT EXISTS makes this a no-op on an existing database.
  await dbRun(`CREATE TABLE IF NOT EXISTS items (
    type_id         INTEGER PRIMARY KEY,
    name            TEXT,
    description     TEXT,
    icon_url        TEXT,
    volume          REAL,
    mass            REAL,
    meta_level      INTEGER DEFAULT 0,
    packaged_volume REAL    DEFAULT NULL,
    pi_tier         INTEGER DEFAULT NULL,
    group_id        INTEGER,
    category_name   TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS blueprints (
    blueprint_id     INTEGER PRIMARY KEY,
    product_id       INTEGER,
    product_quantity INTEGER DEFAULT 1,
    build_time       INTEGER,
    activity_id      INTEGER DEFAULT 1,
    research_time    INTEGER DEFAULT NULL
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS blueprint_materials (
    blueprint_id INTEGER,
    material_id  INTEGER,
    quantity     INTEGER,
    PRIMARY KEY (blueprint_id, material_id)
  )`);

  logger.info('⟳ Running database migrations...');

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

  // Advisor chat history (the live database already has this table from an earlier release; this makes a fresh install match)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id    INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT 'default',
      timestamp       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_chat_history_character
    ON chat_history (character_id, timestamp)
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
  await addColumn('items', 'meta_level INTEGER DEFAULT 0');

  // activity_id on blueprints (1=manufacturing, 9=reaction — populated by sde-import.js)
  await addColumn('blueprints', 'activity_id INTEGER DEFAULT 1');

  // research_time on blueprints (base ME-research seconds from SDE — v1.11.0, populated by sde-import.js)
  // NULL until SDE import runs; ME Research ROI ranker degrades to ISK-only when NULL.
  await addColumn('blueprints', 'research_time INTEGER DEFAULT NULL');

  // activity_id on precomputed_profits
  await addColumn('precomputed_profits', 'activity_id INTEGER DEFAULT 1');

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
    logger.info('⟳ v1.1 migration: recreating precomputed_profits with multi-region schema...');
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
    logger.info('✓ precomputed_profits migrated to multi-region schema');
  }

  // v1.2.0 migration: product_id index for fast volume copy
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_precomputed_product ON precomputed_profits (product_id)`);

  // Where a row's daily volume came from: 'hub' (that hub's own trading) or 'jita' (the hub has no
  // volume data of its own, so Jita's is shown and labelled as such). NULL = no volume known.
  await addColumn('precomputed_profits', 'volume_source TEXT DEFAULT NULL');

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

  // "Remember my characters" — per-main preference + encrypted alt refresh tokens.
  // See the long comment above REMEMBER_ENCRYPTION_KEY for the security model.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS character_remember_pref (
      character_id  INTEGER PRIMARY KEY,   -- the main/primary character
      enabled       INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS remembered_characters (
      main_character_id INTEGER NOT NULL,        -- the main this alt is remembered under
      character_id       INTEGER NOT NULL,        -- the alt's own character_id
      character_name     TEXT    NOT NULL DEFAULT '',
      enc_refresh_token   TEXT    NOT NULL,        -- AES-256-GCM ciphertext, base64
      token_iv            TEXT    NOT NULL,
      token_tag           TEXT    NOT NULL,
      owner_hash          TEXT    NOT NULL DEFAULT '', -- JWT 'owner' claim at capture — detects character transfer
      granted_scopes      TEXT    NOT NULL DEFAULT '', -- space-separated 'scp' claim at capture — detects scope drift
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at        TEXT    DEFAULT NULL,
      PRIMARY KEY (main_character_id, character_id)
    )
  `);

  // v1.3.0 migration: material source hub columns (idempotent — ignored if already present)
  await addColumn('character_industry_settings', 'material_region_id INTEGER DEFAULT 10000002');
  await addColumn('character_industry_settings', "material_region_name TEXT DEFAULT 'Jita'");

  // v1.6.0 migration: haulage columns on industry settings + packaged_volume on items
  await addColumn('character_industry_settings', 'haul_enabled INTEGER DEFAULT 0');
  await addColumn('character_industry_settings', 'leg1_haul_rate REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg2_haul_rate REAL DEFAULT 0');
  await addColumn('items', 'packaged_volume REAL DEFAULT NULL');

  // v1.7.2 migration: PI tier on items (P1–P4; populated by sde-import.js tagPiTiers step)
  await addColumn('items', 'pi_tier INTEGER DEFAULT NULL');

  // v1.7.0 migration: haulage Phase 2 — method selectors, collateral, per-jump, flat total, self-haul
  await addColumn('character_industry_settings', "leg1_method TEXT DEFAULT 'user_defined'");
  await addColumn('character_industry_settings', "leg2_method TEXT DEFAULT 'user_defined'");
  await addColumn('character_industry_settings', 'leg1_collateral REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg2_collateral REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg1_isk_per_jump REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg2_isk_per_jump REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg1_flat_total REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg2_flat_total REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg1_service_label TEXT DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg2_service_label TEXT DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg1_self_char_id INTEGER DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg1_self_ship TEXT DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg1_self_fuel REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'leg2_self_char_id INTEGER DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg2_self_ship TEXT DEFAULT NULL');
  await addColumn('character_industry_settings', 'leg2_self_fuel REAL DEFAULT 0');

  // v1.35.0 migration: Inter-hub independent haul config
  await addColumn('character_industry_settings', 'interhub_haul_enabled INTEGER DEFAULT 0');
  await addColumn('character_industry_settings', "interhub_method TEXT DEFAULT 'user_defined'");
  await addColumn('character_industry_settings', 'interhub_haul_rate REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'interhub_isk_per_jump REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'interhub_flat_total REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'interhub_self_fuel REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'interhub_collateral REAL DEFAULT 0');
  await addColumn('character_industry_settings', 'interhub_service_label TEXT DEFAULT NULL');
  await addColumn('character_industry_settings', 'interhub_self_char_id INTEGER DEFAULT NULL');
  await addColumn('character_industry_settings', 'interhub_self_ship TEXT DEFAULT NULL');

  // ── v1.4.0 Corp Feature migrations ─────────────────────────────────────────
  //
  // corp_config       — one row per corporation; stores encrypted director refresh token
  // corp_blueprints   — ESI corp blueprint cache (refreshed via director token)
  // corp_assets       — ESI corp asset cache
  // corp_jobs         — ESI corp industry job cache
  // corp_admin_access — admin-whitelist: characters that bypass ESI role check (dev/testing)
  //
  // Token encryption: AES-256-GCM via Node built-in crypto (no extra dependencies)

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_config (
      corp_id              INTEGER PRIMARY KEY,
      corp_name            TEXT    NOT NULL DEFAULT '',
      director_char_id     INTEGER NOT NULL,
      director_char_name   TEXT    NOT NULL DEFAULT '',
      enc_refresh_token    TEXT    NOT NULL,  -- AES-256-GCM ciphertext, base64
      token_iv             TEXT    NOT NULL,  -- 12-byte IV, hex
      token_tag            TEXT    NOT NULL,  -- 16-byte auth tag, hex
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
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_assets_loc  ON corp_assets (location_id)`);   // the Asset Safety view walks location_id
  // Corp items locked in Asset Safety (CCP: location_id 2004; the wrap is type 60): the wrap, anything flagged
  // AssetSafety, and everything nested inside them. They can't be used for manufacturing, so calculations skip them.
  await dbRun(`DROP VIEW IF EXISTS corp_asset_safety_items`);
  await dbRun(`CREATE VIEW corp_asset_safety_items AS
    WITH RECURSIVE s(corp_id, item_id) AS (
      SELECT corp_id, item_id FROM corp_assets
       WHERE type_id = 60 OR location_id = 2004 OR location_flag = 'AssetSafety'
      UNION
      SELECT a.corp_id, a.item_id FROM corp_assets a JOIN s ON a.location_id = s.item_id AND a.corp_id = s.corp_id
    )
    SELECT corp_id, item_id FROM s`);
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
  await addColumn('corp_jobs', 'installer_name TEXT');

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_corp_jobs_corp ON corp_jobs (corp_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS corp_admin_access (
      character_id INTEGER PRIMARY KEY,  -- character bypasses ESI role check (admin/dev)
      corp_id      INTEGER,              -- NULL = access all corps
      note         TEXT,                 -- admin note (e.g. "developer testing")
      added_at     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Jita book snapshot — single-row JSON blob; loaded at startup so the trading scanner
  // has instant data while the background poll refreshes the book from ESI.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS jita_book_cache (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot   TEXT    NOT NULL,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // v1.25.0: per-hub book snapshots (all hubs except Jita which uses jita_book_cache)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS hub_book_cache (
      hub_id     TEXT PRIMARY KEY,
      snapshot   TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // v1.25.0: per-hub 30-day volume history for ISK/day estimates on non-Jita hubs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS hub_history_prices (
      type_id    INTEGER NOT NULL,
      region_id  INTEGER NOT NULL,
      avg_30d_volume REAL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (type_id, region_id)
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
  await addColumn('precomputed_profits', 'avg_30d_price REAL DEFAULT NULL');

  // run_id: tracks which precompute run inserted each row; stale rows (previous run_id) are
  // deleted at the end of a successful run so users never see permanently-mixed stale/fresh data.
  await addColumn('precomputed_profits', 'run_id INTEGER');

  // Pre-computed cross-hub strategies: Jita-materials vs local-materials per blueprint × sell hub.
  // Populated at the end of each runPreCompute so compare_markets queries need no runtime JOIN.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS precomputed_strategies (
      blueprint_id       INTEGER NOT NULL,
      sell_region_id     INTEGER NOT NULL,
      product_id         INTEGER NOT NULL,
      product_name       TEXT,
      product_qty        INTEGER DEFAULT 1,
      sell_price         REAL    DEFAULT 0,
      buy_price          REAL    DEFAULT 0,
      build_time         INTEGER DEFAULT 0,
      avg_daily_volume   REAL    DEFAULT NULL,
      local_mat_cost     REAL    DEFAULT 0,
      local_profit       REAL    DEFAULT 0,
      local_margin       REAL    DEFAULT 0,
      local_isk_per_hour REAL    DEFAULT 0,
      jita_mat_cost      REAL    DEFAULT 0,
      jita_profit        REAL    DEFAULT 0,
      jita_margin        REAL    DEFAULT 0,
      jita_isk_per_hour  REAL    DEFAULT 0,
      computed_at        TEXT    NOT NULL DEFAULT '',
      run_id             INTEGER,
      PRIMARY KEY (blueprint_id, sell_region_id)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_strat_product_name ON precomputed_strategies (product_name)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_strat_product_id   ON precomputed_strategies (product_id)`);

  // v1.12.0: contract pricing — derived from public single-item exchange contracts.
  // Populated weekly by ingestRegionContracts(). Used as a revenue source for
  // contract-only items (capitals, faction gear) that have no market sell orders.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS contract_prices (
      type_id       INTEGER NOT NULL,
      region_id     INTEGER NOT NULL,
      low           REAL    DEFAULT 0,   -- lowest qualifying single-item unit price
      high          REAL    DEFAULT 0,   -- highest
      median        REAL    DEFAULT 0,   -- median of outlier-filtered samples
      suggested     REAL    DEFAULT 0,   -- recommended sell (median, nudged by spread)
      sample_count  INTEGER DEFAULT 0,   -- number of qualifying contracts
      source        TEXT    DEFAULT 'single',
      computed_at   TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (type_id, region_id)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_contract_prices_type ON contract_prices (type_id)`);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS character_ticker_config (
      character_id  INTEGER PRIMARY KEY,
      config_json   TEXT    NOT NULL DEFAULT '[]',
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // v1.31.0: push notification tables
  await dbRun(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      character_id INTEGER NOT NULL,
      endpoint     TEXT PRIMARY KEY,
      p256dh       TEXT NOT NULL,
      auth         TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS push_job_watch (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id INTEGER NOT NULL,
      job_key      TEXT NOT NULL,
      product_name TEXT NOT NULL,
      end_date     TEXT NOT NULL,
      notified     INTEGER DEFAULT 0,
      UNIQUE(character_id, job_key)
    )
  `);

  // v1.32.0: drop orphaned PIN columns from pre-v1.7 auth system (safe no-op if absent)
  try { await dbRun(`ALTER TABLE corp_config DROP COLUMN pin_hash`); } catch (_) {}
  try { await dbRun(`ALTER TABLE corp_config DROP COLUMN pin_salt`); } catch (_) {}

  // v1.34.0: Keepstar market history — autonomous polling, server-side refresh token
  await dbRun(`
    CREATE TABLE IF NOT EXISTS structure_token (
      structure_id      INTEGER PRIMARY KEY,
      enc_refresh_token TEXT NOT NULL,
      token_iv          TEXT NOT NULL,
      token_tag         TEXT NOT NULL,
      stored_at         TEXT DEFAULT (datetime('now'))
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS structure_market_history (
      structure_id INTEGER NOT NULL,
      type_id      INTEGER NOT NULL,
      date         TEXT    NOT NULL,
      avg_sell     REAL,
      min_sell     REAL,
      max_sell     REAL,
      order_count  INTEGER,
      PRIMARY KEY (structure_id, type_id, date)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_smh_lookup ON structure_market_history (structure_id, type_id, date)`);
  await addColumn('structure_market_history', 'total_sell_qty INTEGER DEFAULT NULL');

  // v1.36.0: LP store tables + item category (populated by sde-import.js)
  await addColumn('items', 'category_name TEXT');
  await addColumn('items', 'group_id INTEGER');
  await dbRun(`CREATE TABLE IF NOT EXISTS npc_corporations (
    corp_id      INTEGER PRIMARY KEY,
    corp_name    TEXT,
    faction_id   INTEGER,
    faction_name TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS lp_offers (
    corp_id   INTEGER NOT NULL,
    offer_id  INTEGER NOT NULL,
    type_id   INTEGER NOT NULL,
    quantity  INTEGER NOT NULL DEFAULT 1,
    lp_cost   INTEGER NOT NULL DEFAULT 0,
    isk_cost  REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (corp_id, offer_id)
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_lp_offers_type ON lp_offers (type_id)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_lp_offers_corp ON lp_offers (corp_id)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS lp_offer_required_items (
    offer_id    INTEGER NOT NULL,
    corp_id     INTEGER NOT NULL,
    req_type_id INTEGER NOT NULL,
    quantity    INTEGER NOT NULL,
    PRIMARY KEY (offer_id, corp_id, req_type_id)
  )`);

  // v1.35.0: T1→T2 invention relationship tables (populated by sde-import.js)
  await dbRun(`CREATE TABLE IF NOT EXISTS blueprint_invention (
    t1_blueprint_id  INTEGER NOT NULL,
    t2_blueprint_id  INTEGER NOT NULL,
    probability      REAL    DEFAULT 0.4,
    output_runs      INTEGER DEFAULT 1,
    PRIMARY KEY (t1_blueprint_id, t2_blueprint_id)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS invention_materials (
    t1_blueprint_id  INTEGER NOT NULL,
    material_id      INTEGER NOT NULL,
    quantity         INTEGER NOT NULL,
    PRIMARY KEY (t1_blueprint_id, material_id)
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_bi_t2 ON blueprint_invention (t2_blueprint_id)`);
  // v1.35.0: invention settings columns
  await addColumn('character_industry_settings', "invention_rig_ids TEXT DEFAULT '[]'");
  await addColumn('character_industry_settings', 'invention_system_id INTEGER DEFAULT NULL');
  await addColumn('character_industry_settings', 'invention_system_name TEXT DEFAULT NULL');

  // PI Planner: system/planet/region geography + PI schematic recipes (populated by sde-import.js)
  await dbRun(`CREATE TABLE IF NOT EXISTS sde_regions (
    region_id INTEGER PRIMARY KEY,
    name      TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS sde_systems (
    system_id         INTEGER PRIMARY KEY,
    name              TEXT,
    region_id         INTEGER,
    constellation_id  INTEGER,
    security_status   REAL
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sde_systems_region ON sde_systems (region_id)`);

  // Skill/standing/implant snapshot per character. The in-memory session expires (2h) and is
  // lost on every restart; without this, a missing session silently priced fees and build time
  // at skill level 0. Refreshed on every /api/session-data post.
  await dbRun(`CREATE TABLE IF NOT EXISTS character_skill_snapshot (
    character_id INTEGER PRIMARY KEY,
    skills       TEXT NOT NULL DEFAULT '[]',
    standings    TEXT NOT NULL DEFAULT '{}',
    implants     TEXT NOT NULL DEFAULT '[]',
    updated_at   TEXT NOT NULL
  )`);

  // Structure-fit registry: what rigs players actually run in the structures they build in.
  // Learned from Mfg Setup saves + the structure behind the character's own industry jobs, so
  // it can eventually pre-fill the setup. structure_id = 0 means "structure not identified".
  await dbRun(`CREATE TABLE IF NOT EXISTS known_structures (
    structure_id    INTEGER PRIMARY KEY,
    name            TEXT,
    solar_system_id INTEGER,
    type_id         INTEGER,
    owner_id        INTEGER,
    first_seen      TEXT,
    last_seen       TEXT
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS structure_fit_reports (
    structure_id      INTEGER NOT NULL DEFAULT 0,
    character_id      INTEGER NOT NULL,
    structure_type_id INTEGER,
    system_id         INTEGER,
    rig_ids           TEXT    NOT NULL DEFAULT '[]',
    facility_tax      REAL    DEFAULT 0,
    reported_at       TEXT    NOT NULL,
    PRIMARY KEY (structure_id, character_id)
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sfr_system ON structure_fit_reports (system_id, structure_type_id)`);
  // Which characters have themselves resolved a structure through ESI with their OWN token. A cached
  // known_structures row is only trusted for a character listed here, so one user can't use the
  // shared cache to learn about a structure they have no access to.
  await dbRun(`CREATE TABLE IF NOT EXISTS structure_access (
    structure_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    verified_at  TEXT    NOT NULL,
    PRIMARY KEY (structure_id, character_id)
  )`);
  await addColumn('character_industry_settings', 'structure_id INTEGER DEFAULT NULL');
  await addColumn('character_industry_settings', 'structure_name TEXT DEFAULT NULL');
  // Seed the registry once from setups users have already saved.
  await dbRun(`INSERT OR IGNORE INTO structure_fit_reports
      (structure_id, character_id, structure_type_id, system_id, rig_ids, facility_tax, reported_at)
    SELECT 0, s.character_id, s.structure_type_id, s.system_id, COALESCE(s.rig_ids, '[]'), COALESCE(s.facility_tax, 0), datetime('now')
      FROM character_industry_settings s
     WHERE s.structure_type_id IS NOT NULL AND s.system_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM structure_fit_reports r WHERE r.character_id = s.character_id)`);

  await dbRun(`CREATE TABLE IF NOT EXISTS sde_planets (
    planet_id        INTEGER PRIMARY KEY,
    system_id        INTEGER,
    planet_index     INTEGER,
    type_id          INTEGER,
    planet_type_name TEXT
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sde_planets_system ON sde_planets (system_id)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS pi_planet_resources (
    planet_type_name TEXT NOT NULL,
    resource_type_id INTEGER NOT NULL,
    PRIMARY KEY (planet_type_name, resource_type_id)
  )`);
  await dbRun(`CREATE TABLE IF NOT EXISTS pi_schematics (
    schematic_id      INTEGER PRIMARY KEY,
    product_type_id   INTEGER,
    product_quantity  INTEGER,
    cycle_time        INTEGER
  )`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_pi_schematics_product ON pi_schematics (product_type_id)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS pi_schematic_materials (
    schematic_id     INTEGER NOT NULL,
    material_type_id INTEGER NOT NULL,
    quantity         INTEGER NOT NULL,
    PRIMARY KEY (schematic_id, material_type_id)
  )`);

  // Migrate token captured by test flow (one-time, no-op if already done or test skipped)
  try {
    const testTok = await dbGet(`SELECT * FROM test_structure_token WHERE structure_id = ?`, [1049588174021]);
    if (testTok) {
      await dbRun(
        `INSERT OR IGNORE INTO structure_token (structure_id, enc_refresh_token, token_iv, token_tag, stored_at)
         VALUES (?, ?, ?, ?, ?)`,
        [testTok.structure_id, testTok.enc_refresh_token, testTok.token_iv, testTok.token_tag, testTok.stored_at]
      );
      // Migrate test history rows too
      await dbRun(`
        INSERT OR IGNORE INTO structure_market_history (structure_id, type_id, date, avg_sell, min_sell, max_sell, order_count)
        SELECT structure_id, type_id, date, avg_sell, min_sell, max_sell, order_count
          FROM structure_market_history_test
      `);
    }
  } catch (_) { /* test tables may not exist on a fresh install */ }

  logger.info('✓ Database migrations complete');
}

module.exports = { runMigrations };
