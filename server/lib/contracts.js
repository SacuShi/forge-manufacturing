'use strict';
// Public item-exchange contracts as a price signal: downloads a region's contracts from ESI and stores the per-item
// prices (so items with no market orders can still be priced), plus the small statistics helpers it uses.

const logger = require('./logger');
const jobState = require('./job-state');
const { dbRun, dbTxMutex } = require('./db');
const { esiFetch } = require('./esi');

// ── CONTRACT PRICE INGEST (v1.12.0) ──────────────────────────────────────────
// Builds a per-region price index from public single-item exchange contracts, so
// True Profit / the sidebar can price contract-only items (capitals, faction gear)
// that have no market sell orders. Runs weekly — contract-only stock is slow-moving.
//
// v1 scope: The Forge only (where ~all capital/BPC contracts live); single-item,
// non-BPC sell contracts only (BPC value depends on runs/ME, so it's excluded to
// avoid misleading flat medians — residual/bundle pricing is a future enhancement).

const CONTRACT_INGEST_REGION = 10000002; // The Forge (Jita)

function medianAsc(a) {
  const n = a.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function percentileAsc(a, p) {
  const n = a.length;
  if (!n) return 0;
  return a[Math.min(n - 1, Math.max(0, Math.round((n - 1) * p)))];
}

// Run async `fn` over `items` with bounded concurrency (keeps ESI load polite).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await fn(items[idx]); } catch (_) { /* tolerate per-item failure */ }
    }
  });
  await Promise.all(workers);
}

// Human, truthful rationale derived from the sample — no fabricated game events.
function contractRationale(row) {
  const { low, high, sample_count: n } = row;
  const spread = low > 0 ? (high - low) / low : 0;
  if (n <= 2) return `Only ${n} contract${n === 1 ? '' : 's'} listed in-region — thin market, treat this as indicative.`;
  if (spread > 1.5) return `${n} contracts with a wide spread — suggested near the low-median to actually move it.`;
  if (spread < 0.25) return `Tight cluster of ${n} contracts — confident price.`;
  return `${n} contracts listed — suggested near the median for a sale within roughly a week.`;
}

async function ingestRegionContracts(regionId = CONTRACT_INGEST_REGION) {
  if (jobState.contractIngestRunning) return { status: 'skipped', reason: 'already_running' };
  jobState.contractIngestRunning = true;
  const start = Date.now();
  try {
    // 1. Page all public contracts; keep item_exchange sells (price > 0).
    const contracts = [];
    let page = 1, pages = 1;
    do {
      const res = await esiFetch(
        `https://esi.evetech.net/latest/contracts/public/${regionId}/?datasource=tranquility&page=${page}`
      );
      if (!res.ok) break;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) break;
      for (const c of data) {
        if (c.type === 'item_exchange' && c.price > 0) contracts.push(c);
      }
      pages = parseInt(res.headers.get('x-pages') || '1', 10);
      page++;
      await new Promise(r => setTimeout(r, 60));
    } while (page <= pages);

    logger.info(`⟳ Contract ingest ${regionId}: ${contracts.length} item_exchange sells across ${pages} pages`);

    // 2. Fetch items per contract (bounded concurrency). Keep single-item, non-BPC,
    //    no-swap sells; record unit price = contract price / quantity.
    const samples = new Map(); // type_id → [unitPrice, …]
    let processed = 0, singles = 0;
    await mapLimit(contracts, 20, async (c) => {
      processed++;
      const res = await esiFetch(
        `https://esi.evetech.net/latest/contracts/public/items/${c.contract_id}/?datasource=tranquility`
      );
      if (!res.ok) return; // 404 = contract expired between calls
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) return;
      if (items.some(it => !it.is_included)) return; // a swap (wants items back) — skip
      const incl = items.filter(it => it.is_included);
      if (incl.length !== 1) return;                 // bundle — skip in v1
      const it = incl[0];
      if (it.is_blueprint_copy) return;              // BPC value depends on runs/ME — skip
      const qty = it.quantity > 0 ? it.quantity : 1;
      const unit = c.price / qty;
      if (!isFinite(unit) || unit <= 0) return;
      if (!samples.has(it.type_id)) samples.set(it.type_id, []);
      samples.get(it.type_id).push(unit);
      singles++;
    });

    // 3. Aggregate (outlier-filtered) and upsert — clean slate for the region.
    await dbRun('DELETE FROM contract_prices WHERE region_id = ?', [regionId]);
    const now = new Date().toISOString();
    let written = 0;
    await dbTxMutex.lock();
    try {
      await dbRun('BEGIN TRANSACTION');
      for (const [typeId, prices] of samples) {
        const sorted = prices.slice().sort((a, b) => a - b);
        const med0 = medianAsc(sorted);
        // Drop obvious scams / mispriced bundles: keep within [0.3×, 4×] of the median.
        const filtered = sorted.filter(p => p >= med0 * 0.3 && p <= med0 * 4);
        if (filtered.length === 0) continue;
        const low  = filtered[0];
        const high = filtered[filtered.length - 1];
        const med  = medianAsc(filtered);
        const n    = filtered.length;
        const spread = low > 0 ? (high - low) / low : 0;
        // Wide + well-sampled → lean toward the 35th percentile (price to actually sell).
        const suggested = (n >= 5 && spread > 1.0) ? percentileAsc(filtered, 0.35) : med;
        await dbRun(
          `INSERT OR REPLACE INTO contract_prices
             (type_id, region_id, low, high, median, suggested, sample_count, source, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'single', ?)`,
          [typeId, regionId, low, high, med, suggested, n, now]
        );
        written++;
      }
      await dbRun('COMMIT');
    } catch (txErr) {
      await dbRun('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbTxMutex.unlock();
    }

    const secs = ((Date.now() - start) / 1000).toFixed(0);
    logger.info(`✓ Contract ingest ${regionId}: ${written} items priced from ${singles} single-item contracts (${processed} fetched) in ${secs}s`);
    return { status: 'completed', region_id: regionId, items_priced: written, single_contracts: singles, contracts_fetched: processed };
  } catch (err) {
    logger.error('Contract ingest error:', err.message);
    return { status: 'error', error: err.message };
  } finally {
    jobState.contractIngestRunning = false;
  }
}

module.exports = { CONTRACT_INGEST_REGION, contractRationale, ingestRegionContracts };
