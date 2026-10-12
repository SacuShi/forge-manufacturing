'use strict';
// Asset Safety detection (forge-v1/src/utils/assetSafety.ts) — transpiled and exercised with hand-built asset trees.
//   node test-asset-safety.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require(path.join(__dirname, '../forge-v1/node_modules/typescript'));

const src = fs.readFileSync(path.join(__dirname, '../forge-v1/src/utils/assetSafety.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(js, { module: mod, exports: mod.exports, require: () => ({}) });
const A = mod.exports;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const asset = (item_id, type_id, location_id, location_flag = 'Hangar') => ({ item_id, type_id, quantity: 1, location_id, location_flag, is_singleton: false });

const STATION = 60003760;
const assets = [
  // a normal station hangar: a ship with a fitted module, and loose minerals
  asset(1, 587, STATION),                       // Rifter in the hangar
  asset(2, 2046, 1, 'LoSlot0'),                 // module fitted to the Rifter
  asset(3, 34, STATION),                        // Tritanium
  // an asset-safety wrap that has NOT been delivered anywhere (location 2004)
  asset(10, 60, 2004, 'AssetSafety'),           // the wrap
  asset(11, 587, 10, 'AssetSafety'),            // a ship inside it
  asset(12, 2046, 11, 'LoSlot0'),               // its fitted module
  asset(13, 35, 10, 'AssetSafety'),             // loose Pyerite inside
  // a wrap that HAS been delivered to the station hangar; contents still locked inside
  asset(20, 60, STATION),
  asset(21, 36, 20, 'AssetSafety'),
  asset(22, 11399, 21),                         // (odd nesting) still inside the wrap's contents
  // a stray item flagged AssetSafety whose parent isn't in the list
  asset(30, 37, 999999, 'AssetSafety'),
];

t('items in an undelivered wrap (location 2004) and everything nested in them are safety', () => {
  const ids = A.findAssetSafetyItemIds(assets);
  for (const id of [10, 11, 12, 13]) assert.ok(ids.has(id), 'item ' + id);
});

t('a wrap delivered to a station keeps its contents locked (the wrap and its contents are safety)', () => {
  const ids = A.findAssetSafetyItemIds(assets);
  for (const id of [20, 21, 22]) assert.ok(ids.has(id), 'item ' + id);
});

t('ordinary hangar items, ships and their fittings are NOT safety', () => {
  const ids = A.findAssetSafetyItemIds(assets);
  for (const id of [1, 2, 3]) assert.ok(!ids.has(id), 'item ' + id);
});

t('an item flagged AssetSafety is safety even when its parent is unknown', () => {
  assert.ok(A.findAssetSafetyItemIds(assets).has(30));
});

t('splitAssetSafety partitions without losing or duplicating anything', () => {
  const { usable, safety, safetyIds } = A.splitAssetSafety(assets);
  assert.strictEqual(usable.length + safety.length, assets.length);
  assert.strictEqual(JSON.stringify(usable.map(a => a.item_id).sort((a, b) => a - b)), JSON.stringify([1, 2, 3]));
  assert.strictEqual(safetyIds.size, safety.length);
});

t('with no safety items the original array is returned untouched', () => {
  const plain = assets.slice(0, 3);
  const r = A.splitAssetSafety(plain);
  assert.strictEqual(r.usable, plain); assert.strictEqual(r.safety.length, 0);
});

t('a parent cycle cannot hang the walk', () => {
  const cyc = [asset(1, 587, 2), asset(2, 587, 1), asset(3, 34, STATION)];
  const ids = A.findAssetSafetyItemIds(cyc);
  assert.strictEqual(ids.size, 0);
});

t('blueprints: judged by the asset tree, their own location, or their parent', () => {
  const ids = A.findAssetSafetyItemIds(assets);
  const bp = (item_id, location_id, location_flag = 'Hangar') => ({ item_id, location_id, location_flag });
  assert.ok(A.isInAssetSafety(bp(11, 10), ids));                         // in the asset list, inside a wrap
  assert.ok(A.isInAssetSafety(bp(500, 2004, 'AssetSafety'), ids));      // not in the asset list, but located at 2004
  assert.ok(A.isInAssetSafety(bp(501, 10), ids));                        // parent is the wrap
  assert.ok(!A.isInAssetSafety(bp(502, STATION), ids));                  // ordinary station hangar
});

t('release fees: 15% to another system, 0.5% within the same system', () => {
  const f = A.assetSafetyFees(1_000_000_000);
  assert.strictEqual(f.otherSystem, 150_000_000);
  assert.strictEqual(f.sameSystem, 5_000_000);
  assert.strictEqual(JSON.stringify(A.assetSafetyFees(NaN)), JSON.stringify({ otherSystem: 0, sameSystem: 0 }));
  assert.strictEqual(JSON.stringify(A.assetSafetyFees(-5)), JSON.stringify({ otherSystem: 0, sameSystem: 0 }));
});

console.log(`\n${n} tests passed`);
