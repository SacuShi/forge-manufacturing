'use strict';
// Volume enrichment: fetches trading volume history from ESI for the profitable products, classifies how liquid each
// one is (safe / risky tiers) and writes that back to precomputed_profits.

const logger = require('./logger');
const jobState = require('./job-state');
const market = require('./market-cache'); // live values (historyPriceMap, ...) are read as market.<name>
const { dbAll, dbRun, dbTxMutex } = require('./db');
const { esiFetch } = require('./esi');
const { VALID_REGIONS } = require('./hubs');
const { loadHistoryPriceMap } = market;

// VOLUME ENRICHMENT JOB (v0.9.1)
// Fetches market history + market_group_id for top profitable items
// Runs incrementally to respect ESI rate limits


/**
 * 4-tier liquidity classification for one row, from THAT row's own prices and volume.
 * (Previously computed from the Jita row and copied to every hub, so a hub's label described
 * Jita's spread and Jita's volume.)
 */
function classifyLiquidity({ marketGroupId, sellPrice, materialCost, buyPrice, avgVolume }) {
  // TIER 1: Contract-only items (cannot be sold on market)
  if (marketGroupId === null) return 'contract_only';
  // TIER 2: Margin cap (500% maximum - anything beyond is likely scam/phantom)
  if (materialCost > 0 && (sellPrice / materialCost) > 5.0) return 'extreme_margin';
  // TIER 3: Volume requirements (tiered by price)
  if (sellPrice < 100000000 && avgVolume < 10) return 'low_volume';                              // <100M ISK needs 10+ units/day
  if (sellPrice >= 100000000 && sellPrice < 1000000000 && avgVolume < 5) return 'low_volume';   // 100M-1B ISK needs 5+ units/day
  if (sellPrice >= 1000000000 && avgVolume < 2) return 'low_volume';                            // >1B ISK needs 2+ units/day
  // TIER 4: Spread sanity check
  if (buyPrice === 0 && sellPrice > 10000000) return 'no_buy_orders';                            // >10M ISK with no buy orders = suspicious
  if (materialCost > 0 && ((sellPrice - materialCost) / sellPrice) > 0.9) return 'suspicious_spread';  // >90% spread is unusual
  return null;
}

/**
 * Every non-Jita hub row gets ITS OWN daily volume (hub_history_prices: ESI history for the
 * empire hubs, FORGE's quantity-drop estimate for C-J6MT) and a liquidity label computed from its
 * own prices. Only where the hub has no volume data does Jita's volume appear, tagged
 * volume_source = 'jita' so the UI says so. Rows priced at Jita (the hub lists none) use Jita's
 * volume and Jita's bids, because that is where the sale would happen.
 */
async function applyRegionVolumeAndLiquidity() {
  const jitaRows = await dbAll(
    `SELECT product_id, avg_daily_volume, market_group_id, buy_price
       FROM precomputed_profits WHERE region_id = 10000002`
  );
  const jitaBy = new Map(jitaRows.map(r => [r.product_id, r]));
  let updated = 0;

  for (const regionId of VALID_REGIONS) {
    if (regionId === 10000002) continue;
    const volRows = await dbAll(
      'SELECT type_id, avg_30d_volume FROM hub_history_prices WHERE region_id = ? AND avg_30d_volume > 0', [regionId]
    );
    const hubVol = new Map(volRows.map(r => [r.type_id, r.avg_30d_volume]));
    const rows = await dbAll(
      `SELECT blueprint_id, product_id, sell_price, buy_price, material_cost, price_source
         FROM precomputed_profits WHERE region_id = ?`, [regionId]
    );

    await dbTxMutex.lock();
    try {
      await dbRun('BEGIN TRANSACTION');
      for (const r of rows) {
        const j = jitaBy.get(r.product_id);
        const soldAtJita = r.price_source === 'jita_fallback';
        const hv  = soldAtJita ? null : hubVol.get(r.product_id);
        // Jita not enriched yet for this product: its market group (marketable or not) is unknown, so no
        // liquidity label — but this hub's OWN volume is still worth recording.
        if (!j || j.avg_daily_volume == null) {
          if (hv != null) {
            await dbRun(
              `UPDATE precomputed_profits SET avg_daily_volume = ?, volume_source = 'hub' WHERE blueprint_id = ? AND region_id = ?`,
              [hv, r.blueprint_id, regionId]
            );
            updated++;
          }
          continue;
        }
        const vol = hv != null ? hv : j.avg_daily_volume;
        const src = hv != null ? 'hub' : 'jita';
        const liq = classifyLiquidity({
          marketGroupId: j.market_group_id ?? null,
          sellPrice: r.sell_price, materialCost: r.material_cost,
          buyPrice: soldAtJita ? (j.buy_price || 0) : (r.buy_price || 0),
          avgVolume: vol || 0,
        });
        await dbRun(
          `UPDATE precomputed_profits
              SET avg_daily_volume = ?, market_group_id = ?, liquidity_risk = ?, volume_source = ?
            WHERE blueprint_id = ? AND region_id = ?`,
          [vol, j.market_group_id ?? null, liq, src, r.blueprint_id, regionId]
        );
        updated++;
      }
      await dbRun('COMMIT');
    } catch (err) {
      await dbRun('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      dbTxMutex.unlock();
    }
  }
  return updated;
}

async function runVolumeEnrichment() {
  if (jobState.volumeEnrichmentRunning) {
    logger.info('⚠ Volume enrichment already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  jobState.volumeEnrichmentRunning = true;
  const startTime = Date.now();

  try {
    logger.info('═══════════════════════════════════════════');
    logger.info('⟳ VOLUME ENRICHMENT STARTING');
    logger.info('═══════════════════════════════════════════');

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
      logger.info('✓ No items need enrichment');
      // Prices moved since the last run, so every hub's own volume/liquidity labels are refreshed anyway.
      try { await applyRegionVolumeAndLiquidity(); } catch (e) { logger.error('⚠ Hub volume/liquidity pass failed:', e.message); }
      jobState.volumeEnrichmentRunning = false;
      return { status: 'completed', enriched: 0, message: 'All items already enriched' };
    }

    logger.info(`⟳ Enriching ${itemsToEnrich.length} items...`);

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
        const liquidityRisk = classifyLiquidity({
          marketGroupId, sellPrice: item.sell_price, materialCost: item.material_cost,
          buyPrice: item.buy_price, avgVolume,
        });

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
        logger.error(`  ✗ Error enriching ${item.product_name}:`, err.message);
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
      logger.info(`⟳ Fetching history for ${zeroSellItems.length} zero-sell-price items...`);
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
          logger.error(`  ✗ Zero-sell history fetch failed for ${item.product_name}:`, err.message);
        }
      }
      logger.info('✓ Zero-sell-price history pass complete');
    }

    // Reload the in-memory map so the next precompute run benefits immediately
    await loadHistoryPriceMap();

    // Per-hub volume + liquidity (own data first, Jita's only where a hub has none — tagged).
    try {
      const n = await applyRegionVolumeAndLiquidity();
      logger.info(`✓ Hub volume/liquidity applied to ${n} rows`);
    } catch (e) {
      logger.error('⚠ Hub volume/liquidity pass failed:', e.message);
    }

    const durationSec = (Date.now() - startTime) / 1000;

    logger.info('═══════════════════════════════════════════');
    logger.info(`✓ VOLUME ENRICHMENT COMPLETE`);
    logger.info(`  Enriched: ${enriched} items`);
    logger.info(`  Errors: ${errors}`);
    logger.info(`  Filtered: ${contractOnlyCount + extremeMarginCount + lowVolumeCount + suspiciousSpreadCount + noBuyOrdersCount} total`);
    logger.info(`    - Contract-only: ${contractOnlyCount}`);
    logger.info(`    - Extreme margin (>500%): ${extremeMarginCount}`);
    logger.info(`    - Low volume: ${lowVolumeCount}`);
    logger.info(`    - No buy orders: ${noBuyOrdersCount}`);
    logger.info(`    - Suspicious spread: ${suspiciousSpreadCount}`);
    logger.info(`  Duration: ${durationSec.toFixed(1)}s`);
    logger.info('═══════════════════════════════════════════');

    jobState.volumeEnrichmentRunning = false;
    return { status: 'completed', enriched, errors, durationSec };

  } catch (err) {
    logger.error('❌ Volume enrichment failed:', err.message);
    jobState.volumeEnrichmentRunning = false;
    return { status: 'failed', error: err.message };
  }
}

module.exports = { runVolumeEnrichment, applyRegionVolumeAndLiquidity };
