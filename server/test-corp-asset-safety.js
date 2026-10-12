'use strict';
// Corp blueprints locked in Asset Safety must not be offered to the Queue Planner / AI. This runs the REAL view DDL and
// predicate text extracted from server.js against a throw-away in-memory SQLite database.   node test-corp-asset-safety.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const viewMatch = src.match(/CREATE VIEW corp_asset_safety_items AS[\s\S]*?SELECT corp_id, item_id FROM s/);
const predMatch = src.match(/const CORP_BP_USABLE_SQL = `([\s\S]*?)`;/);
assert.ok(viewMatch && predMatch, 'view / predicate not found in server.js');
const VIEW_SQL = viewMatch[0].replace(/\r/g, '');
const PRED = predMatch[1].replace(/\r/g, '');

const db = new sqlite3.Database(':memory:');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

(async () => {
  await run(`CREATE TABLE corp_assets (item_id INTEGER PRIMARY KEY, corp_id INTEGER, type_id INTEGER, quantity INTEGER, location_id INTEGER, location_flag TEXT, is_singleton INTEGER)`);
  await run(`CREATE TABLE corp_blueprints (item_id INTEGER PRIMARY KEY, corp_id INTEGER, type_id INTEGER, runs INTEGER, material_efficiency INTEGER, time_efficiency INTEGER, location_id INTEGER, location_flag TEXT)`);
  await run(VIEW_SQL);

  const CORP = 98000001, OTHER = 98000002, STATION = 60003760;
  const A = (item_id, type_id, location_id, location_flag = 'CorpSAG1', corp = CORP) =>
    run('INSERT INTO corp_assets VALUES (?,?,?,?,?,?,0)', [item_id, corp, type_id, 1, location_id, location_flag]);
  const BP = (item_id, location_id, location_flag = 'CorpSAG1', corp = CORP) =>
    run('INSERT INTO corp_blueprints VALUES (?,?,?,?,?,?,?,?)', [item_id, corp, 1000 + item_id, -1, 10, 20, location_id, location_flag]);

  // a normal corp hangar, a wrap at 2004 holding a container holding a blueprint, a wrap delivered to a station
  await A(1, 27, STATION);                    // an office/container at the station
  await A(10, 60, 2004, 'AssetSafety');       // undelivered wrap
  await A(11, 3293, 10, 'AssetSafety');       // a container inside it
  await A(20, 60, STATION);                   // delivered wrap
  await A(21, 3293, 20, 'AssetSafety');       // container inside it
  await A(900, 60, 2004, 'AssetSafety', OTHER); // another corp's wrap must not affect this corp

  await BP(100, STATION);                     // usable
  await BP(101, 1);                           // usable (in a normal container)
  await BP(102, 10);                          // directly in the undelivered wrap
  await BP(103, 11);                          // in a container inside the wrap
  await BP(104, 21);                          // in a container inside the delivered wrap
  await BP(105, 2004, 'AssetSafety');         // blueprint located at 2004 (not in the asset list)
  await BP(106, 555, 'AssetSafety');          // flagged AssetSafety, unknown parent
  await BP(107, STATION, 'CorpSAG1', OTHER);  // other corp's blueprint (not selected below)

  const rows = await all(`SELECT cb.item_id FROM corp_blueprints cb WHERE cb.corp_id = ? AND ${PRED} ORDER BY cb.item_id`, [CORP]);
  assert.strictEqual(JSON.stringify(rows.map(r => r.item_id)), JSON.stringify([100, 101]));
  console.log('ok - only the two blueprints that are NOT locked in Asset Safety remain');

  const other = await all(`SELECT cb.item_id FROM corp_blueprints cb WHERE cb.corp_id = ? AND ${PRED}`, [OTHER]);
  assert.strictEqual(JSON.stringify(other.map(r => r.item_id)), JSON.stringify([107]));
  console.log("ok - another corp's wrap doesn't hide this corp's blueprints (and vice versa)");

  const view = await all('SELECT item_id FROM corp_asset_safety_items WHERE corp_id = ? ORDER BY item_id', [CORP]);
  assert.strictEqual(JSON.stringify(view.map(r => r.item_id)), JSON.stringify([10, 11, 20, 21]));
  console.log('ok - the view holds the wraps and everything nested in them');
  console.log('\n3 tests passed');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
