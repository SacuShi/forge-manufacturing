// Tests lib/profit-query.js against a real in-memory SQLite table. Run: node test-profit-query.js
const sqlite3 = require('sqlite3');
const assert = require('assert');
const { buildTopProfitableQuery, orderFor } = require('./lib/profit-query');

const db = new sqlite3.Database(':memory:');
const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, (e) => (e ? rej(e) : res())));
const all = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  await run(`CREATE TABLE precomputed_profits (blueprint_id INT, region_id INT, product_id INT, product_name TEXT,
    material_cost REAL, sell_price REAL, buy_price REAL, profit REAL, profit_margin REAL, isk_per_hour REAL,
    build_time INT, material_count INT, computed_at TEXT, avg_daily_volume REAL, market_group_id INT,
    liquidity_risk TEXT, activity_id INT, price_source TEXT, avg_30d_price REAL, volume_source TEXT)`);
  const ins = (bp, region, name, mat, sell, o = {}) => run(
    `INSERT INTO precomputed_profits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [bp, region, bp * 10, name, mat, sell, 0, sell - mat, (sell - mat) / sell * 100, (sell - mat) / (3600 / 3600), 3600, 3, 'now',
      o.vol === undefined ? 100 : o.vol, 1, o.risk ?? null, o.act ?? 1, o.src ?? 'hub', 0, 'hub']);
  const JITA = 10000002, AMARR = 10000043;
  await ins(1, JITA, 'Rifter', 100, 200); await ins(1, AMARR, 'Rifter', 150, 400, { src: 'jita_fallback' });
  await ins(2, JITA, 'Slasher', 100, 130, { risk: 'critical' }); await ins(2, AMARR, 'Slasher', 120, 300);
  await ins(3, AMARR, 'Tritanium Reaction', 50, 500, { act: 9, vol: 2 });

  // same hub: risky filtered, price_source returned, columns present
  let q = buildTopProfitableQuery({ regionId: JITA, limit: 10 });
  let rows = await all(q.sql, q.params);
  assert.deepStrictEqual(rows.map((r) => r.product_name), ['Rifter']);
  assert.strictEqual(rows[0].price_source, 'hub');
  assert.ok('activity_id' in rows[0] && 'market_group_id' in rows[0] && 'volume_source' in rows[0]);
  q = buildTopProfitableQuery({ regionId: JITA, includeRisky: true, limit: 10 });
  assert.strictEqual((await all(q.sql, q.params)).length, 2);

  // fallback tag survives (this is what the AI advisor used to lose)
  q = buildTopProfitableQuery({ regionId: AMARR, limit: 10, orderClause: orderFor('profit') });
  rows = await all(q.sql, q.params);
  assert.strictEqual(rows.find((r) => r.product_name === 'Rifter').price_source, 'jita_fallback');

  // min volume: unknown volume passes, low volume does not
  q = buildTopProfitableQuery({ regionId: AMARR, minVolume: 5, limit: 10 });
  assert.ok(!(await all(q.sql, q.params)).some((r) => r.product_name === 'Tritanium Reaction'));

  // activity + search
  q = buildTopProfitableQuery({ regionId: AMARR, activity: 'reaction', limit: 10 });
  assert.deepStrictEqual((await all(q.sql, q.params)).map((r) => r.product_name), ['Tritanium Reaction']);
  q = buildTopProfitableQuery({ regionId: AMARR, search: 'rif', limit: 10 });
  assert.deepStrictEqual((await all(q.sql, q.params)).map((r) => r.product_name), ['Rifter']);

  // cross hub: sell at Amarr, materials from Jita -> profit recomputed from the SOURCE row's cost
  q = buildTopProfitableQuery({ isCrossHub: true, regionId: AMARR, sourceRegionId: JITA, includeRisky: true, limit: 10, orderClause: orderFor('profit') });
  rows = await all(q.sql, q.params);
  const rif = rows.find((r) => r.product_name === 'Rifter');
  assert.strictEqual(rif.material_cost, 100); assert.strictEqual(rif.sell_price, 400); assert.strictEqual(rif.profit, 300);
  assert.strictEqual(rif.price_source, 'jita_fallback');
  assert.ok(!rows.some((r) => r.product_name === 'Tritanium Reaction'), 'no source-hub row -> not buildable cross-hub');
  // every sort option resolves in the cross-hub join (ambiguous-column guard)
  for (const sort of ['profit', 'margin', 'isk_per_hour', 'cost', 'sell_price']) {
    q = buildTopProfitableQuery({ isCrossHub: true, regionId: AMARR, sourceRegionId: JITA, orderClause: orderFor(sort), limit: 5 });
    await all(q.sql, q.params);
  }
  assert.strictEqual(orderFor('x; DROP TABLE'), 'profit DESC');
  console.log('profit-query: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
