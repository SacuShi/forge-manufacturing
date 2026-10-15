'use strict';
// One place that builds the "top profitable" query over precomputed_profits, so every caller
// (Market Opportunities, the skill-filtered list, the AI advisor) selects the same columns and
// applies the same filters. Before this existed the SQL was copied four times and the copies drifted
// (the AI advisor's copy never returned price_source, so it could not tell a Jita-fallback price).

// Columns every caller gets, in both the same-hub and cross-hub shapes.
const COLUMNS = [
  'blueprint_id', 'product_id', 'product_name', 'sell_price', 'buy_price', 'build_time',
  'material_count', 'computed_at', 'avg_daily_volume', 'market_group_id', 'liquidity_risk',
  'price_source', 'avg_30d_price', 'volume_source',
];

// low_volume is a WARNING, not an exclusion; only critical risks are filtered out.
const RISK_OK = (col) => `(${col} IS NULL OR ${col} = '' OR ${col} = 'low_volume')`;

const SORTS = {
  profit:       'profit DESC',
  margin:       'profit_margin DESC',
  isk_per_hour: 'isk_per_hour DESC',
  cost:         'material_cost ASC',
  sell_price:   'sell_price DESC',
};
const orderFor = (sort) => SORTS[sort] || SORTS.profit;

const ACTIVITY_IDS = { manufacturing: 1, reaction: 9 };

/**
 * @param {object} o
 * @param {boolean} [o.isCrossHub]   materials priced at sourceRegionId, product sold at regionId
 * @param {number}  o.regionId       sell hub
 * @param {number}  [o.sourceRegionId]
 * @param {number}  [o.minProfit=0]
 * @param {number}  [o.minVolume=0]  rows with unknown volume always pass
 * @param {boolean} [o.includeRisky=false]
 * @param {string}  [o.orderClause]  must come from SORTS (never user text)
 * @param {string}  [o.search]       product-name substring (caller sanitises)
 * @param {string}  [o.activity]     'manufacturing' | 'reaction' | anything else = all
 * @param {number}  o.limit
 * @returns {{sql: string, params: any[]}}
 */
function buildTopProfitableQuery(o) {
  const {
    isCrossHub = false, regionId, sourceRegionId, minProfit = 0, minVolume = 0,
    includeRisky = false, orderClause = SORTS.profit, search, activity, limit,
  } = o;
  const t = isCrossHub ? 'sell.' : '';
  const where = [`${t}region_id = ?`, isCrossHub ? '(sell.sell_price - src.material_cost) > ?' : 'profit > ?', `${t}sell_price > 0`];
  const whereParams = [regionId, minProfit];

  if (search) { where.push(`${t}product_name LIKE ?`); whereParams.push(`%${search}%`); }
  if (ACTIVITY_IDS[activity]) { where.push(`COALESCE(${t}activity_id, 1) = ${ACTIVITY_IDS[activity]}`); }
  if (minVolume > 0) { where.push(`(${t}avg_daily_volume >= ? OR ${t}avg_daily_volume IS NULL)`); whereParams.push(minVolume); }
  if (!includeRisky) where.push(RISK_OK(`${t}liquidity_risk`));

  if (!isCrossHub) {
    return {
      sql: `SELECT ${COLUMNS.join(', ')}, material_cost, profit, profit_margin, isk_per_hour,
                   COALESCE(activity_id, 1) AS activity_id
            FROM precomputed_profits
            WHERE ${where.join(' AND ')}
            ORDER BY ${orderClause}
            LIMIT ?`,
      params: [...whereParams, limit],
    };
  }

  // Cross-hub: self-join. The sell-hub row supplies revenue and metadata, the source-hub row the
  // material cost; profit is recalculated in SQL so filtering and sorting use the true figure.
  return {
    sql: `SELECT ${COLUMNS.map((c) => 'sell.' + c + ' AS ' + c).join(', ')},
                 src.material_cost AS material_cost,
                 (sell.sell_price - src.material_cost) AS profit,
                 CASE WHEN sell.sell_price > 0
                      THEN (sell.sell_price - src.material_cost) / sell.sell_price * 100 ELSE 0 END AS profit_margin,
                 CASE WHEN sell.build_time > 0
                      THEN (sell.sell_price - src.material_cost) / (sell.build_time / 3600.0) ELSE 0 END AS isk_per_hour,
                 COALESCE(sell.activity_id, 1) AS activity_id
          FROM precomputed_profits sell
          JOIN precomputed_profits src ON src.blueprint_id = sell.blueprint_id AND src.region_id = ?
          WHERE ${where.join(' AND ')}
          ORDER BY ${orderClause}
          LIMIT ?`,
    // sourceRegionId first: it binds the JOIN's `src.region_id = ?`, which precedes WHERE in the text.
    params: [sourceRegionId, ...whereParams, limit],
  };
}

module.exports = { buildTopProfitableQuery, orderFor, SORTS, RISK_OK };
