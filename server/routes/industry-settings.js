'use strict';
// The Mfg Setup: where a character builds (system, structure, rigs, taxes, haul legs), what their fees are, and the
// structure suggestions learned from their jobs.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const IM = require('../lib/industry-math'); // shared manufacturing mechanics (rigs, ME, EIV, job cost, time)
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { clientErrMsg } = require('../lib/http-errors');
const { getCached } = require('../lib/cache');
const { HUB_STANDINGS, HUB_STRUCTURE_FEES, REGIONS, VALID_REGIONS } = require('../lib/hubs');
const { costIndexCache, fetchAdjustedPrices, fetchCostIndices } = require('../lib/esi-industry-data');
const { sanitizeSkills, sanitizeStandings, sanitizeImplants, getCharacterSession, calcSalesFeeRates } = require('../lib/character-session');
const { INT32_MAX_ID, isPlayerStructureId, lookupStructure, recordFitReport, learnStructureFit } = require('../lib/structures');

/** @param {{ blueprintMaterialsCache: Map }} deps */
module.exports = function industrySettingsRoutes({ blueprintMaterialsCache }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════════════════
  // v1.2.0 — INDUSTRY SETTINGS ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/industry-settings — fetch saved settings for the authed character
  router.get('/api/industry-settings', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const characterId = req.characterId;
      const settings = await dbGet(
        'SELECT * FROM character_industry_settings WHERE character_id = ?',
        [characterId]
      );
      res.json(await withSettingsExtras(settings) || {
        system_id:            null,
        system_name:          null,
        structure_type_id:    null,
        rig_ids:              '[]',
        facility_tax:         0,
        material_region_id:   10000002,
        material_region_name: 'Jita',
        haul_enabled:         0,
        // Phase 1 — flat rate fields (kept for backward compat)
        leg1_haul_rate:       0,
        leg2_haul_rate:       0,
        // Phase 2 — method + per-method params
        leg1_method:          'user_defined',
        leg2_method:          'user_defined',
        leg1_collateral:      0,
        leg2_collateral:      0,
        leg1_isk_per_jump:    0,
        leg2_isk_per_jump:    0,
        leg1_flat_total:      0,
        leg2_flat_total:      0,
        leg1_service_label:   null,
        leg2_service_label:   null,
        leg1_self_char_id:    null,
        leg1_self_ship:       null,
        leg1_self_fuel:       0,
        leg2_self_char_id:    null,
        leg2_self_ship:       null,
        leg2_self_fuel:       0,
        invention_rig_ids:    '[]',
        invention_system_id:  null,
        invention_system_name: null,
      });
    } catch (err) {
      logger.error('Industry settings GET error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // Saved settings plus what the UI needs to show the setup honestly: the system's security
  // (rig bonuses scale by it) and any saved rig ids that no longer exist in the game data.
  async function withSettingsExtras(settings) {
    if (!settings) return null;
    let rigIds = [];
    try { rigIds = JSON.parse(settings.rig_ids || '[]'); } catch (_) { /* treat as empty */ }
    const sysRow = settings.system_id
      ? await dbGet('SELECT security_status FROM sde_systems WHERE system_id = ?', [settings.system_id])
      : null;
    const setup = IM.describeSetup({
      structureTypeId: settings.structure_type_id,
      rigIds,
      systemSecurity: sysRow ? sysRow.security_status : null,
    });
    return {
      ...settings,
      system_security: sysRow ? sysRow.security_status : null,
      security_class:  setup.secClass,
      invalid_rig_ids: setup.invalidRigIds,
      ignored_rig_ids: setup.ignoredRigIds,
    };
  }

  // GET /api/industry-rigs — the real rig + structure stats the calculations use (static game data).
  router.get('/api/industry-rigs', security.apiLimiter, security.verifyEveToken, (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');   // static data, but the route is token-gated: never let a shared cache serve it
    res.json({ rigs: IM.RIGS, structures: IM.STRUCTURES });
  });

  // GET /api/structure-fit-suggestions?system_id=&structure_type_id=
  // What other FORGE users report running in this system on this structure type, grouped by
  // structure and identical rig set. Anonymous: only counts are returned, never character ids.
  router.get('/api/structure-fit-suggestions', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const systemId = parseInt(req.query.system_id, 10);
      const typeId   = parseInt(req.query.structure_type_id, 10);
      if (!systemId || !typeId) return res.status(400).json({ error: 'system_id and structure_type_id required' });

      const rows = await dbAll(
        `SELECT structure_id, character_id, rig_ids, facility_tax, reported_at
         FROM structure_fit_reports
        WHERE system_id = ? AND structure_type_id = ? AND character_id != ?`,
        [systemId, typeId, req.characterId]
      );
      // The requester's own linked structure (if any) lets us show only reports for THAT structure.
      const own = await dbGet('SELECT structure_id FROM character_industry_settings WHERE character_id = ?', [req.characterId]);
      const ownStructureId = own && own.structure_id ? Number(own.structure_id) : null;

      const groups = new Map();
      for (const r of rows) {
        let ids = [];
        try { ids = JSON.parse(r.rig_ids || '[]'); } catch (_) { continue; }
        const valid = [...new Set(ids.map(Number).filter(id => IM.RIGS[id]))].sort((a, b) => a - b);
        if (valid.length === 0) continue;
        // Reports for the requester's own structure stay separate; everything else is merged by rig
        // set so the number of structures in a system can't be read from the number of rows.
        const same = !!ownStructureId && Number(r.structure_id) === ownStructureId;
        const key = `${same ? 'own' : 'other'}|${valid.join(',')}`;
        let g = groups.get(key);
        if (!g) {
          g = { same_structure: same, rig_ids: valid, taxes: [], chars: new Set(), last: '' };
          groups.set(key, g);
        }
        g.chars.add(r.character_id);
        g.taxes.push(Number(r.facility_tax) || 0);
        if (r.reported_at > g.last) g.last = r.reported_at;
      }

      const mode = arr => {
        const tally = new Map();
        arr.forEach(v => tally.set(v, (tally.get(v) || 0) + 1));
        return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      };
      // Deliberately no structure id or name in the response: any logged-in user can query any
      // system, and a private structure's identity/location must not leak through this endpoint.
      let suggestions = [...groups.values()]
        .map(g => ({
          same_structure:   g.same_structure,
          rig_ids:          g.rig_ids,
          rig_names:        g.rig_ids.map(id => IM.RIGS[id].name),
          facility_tax:     mode(g.taxes),
          reports:          g.chars.size,
          _last:            g.last,          // used only for ordering; never sent (an exact timestamp would identify a reporter)
        }))
        .sort((a, b) => Number(b.same_structure) - Number(a.same_structure)
                      || b.reports - a.reports
                      || (b._last > a._last ? 1 : -1));
      // If the requester's own structure is known and others report on it, show only those.
      if (suggestions.some(s => s.same_structure)) suggestions = suggestions.filter(s => s.same_structure);
      // Anything else needs at least 2 independent reporters before it is shown: a single report would
      // let any user probe "does a FORGE pilot have a structure of this type in system X?" or read one
      // pilot's fit. (A same_structure report was verified against the requester's own access, so it is exempt.)
      suggestions = suggestions.filter(s => s.same_structure || s.reports >= 2);

      res.json({ suggestions: suggestions.slice(0, 5).map(({ _last, ...pub }) => pub) });
    } catch (err) {
      logger.error('structure-fit-suggestions error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // GET /api/job-cost-check — FORGE's install-cost estimate vs what CCP actually charged for the
  // character's running manufacturing jobs. Only jobs in the facility the Mfg Setup describes are
  // compared (other facilities would use a different tax/structure). The estimate uses today's
  // system cost index, while a job paid the index in force when it was installed, so small
  // differences are expected; a consistent large gap points at a wrong setting.
  router.get('/api/job-cost-check', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const characterId = req.characterId;
      const session = getCached(`session:${characterId}`);
      if (!session) return res.status(400).json({ error: 'No session — refresh the page first', code: 'SESSION_MISSING' });
      const settings = await dbGet('SELECT * FROM character_industry_settings WHERE character_id = ?', [characterId]);
      if (!settings || !settings.system_id) return res.json({ configured: false, jobs: [], summary: null });

      const [adjustedPrices, costIndices] = await Promise.all([fetchAdjustedPrices(), fetchCostIndices()]);
      const sci      = costIndices[settings.system_id] || 0;
      const costMult = IM.STRUCTURES[settings.structure_type_id]?.costMult ?? 1;
      const taxDec   = (settings.facility_tax || 0) / 100;

      const skipped = { other_facility: 0, not_manufacturing: 0, no_cost: 0, no_recipe: 0 };
      const jobs = [];
      for (const j of (Array.isArray(session.jobs) ? session.jobs : []).slice(0, 200)) {
        if (!j || j.activityId !== 1) { skipped.not_manufacturing++; continue; }
        const sameFacility = settings.structure_id
          ? Number(j.facilityId) === Number(settings.structure_id)
          : (!settings.structure_type_id && Number(j.facilityId) > 0 && Number(j.facilityId) <= INT32_MAX_ID);
        if (!sameFacility) { skipped.other_facility++; continue; }
        if (!(j.cost > 0)) { skipped.no_cost++; continue; }
        const mats = blueprintMaterialsCache.get(
          (await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [j.typeId]))?.blueprint_id
        );
        if (!mats || mats.length === 0) { skipped.no_recipe++; continue; }
        const runs      = Math.max(1, Number(j.quantity) || 1);
        const eiv       = IM.estimatedItemValue(mats, runs, adjustedPrices);
        const predicted = IM.jobCost({ eiv, sci, costMult, facilityTaxDecimal: taxDec }).total;
        jobs.push({
          name: j.name, runs, actual: j.cost, predicted,
          diff_pct: predicted > 0 ? ((j.cost - predicted) / predicted) * 100 : null,
        });
      }

      const sumActual = jobs.reduce((s, x) => s + x.actual, 0);
      const sumPred   = jobs.reduce((s, x) => s + x.predicted, 0);
      res.json({
        configured: true,
        jobs: jobs.slice(0, 25),
        skipped,
        summary: jobs.length ? {
          compared: jobs.length, actual_total: sumActual, predicted_total: sumPred,
          diff_pct: sumPred > 0 ? ((sumActual - sumPred) / sumPred) * 100 : null,
        } : null,
      });
    } catch (err) {
      logger.error('job-cost-check error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // GET /api/character-fee-rates — return the character's fee rates for the given sell hub.
  // Used by the client to recompute Market Opportunities profit/margin/ISK-hr with the same
  // formula used by /api/true-cost, so both panels show consistent figures.
  //
  // Query params:
  //   sellRegionId  — region to use for standings-based broker fee (default 10000002 = Jita)
  //
  // Response:
  //   broker_fee_rate        — decimal (e.g. 0.025 for 2.5%)
  //   transaction_tax_rate   — decimal (e.g. 0.0375)
  //   sci                    — System Cost Index for the character's configured system (0 if unconfigured)
  //   scc_rate               — always 0.04 (SCC surcharge, flat — see the "Job cost formula" comment above calcHaulLegs for why 4%, not the 2% that applies to research-only)
  //   facility_tax           — decimal (e.g. 0.025 for 2.5%)
  //   setup_configured       — true if industry system has been set
  router.get('/api/character-fee-rates', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const characterId  = req.characterId;
      const sellRegionId = VALID_REGIONS.includes(parseInt(req.query.sellRegionId))
        ? parseInt(req.query.sellRegionId)
        : 10000002;

      // ── Session: skills + standings ────────────────────────────────────────
      const { skillMap, standings } = getCharacterSession(characterId);

      // ── Industry settings (system + facility tax) ──────────────────────────
      const settings = await dbGet(
        'SELECT * FROM character_industry_settings WHERE character_id = ?',
        [characterId]
      );
      const facilityTaxDecimal = (settings?.facility_tax || 0) / 100;
      const targetSystemId     = settings?.system_id || 30000142; // default: Jita IV

      // ── System Cost Index ──────────────────────────────────────────────────
      const costIndices = await fetchCostIndices();
      const sci         = costIndices[targetSystemId] || 0;

      // ── Sales fee rates ────────────────────────────────────────────────────
      const { brokerFeeRate, transactionTaxRate } =
        calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[sellRegionId], HUB_STRUCTURE_FEES[sellRegionId] ?? null);

      res.json({
        broker_fee_rate:      brokerFeeRate,
        transaction_tax_rate: transactionTaxRate,
        sci,
        scc_rate:             0.04,
        facility_tax:         facilityTaxDecimal,
        setup_configured:     !!(settings?.system_id),
      });

    } catch (err) {
      logger.error('Character fee rates error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // POST /api/industry-settings — save settings for the authed character.
  // Accepts both manufacturing location fields (system, structure, rigs, tax) and
  // the material source hub (material_region_id / material_region_name).
  // Any subset of fields may be sent; omitted fields are preserved via ON CONFLICT DO UPDATE.
  async function saveIndustrySettings({
    characterId, system_id, system_name, structure_type_id, rig_ids, tax, validMatRegion,
    material_region_name, haul_enabled, leg1Rate, leg2Rate, l1method, l2method,
    leg1_collateral, leg2_collateral, leg1_isk_per_jump, leg2_isk_per_jump,
    leg1_flat_total, leg2_flat_total, leg1_service_label, leg2_service_label,
    leg1_self_char_id, leg1_self_ship, leg1_self_fuel,
    leg2_self_char_id, leg2_self_ship, leg2_self_fuel,
    invention_rig_ids, invention_system_id, invention_system_name,
    interhub_haul_enabled, ihmethod, interhub_haul_rate, interhub_isk_per_jump,
    interhub_flat_total, interhub_self_fuel, interhub_collateral,
    interhub_service_label, interhub_self_char_id, interhub_self_ship,
  }) {
    await dbRun(`
    INSERT INTO character_industry_settings
      (character_id, system_id, system_name, structure_type_id,
       rig_ids, facility_tax, material_region_id, material_region_name,
       haul_enabled, leg1_haul_rate, leg2_haul_rate,
       leg1_method, leg2_method,
       leg1_collateral, leg2_collateral,
       leg1_isk_per_jump, leg2_isk_per_jump,
       leg1_flat_total, leg2_flat_total,
       leg1_service_label, leg2_service_label,
       leg1_self_char_id, leg1_self_ship, leg1_self_fuel,
       leg2_self_char_id, leg2_self_ship, leg2_self_fuel,
       invention_rig_ids, invention_system_id, invention_system_name,
       interhub_haul_enabled, interhub_method,
       interhub_haul_rate, interhub_isk_per_jump, interhub_flat_total,
       interhub_self_fuel, interhub_collateral, interhub_service_label,
       interhub_self_char_id, interhub_self_ship,
       updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(character_id) DO UPDATE SET
      system_id              = excluded.system_id,
      system_name            = excluded.system_name,
      structure_type_id      = excluded.structure_type_id,
      rig_ids                = excluded.rig_ids,
      facility_tax           = excluded.facility_tax,
      material_region_id     = excluded.material_region_id,
      material_region_name   = excluded.material_region_name,
      haul_enabled           = excluded.haul_enabled,
      leg1_haul_rate         = excluded.leg1_haul_rate,
      leg2_haul_rate         = excluded.leg2_haul_rate,
      leg1_method            = excluded.leg1_method,
      leg2_method            = excluded.leg2_method,
      leg1_collateral        = excluded.leg1_collateral,
      leg2_collateral        = excluded.leg2_collateral,
      leg1_isk_per_jump      = excluded.leg1_isk_per_jump,
      leg2_isk_per_jump      = excluded.leg2_isk_per_jump,
      leg1_flat_total        = excluded.leg1_flat_total,
      leg2_flat_total        = excluded.leg2_flat_total,
      leg1_service_label     = excluded.leg1_service_label,
      leg2_service_label     = excluded.leg2_service_label,
      leg1_self_char_id      = excluded.leg1_self_char_id,
      leg1_self_ship         = excluded.leg1_self_ship,
      leg1_self_fuel         = excluded.leg1_self_fuel,
      leg2_self_char_id      = excluded.leg2_self_char_id,
      leg2_self_ship         = excluded.leg2_self_ship,
      leg2_self_fuel         = excluded.leg2_self_fuel,
      invention_rig_ids      = excluded.invention_rig_ids,
      invention_system_id    = excluded.invention_system_id,
      invention_system_name  = excluded.invention_system_name,
      interhub_haul_enabled  = excluded.interhub_haul_enabled,
      interhub_method        = excluded.interhub_method,
      interhub_haul_rate     = excluded.interhub_haul_rate,
      interhub_isk_per_jump  = excluded.interhub_isk_per_jump,
      interhub_flat_total    = excluded.interhub_flat_total,
      interhub_self_fuel     = excluded.interhub_self_fuel,
      interhub_collateral    = excluded.interhub_collateral,
      interhub_service_label = excluded.interhub_service_label,
      interhub_self_char_id  = excluded.interhub_self_char_id,
      interhub_self_ship     = excluded.interhub_self_ship,
      updated_at             = excluded.updated_at
  `, [
      characterId,
      system_id         || null,
      system_name       || null,
      structure_type_id || null,
      JSON.stringify(Array.isArray(rig_ids) ? rig_ids : []),
      tax,
      validMatRegion,
      material_region_name || REGIONS[validMatRegion]?.hub || 'Jita',
      haul_enabled ? 1 : 0,
      leg1Rate,
      leg2Rate,
      l1method, l2method,
      Math.max(0, parseFloat(leg1_collateral)   || 0),
      Math.max(0, parseFloat(leg2_collateral)   || 0),
      Math.max(0, parseFloat(leg1_isk_per_jump) || 0),
      Math.max(0, parseFloat(leg2_isk_per_jump) || 0),
      Math.max(0, parseFloat(leg1_flat_total)   || 0),
      Math.max(0, parseFloat(leg2_flat_total)   || 0),
      leg1_service_label || null,
      leg2_service_label || null,
      leg1_self_char_id  || null,
      leg1_self_ship     || null,
      Math.max(0, parseFloat(leg1_self_fuel)    || 0),
      leg2_self_char_id  || null,
      leg2_self_ship     || null,
      Math.max(0, parseFloat(leg2_self_fuel)    || 0),
      JSON.stringify(Array.isArray(invention_rig_ids) ? invention_rig_ids : []),
      invention_system_id   || null,
      invention_system_name || null,
      interhub_haul_enabled ? 1 : 0,
      ihmethod,
      Math.max(0, parseFloat(interhub_haul_rate)    || 0),
      Math.max(0, parseFloat(interhub_isk_per_jump) || 0),
      Math.max(0, parseFloat(interhub_flat_total)   || 0),
      Math.max(0, parseFloat(interhub_self_fuel)    || 0),
      Math.max(0, parseFloat(interhub_collateral)   || 0),
      interhub_service_label || null,
      interhub_self_char_id  || null,
      interhub_self_ship     || null,
      new Date().toISOString(),
    ]);
  }

  router.post('/api/industry-settings', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const characterId = req.characterId;
      const {
        system_id, system_name,
        structure_type_id, rig_ids, facility_tax,
        material_region_id   = 10000002,
        material_region_name = 'Jita',
        haul_enabled         = false,
        // Phase 1 — flat rate (user_defined ISK/m³)
        leg1_haul_rate       = 0,
        leg2_haul_rate       = 0,
        // Phase 2 — method + per-method params
        leg1_method          = 'user_defined',
        leg2_method          = 'user_defined',
        leg1_collateral      = 0,
        leg2_collateral      = 0,
        leg1_isk_per_jump    = 0,
        leg2_isk_per_jump    = 0,
        leg1_flat_total      = 0,
        leg2_flat_total      = 0,
        leg1_service_label   = null,
        leg2_service_label   = null,
        leg1_self_char_id    = null,
        leg1_self_ship       = null,
        leg1_self_fuel       = 0,
        leg2_self_char_id    = null,
        leg2_self_ship       = null,
        leg2_self_fuel       = 0,
        invention_rig_ids    = [],
        invention_system_id  = null,
        invention_system_name = null,
        // v1.35.0 — inter-hub independent haul config
        interhub_haul_enabled  = false,
        interhub_method        = 'user_defined',
        interhub_haul_rate     = 0,
        interhub_isk_per_jump  = 0,
        interhub_flat_total    = 0,
        interhub_self_fuel     = 0,
        interhub_collateral    = 0,
        interhub_service_label = null,
        interhub_self_char_id  = null,
        interhub_self_ship     = null,
      } = req.body;

      // Validate: facility_tax must be 0–100
      const tax = Math.min(100, Math.max(0, parseFloat(facility_tax) || 0));

      // Validate material_region_id against the known hub whitelist
      const validMatRegion = VALID_REGIONS.includes(parseInt(material_region_id))
        ? parseInt(material_region_id)
        : 10000002;

      const VALID_METHODS = ['user_defined', 'red_frog', 'black_frog', 'pushx', 'self_haul'];
      const leg1Rate  = Math.max(0, parseFloat(leg1_haul_rate)    || 0);
      const leg2Rate  = Math.max(0, parseFloat(leg2_haul_rate)    || 0);
      const l1method  = VALID_METHODS.includes(leg1_method) ? leg1_method : 'user_defined';
      const l2method  = VALID_METHODS.includes(leg2_method) ? leg2_method : 'user_defined';
      const ihmethod  = VALID_METHODS.includes(interhub_method) ? interhub_method : 'user_defined';

      // System ids are used to build ESI route URLs: only real EVE solar-system ids are accepted.
      const validSystemId = v => v == null || v === '' || (Number.isSafeInteger(Number(v)) && Number(v) >= 30000000 && Number(v) < 33000000);
      if (!validSystemId(system_id) || !validSystemId(invention_system_id)) {
        return res.status(400).json({ error: 'Invalid system id' });
      }

      // Only real manufacturing rigs from the game data, at most the 3 a structure can carry.
      // Unknown ids (old picker bug, stale entries) are dropped instead of silently counting as 0.
      // Same rules the read path enforces: real rigs only, no duplicates, max 3, matching the structure's
      // size, and none at an NPC station.
      const cleanRigIds = IM.describeSetup({
        structureTypeId: Number(structure_type_id) || null, rigIds: rig_ids, systemSecurity: null,
      }).rigs.map(r => r.id);

      await saveIndustrySettings({
        characterId, system_id: system_id ? Number(system_id) : null, system_name, structure_type_id, rig_ids: cleanRigIds, tax, validMatRegion,
        material_region_name, haul_enabled, leg1Rate, leg2Rate, l1method, l2method,
        leg1_collateral, leg2_collateral, leg1_isk_per_jump, leg2_isk_per_jump,
        leg1_flat_total, leg2_flat_total, leg1_service_label, leg2_service_label,
        leg1_self_char_id, leg1_self_ship, leg1_self_fuel,
        leg2_self_char_id, leg2_self_ship, leg2_self_fuel,
        invention_rig_ids, invention_system_id: invention_system_id ? Number(invention_system_id) : null, invention_system_name,
        interhub_haul_enabled, ihmethod, interhub_haul_rate, interhub_isk_per_jump,
        interhub_flat_total, interhub_self_fuel, interhub_collateral,
        interhub_service_label, interhub_self_char_id, interhub_self_ship,
      });

      res.json({ ok: true });

      // Register this setup in the structure-fit registry (identifies the structure from the
      // character's own jobs when possible). Best effort — never affects the save.
      const liveToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      learnStructureFit(characterId, liveToken, getCached(`session:${characterId}`)?.jobs, { force: true })
        .catch(e => logger.error('structure-fit learn failed:', e.message));
    } catch (err) {
      logger.error('Industry settings POST error:', err.message);
      res.status(500).json({ error: clientErrMsg(err) });
    }
  });

  // GET /api/system-search?q=<query> — autocomplete solar system names (local index)
  // Uses the system name map built by fetchCostIndices() — no ESI search call needed.
  // Prefix matches are ranked first; falls back to substring matches.
  // Returns up to 10 results.
  router.get('/api/system-search', security.apiLimiter, security.verifyEveToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim().toLowerCase();
      if (q.length < 2) return res.json([]);

      // Warm the cache if needed (also triggers name lookup on first call)
      await fetchCostIndices();

      const nameMap = costIndexCache.nameMap;
      if (!nameMap || nameMap.size === 0) return res.json([]);

      const prefix    = [];
      const substring = [];

      for (const [nameLower, info] of nameMap) {
        if (nameLower.startsWith(q)) {
          prefix.push(info);
        } else if (nameLower.includes(q)) {
          substring.push(info);
        }
        // Early exit once we have enough results
        if (prefix.length >= 10) break;
      }

      // Prefix matches first (sorted alphabetically), then substring matches
      prefix.sort((a, b) => a.system_name.localeCompare(b.system_name));
      substring.sort((a, b) => a.system_name.localeCompare(b.system_name));

      const results = [...prefix, ...substring].slice(0, 10);
      // Attach each system's security status — rig bonuses scale by it, so the Mfg Setup screen
      // shows the user their real (security-scaled) rig values for the system they pick.
      if (results.length) {
        const secRows = await dbAll(
          `SELECT system_id, security_status FROM sde_systems WHERE system_id IN (${results.map(() => '?').join(',')})`,
          results.map(r => r.system_id)
        );
        const secById = new Map(secRows.map(r => [r.system_id, r.security_status]));
        return res.json(results.map(r => ({ ...r, security: secById.has(r.system_id) ? secById.get(r.system_id) : null })));
      }
      res.json(results);
    } catch (err) {
      logger.error('System search error:', err.message);
      res.json([]);
    }
  });

  return router;
};
