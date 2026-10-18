#!/usr/bin/env node
/**
 * Generates the static industry lookup tables used by lib/industry-math.js.
 *
 *   node lib/industry-data/gen-industry-data.js <sde-dir>
 *
 * <sde-dir> is the extracted EVE Ref reference-data archive (the same one
 * sde-import.js downloads: types.json, groups.json, categories.json,
 * blueprints.json). Attribute values come from ESI's public dogma endpoints,
 * which is where CCP publishes them, so nothing here is hand-typed.
 *
 * Writes next to this file: rigs.json, structures.json, product-families.json,
 * science-time-skills.json. Re-run after a CCP industry rebalance.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const SDE_DIR = process.argv[2];
if (!SDE_DIR) { console.error('usage: node gen-industry-data.js <sde-dir>'); process.exit(1); }
const OUT = __dirname;
const readSde = f => JSON.parse(fs.readFileSync(path.join(SDE_DIR, f), 'utf8'));
const nm = o => o?.name?.en || o?.name || '';

const ESI = 'https://esi.evetech.net/latest';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function esi(p) {
  const r = await fetch(`${ESI}${p}?datasource=tranquility`, { headers: { 'User-Agent': 'FORGE-industry-data-gen' } });
  if (!r.ok) throw new Error(`ESI ${p} -> ${r.status}`);
  await sleep(60);
  return r.json();
}

// Attribute ids, verified against ESI /dogma/attributes (names in comments).
const A = {
  TIME_BONUS: 2593,   // attributeEngRigTimeBonus
  MAT_BONUS:  2594,   // attributeEngRigMatBonus
  COST_BONUS: 2595,   // attributeEngRigCostBonus
  SEC_HI:     2355,   // hiSecModifier
  SEC_LOW:    2356,   // lowSecModifier
  SEC_NULL:   2357,   // nullSecModifier
  STR_MAT:    2600,   // strEngMatBonus
  STR_COST:   2601,   // strEngCostBonus
  STR_TIME:   2602,   // strEngTimeBonus
};

// Which product families each rig EFFECT modifies. The effect names are CCP's own (ESI
// /dogma/effects): each one writes the rig's bonus into a category-specific attribute on the
// structure. Coverage is derived from the effects a rig actually carries, so it cannot disagree
// with the game (e.g. the XL "Equipment and Consumable" rigs carry BOTH an equipment and an ammo
// effect). A rig effect not listed here makes the generator stop — a CCP change must be reviewed.
const EFFECT_FAMILIES = {
  rigEquipmentManufactureMaterialBonus: ['equipment'],      rigEquipmentManufactureTimeBonus: ['equipment'],
  rigAmmoManufactureMaterialBonus: ['ammo'],                rigAmmoManufactureTimeBonus: ['ammo'],
  rigDroneManufactureMaterialBonus: ['drone_fighter'],      rigDroneManufactureTimeBonus: ['drone_fighter'],
  rigSmallshipManufactureMaterialBonus: ['basic_small_ship'],   rigSmallshipManufactureTimeBonus: ['basic_small_ship'],
  rigMediumshipManufactureMaterialBonus: ['basic_medium_ship'], rigMediumshipsManufactureTimeBonus: ['basic_medium_ship'],
  rigLargeshipManufactureMaterialBonus: ['basic_large_ship'],   rigLargeshipManufactureTimeBonus: ['basic_large_ship'],
  rigAdvSmshipManufactureMaterialBonus: ['adv_small_ship'],     rigAdvSmshipManufactureTimeBonus: ['adv_small_ship'],
  rigAdvMedShipManufactureMaterialBonus: ['adv_medium_ship'],   rigAdvMedShipManufactureTimeBonus: ['adv_medium_ship'],
  rigAdvLarShipManufactureMaterialBonus: ['adv_large_ship'],    rigAdvLarShipManufactureTimeBonus: ['adv_large_ship'],
  rigCapShipManufactureMaterialBonus: ['capital_ship'],         rigCapShipManufactureTimeBonus: ['capital_ship'],
  rigAllShipManufactureMaterialBonus: ['basic_small_ship', 'adv_small_ship', 'basic_medium_ship', 'adv_medium_ship', 'basic_large_ship', 'adv_large_ship', 'capital_ship'],
  rigAllShipManufactureTimeBonus: ['basic_small_ship', 'adv_small_ship', 'basic_medium_ship', 'adv_medium_ship', 'basic_large_ship', 'adv_large_ship', 'capital_ship'],
  rigAdvComponentManufactureMaterialBonus: ['adv_component'],   rigAdvComponentManufactureTimeBonus: ['adv_component'],
  rigAdvCapComponentManufactureMaterialBonus: ['adv_cap_component'], rigAdvCapComponentManufactureTimeBonus: ['adv_cap_component'],
  rigBasCapCompManufactureMaterialBonus: ['cap_component'],     rigBasCapCompManufactureTimeBonus: ['cap_component'],
  rigStructureManufactureMaterialBonus: ['structure'],          rigStructureManufactureTimeBonus: ['structure'],
  // Thukker rigs: a second, separate material bonus (attribute 2653) on capital components.
  rigThukkerBasCapCompManufactureMaterialBonus: ['cap_component'],
  rigThukkerAdvCapCompManufactureMaterialBonus: ['adv_cap_component'],
};
// Effects that are not production bonuses (present on every rig).
const IGNORED_EFFECTS = new Set(['rigSlot', 'structureEngineeringRigSecurityModification']);

// Product group NAME (or whole category name) -> product family.
const SHIP_GROUPS = {
  basic_small_ship:  ['Frigate', 'Shuttle', 'Destroyer', 'Corvette'],
  adv_small_ship:    ['Assault Frigate', 'Covert Ops', 'Interceptor', 'Stealth Bomber', 'Electronic Attack Ship', 'Expedition Frigate', 'Logistics Frigate', 'Interdictor', 'Tactical Destroyer', 'Command Destroyer'],
  basic_medium_ship: ['Cruiser', 'Combat Battlecruiser', 'Attack Battlecruiser', 'Hauler', 'Mining Barge'],
  adv_medium_ship:   ['Heavy Assault Cruiser', 'Command Ship', 'Exhumer', 'Force Recon Ship', 'Combat Recon Ship', 'Logistics', 'Heavy Interdiction Cruiser', 'Strategic Cruiser', 'Deep Space Transport', 'Blockade Runner'],
  basic_large_ship:  ['Battleship', 'Freighter', 'Industrial Command Ship'],
  adv_large_ship:    ['Marauder', 'Black Ops', 'Jump Freighter'],
  capital_ship:      ['Dreadnought', 'Carrier', 'Titan', 'Supercarrier', 'Capital Industrial Ship', 'Force Auxiliary', 'Lancer Dreadnought', 'Command Carrier'],
};
// Ship groups deliberately left out (no rig family is documented to cover them).
const SHIP_UNCLASSIFIED_OK = new Set(['Capsule', 'Prototype Exploration Ship', 'Special Edition Yachts', 'Flag Cruiser', 'Expedition Command Ship']);
const OTHER_GROUPS = {
  adv_component:     ['Construction Components', 'Tool', 'Data Interfaces', 'Hybrid Tech Components'],
  adv_cap_component: ['Advanced Capital Construction Components'],
  cap_component: ['Capital Construction Components'],
  structure:     ['Structure Components', 'Fuel Block'],
  equipment:     ['Cargo Container', 'Secure Cargo Container', 'Audit Log Secure Container', 'Freight Container'],
};
const CATEGORY_FAMILY = {
  Module: 'equipment', Implant: 'equipment', Deployable: 'equipment',
  Charge: 'ammo', Drone: 'drone_fighter', Fighter: 'drone_fighter',
  Structure: 'structure', 'Structure Module': 'structure', Starbase: 'structure',
  Subsystem: 'adv_medium_ship',
};
// Booster is an Implant-category group that the equipment rig description does not list.
const EXCLUDE_GROUPS = new Set(['Booster']);

(async () => {
  const T = readSde('types.json'), G = readSde('groups.json'), C = readSde('categories.json'), B = readSde('blueprints.json');
  const catName = id => nm(C[id]);

  // ── product-families.json ────────────────────────────────────────────────
  const groups = Object.entries(G).filter(([, g]) => g.published !== false)
    .map(([id, g]) => ({ id: +id, name: nm(g), cat: catName(g.category_id) }));
  const byName = n => groups.filter(g => g.name === n);
  const fam = {};
  const assign = (g, f) => {
    if (fam[g.id] && fam[g.id] !== f) throw new Error(`group ${g.id} ${g.name} assigned to both ${fam[g.id]} and ${f}`);
    fam[g.id] = f;
  };
  for (const [f, names] of Object.entries(SHIP_GROUPS)) {
    for (const n of names) {
      const hit = byName(n).filter(g => g.cat === 'Ship');
      if (hit.length === 0) throw new Error(`ship group "${n}" not found in SDE (renamed?)`);
      hit.forEach(g => assign(g, f));
    }
  }
  for (const [f, names] of Object.entries(OTHER_GROUPS)) {
    for (const n of names) {
      const hit = byName(n);
      if (hit.length === 0) throw new Error(`group "${n}" not found in SDE (renamed?)`);
      hit.forEach(g => assign(g, f));
    }
  }
  for (const g of groups) {
    if (fam[g.id] || EXCLUDE_GROUPS.has(g.name)) continue;
    const f = CATEGORY_FAMILY[g.cat];
    if (f) assign(g, f);
  }
  const unclassifiedShips = groups.filter(g => g.cat === 'Ship' && !fam[g.id] && !SHIP_UNCLASSIFIED_OK.has(g.name));
  if (unclassifiedShips.length) {
    throw new Error('unclassified ship groups (add to SHIP_GROUPS or SHIP_UNCLASSIFIED_OK): ' + unclassifiedShips.map(g => `${g.id}:${g.name}`).join(', '));
  }

  // ── rigs.json ────────────────────────────────────────────────────────────
  const rigTypes = Object.entries(T).filter(([, t]) => {
    const n = nm(t);
    return /^Standup (M|L|XL)-Set /.test(n) && /Manufacturing/.test(n) && !/Reaction|Blueprint/.test(n);
  });
  const rigs = {};
  const effectCache = {};
  const effect = async eid => effectCache[eid] || (effectCache[eid] = await esi(`/dogma/effects/${eid}/`));
  const ATTR_THUKKER_MAT = 2653;   // attributeThukkerEngRigMatBonus
  for (const [id, t] of rigTypes) {
    const gm = nm(G[t.group_id]).match(/^Structure Engineering Rig (M|L|XL) - (.+)$/);
    if (!gm) throw new Error(`rig ${id} group name not parseable: ${nm(G[t.group_id])}`);
    const family = gm[2].replace(/ (Material Efficiency|Time Efficiency|Efficiency|ME|TE)$/, '');
    const ty = await esi(`/universe/types/${id}/`);
    const at = {}; (ty.dogma_attributes || []).forEach(a => { at[a.attribute_id] = a.value; });

    // Coverage straight from the rig's effects: which structure attribute each effect writes, from
    // which of the rig's own bonus attributes (standard material 2594, Thukker material 2653, time 2593).
    const matCovers = new Set(), thukkerCovers = new Set(), timeCovers = new Set();
    for (const e of ty.dogma_effects || []) {
      const d = await effect(e.effect_id);
      if (IGNORED_EFFECTS.has(d.name)) continue;
      const fams = EFFECT_FAMILIES[d.name];
      if (!fams) throw new Error(`rig ${id} (${nm(t)}) has an unknown production effect "${d.name}" — review EFFECT_FAMILIES`);
      const src = (d.modifiers || []).map(m => m.modifying_attribute_id);
      const target = src.includes(A.TIME_BONUS) ? timeCovers : src.includes(ATTR_THUKKER_MAT) ? thukkerCovers : src.includes(A.MAT_BONUS) ? matCovers : null;
      if (!target) throw new Error(`rig ${id} effect "${d.name}" modifies from an unrecognised attribute ${JSON.stringify(src)}`);
      fams.forEach(x => target.add(x));
    }
    const rig = {
      name: nm(t), size: gm[1], family,
      matPct:        -(at[A.MAT_BONUS]  || 0),
      thukkerMatPct: -(at[ATTR_THUKKER_MAT] || 0),
      timePct:       -(at[A.TIME_BONUS] || 0),
      costPct:       -(at[A.COST_BONUS] || 0),
      matCovers: [...matCovers].sort(), thukkerCovers: [...thukkerCovers].sort(), timeCovers: [...timeCovers].sort(),
      sec: { hi: at[A.SEC_HI] ?? 1, low: at[A.SEC_LOW] ?? 1, null: at[A.SEC_NULL] ?? 1 },
    };
    // Every bonus must have somewhere to apply, and every rig must do something.
    if (rig.matPct > 0 && !rig.matCovers.length) throw new Error(`rig ${id}: material bonus but no covered family`);
    if (rig.thukkerMatPct > 0 && !rig.thukkerCovers.length) throw new Error(`rig ${id}: Thukker bonus but no covered family`);
    if (rig.timePct > 0 && !rig.timeCovers.length) throw new Error(`rig ${id}: time bonus but no covered family`);
    if (!(rig.matPct > 0 || rig.thukkerMatPct > 0 || rig.timePct > 0)) throw new Error(`rig ${id} (${rig.name}) has no bonus values — attribute read failed?`);
    rigs[id] = rig;
  }

  // ── structures.json ──────────────────────────────────────────────────────
  const structures = {};
  for (const id of [35825, 35826, 35827]) {
    const ty = await esi(`/universe/types/${id}/`);
    const at = {}; (ty.dogma_attributes || []).forEach(a => { at[a.attribute_id] = a.value; });
    structures[id] = { name: ty.name, matMult: at[A.STR_MAT], costMult: at[A.STR_COST], timeMult: at[A.STR_TIME] };
    for (const k of ['matMult', 'costMult', 'timeMult']) {
      if (typeof structures[id][k] !== 'number') throw new Error(`structure ${id} missing ${k}`);
    }
  }

  // ── science-time-skills.json ─────────────────────────────────────────────
  const skillIds = new Set();
  for (const bp of Object.values(B)) {
    Object.keys(bp.activities?.manufacturing?.required_skills || {}).forEach(s => skillIds.add(+s));
  }
  // Find the attribute id of manufactureTimePerLevel from a skill known to carry it.
  const probe = await esi('/universe/types/11452/'); // Mechanical Engineering
  let perLevelAttr = null;
  for (const a of probe.dogma_attributes || []) {
    const d = await esi(`/dogma/attributes/${a.attribute_id}/`);
    if (d.name === 'manufactureTimePerLevel') { perLevelAttr = a.attribute_id; break; }
  }
  if (perLevelAttr === null) throw new Error('could not locate manufactureTimePerLevel attribute');
  const science = {};
  for (const sid of [...skillIds].sort((a, b) => a - b)) {
    const ty = await esi(`/universe/types/${sid}/`);
    const a = (ty.dogma_attributes || []).find(x => x.attribute_id === perLevelAttr);
    if (a && a.value) science[sid] = { name: ty.name, pctPerLevel: -a.value };
  }

  const w = (f, o) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(o, null, 1) + '\n');
  w('rigs.json', rigs);
  w('structures.json', structures);
  w('product-families.json', fam);
  w('science-time-skills.json', science);
  console.log(`rigs ${Object.keys(rigs).length}, structures ${Object.keys(structures).length}, product groups ${Object.keys(fam).length}, science time skills ${Object.keys(science).length} (attr ${perLevelAttr})`);
})().catch(e => { console.error('GENERATOR FAILED:', e.message); process.exit(1); });
