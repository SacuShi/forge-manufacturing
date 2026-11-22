'use strict';
// The pilot's REACTION setup (refinery + reactor rigs + where it runs), used by True Profit and the Queue Planner.
// Reactions run in Upwell refineries (Athanor/Tatara), not engineering complexes, so they have their own saved setup
// next to the manufacturing one. Nothing saved = exactly the old behaviour: the manufacturing system/tax, no refinery
// or rig bonuses, only the Reactions skill.

const IM = require('./industry-math');
const { dbGet } = require('./db');

const JITA_SYSTEM = 30000142; // default system when nothing is saved (Jita IV)

function parseRigIds(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

/**
 * @param {object|null} settings a character_industry_settings row
 * @returns {Promise<{configured:boolean, setup:object, systemId:number, facilityTaxDecimal:number}>}
 */
async function loadReactionSetup(settings) {
  const mfgSystemId = settings?.system_id || JITA_SYSTEM;
  const refineryId  = Number(settings?.reaction_structure_type_id) || null;
  if (!refineryId || !IM.STRUCTURES[refineryId]?.refinery) {
    return {
      configured: false,
      setup: IM.describeSetup({}),
      systemId: mfgSystemId,
      facilityTaxDecimal: IM.effectiveFacilityTax(settings),
    };
  }
  const systemId = settings.reaction_system_id || mfgSystemId;
  const sysRow = await dbGet('SELECT security_status FROM sde_systems WHERE system_id = ?', [systemId]);
  return {
    configured: true,
    setup: IM.describeSetup({
      structureTypeId: refineryId,
      rigIds: parseRigIds(settings.reaction_rig_ids),
      systemSecurity: sysRow ? sysRow.security_status : null,
    }),
    systemId,
    facilityTaxDecimal: IM.clampFacilityTax((Number(settings.reaction_facility_tax) || 0) / 100),
  };
}

module.exports = { loadReactionSetup, parseRigIds };
