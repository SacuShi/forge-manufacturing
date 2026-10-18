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
const { initDatabase, dbAll, dbGet, dbRun } = database;
const { runMigrations } = require('./lib/migrations');
const { DECRYPTORS, decryptorTypeIds } = require('./lib/invention');
const { CONTRACT_INGEST_REGION, ingestRegionContracts } = require('./lib/contracts');
const { runPreCompute } = require('./lib/precompute');
const { runVolumeEnrichment } = require('./lib/volume-enrichment');
const market = require('./lib/market-cache'); // live values (historyPriceMap, name maps, jitaPricesCacheExpiry) are read as market.<name>
const { ensureHubPollerRunning, loadHubSnapshots, markTradingActivity } = require('./lib/hub-pollers');
const {
  warmAllRegions, loadHistoryPriceMap, loadGlobalItemNameMap,
  loadBlueprintMaterialsCache, blueprintMaterialsCache,
} = market;
const { refreshCorpData } = require('./lib/corp');
const {
  _ksTkPool, cacheStructureToken, pollKeepstarHistory, KS_POLL_INTERVAL_MS,
} = require('./lib/keepstar-token');
const {
  loadSkillSnapshots, 
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

// ── Profit lists, admin endpoints and the health check ───────────────────────
app.use(require('./routes/profit-lists'));
app.use(require('./routes/admin'));

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
