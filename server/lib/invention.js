'use strict';
// T2 invention costs: decryptors, the encryption skills, rig probability bonuses and the cost of one successful invention.

const HP = require('./hub-price');
const { dbAll } = require('./db');
const { getRawJitaPrices } = require('./market-cache');

// POST /api/true-cost — calculate full True Profit for an item with all fees
// Body: { product_id, me, te, runs, regionId, materialRegionId }
//
// Calculation is fully local — no external API calls during the request:
//   • Material quantities  → blueprint_materials table (already in DB)
//   • Adjusted prices      → ESI /markets/prices/ (cached 6 h, warmed on first use)
//   • System Cost Index    → ESI /industry/systems/ (cached 1 h, warmed on first use)
//   • Sell price           → regionPriceCache (populated by precompute job)
//   • Sales fees           → character skills + standings (session cache)
//
// Rig and structure bonuses live in lib/industry-math.js, driven by lib/industry-data/*.json
// (generated from the SDE + ESI dogma by gen-industry-data.js). The old hand-maintained
// RIG_ME_BONUSES table was additive, ignored system security and applied every rig to every
// product; test-industry-math.js now checks the Mfg Setup rig catalog against the game data.

// Invention probability rigs for Upwell structures.
// In EVE, invention probability is primarily skill-based. Structure rigs affect
// invention job TIME and JOB FEE, not base probability. This map exists for
// future verified rig type_ids — leave empty until confirmed from EVE SDE.
// When verified, add: typeId: bonusAsDecimal  (e.g. 0.015 = +1.5% flat bonus)
const RIG_INVENTION_PROBABILITY = {
  // Example (VERIFY before activating): 99999: 0.015,
};

// Encryption Methods skill IDs — weighted at ÷40 in the invention formula.
// Science skills (any other activity=8 skill) are weighted at ÷30.
// Formula: P = base × (1 + enc/40 + sci1/30 + sci2/30) × decryptorMult
// Source: https://wiki.eveuniversity.org/Invention
// Verified 17 Sept 2026 against live ESI (/universe/types/{id}/). Three entries
// were fabricated (same "unverified hand-typed ids" pattern as the rig-catalog
// bug): 3407 doesn't exist in the SDE at all; 3410 is actually Astrogeology
// (mining skill); 3411 is actually Cybernetics (implant skill) — neither has
// anything to do with invention. The Amarr/Caldari comments were also swapped
// on the two real entries. Removed the three fake ones, fixed the swap, and
// added the two real Encryption Methods skills this set was missing entirely
// (Triglavian and Upwell — both currently obtainable, used for Triglavian/
// Upwell-structure invention jobs).
const ENCRYPTION_SKILL_IDS = new Set([
  21790, // Caldari Encryption Methods
  23087, // Amarr Encryption Methods
  23121, // Gallente Encryption Methods
  21791, // Minmatar Encryption Methods
  3408,  // Sleeper Encryption Methods
  52308, // Triglavian Encryption Methods
  55025, // Upwell Encryption Methods
]);

// Invention decryptors: probability multiplier (%), run modifier, ME modifier, TE modifier.
// Source: https://wiki.eveuniversity.org/Invention
const DECRYPTORS = {
  none:                   { name: null,                          probMult:   0, runs: 0, me:  0, te:  0 },
  accelerant:             { name: 'Accelerant Decryptor',        probMult:  20, runs: 1, me:  2, te: 10 },
  attainment:             { name: 'Attainment Decryptor',        probMult:  80, runs: 4, me: -1, te:  4 },
  augmentation:           { name: 'Augmentation Decryptor',      probMult: -40, runs: 9, me: -2, te:  2 },
  optimized_attainment:   { name: 'Optimized Attainment Decryptor',   probMult:  90, runs: 2, me:  1, te: -2 },
  optimized_augmentation: { name: 'Optimized Augmentation Decryptor', probMult: -10, runs: 7, me:  2, te:  0 },
  parity:                 { name: 'Parity Decryptor',            probMult:  50, runs: 3, me:  1, te: -2 },
  process:                { name: 'Process Decryptor',           probMult:  10, runs: 0, me:  3, te:  6 },
  symmetry:               { name: 'Symmetry Decryptor',          probMult:   0, runs: 2, me:  1, te:  8 },
};

// type_id for each decryptor — populated at startup from the items table
const decryptorTypeIds = {};

async function calcInventionCost({
  invParent, decr, decryptor_type, skillMap, settings, targetSystemId,
  adjustedPrices, costIndices, matWarm, matEntry, runs, invention_prob_bonus,
}) {
  if (!invParent) return null;

  const invRigIds   = JSON.parse(settings?.invention_rig_ids || '[]');
  const invSystemId = settings?.invention_system_id || targetSystemId;
  // No dedicated invention-facility-tax setting exists (invention_system_id
  // is the only invention-specific location field), so reuse the same
  // facility_tax the user set for manufacturing — same fallback pattern as
  // invSystemId above. Previously this was omitted entirely (0%), understating
  // invention job cost for anyone building at a taxed player structure.
  const invFacilityTaxDecimal = (settings?.facility_tax || 0) / 100;

  // P = base × (1 + enc/40 + sci1/30 + sci2/30) × decryptorMult + rigBonus + probBonus
  // Source: https://wiki.eveuniversity.org/Invention
  const invSkills = await dbAll(
    'SELECT skill_id FROM blueprint_skills WHERE blueprint_id = ? AND activity_id = 8',
    [invParent.t1_blueprint_id]
  );
  const encSkill    = invSkills.find(s => ENCRYPTION_SKILL_IDS.has(s.skill_id));
  const sciSkills   = invSkills.filter(s => !ENCRYPTION_SKILL_IDS.has(s.skill_id));
  const encLevel    = encSkill ? (skillMap[encSkill.skill_id] || 0) : 0;
  const sciBonus    = sciSkills.reduce((sum, s) => sum + (skillMap[s.skill_id] || 0) / 30, 0);
  const encBonus    = encLevel / 40;
  const skillFactor = 1 + sciBonus + encBonus;

  const rigBonus      = invRigIds.reduce((sum, id) => sum + (RIG_INVENTION_PROBABILITY[id] || 0), 0);
  const decryptorMult = 1 + decr.probMult / 100;
  const probBonus     = (invention_prob_bonus || 0) / 100;

  const effectiveProb = Math.min(1.0,
    invParent.probability * skillFactor * decryptorMult + rigBonus + probBonus
  );
  const expectedAttempts        = 1 / effectiveProb;
  const skillLevels             = invSkills.map(s => ({ skillId: s.skill_id, level: skillMap[s.skill_id] || 0 }));
  const outputRunsWithDecryptor = (invParent.output_runs || 1) + decr.runs;

  const invMats = await dbAll(`
    SELECT im.material_id, im.quantity, i.name
      FROM invention_materials im
      LEFT JOIN items i ON i.type_id = im.material_id
     WHERE im.t1_blueprint_id = ?
  `, [invParent.t1_blueprint_id]);

  // Datacores and decryptors are bought at the source hub; anything it doesn't stock is priced at
  // Jita's live lowest sell (tagged), never at a buy order, which can't be bought from.
  const invPrices = matWarm ? HP.withJitaFallback(matEntry.prices, getRawJitaPrices()) : null;
  let dcCostPerAttempt = 0;
  const datacores = [];
  for (const m of invMats) {
    const p         = invPrices ? invPrices[m.material_id] : null;
    const unitPrice = p?.sell || p?.buy || 0;     // a bid is only a last resort when nobody sells it
    const total     = unitPrice * m.quantity;
    dcCostPerAttempt += total;
    datacores.push({ materialId: m.material_id, name: m.name || `Mat ${m.material_id}`, quantity: m.quantity, unitPrice, totalPerAttempt: total, priceScope: p?.sellScope === 'jita' ? 'jita' : (p?.sell ? 'hub' : (p?.buy ? 'buy_order' : 'none')) });
  }

  let decryptorCostPerAttempt = 0;
  const decryptorTypeId = decryptorTypeIds[decryptor_type] || null;
  if (decryptorTypeId) {
    const dp = invPrices ? invPrices[decryptorTypeId] : null;
    decryptorCostPerAttempt = dp?.sell || dp?.buy || 0;
  }

  let invEiv = 0;
  for (const m of invMats) invEiv += (adjustedPrices[m.material_id] || 0) * m.quantity;
  const invSci           = costIndices[invSystemId] || 0;
  const invJobPerAttempt = invEiv * invSci + invEiv * 0.04 + invEiv * invFacilityTaxDecimal; // system cost + SCC surcharge (4% — invention isn't ME/TE research, so the Jul 2025 research-only cut to 2% doesn't apply; see the "Job cost formula" comment above calcHaulLegs) + facility tax

  const perBpcCost = (dcCostPerAttempt + decryptorCostPerAttempt + invJobPerAttempt) * expectedAttempts;
  const amortize   = (cost) => (cost * expectedAttempts / outputRunsWithDecryptor) * runs;
  const totalInvCost       = (perBpcCost / outputRunsWithDecryptor) * runs;
  const totalDcCost        = amortize(dcCostPerAttempt);
  const totalDecryptorCost = amortize(decryptorCostPerAttempt);
  const totalInvJobCost    = amortize(invJobPerAttempt);

  return {
    total:                      totalInvCost,
    per_bpc_cost:               perBpcCost,
    effective_probability:      effectiveProb,
    base_probability:           invParent.probability,
    skill_factor:               skillFactor,
    skill_bonus:                sciBonus + encBonus,
    rig_bonus:                  rigBonus,
    prob_bonus:                 probBonus,
    expected_attempts:          expectedAttempts,
    datacores_cost:             totalDcCost,
    job_cost:                   totalInvJobCost,
    decryptor_cost:             totalDecryptorCost,
    dc_cost_per_attempt:        dcCostPerAttempt,
    decryptor_cost_per_attempt: decryptorCostPerAttempt,
    job_cost_per_attempt:       invJobPerAttempt,
    decryptor_type:             decryptor_type || 'none',
    decryptor:                  { ...decr, output_runs: outputRunsWithDecryptor },
    output_runs:                outputRunsWithDecryptor,
    datacores,
    skills:                     skillLevels,
  };
}

module.exports = { DECRYPTORS, decryptorTypeIds, calcInventionCost };
