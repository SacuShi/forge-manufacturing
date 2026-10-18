'use strict';
// A tiny, hand-made EVE universe for the integration tests: one T1 product, three materials, one hub.
// Every number is chosen so the expected result can be worked out by hand (see the tests).

const JITA_REGION = 10000002;
const JITA_SYSTEM = 30000142;
const HUB_STATION = 60003760;   // Jita IV-4: the station whose orders count first
const OTHER_STATION = 60000002; // elsewhere in the region: cheaper, but only used as a fallback

const TRIT = 34, PYER = 35, MEXA = 36;
const PRODUCT = 900001;
const BLUEPRINT = 900101;

const types = [
  { id: TRIT, name: 'Tritanium', group: 18 },
  { id: PYER, name: 'Pyerite', group: 18 },
  { id: MEXA, name: 'Mexallon', group: 18 },
  { id: PRODUCT, name: 'Test Frigate', group: 25 },
  { id: BLUEPRINT, name: 'Test Frigate Blueprint', group: 105 },
];

// Base (ME 0, one run) material list and build time of the blueprint.
const materials = [{ id: TRIT, qty: 1000 }, { id: PYER, qty: 500 }, { id: MEXA, qty: 100 }];
const BUILD_TIME_SECONDS = 600;
const INDUSTRY_SKILL = 3380;

// Prices. `adjusted` feeds CCP's job-fee base (EIV); `hubSell` is what the market actually asks at the hub.
const adjusted = { [TRIT]: 4.03, [PYER]: 16.8, [MEXA]: 52.8, [PRODUCT]: 1_500_000 };
const hubSell = { [TRIT]: 4.0, [PYER]: 16.5, [MEXA]: 52.0, [PRODUCT]: 5_000_000 };
const otherSell = { [TRIT]: 3.5 }; // cheaper elsewhere in the region: must NOT win while the hub stocks the item
const COST_INDEX_MANUFACTURING = 0.05;

function orders() {
  const out = [];
  let id = 1;
  const push = (type_id, price, location_id, is_buy_order) => out.push({
    order_id: id++, type_id, price, location_id, is_buy_order, volume_remain: 1e9, volume_total: 1e9, min_volume: 1,
    duration: 90, issued: '2026-01-01T00:00:00Z', range: 'region',
  });
  for (const [t, p] of Object.entries(hubSell)) {
    push(Number(t), p, HUB_STATION, false);
    push(Number(t), p * 0.8, HUB_STATION, true);
  }
  for (const [t, p] of Object.entries(otherSell)) push(Number(t), p, OTHER_STATION, false);
  return out;
}

/** What the ESI stub serves (see preload.cjs). */
function esiFixtures() {
  return {
    pricesList: Object.entries(adjusted).map(([t, p]) => ({ type_id: Number(t), adjusted_price: p, average_price: p })),
    industrySystems: [{ solar_system_id: JITA_SYSTEM, cost_indices: [
      { activity: 'manufacturing', cost_index: COST_INDEX_MANUFACTURING }, { activity: 'reaction', cost_index: 0.01 }] }],
    systemNames: { [JITA_SYSTEM]: 'Jita' },
    orders: { [JITA_REGION]: orders() },
    structures: {},
  };
}

/** Tables the server expects to exist before it boots (the real ones come from the SDE import). */
const SEED_SQL = [
  `CREATE TABLE items (type_id INTEGER PRIMARY KEY, name TEXT, meta_level INTEGER, packaged_volume REAL, group_id INTEGER, category_name TEXT, pi_tier INTEGER, description TEXT, icon_url TEXT, volume REAL, mass REAL)`,
  `CREATE TABLE blueprints (blueprint_id INTEGER PRIMARY KEY, product_id INTEGER, product_quantity INTEGER DEFAULT 1, build_time INTEGER, activity_id INTEGER DEFAULT 1, research_time INTEGER)`,
  `CREATE TABLE blueprint_materials (blueprint_id INTEGER, material_id INTEGER, quantity INTEGER, PRIMARY KEY (blueprint_id, material_id))`,
  `CREATE TABLE blueprint_skills (blueprint_id INTEGER NOT NULL, skill_id INTEGER NOT NULL, skill_level INTEGER NOT NULL, activity_id INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE sde_systems (system_id INTEGER PRIMARY KEY, name TEXT, region_id INTEGER, constellation_id INTEGER, security_status REAL)`,
];

function seedRows() {
  const rows = [];
  for (const t of types) rows.push(['INSERT INTO items (type_id, name, group_id, packaged_volume) VALUES (?,?,?,?)', [t.id, t.name, t.group, 1]]);
  rows.push(['INSERT INTO blueprints (blueprint_id, product_id, product_quantity, build_time, activity_id) VALUES (?,?,?,?,1)', [BLUEPRINT, PRODUCT, 1, BUILD_TIME_SECONDS]]);
  for (const m of materials) rows.push(['INSERT INTO blueprint_materials VALUES (?,?,?)', [BLUEPRINT, m.id, m.qty]]);
  rows.push(['INSERT INTO blueprint_skills VALUES (?,?,?,1)', [BLUEPRINT, INDUSTRY_SKILL, 1]]);
  rows.push(['INSERT INTO sde_systems VALUES (?,?,?,?,?)', [JITA_SYSTEM, 'Jita', JITA_REGION, 20000020, 0.9459]]);
  return rows;
}

/** Material cost for `runs` runs at material efficiency `me` percent, priced at `unit` — the game's rounding rule. */
function expectedMaterials(runs, me, unit) {
  const mult = 1 - me / 100;
  return materials.map((m) => {
    const qty = Math.max(runs, Math.ceil(Math.round(runs * m.qty * mult * 100) / 100));
    return { id: m.id, qty, cost: qty * unit[m.id] };
  });
}
/** Estimated item value: BASE quantities (ME 0) times adjusted price — the job-fee base. */
const expectedEiv = (runs) => materials.reduce((s, m) => s + m.qty * runs * adjusted[m.id], 0);

module.exports = {
  JITA_REGION, JITA_SYSTEM, HUB_STATION, OTHER_STATION, TRIT, PYER, MEXA, PRODUCT, BLUEPRINT,
  types, materials, BUILD_TIME_SECONDS, INDUSTRY_SKILL, adjusted, hubSell, otherSell, COST_INDEX_MANUFACTURING,
  esiFixtures, SEED_SQL, seedRows, expectedMaterials, expectedEiv,
};
