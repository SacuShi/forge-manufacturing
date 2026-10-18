'use strict';
// The pre-compute job: calculates the profit of every blueprint at every hub and stores it in precomputed_profits, so the
// profit lists are a database read. Runs at start-up, after price refreshes, and on demand from the admin endpoint.

const logger = require('./logger');
const HP = require('./hub-price');
const jobState = require('./job-state');
const market = require('./market-cache'); // live values (historyPriceMap, ...) are read as market.<name>
const { dbAll, dbGet, dbRun, dbTxMutex } = require('./db');
const { CACHE_TTL_MS } = require('./cache');
const { VALID_REGIONS } = require('./hubs');
const { applyRegionVolumeAndLiquidity } = require('./volume-enrichment');
const { setRegionPriceCache, getRawJitaPrices, fetchRegionPrices } = market;

async function runPreCompute() {
  if (jobState.preComputeRunning) {
    logger.info('⚠ Pre-compute already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  jobState.preComputeRunning = true;
  const startTime = Date.now();
  let runId;

  try {
    // Log the run — inside try so a DB failure here resets preComputeRunning via finally
    const run = await dbRun(
      `INSERT INTO precompute_runs (started_at, status) VALUES (datetime('now'), 'running')`
    );
    runId = run.lastID;
    logger.info('═══════════════════════════════════════════');
    logger.info('⟳ PRE-COMPUTE JOB STARTING');
    logger.info('═══════════════════════════════════════════');

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

    logger.info(`⟳ Processing ${allBlueprints.length} blueprints × ${VALID_REGIONS.length} regions...`);

    // Step 2: For each market region, fetch prices and compute profitability
    let totalProcessed = 0;
    const computedAt = new Date().toISOString();

    for (const regionId of VALID_REGIONS) {
      logger.info(`⟳ Region ${regionId}: fetching prices...`);

      let prices;
      try {
        prices = await fetchRegionPrices(regionId);
        setRegionPriceCache(regionId, prices);
        if (regionId === 10000002) {
          market.jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS; // keep compat accessor in sync
        } else {
          // Each hub is priced from its OWN sell orders; for types it has none of, Jita's live
          // lowest sell (tagged sellScope 'jita', stored as price_source 'jita_fallback').
          prices = HP.withJitaFallback(prices, getRawJitaPrices());
        }
      } catch (err) {
        logger.error(`⚠ Region ${regionId}: price fetch failed, skipping — ${err.message}`);
        continue;
      }

      await dbTxMutex.lock();
      let regionProcessed = 0;
      try {
      await dbRun('BEGIN TRANSACTION');

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
          ? (prices[bp.product_id]?.sellScope === 'jita' ? 'jita_fallback'
              : (regionId === 10000002 ? 'jita' : `region_${regionId}`))
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
             material_count, computed_at, price_source, activity_id, avg_30d_price, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(blueprint_id, region_id) DO UPDATE SET
            product_id     = excluded.product_id,
            product_name   = excluded.product_name,
            material_cost  = excluded.material_cost,
            sell_price     = excluded.sell_price,
            buy_price      = excluded.buy_price,
            profit         = excluded.profit,
            profit_margin  = excluded.profit_margin,
            isk_per_hour   = excluded.isk_per_hour,
            build_time     = excluded.build_time,
            material_count = excluded.material_count,
            computed_at    = excluded.computed_at,
            price_source   = excluded.price_source,
            activity_id    = excluded.activity_id,
            avg_30d_price  = excluded.avg_30d_price,
            run_id         = excluded.run_id
        `, [
          bp.blueprint_id, regionId, bp.product_id, bp.product_name || null,
          totalMatCost, sellPrice, buyPrice, profit, profitMargin,
          iskPerHour, bp.build_time || 0, materials.length, computedAt,
          priceSource, bp.activity_id || 1, hist30d || null, runId
        ]);

        regionProcessed++;
      }

      await dbRun('COMMIT');
      } catch (txErr) {
        await dbRun('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        dbTxMutex.unlock();
      }
      totalProcessed += regionProcessed;
      logger.info(`✓ Region ${regionId}: ${regionProcessed} blueprints processed`);
    }

    // Build cross-hub strategy table — but only if Jita data was successfully written.
    // A Jita ESI failure leaves zero rows with region_id=10000002 for this run_id; the
    // INNER JOIN would then produce zero rows and the stale-row DELETE would wipe everything.
    const jitaCount = await dbGet(
      'SELECT COUNT(*) AS cnt FROM precomputed_profits WHERE region_id = 10000002 AND run_id = ?',
      [runId]
    );
    if (!jitaCount || jitaCount.cnt === 0) {
      // No Jita data: clean stale profits (standalone — no strategies write to stay consistent with)
      await dbRun(`DELETE FROM precomputed_profits WHERE run_id IS NULL OR run_id != ?`, [runId]);
      logger.warn('⚠ Skipping strategies build — no Jita data this run (Jita ESI fetch may have failed). Existing strategies preserved.');
    } else {
    // Jita data OK: clean profits + rebuild strategies in one transaction so both tables
    // stay consistent — if the strategies INSERT throws, the profits DELETE rolls back too.
    logger.info('⟳ Building cross-hub strategy table...');
    await dbTxMutex.lock();
    try {
    await dbRun('BEGIN TRANSACTION');
    await dbRun(`DELETE FROM precomputed_profits WHERE run_id IS NULL OR run_id != ?`, [runId]);
    await dbRun(`
      INSERT OR REPLACE INTO precomputed_strategies
        (blueprint_id, sell_region_id, product_id, product_name, product_qty,
         sell_price, buy_price, build_time, avg_daily_volume,
         local_mat_cost, local_profit, local_margin, local_isk_per_hour,
         jita_mat_cost, jita_profit, jita_margin, jita_isk_per_hour,
         computed_at, run_id)
      WITH base AS (
        SELECT
          s.blueprint_id,
          s.region_id                                                          AS sell_region_id,
          s.product_id,
          s.product_name,
          s.sell_price,
          s.buy_price,
          s.build_time,
          s.avg_daily_volume,
          s.material_cost                                                      AS local_mat_cost,
          s.profit                                                             AS local_profit,
          s.profit_margin                                                      AS local_margin,
          s.isk_per_hour                                                       AS local_isk_per_hour,
          j.material_cost                                                      AS jita_mat_cost,
          s.computed_at,
          MAX(1, CAST(ROUND(
            (s.profit + s.material_cost) / NULLIF(s.sell_price, 0)
          ) AS INTEGER))                                                       AS product_qty
        FROM precomputed_profits s
        JOIN precomputed_profits j
          ON  j.blueprint_id = s.blueprint_id
          AND j.region_id    = 10000002
          AND j.run_id       = ?
        WHERE s.run_id = ?
          AND COALESCE(s.price_source, '') != 'jita_fallback'
      )
      SELECT
        blueprint_id,
        sell_region_id,
        product_id,
        product_name,
        product_qty,
        sell_price,
        buy_price,
        build_time,
        avg_daily_volume,
        local_mat_cost,
        local_profit,
        local_margin,
        local_isk_per_hour,
        jita_mat_cost,
        sell_price * product_qty - jita_mat_cost                              AS jita_profit,
        CASE WHEN sell_price * product_qty > 0
          THEN (sell_price * product_qty - jita_mat_cost)
               / (sell_price * product_qty) * 100
          ELSE 0 END                                                           AS jita_margin,
        CASE WHEN build_time > 0
          THEN (sell_price * product_qty - jita_mat_cost) / (build_time / 3600.0)
          ELSE 0 END                                                           AS jita_isk_per_hour,
        computed_at,
        ?                                                                      AS run_id
      FROM base
    `, [runId, runId, runId]);
    await dbRun(`DELETE FROM precomputed_strategies WHERE run_id IS NULL OR run_id != ?`, [runId]);
    await dbRun('COMMIT');
    } catch (txErr) {
      await dbRun('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbTxMutex.unlock();
    }
    logger.info('✓ Cross-hub strategy table built');
    } // end Jita-guard block

    // Volume / liquidity labels follow each row's current price source, so refresh them whenever the rows were rewritten
    // (the scheduled run also chains the Jita volume enrichment afterwards, which does the same).
    try { await applyRegionVolumeAndLiquidity(); }
    catch (e) { logger.error('⚠ Hub volume/liquidity pass failed:', e.message); }

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

    logger.info('═══════════════════════════════════════════');
    logger.info(`✓ PRE-COMPUTE COMPLETE`);
    logger.info(`  Blueprints × Regions: ${totalProcessed}`);
    logger.info(`  Duration: ${durationSec.toFixed(1)}s`);
    logger.info('═══════════════════════════════════════════');

    return { status: 'completed', processed: totalProcessed, durationSec };

  } catch (err) {
    // Rollback on failure
    try { await dbRun('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }

    if (runId) {
      await dbRun(`
        UPDATE precompute_runs
        SET completed_at = datetime('now'),
            status = 'failed',
            error = ?
        WHERE id = ?
      `, [err.message, runId]);
    }

    logger.error('❌ Pre-compute failed:', err.message);
    return { status: 'failed', error: err.message };
  } finally {
    jobState.preComputeRunning = false;
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

module.exports = { runPreCompute };
