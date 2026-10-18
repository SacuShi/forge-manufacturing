'use strict';
// Station trading: the hubs' order books, the margin scanner, and the character's own market orders.

const express = require('express');
const fetch = require('node-fetch');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll } = require('../lib/db');
const { HUB_CONFIG, HUB_IDS, HUB_STANDINGS, HUB_STRUCTURE_FEES } = require('../lib/hubs');
const { getCharacterSession, calcSalesFeeRates } = require('../lib/character-session');
const { hubBooks, hubMetas, hubNameMaps, ensureHubPollerRunning } = require('../lib/hub-pollers');

const router = express.Router();

/** Freshness/status snapshot for a hub. */
function tradingMeta(hubId = 'jita') {
  const cfg  = HUB_CONFIG[hubId] || HUB_CONFIG.jita;
  const meta = hubMetas[hubId]   || hubMetas.jita;
  const now  = Date.now();
  return {
    hub:          hubId,
    station:      cfg.name,
    stationId:    cfg.stationId,
    regionId:     cfg.regionId,
    stationLabel: cfg.label,
    updatedAt:    meta.updatedAt || null,
    ageSec:       meta.updatedAt ? Math.round((now - meta.updatedAt) / 1000) : null,
    expiresInSec: meta.expiresAt ? Math.max(0, Math.round((meta.expiresAt - now) / 1000)) : null,
    types:        meta.types,
    warming:      meta.updatedAt === 0,
    lastError:    meta.lastError,
  };
}

/** Shape one type's book entry for the API. */
function tradingEntry(hubId, typeId) {
  const b = hubBooks[hubId]?.get(typeId);
  if (!b) return { typeId, sell: 0, buy: 0, spread: 0, spreadPct: 0, sellOrders: 0, buyOrders: 0, sellQtyTop: 0, buyQtyTop: 0, found: false };
  return { typeId, ...b, found: true };
}

// ── Trading API ───────────────────────────────────────────────────────────────
router.get('/api/trading/meta', (req, res) => {
  const hubId = HUB_IDS.includes(req.query.hub) ? req.query.hub : 'jita';
  ensureHubPollerRunning(hubId);
  res.json(tradingMeta(hubId));
});

// /api/trading/jita — kept for backward compat (watchlist price lookups); hub param optional
router.get('/api/trading/jita', (req, res) => {
  const hubId = HUB_IDS.includes(req.query.hub) ? req.query.hub : 'jita';
  ensureHubPollerRunning(hubId);
  const raw = String(req.query.types || '').trim();
  if (raw) {
    const ids = raw.split(',')
      .map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && !Number.isNaN(n) && n > 0)
      .slice(0, 200);
    return res.json({ meta: tradingMeta(hubId), results: ids.map(id => tradingEntry(hubId, id)) });
  }
  res.json({ meta: tradingMeta(hubId), count: hubBooks[hubId].size });
});

router.get('/api/trading/jita/:typeId', (req, res) => {
  const hubId  = HUB_IDS.includes(req.query.hub) ? req.query.hub : 'jita';
  const typeId = parseInt(req.params.typeId, 10);
  ensureHubPollerRunning(hubId);
  if (!Number.isInteger(typeId) || typeId <= 0) return res.status(400).json({ error: 'invalid typeId' });
  res.json({ meta: tradingMeta(hubId), ...tradingEntry(hubId, typeId) });
});

// POST /api/trading/scan — multi-hub station-trading opportunity scanner
// Volume strategy:
//   Jita       → item_history_prices (authoritative)
//   Other hubs → hub_history_prices (hub-specific) overlaid on Jita as proxy
//                When hub-specific data isn't ready, Jita volumes serve as a
//                temporary proxy so Vol/day is never completely blank.
//   Keepstar   → no ESI history endpoint; Vol/day intentionally blank.
async function resolveTradingVolumeMap({ hubId, cfg }) {
  const jitaRows = await dbAll(
    'SELECT type_id, avg_30d_volume FROM item_history_prices WHERE avg_30d_volume > 0', []
  );
  const jitaVolMap = new Map(jitaRows.map(r => [r.type_id, r.avg_30d_volume]));

  if (hubId === 'jita') {
    return { volMap: jitaVolMap, hubVolumeEnriched: true };
  }

  if (cfg.isStructure) {
    // Player structure — no ESI market history endpoint. FORGE's autonomous Keepstar
    // polling estimates daily volume via sell-qty-drop tracking stored in hub_history_prices.
    // Use only that data; no Jita proxy (markets are structurally different from empire hubs).
    const hubRows = await dbAll(
      'SELECT type_id, avg_30d_volume FROM hub_history_prices WHERE region_id = ? AND avg_30d_volume > 0',
      [cfg.regionId]
    );
    const volMap = new Map(hubRows.map(r => [r.type_id, r.avg_30d_volume]));
    return { volMap, hubVolumeEnriched: volMap.size > 0 };
  }

  const hubRows = await dbAll(
    'SELECT type_id, avg_30d_volume FROM hub_history_prices WHERE region_id = ? AND avg_30d_volume > 0',
    [cfg.regionId]
  );
  const hubSpecificMap = new Map(hubRows.map(r => [r.type_id, r.avg_30d_volume]));
  const hubVolumeEnriched = hubSpecificMap.size > 100;
  // Merge: start with Jita as baseline proxy, then overwrite with hub-specific values
  // so items that trade here show local volume, others show Jita as an estimate.
  const volMap = new Map([...jitaVolMap, ...hubSpecificMap]);
  return { volMap, hubVolumeEnriched };
}

function scanTradingOpportunities({
  activeBook, nameMap, volMap, brokerFeeRate, transactionTaxRate,
  safeMinMarginPct, capISK, maxSellOrders, minVolume, resultCap,
}) {
  const allMatches = [];

  for (const [typeId, entry] of activeBook) {
    const { sell, buy, sellOrders, buyOrders, sellQtyTop, buyQtyTop } = entry;
    if (!sell || !buy || sell <= buy) continue;
    if (sell > buy * 1000) continue; // floor-price buy order (0.01 ISK placeholder) — no real market
    if (maxSellOrders !== null && sellOrders > maxSellOrders) continue;

    const brokerFeeBuy  = buy  * brokerFeeRate;
    const brokerFeeSell = sell * brokerFeeRate;
    const transTax      = sell * transactionTaxRate;
    const netProfit     = sell - buy - brokerFeeBuy - brokerFeeSell - transTax;
    const netMarginPct  = (netProfit / sell) * 100;

    if (netMarginPct < safeMinMarginPct) continue;
    if (capISK !== null && buy > capISK) continue;

    const avgDailyVol = volMap.get(typeId) ?? 0;
    if (avgDailyVol > 0 && avgDailyVol < minVolume) continue;

    const iskPerDay = netProfit * avgDailyVol * 0.15;
    allMatches.push({
      typeId,
      name: nameMap.get(typeId) ?? `Type #${typeId}`,
      sell, buy, netProfit, netMarginPct,
      brokerFeeBuy, brokerFeeSell, transTax,
      sellOrders, buyOrders, sellQtyTop, buyQtyTop,
      avgDailyVol, sampleDays: 30, iskPerDay,
      sellDepth: [{ price: sell, qty: sellQtyTop }],
      buyDepth:  [{ price: buy,  qty: buyQtyTop  }],
    });
  }

  allMatches.sort((a, b) => {
    if (a.avgDailyVol === 0 && b.avgDailyVol > 0) return 1;
    if (a.avgDailyVol > 0 && b.avgDailyVol === 0) return -1;
    if (a.avgDailyVol > 0) return b.iskPerDay - a.iskPerDay;
    return b.netMarginPct - a.netMarginPct;
  });

  return { results: allMatches.slice(0, resultCap), totalMatched: allMatches.length };
}

router.post('/api/trading/scan', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const {
      hub           = 'jita',
      minMarginPct  = 3,
      minVolume     = 0,
      capital       = null,
      maxSellOrders = null,
    } = req.body;
    // Guard against non-numeric strings (e.g. "abc") that would make all comparisons
    // return false, silently disabling the margin filter and returning the full book.
    const safeMinMarginPct = (isFinite(Number(minMarginPct)) && Number(minMarginPct) >= 0)
      ? Number(minMarginPct) : 3;

    const hubId = HUB_IDS.includes(hub) ? hub : 'jita';
    const cfg   = HUB_CONFIG[hubId];
    ensureHubPollerRunning(hubId);

    const characterId = req.characterId;
    const { skillMap, standings } = getCharacterSession(characterId);
    const sessionCached = Object.keys(skillMap).length > 0;
    // Fees use the selected hub's faction/corp standings (or fixed fee for player structures)
    const { brokerFeeRate, transactionTaxRate } =
      calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[cfg.regionId], HUB_STRUCTURE_FEES[cfg.regionId] ?? null);

    const activeBook = hubBooks[hubId];
    if (activeBook.size === 0) {
      return res.json({
        results: [], total: 0, totalMatched: 0, jitaBookSize: 0, coveredWithVolume: 0,
        brokerFeeRate, transactionTaxRate, sessionCached, hubVolumeEnriched: hubId === 'jita',
        meta: { ...tradingMeta(hubId), warming: true },
      });
    }

    const { volMap, hubVolumeEnriched } = await resolveTradingVolumeMap({ hubId, cfg });

    const nameMap    = hubNameMaps[hubId];
    const RESULT_CAP = 500;
    const capISK     = (capital && capital > 0) ? capital : null;

    const { results, totalMatched } = scanTradingOpportunities({
      activeBook, nameMap, volMap, brokerFeeRate, transactionTaxRate,
      safeMinMarginPct, capISK, maxSellOrders, minVolume, resultCap: RESULT_CAP,
    });

    res.json({
      results,
      total:             results.length,
      totalMatched,
      jitaBookSize:      activeBook.size,
      coveredWithVolume: volMap.size,
      brokerFeeRate,
      transactionTaxRate,
      sessionCached,
      hubVolumeEnriched,
      meta:              tradingMeta(hubId),
    });
  } catch (err) {
    logger.error('Trading scan error:', err);
    res.status(500).json({ error: 'Scan failed' });
  }
});

// GET /api/trading/character-orders — fetches the character's live market orders from ESI
// and cross-references them against the Jita book to flag undercuts.
// The Authorization header carries the CCP EVE JWT (same token used for all auth), which
// is forwarded directly to ESI — no stored tokens needed.
router.get('/api/trading/character-orders', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    ensureHubPollerRunning('jita');

    const characterId = req.characterId;
    const eveToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');

    const esiUrl = `https://esi.evetech.net/v2/characters/${characterId}/orders/?datasource=tranquility`;
    const esiRes = await fetch(esiUrl, { headers: { Authorization: `Bearer ${eveToken}` } });

    if (esiRes.status === 403) {
      const body = await esiRes.text().catch(() => '');
      const isScopeMissing = body.includes('scope') || body.includes('authorization');
      return res.status(403).json({
        error: isScopeMissing
          ? 'scope_missing: re-login required to grant esi-markets.read_character_orders.v1'
          : 'ESI 403: access denied',
      });
    }
    if (!esiRes.ok) {
      const text = await esiRes.text().catch(() => esiRes.statusText);
      return res.status(502).json({ error: `ESI ${esiRes.status}: ${text}` });
    }

    const esiOrders = await esiRes.json();

    // Resolve type names — precomputed covers most tradeable items; fall back to type ID string
    const typeIds = [...new Set(esiOrders.map(o => o.type_id))];
    const nameRows = typeIds.length
      ? await dbAll(
          `SELECT DISTINCT product_id, product_name FROM precomputed_profits WHERE product_id IN (${typeIds.map(() => '?').join(',')})`,
          typeIds
        )
      : [];
    const nameMap = new Map(nameRows.map(r => [r.product_id, r.product_name]));

    // Enrich each order with undercut status from the live Jita book (orders are always at Jita)
    const orders = esiOrders.map(o => {
      const book = hubBooks.jita.get(o.type_id);
      let isUndercut = false, undercutBy = 0, bookBest = null;

      if (book) {
        if (o.is_buy_order) {
          bookBest   = book.buy;
          isUndercut = book.buy > o.price;
          undercutBy = isUndercut ? book.buy - o.price : 0;
        } else {
          bookBest   = book.sell;
          isUndercut = book.sell < o.price && book.sell > 0;
          undercutBy = isUndercut ? o.price - book.sell : 0;
        }
      }

      return {
        order_id:      o.order_id,
        type_id:       o.type_id,
        name:          nameMap.get(o.type_id) ?? `Type #${o.type_id}`,
        price:         o.price,
        volume_remain: o.volume_remain,
        volume_total:  o.volume_total,
        is_buy_order:  o.is_buy_order,
        duration:      o.duration,
        issued:        o.issued,
        location_id:   o.location_id,
        range:         o.range ?? 'station',
        isUndercut,
        undercutBy,
        bookBest,
      };
    });

    res.json({ orders, meta: tradingMeta() });
  } catch (err) {
    logger.error('Character orders error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
