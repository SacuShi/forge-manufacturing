'use strict';
/**
 * Single source of truth for EVE manufacturing mechanics used by True Profit,
 * the Queue Planner and the shortfall/haul calculations.
 *
 * Every number comes from CCP's own data (lib/industry-data/*.json, generated
 * from the SDE + ESI dogma by gen-industry-data.js) or a rule documented by
 * CCP/EVE University:
 *   - Material quantity is rounded once per JOB, with a floor of 1 per run:
 *       max(runs, ceil(round(base × runs × multiplier, 2)))
 *   - The multiplier is the PRODUCT of blueprint ME, structure bonus and the
 *     applicable rig bonuses (each rig's own value × its security multiplier).
 *   - A rig only affects the product families its description lists.
 *   - Job cost = EIV × (SCI × structureCostMult + facilityTax + SCC), where EIV
 *     is built from BASE (ME 0) quantities and CCP adjusted prices.
 */

const RIGS       = require('./industry-data/rigs.json');
const STRUCTURES = require('./industry-data/structures.json');
const FAMILIES   = require('./industry-data/product-families.json');
const SCIENCE    = require('./industry-data/science-time-skills.json');

const SCC_RATE = 0.04; // manufacturing/invention surcharge (4%; the 2% rate is research-only)

/** hi ≥ 0.45 (displays as 0.5+), low 0 < sec < 0.45, null ≤ 0 (incl. wormholes). Unknown → null. */
function securityClass(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return null;
  if (sec >= 0.45) return 'hi';
  if (sec > 0)     return 'low';
  return 'null';
}

function productFamily(groupId) {
  return FAMILIES[groupId] || null;
}

// Rig size each engineering complex can fit (Raitaru M, Azbel L, Sotiyo XL) and the rig slot count.
const STRUCTURE_RIG_SIZE = { 35825: 'M', 35826: 'L', 35827: 'XL' };
const MAX_RIGS = 3;

/**
 * Resolve a saved Mfg Setup (structure + rig type_ids + system security) into per-rig effective
 * stats. Pure; call once per request. Enforces what the game enforces, so stale or hand-edited
 * data can't over-credit a setup: duplicates dropped, at most 3 rigs, a rig must match the
 * structure's size, and an NPC station (no structure) takes no rigs.
 *  - invalidRigIds : ids that do not exist in the game data
 *  - ignoredRigIds : real rigs that cannot apply (wrong size for the structure, NPC station,
 *                    or beyond the 3 slots) — reported so the UI can say so
 * @param {{structureTypeId?:number|null, rigIds?:number[], systemSecurity?:number|null}} p
 */
function describeSetup({ structureTypeId, rigIds = [], systemSecurity = null }) {
  const structure = structureTypeId ? (STRUCTURES[structureTypeId] || null) : null;
  const fitSize   = structureTypeId ? (STRUCTURE_RIG_SIZE[structureTypeId] || null) : null;
  const secClass  = securityClass(systemSecurity);
  const rigs = [];
  const invalidRigIds = [];
  const ignoredRigIds = [];
  const seen = new Set();
  for (const raw of Array.isArray(rigIds) ? rigIds : []) {
    const id = Number(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const r = RIGS[id];
    if (!r) { invalidRigIds.push(id); continue; }
    if (!fitSize || r.size !== fitSize || rigs.length >= MAX_RIGS) { ignoredRigIds.push(id); continue; }
    // Unknown security: use the highsec multiplier (the smallest standard value)
    // rather than inflating the bonus; the response flags securityKnown=false.
    const secMult = r.sec[secClass || 'hi'];
    rigs.push({
      id, name: r.name, size: r.size, family: r.family,
      matPct: r.matPct, thukkerMatPct: r.thukkerMatPct || 0, timePct: r.timePct,
      matCovers: r.matCovers, thukkerCovers: r.thukkerCovers || [], timeCovers: r.timeCovers,
      secMult,
      effMatPct:     r.matPct * secMult,
      effThukkerPct: (r.thukkerMatPct || 0) * secMult,
      effTimePct:    r.timePct * secMult,
    });
  }
  return { structure, structureTypeId: structureTypeId || null, rigs, invalidRigIds, ignoredRigIds, secClass, securityKnown: secClass !== null };
}

/**
 * Modifiers that apply to one product. `setup` comes from describeSetup().
 * Each rig bonus applies only where the rig's game effects say it does (material, Thukker
 * material and time have separate coverage). Returns multipliers (1 = no change) plus which rigs
 * matched and what each contributed, for display.
 */
function modifiersForProduct(setup, groupId) {
  const family  = productFamily(groupId);
  const applied = [];
  let matMult  = setup.structure ? setup.structure.matMult  : 1;
  let timeMult = setup.structure ? setup.structure.timeMult : 1;
  if (family) {
    for (const r of setup.rigs) {
      const m  = r.matCovers.includes(family)     ? r.effMatPct     : null;
      const k  = r.thukkerCovers.includes(family) ? r.effThukkerPct : null;
      const tm = r.timeCovers.includes(family)    ? r.effTimePct    : null;
      if (m === null && k === null && tm === null) continue;
      if (m  !== null) matMult  *= 1 - m  / 100;
      if (k  !== null) matMult  *= 1 - k  / 100;
      if (tm !== null) timeMult *= 1 - tm / 100;
      applied.push({
        ...r,
        usedMatPct:  100 * (1 - (1 - (m || 0) / 100) * (1 - (k || 0) / 100)),
        usedTimePct: tm || 0,
        baseMatPct:  m !== null ? r.matPct : (k !== null ? r.thukkerMatPct : 0),
      });
    }
  }
  return {
    family, familyKnown: family !== null, appliedRigs: applied,
    matMult, timeMult,
    costMult: setup.structure ? setup.structure.costMult : 1,
  };
}

/** Blueprint ME as a multiplier (negative ME, e.g. T2 BPC −4, increases quantities). */
const blueprintMeMult = me => 1 - (Number(me) || 0) / 100;

/** Material units required for a whole job (single rounding, ≥ 1 per run). */
function jobQuantity(baseQty, runs, totalMult) {
  const r = Math.max(1, Math.floor(runs) || 1);
  return Math.max(r, Math.ceil(Math.round(baseQty * r * totalMult * 100) / 100));
}

/** [{material_id, quantity}] → [{material_id, base, qty}] for a job. */
function jobMaterials(materials, runs, totalMult) {
  return materials.map(m => ({
    material_id: m.material_id,
    base: m.quantity,
    qty: jobQuantity(m.quantity, runs, totalMult),
  }));
}

/** EIV: base (ME 0) quantities × CCP adjusted prices × runs. */
function estimatedItemValue(materials, runs, adjustedPrices) {
  const r = Math.max(1, Math.floor(runs) || 1);
  let eiv = 0;
  for (const m of materials) eiv += (adjustedPrices?.[m.material_id] || 0) * m.quantity * r;
  return eiv;
}

/** Install cost of one manufacturing job. */
function jobCost({ eiv, sci = 0, costMult = 1, facilityTaxDecimal = 0 }) {
  const system   = eiv * sci * costMult;
  const scc      = eiv * SCC_RATE;
  const facility = eiv * facilityTaxDecimal;
  return { system, scc, facility, total: system + scc + facility };
}

/**
 * Build-time multiplier from skills, blueprint TE, structure+rigs and implant.
 * `requiredSkills` = [{skill_id}] the blueprint requires for manufacturing; the
 * science skills among them each cut time by `pctPerLevel` per level (game
 * attribute manufactureTimePerLevel). Skill bonuses are applied multiplicatively,
 * like Industry/Advanced Industry.
 */
function timeMultiplier({ skillMap = {}, requiredSkills = [], blueprintTe = 0, modsTimeMult = 1, implantPct = 0 }) {
  const industry = 1 - 0.04 * (skillMap[3380] || 0);   // Industry −4%/lvl
  const advInd   = 1 - 0.03 * (skillMap[3388] || 0);   // Advanced Industry −3%/lvl
  let science = 1;
  for (const s of requiredSkills) {
    const sk = SCIENCE[s.skill_id];
    if (sk) science *= 1 - (sk.pctPerLevel * (skillMap[s.skill_id] || 0)) / 100;
  }
  const te = Math.max(0, 1 - (blueprintTe || 0) / 100);
  return te * industry * advInd * science * modsTimeMult * (1 - implantPct / 100);
}

/**
 * Reaction jobs: governed by the Reactions skill (reactionTimeBonus −4%/lvl, skill 45746)
 * and Advanced Industry (−3%/lvl). Engineering-complex structure/rig/implant bonuses and the
 * Industry skill do not apply to reactions.
 */
function reactionTimeMultiplier({ skillMap = {} }) {
  return (1 - 0.04 * (skillMap[45746] || 0)) * (1 - 0.03 * (skillMap[3388] || 0));
}

module.exports = {
  SCC_RATE, RIGS, STRUCTURES, SCIENCE,
  securityClass, productFamily, describeSetup, modifiersForProduct, STRUCTURE_RIG_SIZE, MAX_RIGS,
  blueprintMeMult, jobQuantity, jobMaterials, estimatedItemValue, jobCost, timeMultiplier,
  reactionTimeMultiplier,
};
