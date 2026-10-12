'use strict';
const assert = require('assert');
const HP = require('./lib/hub-price');
const { withJitaFallback, isJitaFallback } = HP;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

const jita = {
  1: { sell: 100, buy: 90, median: 95 },
  2: { sell: 0,   buy: 50, median: 25 },
  3: { sell: 700, buy: 650, median: 675 },
};

t('hub with its own sell keeps it (same object, no scope)', () => {
  const hub = { 1: { sell: 120, buy: 80, median: 100, sellScope: 'hub' } };
  const out = withJitaFallback(hub, jita);
  assert.strictEqual(out[1], hub[1]);
  assert.strictEqual(isJitaFallback(out[1]), false);
});

t('hub with no sell order falls back to Jita live sell, tagged jita', () => {
  const hub = { 1: { sell: 0, buy: 80, median: 80 } };
  const out = withJitaFallback(hub, jita);
  assert.strictEqual(out[1].sell, 100);
  assert.strictEqual(out[1].sellScope, 'jita');
  assert.strictEqual(out[1].buy, 80);            // the hub's own bid is kept
  assert.strictEqual(isJitaFallback(out[1]), true);
});

t('hub sell of 0 with Jita also 0 stays unpriced, not tagged', () => {
  const hub = { 2: { sell: 0, buy: 0, median: 777, avg30d: 777 } };
  const out = withJitaFallback(hub, jita);
  assert.strictEqual(out[2].sell, 0);
  assert.strictEqual(isJitaFallback(out[2]), false);
});

t('type absent from the hub entirely gets Jita sell, tagged jita', () => {
  const out = withJitaFallback({}, jita);
  assert.strictEqual(out[3].sell, 700);
  assert.strictEqual(out[3].sellScope, 'jita');
  assert.strictEqual(out[3].buy, 0);
});

t('Jita itself and missing Jita data are returned untouched', () => {
  assert.strictEqual(withJitaFallback(jita, jita), jita);
  const hub = { 1: { sell: 0, buy: 1 } };
  assert.strictEqual(withJitaFallback(hub, null), hub);
});

t('inputs are never mutated', () => {
  const hub = { 1: { sell: 0, buy: 80, median: 80 } };
  const snap = JSON.stringify(hub), jsnap = JSON.stringify(jita);
  withJitaFallback(hub, jita);
  assert.strictEqual(JSON.stringify(hub), snap);
  assert.strictEqual(JSON.stringify(jita), jsnap);
});

t('overlay is cached per (hub, jita) object pair and refreshed when either is replaced', () => {
  const hub = { 1: { sell: 0, buy: 0 } };
  const a = withJitaFallback(hub, jita);
  assert.strictEqual(withJitaFallback(hub, jita), a);
  const jita2 = { 1: { sell: 999, buy: 1, median: 5 } };
  assert.strictEqual(withJitaFallback(hub, jita2)[1].sell, 999);
});

t('a non-finite or negative hub sell is treated as no sell order', () => {
  const hub = { 1: { sell: NaN, buy: 0 }, 3: { sell: -5, buy: 0 } };
  const out = withJitaFallback(hub, jita);
  assert.strictEqual(out[1].sell, 100);
  assert.strictEqual(out[3].sell, 700);
});

// ── Depth & purchase pricing ────────────────────────────────────────────────
function depthOf(orders) {            // orders: [type, price, qty]
  const acc = HP.makeDepthAccumulator();
  for (const [ty, p, q] of orders) acc.add(ty, p, q);
  return acc.finish();
}
function mk(pricesObj, orders) { return HP.attachDepth(pricesObj, depthOf(orders)); }

t('depth keeps cheapest levels sorted, merges equal prices, tracks total', () => {
  const d = depthOf([[1, 20, 5], [1, 10, 3], [1, 10, 2], [1, 30, 1]]).get(1);
  assert.deepStrictEqual(d.levels, [[10, 5], [20, 5], [30, 1]]);
  assert.strictEqual(d.total, 11);
});

t('depth truncates to 20 levels but keeps the true total', () => {
  const orders = []; for (let i = 1; i <= 30; i++) orders.push([1, i, 10]);
  const d = depthOf(orders).get(1);
  assert.strictEqual(d.levels.length, 20); assert.strictEqual(d.total, 300);
});

t('walkDepth walks the book and prices by level', () => {
  const d = { levels: [[10, 5], [20, 5]], total: 10 };
  const r = HP.walkDepth(d, 7);
  assert.strictEqual(r.filled, 7); assert.strictEqual(r.cost, 5 * 10 + 2 * 20);
});

t('walkDepth prices units beyond stored levels at the last level and flags approx', () => {
  const d = { levels: [[10, 5]], total: 12 };
  const r = HP.walkDepth(d, 9);
  assert.strictEqual(r.filled, 9); assert.strictEqual(r.cost, 90); assert.strictEqual(r.approx, true);
});

const hubP = mk({ 1: { sell: 100, buy: 0 } }, [[1, 100, 4], [1, 120, 4]]);       // hub has 8 units
const jitP = mk({ 1: { sell: 50, buy: 0 } },  [[1, 50, 100], [1, 60, 100]]);

t('hub can cover the whole quantity: hub scope, no import', () => {
  const r = HP.priceBuy({ hubPrices: hubP, jitaPrices: jitP, typeId: 1, qty: 6 });
  assert.strictEqual(r.scope, 'hub'); assert.strictEqual(r.cost, 4 * 100 + 2 * 120);
  assert.strictEqual(r.jitaQty, 0);
});

t('hub cannot cover it all: remainder is imported from Jita, scope mixed', () => {
  const r = HP.priceBuy({ hubPrices: hubP, jitaPrices: jitP, typeId: 1, qty: 20 });
  assert.strictEqual(r.hubQty, 8); assert.strictEqual(r.jitaQty, 12);
  assert.strictEqual(r.scope, 'mixed');
  assert.strictEqual(r.cost, 4 * 100 + 4 * 120 + 12 * 50);
  assert.strictEqual(r.shortStock, false);
});

t('nothing at the hub: all from Jita, scope jita', () => {
  const r = HP.priceBuy({ hubPrices: mk({}, []), jitaPrices: jitP, typeId: 1, qty: 30 });
  assert.strictEqual(r.scope, 'jita'); assert.strictEqual(r.jitaQty, 30); assert.strictEqual(r.cost, 1500);
});

t('neither market can supply it: remainder priced at last visible price and flagged short', () => {
  const r = HP.priceBuy({ hubPrices: hubP, jitaPrices: jitP, typeId: 1, qty: 500 });
  assert.strictEqual(r.shortStock, true); assert.strictEqual(r.unfilledQty, 500 - 8 - 200);
  assert.strictEqual(r.unfilledCost, r.unfilledQty * 60);
});

t('no price anywhere: scope none, zero cost', () => {
  const r = HP.priceBuy({ hubPrices: mk({}, []), jitaPrices: mk({}, []), typeId: 9, qty: 5 });
  assert.strictEqual(r.scope, 'none'); assert.strictEqual(r.cost, 0);
});

t('Jita as the hub never imports from itself; a shortfall is flagged', () => {
  const r = HP.priceBuy({ hubPrices: jitP, jitaPrices: jitP, typeId: 1, qty: 250, hubIsJita: true });
  assert.strictEqual(r.jitaQty, 0); assert.strictEqual(r.scope, 'hub');
  assert.strictEqual(r.shortStock, true); assert.strictEqual(r.unfilledQty, 50);
});

t('a price map with no depth (older cache) falls back to price x quantity at the lowest sell', () => {
  const r = HP.priceBuy({ hubPrices: { 1: { sell: 7, buy: 0 } }, jitaPrices: null, typeId: 1, qty: 10 });
  assert.strictEqual(r.cost, 70); assert.strictEqual(r.scope, 'hub');
});

t('the Resonator case: one hub order of 3 units at 9.5M, 95 needed => the rest imported from Jita', () => {
  const hub = mk({ 83468: { sell: 9.5e6, buy: 3.5e6 } }, [[83468, 9.5e6, 3]]);
  const jit = mk({ 83468: { sell: 3.8e6, buy: 3.0e6 } }, [[83468, 3.8e6, 40], [83468, 4.1e6, 200]]);
  const r = HP.priceBuy({ hubPrices: hub, jitaPrices: jit, typeId: 83468, qty: 95 });
  assert.strictEqual(r.hubQty, 3); assert.strictEqual(r.jitaQty, 92); assert.strictEqual(r.scope, 'mixed');
  assert.strictEqual(r.cost, 3 * 9.5e6 + 40 * 3.8e6 + 52 * 4.1e6);
});

t('a priced type missing from an otherwise-present depth map is treated as available at its lowest sell', () => {
  const hub = mk({ 1: { sell: 40, buy: 0 } }, [[2, 9, 9]]);          // depth exists, but not for type 1
  const r = HP.priceBuy({ hubPrices: hub, jitaPrices: null, typeId: 1, qty: 5 });
  assert.strictEqual(r.cost, 200); assert.strictEqual(r.scope, 'hub');
});

t('history is the last resort and only when nobody lists the item', () => {
  const none = mk({}, []);
  const r = HP.priceBuy({ hubPrices: none, jitaPrices: none, typeId: 1, qty: 10, history: 7 });
  assert.strictEqual(r.scope, 'history'); assert.strictEqual(r.cost, 70);
  const r2 = HP.priceBuy({ hubPrices: hubP, jitaPrices: jitP, typeId: 1, qty: 3, history: 7 });
  assert.strictEqual(r2.scope, 'hub');
});

t('supply survives a JSON round trip and prices identically', () => {
  const sup = HP.describeSupply({ hubPrices: { 1: { sell: 5, buy: 0 } }, jitaPrices: jitP, typeId: 1, hubIsJita: false, history: 0 });
  const back = JSON.parse(JSON.stringify(sup));
  const a = HP.priceFromSupply(sup, 130), b = HP.priceFromSupply(back, 130);
  assert.deepStrictEqual(b, a);
  assert.strictEqual(back.hub.levels[0][1], null);       // unlimited level is sent as null
});

console.log(`\n${n} tests passed`);
