'use strict';
// Admin endpoints: precompute triggers, AI cost report, health check.

const logger = require('../lib/logger');
const config = require('../lib/config');
const router = require('express').Router();

module.exports = function adminRoutes({
  security, dbGet, dbAll, clientErrMsg,
  runPreCompute, runVolumeEnrichment, ingestRegionContracts,
  VALID_REGIONS, CONTRACT_INGEST_REGION,
  preComputeRunning, volumeEnrichmentRunning,
  getJitaPricesCache, db,
}) {

  // Admin: Manually trigger pre-compute
  router.post('/api/admin/precompute', security.adminLimiter, async (req, res) => {
    const adminKey    = config.adminKey;
    const providedKey = req.headers['x-admin-key'];
    if (!adminKey || providedKey !== adminKey) return res.status(403).json({ error: 'Unauthorized' });

    const result = runPreCompute();
    if (preComputeRunning()) {
      res.json({ message: 'Pre-compute job started', status: 'running' });
    } else {
      res.json(await result);
    }
  });

  // Admin: Manually trigger contract price ingest (v1.12.0)
  router.post('/api/admin/contract-ingest', security.adminLimiter, async (req, res) => {
    const adminKey = config.adminKey;
    if (!adminKey || req.headers['x-admin-key'] !== adminKey) return res.status(403).json({ error: 'Unauthorized' });
    const raw      = parseInt(req.body?.regionId, 10);
    const regionId = VALID_REGIONS.includes(raw) ? raw : CONTRACT_INGEST_REGION;
    ingestRegionContracts(regionId).then(r => logger.info('Contract ingest result:', r));
    res.json({ status: 'started', region_id: regionId });
  });

  // Admin: View pre-compute run history
  router.get('/api/admin/precompute-status', security.adminLimiter, async (req, res) => {
    const adminKey    = config.adminKey;
    const providedKey = req.headers['x-admin-key'];
    if (!adminKey || providedKey !== adminKey) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const runs            = await dbAll(`SELECT * FROM precompute_runs ORDER BY id DESC LIMIT 10`);
      const totalBlueprints = await dbGet(`SELECT COUNT(*) as count FROM precomputed_profits`);
      const profitable      = await dbGet(`SELECT COUNT(*) as count FROM precomputed_profits WHERE profit > 0`);
      const enriched        = await dbGet(`SELECT COUNT(*) as count FROM precomputed_profits WHERE avg_daily_volume IS NOT NULL`);
      const risky           = await dbGet(`SELECT COUNT(*) as count FROM precomputed_profits WHERE liquidity_risk IS NOT NULL AND liquidity_risk != ''`);
      res.json({
        runs,
        summary: {
          totalPrecomputed: totalBlueprints?.count || 0,
          profitable:       profitable?.count || 0,
          enriched:         enriched?.count || 0,
          risky:            risky?.count || 0,
          isRunning:        preComputeRunning(),
        }
      });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // Admin: Manually trigger volume enrichment (v0.9.1)
  router.post('/api/admin/volume-enrichment', security.adminLimiter, async (req, res) => {
    const adminKey    = config.adminKey;
    const providedKey = req.headers['x-admin-key'];
    if (!adminKey || providedKey !== adminKey) return res.status(403).json({ error: 'Unauthorized' });
    const result = runVolumeEnrichment();
    if (volumeEnrichmentRunning()) {
      res.json({ message: 'Volume enrichment job started', status: 'running' });
    } else {
      res.json(await result);
    }
  });

  // Admin: View AI costs
  router.get('/api/admin/ai-costs', security.adminLimiter, async (req, res) => {
    const adminKey    = config.adminKey;
    const providedKey = req.headers['x-admin-key'];
    if (!adminKey || providedKey !== adminKey) return res.status(403).json({ error: 'Unauthorized' });
    try {
      const today = await dbGet(`
        SELECT COUNT(*) as requests, SUM(input_tokens) as input_tokens,
               SUM(output_tokens) as output_tokens, SUM(estimated_cost) as total_cost
        FROM ai_usage WHERE created_at >= date('now')`);
      const week = await dbGet(`
        SELECT COUNT(*) as requests, SUM(input_tokens) as input_tokens,
               SUM(output_tokens) as output_tokens, SUM(estimated_cost) as total_cost
        FROM ai_usage WHERE created_at >= date('now', '-7 days')`);
      const month = await dbGet(`
        SELECT COUNT(*) as requests, SUM(input_tokens) as input_tokens,
               SUM(output_tokens) as output_tokens, SUM(estimated_cost) as total_cost
        FROM ai_usage WHERE created_at >= date('now', '-30 days')`);
      const daily = await dbAll(`
        SELECT date(created_at) as date, COUNT(*) as requests,
               SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
               SUM(cache_creation_tokens) as cache_write_tokens,
               SUM(cache_read_tokens) as cache_read_tokens, SUM(estimated_cost) as cost
        FROM ai_usage WHERE created_at >= date('now', '-7 days')
        GROUP BY date(created_at) ORDER BY date DESC`);
      const byCharacter = await dbAll(`
        SELECT character_id, COUNT(*) as requests,
               SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
               SUM(cache_creation_tokens) as cache_write_tokens,
               SUM(cache_read_tokens) as cache_read_tokens,
               SUM(estimated_cost) as total_cost, MAX(created_at) as last_seen
        FROM ai_usage GROUP BY character_id ORDER BY total_cost DESC`);
      const toolRows = await dbAll(`SELECT tools_called FROM ai_usage WHERE tools_called IS NOT NULL`);
      const toolCounts = {};
      for (const row of toolRows) {
        try { for (const t of JSON.parse(row.tools_called)) toolCounts[t] = (toolCounts[t] || 0) + 1; }
        catch (_) {}
      }
      const topTools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([tool, count]) => ({ tool, count }));
      const recent = await dbAll(`
        SELECT created_at, character_id, model, input_tokens, output_tokens,
               cache_creation_tokens, cache_read_tokens, estimated_cost, tools_called
        FROM ai_usage ORDER BY id DESC LIMIT 20`);
      res.json({ today, week, month, daily, byCharacter, topTools, recent });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // Health check
  router.get('/health', async (req, res) => {
    let lastPrecompute = null;
    try {
      lastPrecompute = await dbGet(
        `SELECT completed_at, status, blueprints_processed FROM precompute_runs ORDER BY id DESC LIMIT 1`
      );
    } catch (_) {}
    let enrichmentStats = null;
    try {
      enrichmentStats = await dbGet(`
        SELECT COUNT(*) as total,
               COUNT(CASE WHEN avg_daily_volume IS NOT NULL THEN 1 END) as enriched,
               COUNT(CASE WHEN liquidity_risk IS NOT NULL AND liquidity_risk != '' THEN 1 END) as risky
        FROM precomputed_profits WHERE profit > 0`);
    } catch (_) {}
    res.json({
      status: 'ok',
      version: '1.0.0.0',
      uptime: process.uptime(),
      database: db ? 'connected' : 'disconnected',
      precompute: {
        lastRun:             lastPrecompute?.completed_at || null,
        lastStatus:          lastPrecompute?.status || 'never',
        blueprintsProcessed: lastPrecompute?.blueprints_processed || 0,
        isRunning:           preComputeRunning(),
      },
      volumeEnrichment: {
        total:     enrichmentStats?.total    || 0,
        enriched:  enrichmentStats?.enriched || 0,
        risky:     enrichmentStats?.risky    || 0,
        isRunning: volumeEnrichmentRunning(),
      },
      priceCache: {
        loaded: !!getJitaPricesCache(),
        items:  getJitaPricesCache() ? Object.keys(getJitaPricesCache()).length : 0,
      }
    });
  });

  return router;
};
