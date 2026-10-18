'use strict';
// The Queue Planner: which blueprints to put in the character's free manufacturing slots, by profit per hour.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const HP = require('../lib/hub-price');
const IM = require('../lib/industry-math'); // shared manufacturing mechanics (rigs, ME, EIV, job cost, time)
const { dbAll, dbGet, SQL_VARIABLE_LIMIT } = require('../lib/db');
const { getCached } = require('../lib/cache');
const { HUB_STANDINGS, HUB_STRUCTURE_FEES, VALID_REGIONS } = require('../lib/hubs');
const { fetchAdjustedPrices, fetchCostIndices } = require('../lib/esi-industry-data');
const { getCharacterSession, calcSalesFeeRates, INDUSTRY_IMPLANTS } = require('../lib/character-session');
const { CORP_BP_USABLE_SQL, ensureCorpDataFresh, resolveViewerCorpAccess } = require('../lib/corp');
const market = require('../lib/market-cache');
const { getRawHubPrices, getRawJitaPrices, kickRegionWarm, blueprintMaterialsCache } = market;

const router = express.Router();

// ── Queue Planner ─────────────────────────────────────────────────────────────
//
// Given available factory slots and a planning horizon, recommends the optimal
// build queue that maximises ISK/hr across all free slots.
//
// Algorithm:
//   1. Derive free slots  = (1 + Mass Production + Advanced Mass Production) − active jobs
//   2. Score every owned buildable BP by ISK/hr (precomputed_profits baseline,
//      adjusted for the character's actual ME bonus and sales fee rates)
//   3. Greedy fill: highest ISK/hr first — one BP per slot — capped by:
//        • market liquidity  (avg_daily_volume × horizon_days → max runs)
//        • remaining budget  (deducted as each slot is assigned)
//        • planning horizon  (build_time × runs ≤ horizon)
//   4. Aggregate material shortfall across all planned builds for a single shopping trip
//
// No ESI calls at request time — everything comes from session cache + local DB.

// Manufacturing and Reaction jobs use two INDEPENDENT slot pools in EVE —
// Mass Production/Advanced Mass Production (skills 3387/24625) govern
// manufacturing slots (activity_id 1); Mass Reactions/Advanced Mass Reactions
// (skills 45748/45749) govern reaction slots (activity_id 9). A reaction job
// can never occupy a manufacturing slot or vice versa. Verified 17 Sept 2026
// against eveuniversity.org/Reactions. (This used to be one combined pool
// sized only by the manufacturing skills, with both job types counted
// against it — wrong for anyone running reactions, and wrong entirely when
// activityFilter='reactions' selects a slot count governed by the wrong
// skill pair.)
function calcMfgSlotAllocation({ multiCharMode, characters, skillMap, activeJobs }) {
  let mfgFreeSlots, reactionFreeSlots, totalMfgSlots, totalReactionSlots, charSlotPool;
  if (multiCharMode) {
    totalMfgSlots      = characters.reduce((s, c) => s + (c.mfgTotalSlots ?? c.totalSlots ?? 0), 0);
    totalReactionSlots = characters.reduce((s, c) => s + (c.reactionTotalSlots ?? 0), 0);
    mfgFreeSlots      = characters.reduce((s, c) => s + (c.mfgFreeSlots      ?? c.freeSlots ?? 0), 0);
    reactionFreeSlots = characters.reduce((s, c) => s + (c.reactionFreeSlots ?? 0), 0);
    charSlotPool  = characters;
  } else {
    const massProduction       = skillMap[3387]  || 0;
    const advMassProduction    = skillMap[24625] || 0;
    const massReactions        = skillMap[45748] || 0;
    const advMassReactions     = skillMap[45749] || 0;
    totalMfgSlots      = 1 + massProduction + advMassProduction;
    totalReactionSlots = 1 + massReactions  + advMassReactions;
    const activeMfgJobs      = activeJobs.filter(j => j.activity_id === 1);
    const activeReactionJobs = activeJobs.filter(j => j.activity_id === 9);
    mfgFreeSlots      = Math.max(0, totalMfgSlots      - Math.min(activeMfgJobs.length,      totalMfgSlots));
    reactionFreeSlots = Math.max(0, totalReactionSlots - Math.min(activeReactionJobs.length, totalReactionSlots));
    charSlotPool   = null;
  }
  const occupiedSlots = (totalMfgSlots + totalReactionSlots) - (mfgFreeSlots + reactionFreeSlots);
  return {
    totalMfgSlots: totalMfgSlots + totalReactionSlots, // display total, both pools combined
    occupiedSlots,
    freeSlots: mfgFreeSlots + reactionFreeSlots,        // display total, both pools combined
    mfgFreeSlots, reactionFreeSlots,
    charSlotPool,
  };
}

async function buildOwnedBpMap({ ownedBlueprints, includeCorpBps, characterId, eveToken }) {
  const bpByType = new Map(); // blueprint_type_id → { me, te, runs }
  for (const bp of ownedBlueprints) {
    if (!bp) continue;
    const me = bp.material_efficiency ?? 0;
    const existing = bpByType.get(bp.type_id);
    if (!existing || me > existing.me) {
      bpByType.set(bp.type_id, { me, te: bp.time_efficiency ?? 0, runs: bp.runs });
    }
  }
  // Optionally merge corp BPs (Director only — graceful skip if not a director).
  if (includeCorpBps) {
    try {
      const corpAccess = await resolveViewerCorpAccess(characterId, eveToken);
      if (corpAccess.isDirector && corpAccess.corpId) {
        await ensureCorpDataFresh(corpAccess.corpId, eveToken);
        const corpBps = await dbAll(
          `SELECT cb.type_id, cb.material_efficiency, cb.time_efficiency, cb.runs
           FROM corp_blueprints cb WHERE cb.corp_id = ? AND ${CORP_BP_USABLE_SQL}`,
          [corpAccess.corpId]
        );
        for (const bp of corpBps) {
          const me       = bp.material_efficiency ?? 0;
          const existing = bpByType.get(bp.type_id);
          if (!existing || me > existing.me) {
            bpByType.set(bp.type_id, { me, te: bp.time_efficiency ?? 0, runs: bp.runs });
          }
        }
      }
    } catch (_) { /* not a director or corp data unavailable — proceed without */ }
  }
  return bpByType;
}

async function fetchQueueCandidates({ bpTypeIds, safeRegionId, allowedActivities }) {
  const ph = bpTypeIds.map(() => '?').join(',');
  const candidates = await dbAll(
    `SELECT b.blueprint_id,
            b.product_id,
            b.product_quantity,
            b.build_time,
            COALESCE(b.activity_id, 1)  AS activity_id,
            pp.isk_per_hour,
            pp.profit                   AS profit_per_run,
            pp.material_cost            AS mat_cost_per_run,
            pp.sell_price               AS sell_per_unit,
            pp.avg_daily_volume,
            pp.liquidity_risk,
            i.name                      AS product_name,
            i.group_id                  AS product_group_id
     FROM   blueprints b
     JOIN   precomputed_profits pp
              ON  pp.blueprint_id = b.blueprint_id
              AND pp.region_id    = ?
     JOIN   items i ON i.type_id  = b.product_id
     WHERE  b.blueprint_id IN (${ph})
       AND  pp.isk_per_hour > 0
       AND  pp.profit        > 0
       AND  COALESCE(b.activity_id, 1) IN (${allowedActivities.map(() => '?').join(',')})
     ORDER  BY pp.isk_per_hour DESC`,
    [safeRegionId, ...bpTypeIds, ...allowedActivities]
  );

  // Bulk skill check — one query for all candidates, avoids N round-trips.
  const candidateBpIds = candidates.map(c => c.blueprint_id);
  const reqsByBp = new Map(); // blueprint_id → [{ skill_id, skill_level }]
  if (candidateBpIds.length > 0) {
    const phS  = candidateBpIds.slice(0, SQL_VARIABLE_LIMIT).map(() => '?').join(',');
    const reqs = await dbAll(
      `SELECT blueprint_id, skill_id, skill_level
       FROM blueprint_skills
       WHERE blueprint_id IN (${phS}) AND activity_id IN (1, 9)`,
      candidateBpIds.slice(0, SQL_VARIABLE_LIMIT)
    );
    for (const r of reqs) {
      if (!reqsByBp.has(r.blueprint_id)) reqsByBp.set(r.blueprint_id, []);
      reqsByBp.get(r.blueprint_id).push(r);
    }
  }
  return { candidates, reqsByBp };
}

function runQueuePlannerAllocation({
  candidates, reqsByBp, skillMap, bpByType, setup, implantPct,
  safeHorizon, horizonDays, totalSalesFeeRate,
  effectiveBudget, mfgFreeSlots, reactionFreeSlots, multiCharMode, characters,
  adjustedPrices, sci, facilityTaxDecimal, hubPrices, jitaPrices, hubIsJita, coldMatCost = null,
}) {
  const meetsSkills = bpId => {
    const reqs = reqsByBp.get(bpId) || [];
    return reqs.every(r => (skillMap[r.skill_id] || 0) >= r.skill_level);
  };

  // In multi-char mode, build per-character skill maps and remaining free-slot counts
  // (tracked separately per activity — manufacturing and reaction slots are independent
  // pools, see calcMfgSlotAllocation) so the loop can find the first character who BOTH
  // has a free slot in the RIGHT pool AND meets the blueprint's skill requirements.
  let charSlotPool = null, charSkillMaps, charMfgFreeSlots, charReactionFreeSlots;
  if (multiCharMode) {
    charSlotPool  = characters;
    charSkillMaps = new Map();
    charMfgFreeSlots      = new Map();
    charReactionFreeSlots = new Map();
    for (const c of characters) {
      charSkillMaps.set(c.characterId, c.skills || {});
      charMfgFreeSlots.set(c.characterId,      c.mfgFreeSlots      ?? c.freeSlots ?? 0);
      charReactionFreeSlots.set(c.characterId, c.reactionFreeSlots ?? 0);
    }
  }

  const meetsSkillsForChar = (bpId, charId) => {
    const reqs = reqsByBp.get(bpId) || [];
    const sm   = charSkillMaps ? (charSkillMaps.get(charId) || {}) : skillMap;
    return reqs.every(r => (sm[r.skill_id] || 0) >= r.skill_level);
  };

  const recommendations = [];
  let remainingBudget = effectiveBudget;
  // Single-char mode: two independent counters, checked/decremented by each
  // candidate's own activity_id (1=manufacturing, 9=reaction) — a candidate
  // of one type can never consume a slot from the other pool.
  let mfgSlotsToFill      = mfgFreeSlots;
  let reactionSlotsToFill = reactionFreeSlots;

  for (const c of candidates) {
    if (mfgSlotsToFill <= 0 && reactionSlotsToFill <= 0) break; // both pools exhausted, nothing left can be scheduled
    const isReaction   = c.activity_id === 9;
    const charFreeSlots = multiCharMode ? (isReaction ? charReactionFreeSlots : charMfgFreeSlots) : null;
    if (!multiCharMode && (isReaction ? reactionSlotsToFill : mfgSlotsToFill) <= 0) continue; // this candidate's pool is full but the other might still have room
    if (!meetsSkills(c.blueprint_id)) continue;

    const ownedBp = bpByType.get(c.blueprint_id);
    if (!ownedBp) continue;

    // Material multiplier = owned blueprint ME × structure × the saved rigs that cover THIS product
    // (each at its real, security-scaled value). Reactions run in refineries, not engineering
    // complexes, so the structure/rig set doesn't apply to them.
    const mods     = IM.modifiersForProduct(setup, c.product_group_id);
    const meFactor = isReaction ? IM.blueprintMeMult(ownedBp.me) : IM.blueprintMeMult(ownedBp.me) * mods.matMult;
    const effectiveME = (1 - meFactor) * 100;

    // Build time: skills (incl. science skills the blueprint requires), blueprint TE, structure,
    // the rigs' TE bonus and implant — or the Reactions-skill model for reaction jobs.
    const timeMult = isReaction
      ? IM.reactionTimeMultiplier({ skillMap })
      : IM.timeMultiplier({
          skillMap, requiredSkills: reqsByBp.get(c.blueprint_id) || [], blueprintTe: ownedBp.te || 0,
          modsTimeMult: mods.timeMult, implantPct,
        });
    const effectiveBuildSec = Math.max(1, (c.build_time || 3600) * timeMult);
    const buildHoursPerRun  = effectiveBuildSec / 3600;

    // How many sequential runs fit within the planning horizon for a single slot?
    const maxRunsByTime = Math.max(1, Math.floor(safeHorizon / buildHoursPerRun));

    // Liquidity cap: don't produce more units than the market trades per day×horizon.
    const dailyVol   = c.avg_daily_volume || 0;
    const productQty = c.product_quantity || 1;
    const liquidityRunCap = dailyVol > 0
      ? Math.max(1, Math.ceil((dailyVol * horizonDays) / productQty))
      : maxRunsByTime;

    // Material cost per run and EIV (for job cost) — both computed per-material
    // with the same ceiling rule /api/true-cost and calcAggregateShortfall use
    // (max(1, ceil(qty × meFactor))), not a linear scale-down of an aggregate.
    // blueprintMaterialsCache/adjustedPrices/prices are all pre-warmed
    // in-memory maps, so this costs nothing extra per candidate (no DB/ESI
    // call here). Previously matCostPerRun scaled c.mat_cost_per_run (a 0%-ME
    // aggregate) linearly by meFactor, which can diverge from the ceiling
    // rule per material — and this function charged NO job cost at all,
    // which both let the profitability filter below admit jobs that are
    // actually unprofitable once job cost is included, and made the
    // frontend's "True Profit" label for this number inaccurate.
    const candidateMats = blueprintMaterialsCache.get(c.blueprint_id) || [];
    // Buy hub still loading and no stored figure for this blueprint: it can't be priced honestly, so don't rank it on a cost of 0.
    if (!hubPrices && coldMatCost && !coldMatCost.has(c.blueprint_id)) continue;
    // Material + job cost for a job of `n` runs: single rounding per job and EIV on BASE
    // quantities (lib/industry-math.js). Candidate selection uses n = 1; once the run count is
    // chosen the totals are recomputed for that exact job size.
    const costFor = (n) => {
      let mat = 0;
      if (hubPrices) {
        // Bought like a real purchase: the buy hub's own orders (depth-aware), the remainder
        // imported from Jita. Same function /api/true-cost uses, so the two agree.
        for (const m of IM.jobMaterials(candidateMats, n, meFactor)) {
          mat += HP.priceBuy({ hubPrices, jitaPrices, typeId: m.material_id, qty: m.qty, hubIsJita,
                               history: market.historyPriceMap.get(m.material_id) || 0 }).cost;
        }
      } else {
        // Buy hub's cache is cold: THAT hub's own last precompute figure (never another hub's prices)
        mat = ((coldMatCost && coldMatCost.get(c.blueprint_id)) ?? 0) * meFactor * n;
      }
      const eiv = IM.estimatedItemValue(candidateMats, n, adjustedPrices);
      const job = IM.jobCost({
        eiv, sci: sci || 0, costMult: isReaction ? 1 : mods.costMult, facilityTaxDecimal: facilityTaxDecimal || 0,
      }).total;
      return { mat, job };
    };
    const perRun = costFor(1);
    let matCostPerRun = perRun.mat;
    const jobCostPerRun = perRun.job;
    // Fallback to the precompute aggregate (linear ME scaling) only if this
    // blueprint's materials aren't in the cache for some reason — better than
    // silently pricing it at 0.
    if (candidateMats.length === 0) matCostPerRun = (c.mat_cost_per_run || 0) * meFactor;

    // Re-derive profit per run using the character's actual sales fees.
    const totalSellValue = (c.sell_per_unit || 0) * productQty;
    const salesFees      = totalSellValue * totalSalesFeeRate;
    const profitPerRun   = totalSellValue - salesFees - matCostPerRun - jobCostPerRun;
    if (profitPerRun <= 0) continue; // character's fees + job cost make this unprofitable

    const iskPerHour = buildHoursPerRun > 0 ? profitPerRun / buildHoursPerRun : 0;

    // Budget check: skip if we can't afford even one run. Job cost is a real
    // ISK-out-of-wallet expense at job installation, same as materials, so it
    // counts against the budget cap too.
    const spendPerRun = matCostPerRun + jobCostPerRun;
    if (spendPerRun > 0 && remainingBudget < spendPerRun) continue;
    const maxRunsByBudget = spendPerRun > 0
      ? Math.floor(remainingBudget / spendPerRun)
      : maxRunsByTime;

    // BPOs have runs = -1 (unlimited); BPCs have a finite positive run count.
    const bpcRunCap       = (ownedBp.runs != null && ownedBp.runs > 0) ? ownedBp.runs : maxRunsByTime;
    const recommendedRuns = Math.max(1, Math.min(maxRunsByTime, liquidityRunCap, maxRunsByBudget, bpcRunCap));
    // Exact totals for the chosen job size (per-job rounding makes cost non-linear in runs).
    const exact           = costFor(recommendedRuns);
    const totalMatCost    = candidateMats.length ? exact.mat : matCostPerRun * recommendedRuns;
    const totalJobCost    = exact.job;
    const totalProfit     = (totalSellValue - salesFees) * recommendedRuns - totalMatCost - totalJobCost;
    const totalBuildSec   = effectiveBuildSec * recommendedRuns;

    // In multi-char mode: find the first character who has a free slot in this
    // candidate's own pool (mfg or reaction) AND meets its skill requirements
    // (per-character check, not combined).
    let assignedChar = null;
    if (charSlotPool) {
      for (const char of charSlotPool) {
        if ((charFreeSlots.get(char.characterId) || 0) <= 0) continue;
        if (meetsSkillsForChar(c.blueprint_id, char.characterId)) {
          assignedChar = char;
          break;
        }
      }
      if (!assignedChar) continue; // no character has both a free slot in this pool and the required skills
    }

    recommendations.push({
      blueprintId:            c.blueprint_id,
      productId:              c.product_id,
      productName:            c.product_name,
      productUnits:           productQty * recommendedRuns,
      activityId:             c.activity_id,
      runs:                   recommendedRuns,
      buildTimeSec:           Math.round(totalBuildSec),
      buildTimePerRunSec:     Math.round(effectiveBuildSec),
      materialCost:           totalMatCost,
      jobCost:                totalJobCost,
      estimatedProfit:        totalProfit,
      iskPerHour,
      liquidityRisk:          c.liquidity_risk || null,
      avgDailyVolume:         dailyVol,
      ownedBpME:              ownedBp.me,
      effectiveME,
      materialMultiplier:     meFactor,
      rigsApplied:            isReaction ? 0 : mods.appliedRigs.length,
      // false when the product's item group isn't in the game-data table, so no rig bonus could be applied
      rigCoverageKnown:       isReaction ? true : mods.familyKnown,
      assignedCharacterId:    assignedChar?.characterId ?? null,
      assignedCharacterName:  assignedChar?.name       ?? null,
    });

    remainingBudget -= (totalMatCost + totalJobCost);
    if (assignedChar) {
      charFreeSlots.set(assignedChar.characterId, charFreeSlots.get(assignedChar.characterId) - 1);
    }
    if (isReaction) reactionSlotsToFill--; else mfgSlotsToFill--;
  }

  return { recommendations, remainingBudget };
}

// Shortfall is priced like a real purchase: what the buy hub's own sell orders can supply, then
// the remainder imported from Jita (tagged), using order depth (lib/hub-price.js).
async function calcAggregateShortfall({ recommendations, assets, hubPrices, jitaPrices, hubIsJita }) {
  const assetMap = new Map(); // typeId → total held quantity
  for (const a of assets) {
    assetMap.set(a.type_id, (assetMap.get(a.type_id) || 0) + (a.quantity || 0));
  }

  const recBpIds = recommendations.map(r => r.blueprintId);
  let allMaterials = [];
  if (recBpIds.length > 0) {
    const phM = recBpIds.map(() => '?').join(',');
    allMaterials = await dbAll(
      `SELECT bm.blueprint_id, bm.material_id, bm.quantity AS base_qty, i.name AS material_name
       FROM blueprint_materials bm
       JOIN items i ON i.type_id = bm.material_id
       WHERE bm.blueprint_id IN (${phM})`,
      recBpIds
    );
  }

  const matTotals = new Map(); // typeId → aggregated totals
  for (const mat of allMaterials) {
    const rec = recommendations.find(r => r.blueprintId === mat.blueprint_id);
    if (!rec) continue;
    // Same per-job quantity the planner priced (rec.materialMultiplier already folds in the
    // owned blueprint ME, the structure and the rigs covering this product).
    const adjQty  = IM.jobQuantity(mat.base_qty, rec.runs, rec.materialMultiplier);

    if (!matTotals.has(mat.material_id)) {
      matTotals.set(mat.material_id, {
        typeId:   mat.material_id,
        name:     mat.material_name,
        needed:   0,
        have:     assetMap.get(mat.material_id) || 0,
      });
    }
    matTotals.get(mat.material_id).needed += adjQty;
  }

  return [...matTotals.values()]
    .map(m => {
      const shortage = Math.max(0, m.needed - m.have);
      const pb = hubPrices
        ? HP.priceBuy({ hubPrices, jitaPrices, typeId: m.typeId, qty: shortage, hubIsJita,
                        history: market.historyPriceMap.get(m.typeId) || 0 })
        : null;
      return {
        ...m,
        shortage,
        jitaSell:    pb && shortage > 0 ? pb.unit : 0,        // average unit price of the purchase (legacy field name)
        shortageISK: pb ? pb.cost : 0,
        priceScope:  pb ? pb.scope : null,                    // 'hub' | 'mixed' | 'jita' | 'history' | 'none'
        hubQty:      pb ? pb.hubQty : 0,
        importQty:   pb ? pb.jitaQty + pb.unfilledQty : 0,
        shortStock:  pb ? pb.shortStock : false,
      };
    })
    .filter(m => m.shortage > 0)
    .sort((a, b) => b.shortageISK - a.shortageISK);
}

router.post('/api/queue-planner', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const {
      regionId         = 10000002,  // sell hub — where finished goods are priced/ranked
      materialRegionId = regionId,  // buy hub — where materials would actually be purchased; defaults to regionId if the client didn't send one (old clients, or buy==sell)
      horizonHours   = 72,          // planning window; clipped to 6–168 h
      budgetCap      = null,        // null = full wallet
      includeCorpBps = false,
      activityFilter = 'all',       // 'all' | 'manufacturing' | 'reactions'
      characters     = [],          // [{characterId, name, totalSlots, freeSlots, mfgFreeSlots, reactionFreeSlots}] — multi-char mode
    } = req.body;

    const safeRegionId = VALID_REGIONS.includes(parseInt(regionId)) ? parseInt(regionId) : 10000002;
    // Was hardcoded to reuse safeRegionId (the SELL hub) for material pricing
    // too — reported by the user: the shortfall panel priced materials at
    // wherever "Sell At" was set, ignoring "Buy In" entirely. Materials are
    // bought at the buy-in hub, so price them from there.
    const safeMaterialRegionId = VALID_REGIONS.includes(parseInt(materialRegionId)) ? parseInt(materialRegionId) : safeRegionId;
    const safeHorizon  = Math.min(168, Math.max(6, parseInt(horizonHours) || 72));
    const horizonDays  = safeHorizon / 24;

    // ── Session ───────────────────────────────────────────────────────────────
    const session = getCached(`session:${characterId}`);
    if (!session) {
      return res.status(400).json({ error: 'No session data — refresh the page to reload character data.', code: 'SESSION_MISSING' });
    }
    const { skillMap, standings, implants } = getCharacterSession(characterId);
    const ownedBlueprints = session.blueprints || [];
    const assets          = session.assets     || [];
    const walletBalance   = session.wallet     || 0;
    const activeJobs      = session.jobs       || [];
    // Honour budget cap but never exceed actual wallet balance.
    const effectiveBudget = (budgetCap != null && budgetCap > 0)
      ? Math.min(Number(budgetCap), walletBalance)
      : walletBalance;

    // ── Industry settings ─────────────────────────────────────────────────────
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const rigIds             = JSON.parse(settings?.rig_ids || '[]');
    // Structure + rig bonuses come from the shared mechanics module: per-rig attributes scaled by
    // the system's security class, applied per product at allocation time (a rig only affects the
    // product families it covers), all multiplicative.
    const planSysRow = settings?.system_id
      ? await dbGet('SELECT security_status FROM sde_systems WHERE system_id = ?', [settings.system_id])
      : null;
    const setup = IM.describeSetup({
      structureTypeId: settings?.structure_type_id || null,
      rigIds,
      systemSecurity:  planSysRow ? planSysRow.security_status : null,
    });
    const facilityTaxDecimal = (settings?.facility_tax || 0) / 100;
    const targetSystemId     = settings?.system_id || 30000142; // default: Jita IV

    // ── Manufacturing slot count ──────────────────────────────────────────────
    // In multi-character mode (characters array supplied by the frontend), use the
    // per-character slot counts which the frontend computed from each character's
    // Mass Production / Advanced Mass Production skill levels.
    // In single-character mode, derive from this character's session skillMap.
    const multiCharMode = Array.isArray(characters) && characters.length > 0;
    const { mfgFreeSlots, reactionFreeSlots, charSlotPool } = calcMfgSlotAllocation({ multiCharMode, characters, skillMap, activeJobs });

    // Best manufacturing-time implant (BX series), applied to every blueprint's build time.
    const planImplant = (Array.isArray(implants) ? implants : [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'mfg_time')
      .sort((a, b) => b.pct - a.pct)[0] || null;
    const implantPct = planImplant ? planImplant.pct : 0;

    // ── Prices for material cost re-scoring and shortfall valuation ──────────
    // Follows safeMaterialRegionId (the "Buy In" hub) — materials are what get
    // purchased, so they should be priced where the user actually buys, which
    // is not necessarily the same hub fetchQueueCandidates scores/ranks
    // recommendations against (that's the "Sell At" hub, safeRegionId — finished
    // goods revenue). This used to reuse safeRegionId for both, so the
    // shortfall panel silently priced materials at wherever "Sell At" was set.
    // Falls back to Jita if the selected region's cache isn't warm yet.
    // Materials are priced from the buy hub's own orders (+ Jita for what it can't supply). A cold
    // cache is never filled with Jita's map: the hub's last precompute figures are used and the
    // response says pricesWarm:false.
    const matJitaPrices = getRawJitaPrices();
    // Jita not being loaded makes the import side unknowable, so it is "cold" too (never priced as if Jita had nothing)
    const matHubPrices  = (safeMaterialRegionId === 10000002 || matJitaPrices) ? getRawHubPrices(safeMaterialRegionId) : null;
    if (!matHubPrices) { kickRegionWarm(safeMaterialRegionId); kickRegionWarm(10000002); }
    // The buy hub's own last precompute material cost per blueprint (used only while its cache is cold)
    const coldMatCost = new Map();
    if (!matHubPrices) {
      const rowsCold = await dbAll('SELECT blueprint_id, material_cost FROM precomputed_profits WHERE region_id = ?', [safeMaterialRegionId]);
      for (const r of rowsCold) coldMatCost.set(r.blueprint_id, r.material_cost || 0);
    }

    // ── Job cost inputs (EIV × SCI + SCC + facility tax) ──────────────────────
    // Both calls are cheap, pre-warmed in-memory reads (same functions
    // /api/true-cost uses) — no per-candidate ESI/DB cost from adding this.
    const [adjustedPrices, costIndices] = await Promise.all([
      fetchAdjustedPrices(), fetchCostIndices(),
    ]);
    const sci = costIndices[targetSystemId] || 0;

    // ── Activity filter ───────────────────────────────────────────────────────
    const allowedActivities = activityFilter === 'manufacturing' ? [1]
      : activityFilter === 'reactions' ? [9]
      : [1, 9];

    // ── Owned blueprints — best ME per type (BPO/BPC merge + optional corp BPs) ──
    const eveToken = (req.headers.authorization || '').slice(7);
    const bpByType = await buildOwnedBpMap({ ownedBlueprints, includeCorpBps, characterId, eveToken });

    if (bpByType.size === 0) {
      return res.json({
        recommendations: [], aggregateMaterials: [],
        summaryProfit: 0, summaryIskPerDay: 0, totalMatSpend: 0, totalShortageISK: 0,
        walletBalance, effectiveBudget, horizonHours: safeHorizon, regionId: safeRegionId,
        message: 'No blueprints found.',
      });
    }

    const bpTypeIds = [...bpByType.keys()].slice(0, SQL_VARIABLE_LIMIT);

    // ── Fetch precomputed profit + blueprint metadata, plus bulk skill reqs ───
    // Sorted by ISK/hr descending so the greedy loop allocates best slots first.
    const { candidates, reqsByBp } = await fetchQueueCandidates({ bpTypeIds, safeRegionId, allowedActivities });

    // ── Character's personal sales fee rates at the selected hub ─────────────
    const { brokerFeeRate, transactionTaxRate } = calcSalesFeeRates(
      skillMap, standings, HUB_STANDINGS[safeRegionId], HUB_STRUCTURE_FEES[safeRegionId] ?? null
    );
    const totalSalesFeeRate = brokerFeeRate + transactionTaxRate;

    // ── Greedy slot allocation ────────────────────────────────────────────────
    const { recommendations, remainingBudget: _unusedBudget } = runQueuePlannerAllocation({
      candidates, reqsByBp, skillMap, bpByType, setup, implantPct,
      safeHorizon, horizonDays, totalSalesFeeRate,
      effectiveBudget, mfgFreeSlots, reactionFreeSlots, multiCharMode, characters,
      adjustedPrices, sci, facilityTaxDecimal,
      hubPrices: matHubPrices, jitaPrices: matJitaPrices, hubIsJita: safeMaterialRegionId === 10000002, coldMatCost,
    });

    // ── Aggregate material shortfall for one combined shopping trip ───────────
    const aggregateMaterials = await calcAggregateShortfall({
      recommendations, assets,
      hubPrices: matHubPrices, jitaPrices: matJitaPrices,
      hubIsJita: safeMaterialRegionId === 10000002,
    });

    // ── Summary ───────────────────────────────────────────────────────────────
    const summaryProfit    = recommendations.reduce((s, r) => s + r.estimatedProfit, 0);
    const summaryIskPerDay = horizonDays > 0 ? summaryProfit / horizonDays : 0;
    const totalMatSpend    = recommendations.reduce((s, r) => s + r.materialCost,    0);
    const totalJobCost     = recommendations.reduce((s, r) => s + r.jobCost,         0);
    const totalShortageISK = aggregateMaterials.reduce((s, m) => s + m.shortageISK,  0);

    res.json({
      recommendations,
      aggregateMaterials,
      summaryProfit,
      summaryIskPerDay,
      totalMatSpend,
      totalJobCost,
      totalShortageISK,
      walletBalance,
      effectiveBudget,
      horizonHours: safeHorizon,
      regionId:     safeRegionId,
      materialRegionId: safeMaterialRegionId,
      pricesWarm:   !!matHubPrices,
      // Materials the buy hub can't fully supply (the rest is priced at Jita and has to be imported).
      importMaterials: aggregateMaterials.filter(m => m.importQty > 0).length,
    });
  } catch (err) {
    logger.error('Queue planner error:', err);
    res.status(500).json({ error: 'Failed to generate queue plan' });
  }
});

module.exports = router;
