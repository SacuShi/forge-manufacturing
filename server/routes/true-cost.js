'use strict';
// True Profit: the full cost of building a product (materials at the chosen hub, job fees, invention, hauling, sales tax)
// against what it sells for there.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const HP = require('../lib/hub-price');
const IM = require('../lib/industry-math'); // shared manufacturing mechanics (rigs, ME, EIV, job cost, time)
const { dbAll, dbGet } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { HUB_STANDINGS, HUB_STRUCTURE_FEES, VALID_REGIONS } = require('../lib/hubs');
const { fetchAdjustedPrices, fetchCostIndices } = require('../lib/esi-industry-data');
const { getCharacterSession, calcSalesFeeRates, INDUSTRY_IMPLANTS } = require('../lib/character-session');
const { HAUL_PROVIDERS, calcHaulLegs } = require('../lib/haul');
const { DECRYPTORS, calcInventionCost } = require('../lib/invention');
const market = require('../lib/market-cache');
const {
  regionPriceCache, setRegionPriceCache, getHubPrices, getRawHubPrices, getRawJitaPrices, fetchRegionPrices, kickRegionWarm, regionWarmingSet,
  blueprintMaterialsCache,
} = market;

const router = express.Router();

router.post('/api/true-cost', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const {
      product_id,
      me: meRaw      = 0,
      te: teRaw      = 0,
      runs: runsRaw  = 1,
      regionId       = 10000002,  // sell hub (backward-compat param name)
      materialRegionId = regionId, // source hub — where materials are purchased
      // v1.17.1 — implant set to apply to the ISK/hr calc. DEFAULT = none.
      // The client passes the type_ids of the clone/implant set the user explicitly
      // selected; otherwise True Profit reflects NO implants (honest default).
      implants: selectedImplants = [],
      // v1.35.0 — invention decryptor + manual probability bonus
      decryptor_type        = 'none',
      invention_prob_bonus  = 0,   // flat percentage-point bonus (e.g. 5 = +5 pp)
    } = req.body;

    // Numeric inputs are clamped once, here, so materials, EIV, job cost, revenue and build time all
    // use the SAME job size (a fractional/zero/negative `runs` used to scale only some of them).
    const runs = Math.min(1_000_000, Math.max(1, Math.floor(Number(runsRaw)) || 1));
    const me   = Math.max(-100, Math.min(100, Number(meRaw) || 0));
    const te   = Math.max(-100, Math.min(100, Number(teRaw) || 0));

    // Validate both hub IDs against the known whitelist
    const sellRegionId = VALID_REGIONS.includes(parseInt(regionId))
      ? parseInt(regionId) : 10000002;
    const matRegionId  = VALID_REGIONS.includes(parseInt(materialRegionId))
      ? parseInt(materialRegionId) : sellRegionId;
    const characterId = req.characterId;

    if (!product_id) return res.status(400).json({ error: 'product_id required' });

    // ── Session: skills + standings ────────────────────────────────────────
    const { skillMap, standings, skillsSource, skillsUpdatedAt } = getCharacterSession(characterId);
    // Implant set is whatever the client explicitly selected (default none).
    const implants = Array.isArray(selectedImplants) ? selectedImplants : [];

    // ── Industry settings (system, structure, rigs, facility tax) ──────────
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const rigIds            = JSON.parse(settings?.rig_ids || '[]');
    const facilityTaxDecimal = (settings?.facility_tax || 0) / 100;
    const targetSystemId     = settings?.system_id || 30000142; // default: Jita IV

    // ── Blueprint materials from DB ────────────────────────────────────────
    const blueprint = await dbGet(
      'SELECT blueprint_id, product_quantity, build_time, COALESCE(activity_id, 1) AS activity_id FROM blueprints WHERE product_id = ?',
      [product_id]
    );
    if (!blueprint) {
      return res.status(404).json({ error: `No blueprint found for product ${product_id}` });
    }
    // Reaction formulas (activity 9) run in refineries, not engineering complexes: the structure's
    // material/cost/time bonuses and the Industry skill don't apply (same rule as the Queue Planner).
    const isReaction = blueprint.activity_id === 9;
    const materials = blueprintMaterialsCache.get(blueprint.blueprint_id) || [];

    // ── T2 check (early — needed to select correct ME/TE base before EIV calc) ──
    // Invented T2 BPCs always start at ME -4, TE -4 in EVE regardless of T1 BPO research.
    // The decryptor modifies these values; the client-sent me/te from BPO research is irrelevant.
    const invParent = await dbGet(
      'SELECT t1_blueprint_id, probability, output_runs FROM blueprint_invention WHERE t2_blueprint_id = ?',
      [blueprint.blueprint_id]
    );
    const decr = DECRYPTORS[decryptor_type] || DECRYPTORS.none;
    const T2_BPC_BASE_ME = -4;
    const T2_BPC_BASE_TE = -4;
    const baseME = invParent ? T2_BPC_BASE_ME + decr.me : me;
    const baseTE = invParent ? T2_BPC_BASE_TE + decr.te : te;

    // ── Build modifiers: blueprint ME × structure × the rigs that cover THIS product ──
    // Shared mechanics in lib/industry-math.js (values from CCP's dogma data). Each rig's bonus is
    // its own attribute × the system-security multiplier, applies only to the product families
    // its description lists, and every factor multiplies (no additive summing).
    const productRow = await dbGet('SELECT group_id FROM items WHERE type_id = ?', [product_id]);
    const sysRow     = settings?.system_id
      ? await dbGet('SELECT security_status FROM sde_systems WHERE system_id = ?', [settings.system_id])
      : null;
    const setup      = IM.describeSetup({
      structureTypeId: settings?.structure_type_id || null,
      rigIds,
      systemSecurity:  sysRow ? sysRow.security_status : null,
    });
    const mods       = isReaction
      ? { family: null, familyKnown: true, appliedRigs: [], matMult: 1, timeMult: 1, costMult: 1 }
      : IM.modifiersForProduct(setup, productRow?.group_id);
    const bpMeMult   = IM.blueprintMeMult(baseME);
    const meFactor   = bpMeMult * mods.matMult;          // total material multiplier for this job
    const effectiveME = (1 - meFactor) * 100;            // combined % reduction (display)
    const structureMeBonus = (setup.structure && !isReaction) ? (1 - setup.structure.matMult) * 100 : 0;
    const rigMeBonus = mods.appliedRigs.reduce((sum, r) => sum + r.usedMatPct, 0);

    // ── Adjusted prices + cost indices (ESI, cached) ──────────────────────
    // These calls return instantly when cache is warm; first call ~2–5 s each.
    const [adjustedPrices, costIndices] = await Promise.race([
      Promise.all([fetchAdjustedPrices(), fetchCostIndices()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ESI price fetch timeout')), 60000)),
    ]);

    // ── EIV: CCP's job-fee base is the BASE (ME 0) quantity × adjusted price, not the
    // ME-reduced quantity (EVE University "Manufacturing" → Total job cost).
    const eiv = IM.estimatedItemValue(materials, runs, adjustedPrices);

    // ── Manufacturing job cost = EIV × (SCI × structure cost bonus + facility tax + SCC) ──
    const sci            = costIndices[targetSystemId] || 0;
    const jc             = IM.jobCost({ eiv, sci, costMult: mods.costMult, facilityTaxDecimal });
    const systemJobCost  = jc.system;
    const sccSurcharge   = jc.scc;
    const facilityTaxCost = jc.facility;
    const totalJobCost   = jc.total;

    // ── Prices: LIVE, and the SAME live source the materials/shortfall list uses ──
    // v1.19.2 — the per-item panel is the decision moment, so it uses CURRENT market
    // prices (regionPriceCache, sell-sourced) for both material cost and sell price —
    // identical to the materials list and the "to buy" shortfall, so the whole panel
    // agrees with itself and reflects the market right now.
    //   • Source hub (matRegionId)  — where the player buys raw materials
    //   • Sell hub   (sellRegionId) — where the finished goods are listed
    // The Market Opportunities table / AI deliberately use the (6-hourly) precompute
    // "Est." baseline for cross-item ranking — that's a labelled estimate, not this.
    // When a region cache is cold (e.g. just after a restart) we temporarily fall back
    // to the precompute row, flag prices_warm=false, and warm in the background; the
    // client silently retries so the figure upgrades to live within ~15s.
    const matEntry  = regionPriceCache.get(matRegionId);
    const sellEntry = regionPriceCache.get(sellRegionId);
    const matWarm   = !!(matEntry  && Date.now() < matEntry.expiry);
    const sellWarm  = !!(sellEntry && Date.now() < sellEntry.expiry);
    const pricesWarm = matWarm && sellWarm;

    // Material cost — live source-hub (station-first) sell prices × the job's real material
    // quantities (single rounding per job, ≥ 1 per run).
    let totalMaterialCost = 0;
    // How each material was priced: from the hub's own sell orders, imported from Jita for
    // whatever the hub can't supply, or short on both. Drives the notices and the Jita haul leg.
    const materialSourcing = [];
    const rawHubPrices  = matWarm ? getRawHubPrices(matRegionId) : null;
    const rawJitaPrices = getRawJitaPrices();
    if (!rawJitaPrices && matRegionId !== 10000002) kickRegionWarm(10000002);   // imports can't be priced until Jita is loaded
    if (matWarm) {
      for (const m of IM.jobMaterials(materials, runs, meFactor)) {
        const pb = HP.priceBuy({
          hubPrices: rawHubPrices, jitaPrices: rawJitaPrices,
          typeId: m.material_id, qty: m.qty, hubIsJita: matRegionId === 10000002,
          history: market.historyPriceMap.get(m.material_id) || 0,   // last resort only; tagged scope 'history'
        });
        totalMaterialCost += pb.cost;
        materialSourcing.push({
          material_id: m.material_id, qty: m.qty, scope: pb.scope,
          hub_qty: pb.hubQty, jita_qty: pb.jitaQty, unfilled_qty: pb.unfilledQty,
          unit_cost: pb.unit, cost: pb.cost, hub_cost: pb.hubCost, import_cost: pb.jitaCost + pb.unfilledCost,
          approx: pb.approx, short_stock: pb.shortStock,
        });
      }
    } else {
      // Cold — temporary precompute fallback (ME-scaled) + background warm.
      const precompMat = await dbGet(
        'SELECT material_cost FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, matRegionId]
      );
      totalMaterialCost = (precompMat?.material_cost || 0) * meFactor * runs;
      if (!regionWarmingSet.has(matRegionId)) {
        regionWarmingSet.add(matRegionId);
        fetchRegionPrices(matRegionId)
          .then(prices => setRegionPriceCache(matRegionId, prices))
          .catch(() => {})
          .finally(() => regionWarmingSet.delete(matRegionId));
      }
    }

    // Sell price — live sell-hub price, precompute fallback when cold.
    let unitSell = 0;
    // 'hub'/'region' = the sell hub's own lowest sell; 'jita' = the hub has none listed, so the
    // estimate is Jita's lowest sell (and the sale is assumed to happen at Jita); null = unknown.
    let sellScope = null;
    let sellOrdersSeen = null;      // units listed at the sell hub (thin-book notice)
    let sellHubBuy = 0;             // that hub's highest buy order
    if (sellWarm) {
      const sp = getHubPrices(sellRegionId)?.[product_id];
      unitSell  = sp?.sell || 0;
      sellScope = sp ? (sp.sellScope || null) : null;
      sellHubBuy = getRawHubPrices(sellRegionId)?.[product_id]?.buy || 0;
      const sd = HP.depthFor(getRawHubPrices(sellRegionId), product_id);
      sellOrdersSeen = sd && Number.isFinite(sd.total) ? sd.total : null;
    } else {
      const precompSell = await dbGet(
        'SELECT sell_price FROM precomputed_profits WHERE product_id = ? AND region_id = ?',
        [product_id, sellRegionId]
      );
      unitSell = precompSell?.sell_price || 0;
      if (!regionWarmingSet.has(sellRegionId)) {
        regionWarmingSet.add(sellRegionId);
        fetchRegionPrices(sellRegionId)
          .then(prices => setRegionPriceCache(sellRegionId, prices))
          .catch(() => {})
          .finally(() => regionWarmingSet.delete(sellRegionId));
      }
    }

    const productUnits = (blueprint.product_quantity || 1) * runs;
    const sellPrice    = unitSell * productUnits;

    // ── Sales fees (broker fee + transaction tax) ─────────────────────────
    // Standings are looked up by sell hub — that is where the order is placed. If the sell hub
    // has none listed and the price is Jita's, the sale (and its fees and freight) is at Jita.
    const sellFromJita = sellScope === 'jita';
    const feeRegionId  = sellFromJita ? 10000002 : sellRegionId;
    const {
      brokerFeeRate, transactionTaxRate,
      brokerRelations, accounting, factionStanding, corpStanding,
    } = calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[feeRegionId], HUB_STRUCTURE_FEES[feeRegionId] ?? null);

    const brokerFee      = sellPrice * brokerFeeRate;
    const transactionTax = sellPrice * transactionTaxRate;
    const totalSalesTax  = brokerFee + transactionTax;

    // ── Haulage (Box 5) — Phase 2 ─────────────────────────────────────────
    // Supports user_defined (ISK/m³, ISK/jump, flat), red_frog, black_frog,
    // pushx, and self_haul methods.
    // Requires packaged_volume in items table (populated by sde-import.js).
    // Silently returns 0 when volumes or rates are absent — no breaking change.
    const haulEnabled = !!(settings?.haul_enabled);
    const { leg1Cost, leg2Cost, leg1VolM3, leg2VolM3, leg1EffM3, leg2EffM3,
            leg1Contracts, leg2Contracts, leg1Jumps, leg2Jumps,
            legJCost, legJVolM3, legJJumps, legJRouteKnown, leg1RouteKnown, leg2RouteKnown } =
      await calcHaulLegs({ haulEnabled, settings, matRegionId, sellRegionId: feeRegionId, materials, meFactor, blueprint, product_id, runs,
                           materialSourcing: matWarm ? materialSourcing : null });
    const totalHaulCost = leg1Cost + leg2Cost + legJCost;
    const leg1Method = settings?.leg1_method || 'user_defined';
    const leg2Method = settings?.leg2_method || 'user_defined';

    // ── Invention overhead (T2 items only) ────────────────────────────────
    const inventionCostData = await calcInventionCost({
      invParent, decr, decryptor_type, skillMap, settings, targetSystemId,
      adjustedPrices, costIndices, matWarm, matEntry, runs, invention_prob_bonus,
    });
    const inventionTotal = inventionCostData?.total || 0;

    // ── True profit ────────────────────────────────────────────────────────
    const trueProfit = sellPrice - brokerFee - transactionTax - totalMaterialCost - totalJobCost - totalHaulCost - inventionTotal;
    const trueMargin = sellPrice > 0 ? (trueProfit / sellPrice) * 100 : 0;

    // ── Effective build time + ISK/hr (v1.17.0) ───────────────────────────
    // Manufacturing time stacks multiplicatively: TE × Industry × Advanced
    // Industry × structure TE bonus × Beancounter (BX) implant. This is where
    // industry implants actually affect profitability (throughput), not material cost.
    const baseBuildSeconds   = (blueprint.build_time || 0) * runs;
    const industryLvl        = skillMap[3380] || 0;          // Industry: -4%/lvl mfg time
    const advIndustryLvl     = skillMap[3388] || 0;          // Advanced Industry: -3%/lvl all jobs
    const structureTeBonus   = (setup.structure && !isReaction) ? (1 - setup.structure.timeMult) * 100 : 0;
    // Best manufacturing-time implant the character has plugged in (if any).
    const mfgImplant = isReaction ? null : ((implants || [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'mfg_time')
      .sort((a, b) => b.pct - a.pct)[0] || null);
    // Skills + blueprint TE + structure and the rigs covering this product (their TE bonus
    // was previously ignored) + implant, via the shared module. Science skills the blueprint
    // requires each cut manufacturing time 1%/level. Reactions: Reactions skill + Advanced Industry only.
    const requiredSkills = isReaction ? [] : await dbAll(
      'SELECT skill_id FROM blueprint_skills WHERE blueprint_id = ? AND activity_id = 1',
      [blueprint.blueprint_id]
    );
    const timeMult = isReaction
      ? IM.reactionTimeMultiplier({ skillMap })
      : IM.timeMultiplier({
          skillMap, requiredSkills, blueprintTe: baseTE || 0,
          modsTimeMult: mods.timeMult, implantPct: mfgImplant ? mfgImplant.pct : 0,
        });

    const effectiveBuildSeconds = baseBuildSeconds * timeMult;
    const buildHours  = effectiveBuildSeconds / 3600;
    const iskPerHour  = buildHours > 0 ? trueProfit / buildHours : 0;

    // Reprocessing implant (informational — FORGE prices materials at market, not reprocess yield)
    const reprocImplant = (implants || [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'reprocessing')
      .sort((a, b) => b.pct - a.pct)[0] || null;

    const STRUCTURE_LABELS = { 35825: 'Raitaru', 35826: 'Azbel', 35827: 'Sotiyo' };
    const structureLabel = settings?.structure_type_id
      ? (STRUCTURE_LABELS[settings.structure_type_id] || 'Engineering Complex')
      : 'NPC Station';

    res.json({
      product_id,
      runs,
      sell_price: sellPrice,

      // Box 1 — materials (source hub sell price, ME-adjusted)
      total_material_cost: totalMaterialCost,

      // Box 2 — manufacturing fees
      mfg_fees: {
        total:                totalJobCost,
        system_cost_index:    systemJobCost,
        system_cost_bonuses:  0,   // placeholder — structure/rig cost bonuses not yet modelled
        facility_tax:         facilityTaxCost,
        scc_surcharge:        sccSurcharge,
        alpha_clone_tax:      0,   // Alpha clones pay extra 2% but FORGE only targets Omega
        estimated_item_value: eiv,
        effective_me_pct:     effectiveME,  // for tooltip display
      },

      // Box 3 — sales fees
      sales_tax: {
        total:                    totalSalesTax,
        broker_fee:               brokerFee,
        broker_fee_rate:          brokerFeeRate,
        broker_relations_level:   brokerRelations,
        faction_standing:         factionStanding,
        corp_standing:            corpStanding,
        transaction_tax:          transactionTax,
        transaction_tax_rate:     transactionTaxRate,
        accounting_level:         accounting,
      },

      // Box 5 — haulage (Phase 2)
      haul_cost: {
        total:                     totalHaulCost,
        leg1_cost:                 leg1Cost,
        leg2_cost:                 leg2Cost,
        // Import leg: Jita → build system for what the buy hub can't supply (Leg 1 settings).
        import_leg_cost:           legJCost,
        import_leg_volume_m3:      legJVolM3,
        import_leg_jumps:          legJJumps,
        import_leg_route_known:    legJRouteKnown,
        leg1_route_known:          leg1RouteKnown,
        leg2_route_known:          leg2RouteKnown,
        leg2_configured:           haulEnabled && (leg2Method !== 'user_defined'
                                     || (settings?.leg2_haul_rate || 0) > 0 || (settings?.leg2_isk_per_jump || 0) > 0
                                     || (settings?.leg2_flat_total || 0) > 0),
        haul_enabled:              haulEnabled,
        leg1_configured:           haulEnabled && (leg1Method !== 'user_defined'
                                     || (settings?.leg1_haul_rate || 0) > 0 || (settings?.leg1_isk_per_jump || 0) > 0
                                     || (settings?.leg1_flat_total || 0) > 0),
        leg1_volume_m3:            leg1VolM3,
        leg2_volume_m3:            leg2VolM3,
        // Phase 1 compat: leg1_rate / leg2_rate = raw ISK/m³ from user_defined
        leg1_rate:                 settings?.leg1_haul_rate || 0,
        leg2_rate:                 settings?.leg2_haul_rate || 0,
        // Phase 2 fields
        leg1_method:               leg1Method,
        leg2_method:               leg2Method,
        leg1_jumps:                leg1Jumps,
        leg2_jumps:                leg2Jumps,
        leg1_isk_per_m3_effective: leg1EffM3,
        leg2_isk_per_m3_effective: leg2EffM3,
        leg1_contracts:            leg1Contracts,
        leg2_contracts:            leg2Contracts,
        leg1_collateral:           settings?.leg1_collateral || 0,
        leg2_collateral:           settings?.leg2_collateral || 0,
        leg1_service_label:        settings?.leg1_service_label || null,
        leg2_service_label:        settings?.leg2_service_label || null,
        leg1_self_ship:            settings?.leg1_self_ship || null,
        leg2_self_ship:            settings?.leg2_self_ship || null,
        provider_rates_as_of:      leg1Method in HAUL_PROVIDERS || leg2Method in HAUL_PROVIDERS
                                     ? (HAUL_PROVIDERS[leg1Method] || HAUL_PROVIDERS[leg2Method])?.rates_as_of
                                     : null,
      },

      // Box 4b — invention overhead (T2 items only; null for T1/reaction products)
      invention_cost: inventionCostData,

      // Box 4 + summary — true profit
      true_profit: trueProfit,
      true_margin: trueMargin,

      // Throughput — effective build time + ISK/hr (v1.17.0).
      // Where industry implants actually affect profitability.
      time: {
        base_build_seconds:      baseBuildSeconds,
        effective_build_seconds: Math.round(effectiveBuildSeconds),
        isk_per_hour:            iskPerHour,
        te_pct:                  te || 0,
        industry_level:          industryLvl,
        advanced_industry_level: advIndustryLvl,
        structure_te_bonus_pct:  structureTeBonus,
        time_multiplier:         timeMult,   // blueprint TE × skills (incl. science) × structure × applicable rigs × implant
        mfg_implant:    mfgImplant   ? { name: mfgImplant.name,   pct: mfgImplant.pct }   : null,
        reproc_implant: reprocImplant ? { name: reprocImplant.name, pct: reprocImplant.pct } : null,
      },

      region_id:        regionId,
      prices_warm:      pricesWarm,
      setup_configured: !!(settings?.system_id),
      manufacturing_setup: {
        system_id:          settings?.system_id         || null,
        system_name:        settings?.system_name       || 'Not configured — using Jita IV',
        structure_type_id:  settings?.structure_type_id || null,
        structure_label:    structureLabel,
        rig_ids:            rigIds,
        facility_tax_pct:   settings?.facility_tax      || 0,
        sci_raw:            sci,
        // Effective ME breakdown (v1.9.3)
        // For T2 items blueprint_me = T2 BPC base ME (-4) + decryptor.me; for T1 = researched BPO ME.
        is_t2:              !!invParent,
        blueprint_me:       baseME,         // combined T2 BPC ME (base + decryptor); T1 = researched BPO ME
        t2_base_me:         invParent ? T2_BPC_BASE_ME : null,
        decryptor_me_bonus: invParent ? decr.me : null,
        structure_me_bonus: structureMeBonus,
        rig_me_bonus:       rigMeBonus,
        effective_me:       effectiveME,
        // Real mechanics (lib/industry-math.js): the one multiplier every material quantity uses,
        // and exactly which saved rigs applied to this product with their true (security-scaled) stats.
        material_multiplier: meFactor,
        structure_cost_mult: mods.costMult,
        system_security:     sysRow ? sysRow.security_status : null,
        security_class:      setup.secClass,
        security_known:      setup.securityKnown,
        product_family:      mods.family,
        product_family_known: mods.familyKnown,
        invalid_rig_ids:     setup.invalidRigIds,
        ignored_rig_ids:     setup.ignoredRigIds,   // real rigs that can't apply (wrong size / NPC station / over 3)
        rigs: setup.rigs.map(r => {
          const ap = mods.appliedRigs.find(a => a.id === r.id);
          return {
            id: r.id, name: r.name, size: r.size,
            applies: !!ap,
            // what THIS item gets from the rig, at the system's security (0 when it doesn't cover the item)
            base_me_pct: ap ? ap.baseMatPct : (r.matPct || r.thukkerMatPct), eff_me_pct: ap ? ap.usedMatPct : 0,
            base_te_pct: r.timePct, eff_te_pct: ap ? ap.usedTimePct : 0,
            security_mult: r.secMult,
          };
        }),
      },

      // Data provenance — so the UI can say when a figure leans on an assumption.
      skills_source:     skillsSource,       // 'session' | 'snapshot' | 'none' (none ⇒ level-0 fees/times)
      skills_updated_at: skillsUpdatedAt,
      // Where the finished item's price came from: 'hub'/'region' = the sell hub's own lowest sell;
      // 'jita' = nothing listed at the sell hub, so Jita's lowest sell (and the sale is assumed at Jita).
      sell_price_scope:  sellWarm ? sellScope : null,
      sell_hub_id:       feeRegionId,
      sell_listing: sellWarm ? {
        units_listed:     sellOrdersSeen,           // units for sale at the sell hub (null = unknown)
        hub_highest_buy:  sellHubBuy,
        spread_ratio:     sellHubBuy > 0 ? (unitSell / sellHubBuy) : null,
      } : null,
      // Of the hub's OWN prices: how many were the hub station vs the region-wide fallback.
      material_price_scope: matWarm
        ? (() => {
            const ms = materials.map(m => rawHubPrices?.[m.material_id]?.sellScope);
            return { hub: ms.filter(x => x === 'hub').length, region: ms.filter(x => x === 'region').length };
          })()
        : null,
      // How each material was priced (hub own orders / imported from Jita / short on both).
      material_sourcing: matWarm ? {
        lines:        materialSourcing,
        jita_lines:   materialSourcing.filter(l => l.scope === 'jita').length,
        mixed_lines:  materialSourcing.filter(l => l.scope === 'mixed').length,
        short_lines:  materialSourcing.filter(l => l.short_stock).length,
        import_cost:  materialSourcing.reduce((a, l) => a + l.import_cost, 0),
        jita_unavailable: !rawJitaPrices && matRegionId !== 10000002,
      } : null,
    });

  } catch (err) {
    logger.error('True cost error:', err.message, err.stack?.split('\n')[1]);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
