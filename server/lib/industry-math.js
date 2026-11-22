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

// CCP's SCC surcharge per activity (EVE University "Manufacturing"; CCP Jul 2025 "Exploration and Industry Balance
// Rework": ME/TE research cut from 4% to 2%). Keys match ESI /industry/systems activity names.
const SCC_RATES = {
  manufacturing: 0.04, reaction: 0.04, invention: 0.04, copying: 0.04,
  researching_material_efficiency: 0.02, researching_time_efficiency: 0.02,
};
// Fixed facility tax at NPC stations; structure owners set their own, capped at 10% (EVE University "Manufacturing").
const NPC_FACILITY_TAX = 0.0025;
const MAX_FACILITY_TAX = 0.10;
// A successfully invented T2 blueprint copy starts at ME 2 / TE 4; decryptor modifiers add to these.
const T2_BPC_BASE_ME = 2;
const T2_BPC_BASE_TE = 4;
// Alpha clones pay an extra 0.25% of EIV on every job.
const ALPHA_CLONE_TAX = 0.0025;
// Invention and copying are charged on a fraction of the product's EIV, not on their own inputs (CCP Crius
// "2% of the average value of the inputs for the thing(s) built by the blueprint(s)"; EVE Ref job_cost_base).
const SCIENCE_JOB_VALUE_FRACTION = 0.02;

/**
 * Facility tax (decimal) for a saved Mfg Setup row: CCP's fixed 0.25% at an NPC station (no structure saved,
 * including no setup at all), otherwise the owner's rate (stored as a percentage) capped at 10%.
 */
function effectiveFacilityTax(settings) {
  if (!settings?.structure_type_id) return NPC_FACILITY_TAX;
  return clampFacilityTax((Number(settings.facility_tax) || 0) / 100);
}

/** A job's activity id from either shape: raw ESI (activity_id) or the browser's ActiveJob (activityId). */
function jobActivityId(job) {
  return job?.activity_id ?? job?.activityId ?? null;
}

// ESI reports reaction jobs as activity 9; the SDE's reaction activity is 11 — both are reactions.
const isReactionActivity = (id) => id === 9 || id === 11;

/** Short label for an ESI industry activity id (7 = reverse engineering). */
function activityLabel(id) {
  return ({ 1: 'Manufacturing', 3: 'TE Research', 4: 'ME Research', 5: 'Copying', 7: 'Reverse Engineering',
    8: 'Invention', 9: 'Reaction', 11: 'Reaction' })[id] || '';
}

/** Cost index for one activity in one system, from fetchActivityCostIndices(). 0 when unknown. */
function costIndexFor(byActivity, activity, systemId) {
  return byActivity?.[activity]?.[systemId] || 0;
}

/** A facility tax as a decimal, clamped to CCP's range (0 to 10%). */
function clampFacilityTax(decimal) {
  const d = Number(decimal);
  return Number.isFinite(d) ? Math.min(Math.max(d, 0), MAX_FACILITY_TAX) : 0;
}

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

/**
 * Install cost of one industry job (CCP): base × (SCI × structure cost bonus + facility tax + SCC + alpha tax).
 * `eiv` is the job's base value: the EIV for manufacturing/reactions, 2% of the product EIV for invention/copying
 * (see scienceJobBase). `activity` picks the SCC rate (default manufacturing).
 */
function jobCost({ eiv, sci = 0, costMult = 1, facilityTaxDecimal = 0, activity = 'manufacturing', alpha = false }) {
  const system   = eiv * sci * costMult;
  const scc      = eiv * (SCC_RATES[activity] ?? SCC_RATE);
  const facility = eiv * clampFacilityTax(facilityTaxDecimal);
  const alphaTax = alpha ? eiv * ALPHA_CLONE_TAX : 0;
  return { system, scc, facility, alpha: alphaTax, total: system + scc + facility + alphaTax };
}

/** Job base for invention/copying: 2% of the EIV of what the blueprint builds. */
function scienceJobBase(productEiv) {
  return (Number(productEiv) || 0) * SCIENCE_JOB_VALUE_FRACTION;
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
 * Reaction jobs: only the Reactions skill (45746, reactionTimeBonus −4%/lvl) and the refinery's own time bonus
 * apply. Advanced Industry does NOT (CCP dogma: skill 3388 modifies manufacturing, copying, invention and ME/TE
 * research times — not reactionTimeMultiplier 2662). Engineering-complex bonuses, Industry and implants don't apply.
 * `refineryTimeMult` = structure (Tatara 0.75, Athanor 1) × reactor time rigs, from refinery setups when known.
 */
function reactionTimeMultiplier({ skillMap = {}, refineryTimeMult = 1 }) {
  return (1 - 0.04 * (skillMap[45746] || 0)) * refineryTimeMult;
}

module.exports = {
  SCC_RATE, SCC_RATES, NPC_FACILITY_TAX, T2_BPC_BASE_ME, T2_BPC_BASE_TE, MAX_FACILITY_TAX, ALPHA_CLONE_TAX, SCIENCE_JOB_VALUE_FRACTION,
  RIGS, STRUCTURES, SCIENCE,
  securityClass, productFamily, describeSetup, modifiersForProduct, STRUCTURE_RIG_SIZE, MAX_RIGS,
  blueprintMeMult, jobQuantity, jobMaterials, estimatedItemValue, jobCost, scienceJobBase, timeMultiplier,
  reactionTimeMultiplier, costIndexFor, clampFacilityTax, effectiveFacilityTax, jobActivityId, isReactionActivity, activityLabel,
};
