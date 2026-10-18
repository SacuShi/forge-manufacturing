'use strict';
// Background schedules that start with the server: scheduled corp refresh, the pre-compute -> volume-enrichment chain
// (at start-up and every 6 hours), weekly contract-price ingest and the push-notification job check.

const logger = require('./logger');
const { dbAll, dbGet } = require('./db');
const { refreshCorpData } = require('./corp');
const { runPreCompute } = require('./precompute');
const { runVolumeEnrichment } = require('./volume-enrichment');
const { CONTRACT_INGEST_REGION, ingestRegionContracts } = require('./contracts');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

// ── Scheduled corp data refresh ──────────────────────────────────────────────
// Runs every 4 hours to keep corp data current without hammering ESI.
// Staggered 500ms apart per corp to avoid simultaneous ESI bursts.
function startCorpRefreshSchedule() {
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
}

/** Pre-compute, then (5 seconds after it completes) volume enrichment. `label` is 'Initial' or 'Scheduled'. */
function runPreComputeThenEnrichment(label) {
  return runPreCompute().then(result => {
    logger.info(`✓ ${label} pre-compute:`, result.status);

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
    logger.error(`⚠ ${label} pre-compute failed:`, err.message);
  });
}

/**
 * Starts the schedules that run once the server is listening.
 * @param {{ webpush: object|null, checkPushJobs: () => Promise<void> }} deps
 */
function startScheduledJobs({ webpush, checkPushJobs }) {
  // Run pre-compute on startup (delayed 10s to let ESI warm up)
  setTimeout(() => {
    logger.info('⟳ Running initial pre-compute...');
    runPreComputeThenEnrichment('Initial');
  }, 10000);

  // Schedule pre-compute every 6 hours
  // (Daily would be fine, but 6-hourly keeps prices fresher without ESI abuse)
  setInterval(() => {
    logger.info('⟳ Scheduled pre-compute starting...');
    runPreComputeThenEnrichment('Scheduled');
  }, SIX_HOURS);

  // ── Contract price ingest — weekly (contract-only stock is slow-moving) ──
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
      checkPushJobs()
        .catch(err => logger.error('⚠ Push job check failed:', err.message));
    }, 5 * 60 * 1000).unref();
    logger.info('✓ Push notification job checker: running every 5 minutes');
  }
}

module.exports = { startCorpRefreshSchedule, startScheduledJobs };
