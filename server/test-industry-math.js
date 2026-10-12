'use strict';
// node test-industry-math.js — no framework, exits non-zero on failure.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const M      = require('./lib/industry-math');

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

const COMBAT_BC = 419, BATTLESHIP = 27, FRIGATE = 25, MARAUDER = 900, DREAD = 485;
const NULLSEC = -0.35, HIGHSEC = 0.9, LOWSEC = 0.3;

t('security class boundaries', () => {
  assert.strictEqual(M.securityClass(0.45), 'hi');
  assert.strictEqual(M.securityClass(0.44), 'low');
  assert.strictEqual(M.securityClass(0.05), 'low');
  assert.strictEqual(M.securityClass(0), 'null');
  assert.strictEqual(M.securityClass(-0.99), 'null');
  assert.strictEqual(M.securityClass(undefined), null);
  assert.strictEqual(M.securityClass(null), null);
});

t('product group families', () => {
  assert.strictEqual(M.productFamily(COMBAT_BC), 'basic_medium_ship');
  assert.strictEqual(M.productFamily(BATTLESHIP), 'basic_large_ship');
  assert.strictEqual(M.productFamily(FRIGATE), 'basic_small_ship');
  assert.strictEqual(M.productFamily(MARAUDER), 'adv_large_ship');
  assert.strictEqual(M.productFamily(DREAD), 'capital_ship');
  assert.strictEqual(M.productFamily(99999999), null);
});

t('invalid saved rig ids are reported, valid ones resolved', () => {
  const s = M.describeSetup({ structureTypeId: 35827, rigIds: [37189, 37200, 37181], systemSecurity: NULLSEC });
  assert.deepStrictEqual(s.invalidRigIds, [37189, 37200]);
  assert.strictEqual(s.rigs.length, 1);
  assert.strictEqual(s.rigs[0].id, 37181);
});

t('rig security multiplier comes from the rig\'s own attributes', () => {
  const rig = 37181; // XL Ship ME II: 2.4% ME, 24% TE
  const hi  = M.describeSetup({ structureTypeId: 35827, rigIds: [rig], systemSecurity: HIGHSEC }).rigs[0];
  const lo  = M.describeSetup({ structureTypeId: 35827, rigIds: [rig], systemSecurity: LOWSEC }).rigs[0];
  const nu  = M.describeSetup({ structureTypeId: 35827, rigIds: [rig], systemSecurity: NULLSEC }).rigs[0];
  near(hi.effMatPct, 2.4); near(lo.effMatPct, 2.4 * 1.9); near(nu.effMatPct, 2.4 * 2.1);
  near(nu.effTimePct, 24 * 2.1);
});

t('a rig only applies to the product families it covers', () => {
  const s = M.describeSetup({ structureTypeId: 35826, rigIds: [37175 /*L adv component*/, 43713 /*L drone*/, 37171 /*L equipment*/], systemSecurity: NULLSEC });
  const ship = M.modifiersForProduct(s, COMBAT_BC);
  assert.strictEqual(ship.appliedRigs.length, 0, 'none of those three rigs cover ships');
  near(ship.matMult, 0.99);
});

t('multiple covering rigs and the structure multiply (no additive summing)', () => {
  const s = M.describeSetup({ structureTypeId: 35827, rigIds: [37181], systemSecurity: NULLSEC });
  const mods = M.modifiersForProduct(s, COMBAT_BC);
  assert.strictEqual(mods.appliedRigs.length, 1);
  near(mods.matMult, 0.99 * (1 - 0.024 * 2.1), 1e-12);
  near(mods.costMult, 0.95);
  near(mods.timeMult, 0.7 * (1 - 0.24 * 2.1), 1e-12);
});

t('NPC station: no structure, no rigs → multipliers are exactly 1', () => {
  const s = M.describeSetup({ structureTypeId: null, rigIds: [], systemSecurity: HIGHSEC });
  const mods = M.modifiersForProduct(s, COMBAT_BC);
  assert.strictEqual(mods.matMult, 1); assert.strictEqual(mods.costMult, 1); assert.strictEqual(mods.timeMult, 1);
});

t('unknown product group gets structure bonus but no rig bonus', () => {
  const s = M.describeSetup({ structureTypeId: 35827, rigIds: [37181], systemSecurity: NULLSEC });
  const mods = M.modifiersForProduct(s, null);
  assert.strictEqual(mods.familyKnown, false);
  near(mods.matMult, 0.99);
});

t('rigs are enforced like the game: dedupe, max 3, matching size, none at an NPC station', () => {
  const dup = M.describeSetup({ structureTypeId: 35827, rigIds: [37181, 37181, 37181], systemSecurity: NULLSEC });
  assert.strictEqual(dup.rigs.length, 1);
  const wrongSize = M.describeSetup({ structureTypeId: 35826, rigIds: [37181], systemSecurity: NULLSEC });   // XL rig in an Azbel
  assert.deepStrictEqual(wrongSize.rigs, []); assert.deepStrictEqual(wrongSize.ignoredRigIds, [37181]);
  const npc = M.describeSetup({ structureTypeId: null, rigIds: [37181], systemSecurity: NULLSEC });
  assert.deepStrictEqual(npc.rigs, []); assert.deepStrictEqual(npc.ignoredRigIds, [37181]);
  const over = M.describeSetup({ structureTypeId: 35827, rigIds: [37178, 37179, 37180, 37181], systemSecurity: NULLSEC });
  assert.strictEqual(over.rigs.length, 3); assert.deepStrictEqual(over.ignoredRigIds, [37181]);
});

t('XL Equipment and Consumable rigs cover equipment AND ammo AND drones (from the game effects), not ships', () => {
  const r = M.RIGS[37179];
  assert.deepStrictEqual(r.matCovers, ['ammo', 'drone_fighter', 'equipment']);
  assert.deepStrictEqual(r.timeCovers, ['ammo', 'drone_fighter', 'equipment']);
  const s = M.describeSetup({ structureTypeId: 35827, rigIds: [37179], systemSecurity: NULLSEC });
  const AMMO = +Object.keys(require('./lib/industry-data/product-families.json')).find(g => require('./lib/industry-data/product-families.json')[g] === 'ammo');
  assert.strictEqual(M.modifiersForProduct(s, AMMO).appliedRigs.length, 1);
  assert.strictEqual(M.modifiersForProduct(s, COMBAT_BC).appliedRigs.length, 0);
});

t('time-only rigs speed builds but do not touch materials', () => {
  const s = M.describeSetup({ structureTypeId: 35825, rigIds: [37153], systemSecurity: HIGHSEC });   // M Basic Medium Ship TIME II
  const m = M.modifiersForProduct(s, COMBAT_BC);
  near(m.matMult, 0.99); near(m.timeMult, 0.85 * (1 - 0.24));
});

t('Thukker rigs: separate capital-component bonus, security-scaled by their own multipliers', () => {
  const CAP = 873, ADV_CAP = 913, ADV = 334;
  assert.strictEqual(M.productFamily(CAP), 'cap_component'); assert.strictEqual(M.productFamily(ADV_CAP), 'adv_cap_component'); assert.strictEqual(M.productFamily(ADV), 'adv_component');
  // 45544: only the 3.7% Thukker bonus, basic capital components only
  const nu = M.describeSetup({ structureTypeId: 35825, rigIds: [45544], systemSecurity: NULLSEC });
  const lo = M.describeSetup({ structureTypeId: 35825, rigIds: [45544], systemSecurity: LOWSEC });
  near(M.modifiersForProduct(nu, CAP).matMult, 0.99 * (1 - 0.037 * 0.1), 1e-12);      // x0.1 in nullsec
  near(M.modifiersForProduct(lo, CAP).matMult, 0.99 * (1 - 0.037 * 1.9), 1e-12);      // x1.9 in lowsec
  assert.strictEqual(M.modifiersForProduct(lo, ADV).appliedRigs.length, 0);
  // 45548 (XL): standard 2% on adv components & structures, Thukker 3.7% on both capital families
  const xl = M.describeSetup({ structureTypeId: 35827, rigIds: [45548], systemSecurity: LOWSEC });
  near(M.modifiersForProduct(xl, ADV).matMult, 0.99 * (1 - 0.02 * 1.9), 1e-12);
  near(M.modifiersForProduct(xl, ADV_CAP).matMult, 0.99 * (1 - 0.037 * 1.9), 1e-12);
  near(M.modifiersForProduct(xl, CAP).matMult, 0.99 * (1 - 0.037 * 1.9), 1e-12);
});

t('every rig has a bonus and somewhere to apply it (generator invariant)', () => {
  for (const [id, r] of Object.entries(M.RIGS)) {
    assert.ok(r.matPct > 0 || r.thukkerMatPct > 0 || r.timePct > 0, id + ' has no bonus');
    if (r.matPct > 0) assert.ok(r.matCovers.length, id + ' mat bonus uncovered');
    if (r.thukkerMatPct > 0) assert.ok(r.thukkerCovers.length, id + ' thukker bonus uncovered');
    if (r.timePct > 0) assert.ok(r.timeCovers.length, id + ' time bonus uncovered');
  }
});

t('job quantity rounds once per job, not per run', () => {
  assert.strictEqual(M.jobQuantity(3, 10, 0.9), 27);                 // per-run ceil would give 30
  assert.strictEqual(M.jobQuantity(1, 100, 0.9), 100);               // floor of 1 per run (EVE Uni example)
  assert.strictEqual(M.jobQuantity(10, 1, 0.9), 9);
  assert.strictEqual(M.jobQuantity(7, 10, 1), 70);                   // no float drift at exact values
  assert.strictEqual(M.jobQuantity(3, 1, 1.04), 4);                  // negative ME (T2 BPC −4)
});

t('blueprint ME multiplier', () => {
  near(M.blueprintMeMult(10), 0.9); near(M.blueprintMeMult(-4), 1.04); near(M.blueprintMeMult(0), 1);
});

t('EIV uses base quantities and ignores ME entirely', () => {
  const mats = [{ material_id: 1, quantity: 1000 }, { material_id: 2, quantity: 10 }];
  const adj  = { 1: 5, 2: 1000 };
  near(M.estimatedItemValue(mats, 1, adj), 1000 * 5 + 10 * 1000);
  near(M.estimatedItemValue(mats, 10, adj), 10 * (1000 * 5 + 10 * 1000));
});

t('job cost: structure bonus scales only the SCI part', () => {
  const j = M.jobCost({ eiv: 1000, sci: 0.05, costMult: 0.95, facilityTaxDecimal: 0.01 });
  near(j.system, 1000 * 0.05 * 0.95); near(j.scc, 40); near(j.facility, 10);
  near(j.total, 47.5 + 40 + 10);
});

t('time multiplier includes science skills, rigs, structure, implant', () => {
  const skillMap = { 3380: 5, 3388: 5, 11452: 5, 11441: 5 };       // Industry, Adv Industry, Mech Eng, Plasma
  const req = [{ skill_id: 11452 }, { skill_id: 11441 }, { skill_id: 99999 }];
  const f = M.timeMultiplier({ skillMap, requiredSkills: req, blueprintTe: 20, modsTimeMult: 0.7, implantPct: 4 });
  const expect = 0.8 * 0.8 * 0.85 * 0.95 * 0.95 * 0.7 * 0.96;
  near(f, expect, 1e-12);
});

t('generated data: every manufacturing rig has zero job-cost bonus (so omitting it is correct)', () => {
  const nonzero = Object.entries(M.RIGS).filter(([, r]) => r.costPct !== 0);
  assert.strictEqual(nonzero.length, 0, JSON.stringify(nonzero));
});

t('Mfg Setup rig catalog == generated rig data (ids, names, sizes)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../forge-v1/src/components/IndustrySettings.tsx'), 'utf8');
  const block = src.slice(src.indexOf('const MANUFACTURING_RIGS'), src.indexOf('];', src.indexOf('const MANUFACTURING_RIGS')));
  const rows = [...block.matchAll(/type_id:\s*(\d+),\s*name:\s*'([^']+)',\s*category:\s*'([^']+)',\s*size:\s*'(M|L|XL)'/g)]
    .map(m => ({ id: +m[1], name: m[2], category: m[3], size: m[4] }));
  assert.ok(rows.length > 50, 'parsed catalog rows: ' + rows.length);
  const missing = rows.filter(r => !M.RIGS[r.id]).map(r => r.id);
  assert.deepStrictEqual(missing, [], 'catalog ids unknown to game data');
  const mismatch = rows.filter(r => M.RIGS[r.id] && (M.RIGS[r.id].name !== r.name || M.RIGS[r.id].size !== r.size));
  assert.deepStrictEqual(mismatch.map(r => r.id), [], 'catalog name/size differs from game data');
  const notInUi = Object.keys(M.RIGS).map(Number).filter(id => !rows.some(r => r.id === id));
  assert.deepStrictEqual(notInUi, [], 'game-data rigs the picker cannot select');
});

t('structures match published multipliers', () => {
  near(M.STRUCTURES[35825].matMult, 0.99); near(M.STRUCTURES[35825].costMult, 0.97); near(M.STRUCTURES[35825].timeMult, 0.85);
  near(M.STRUCTURES[35826].costMult, 0.96); near(M.STRUCTURES[35827].costMult, 0.95); near(M.STRUCTURES[35827].timeMult, 0.7);
});

console.log(`\n${passed} passed${process.exitCode ? ', with FAILURES' : ''}`);
