'use strict';
// Inter-hub arbitrage: buy from sell orders at hub A, fill buy orders at hub B. One query for the
// Inter-Hub tab and the AI advisor (they used to be two copies that drifted apart).
//
// Rules (CCP market mechanics):
//   - The buy side must be a LIVE ask at the buy hub: a Jita price standing in for a hub with no stock
//     ('jita_fallback') or a 30-day history average ('history_30d' / 'no_data') is not something you can buy.
//   - Filling an existing buy order costs sales tax only (no broker fee). The tax rate is the pilot's own
//     (Accounting skill, plus any CCP discount at that hub) — callers pass it in.

const { dbAll } = require('./db');

const ARB_SORTS = {
  est_daily_profit: 'est_daily_profit DESC NULLS LAST',
  net_profit:       'net_profit DESC',
  net_margin_pct:   'net_margin_pct DESC',
  isk_per_m3:       'isk_per_m3 DESC NULLS LAST',
  avg_daily_volume: 'avg_daily_volume DESC NULLS LAST',
};

/**
 * @param {object} o
 * @param {number} o.buyHub      region id of the buy hub
 * @param {number} o.sellHub     region id of the sell hub
 * @param {number} o.taxRate     sales tax as a fraction (e.g. 0.03375)
 * @param {number} [o.minMargin] minimum net margin %, default 5
 * @param {string} [o.sortBy]    key of ARB_SORTS
 * @param {number} o.limit
 * @param {number} [o.offset]
 * @param {Function} [query]  dbAll-style function (the AI tools pass their injected one)
 */
async function queryInterHubArb({ buyHub, sellHub, taxRate, minMargin = 5, sortBy, limit, offset = 0 }, query = dbAll) {
  const keep = 1 - Math.max(0, Math.min(1, Number(taxRate) || 0));   // share of the sale the seller keeps
  const orderBy = ARB_SORTS[sortBy] || ARB_SORTS.est_daily_profit;
  const NET = `(MAX(p2.buy_price) * ${keep} - MIN(p1.sell_price))`;
  const VOL = 'COALESCE(MAX(p1.avg_daily_volume), MAX(p2.avg_daily_volume))';
  return query(`
    SELECT
      p1.product_id,
      p1.product_name,
      p1.region_id                          AS buy_region_id,
      p2.region_id                          AS sell_region_id,
      MIN(p1.sell_price)                    AS buy_at,
      MAX(p2.buy_price)                     AS sell_into,
      MAX(p2.buy_price) - MIN(p1.sell_price)          AS gross_spread,
      (MAX(p2.buy_price) - MIN(p1.sell_price)) / MIN(p1.sell_price) * 100  AS gross_margin_pct,
      ${NET}                                AS net_profit,
      ${NET} / MIN(p1.sell_price) * 100     AS net_margin_pct,
      COALESCE(i.packaged_volume, 0)         AS volume_m3,
      CASE WHEN COALESCE(i.packaged_volume, 0) > 0
        THEN ${NET} / i.packaged_volume
        ELSE NULL END                        AS isk_per_m3,
      ${VOL}                                 AS avg_daily_volume,
      CASE WHEN ${VOL} IS NOT NULL THEN ${VOL} * ${NET} ELSE NULL END AS est_daily_profit
    FROM precomputed_profits p1
    JOIN precomputed_profits p2
      ON p1.product_id = p2.product_id
     AND p1.region_id  = ?
     AND p2.region_id  = ?
    LEFT JOIN items i ON i.type_id = p1.product_id
    WHERE p1.sell_price > 0
      AND COALESCE(p1.price_source, '') NOT IN ('jita_fallback', 'history_30d', 'no_data')
      AND p2.buy_price  > 0
      AND (p2.buy_price * ${keep} - p1.sell_price) / p1.sell_price * 100 >= ?
    GROUP BY p1.product_id
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `, [buyHub, sellHub, minMargin, limit, offset]);
}

module.exports = { queryInterHubArb, ARB_SORTS };
