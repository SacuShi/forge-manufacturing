'use strict';
// What the server knows about a character's skills, standings and implants: sanitising what the browser sends,
// the persisted skill snapshot, and the session lookup used for fees and build times.

const logger = require('./logger');
const { dbAll, dbRun } = require('./db');
const { getCached } = require('./cache');

// Clamp client-posted skills/standings/implants before they are persisted or trusted: bounded sizes,
// numeric ids, levels 0-5, standings -10..10. Malformed entries are dropped, never thrown on.
function sanitizeSkills(skills) {
  if (!Array.isArray(skills)) return [];
  const out = [];
  for (const s of skills.slice(0, 700)) {
    const id = Number(s?.skill_id), lvl = Number(s?.active_skill_level);
    if (Number.isSafeInteger(id) && id > 0 && Number.isFinite(lvl)) {
      out.push({ skill_id: id, active_skill_level: Math.max(0, Math.min(5, Math.trunc(lvl))) });
    }
  }
  return out;
}

function sanitizeStandings(st) {
  const clean = { factions: {}, corps: {} };
  if (!st || typeof st !== 'object') return clean;
  for (const group of ['factions', 'corps']) {
    const src = st[group];
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src).slice(0, 2000)) {
      const id = Number(k), val = Number(v);
      if (Number.isSafeInteger(id) && Number.isFinite(val)) clean[group][id] = Math.max(-10, Math.min(10, val));
    }
  }
  return clean;
}

function sanitizeImplants(imp) {
  return Array.isArray(imp) ? imp.slice(0, 20).map(Number).filter(Number.isSafeInteger) : [];
}

// ── Sales-fee helpers (shared by /api/character-fee-rates and /api/true-cost) ──────────

/**
 * Extract a character's skill map and standings from the server-side session cache.
 * Returns safe defaults ({} and empty standing maps) when the session is missing.
 *
 * @param {number|string} characterId
 * @returns {{ skillMap: Object, standings: { factions: Object, corps: Object } }}
 */
// DB-backed copy of each character's last known skills/standings/implants. The 2h in-memory
// session is lost on expiry and on every restart; falling back to this snapshot means fees and
// build times use the character's real skills instead of silently assuming level 0.
const skillSnapshots = new Map(); // characterId -> { skills, standings, implants, updatedAt }

async function loadSkillSnapshots() {
  const rows = await dbAll('SELECT character_id, skills, standings, implants, updated_at FROM character_skill_snapshot');
  for (const r of rows) {
    try {
      skillSnapshots.set(Number(r.character_id), {
        skills:    JSON.parse(r.skills    || '[]'),
        standings: JSON.parse(r.standings || '{}'),
        implants:  JSON.parse(r.implants  || '[]'),
        updatedAt: r.updated_at,
      });
    } catch (_) { /* corrupt row — ignore, next session post rewrites it */ }
  }
  logger.info(`✓ Skill snapshots loaded: ${skillSnapshots.size} characters`);
}

async function saveSkillSnapshot(characterId, skills, standings, implants) {
  const cleanSkills = sanitizeSkills(skills);
  if (cleanSkills.length === 0) return; // never overwrite good data with empty/garbage
  const prev = skillSnapshots.get(Number(characterId));
  const cleanStandings = sanitizeStandings(standings);
  const hasStandings   = Object.keys(cleanStandings.factions).length > 0 || Object.keys(cleanStandings.corps).length > 0;
  const snap = {
    skills:    cleanSkills,
    // a snapshot that carries no standings / implants (an alt without the standings scope) keeps the earlier ones
    standings: hasStandings || !prev ? cleanStandings : prev.standings,
    implants:  Array.isArray(implants) || !prev ? sanitizeImplants(implants) : prev.implants,
    updatedAt: new Date().toISOString(),
  };
  skillSnapshots.set(Number(characterId), snap);
  await dbRun(
    `INSERT INTO character_skill_snapshot (character_id, skills, standings, implants, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET
       skills = excluded.skills, standings = excluded.standings,
       implants = excluded.implants, updated_at = excluded.updated_at`,
    [Number(characterId), JSON.stringify(snap.skills), JSON.stringify(snap.standings),
     JSON.stringify(snap.implants), snap.updatedAt]
  );
}

// skillsSource: 'session' (live), 'snapshot' (last saved copy), 'none' (nothing known → level 0).
function getCharacterSession(characterId) {
  const session = getCached(`session:${characterId}`);
  const snap    = skillSnapshots.get(Number(characterId));
  const ownLive = Array.isArray(session?.own_skills) && session.own_skills.length > 0;
  // A current client always sends its own levels (own_skills); an empty list means they failed to load, in which
  // case the saved snapshot (or "none") is used — never the best-of-all-characters list, which would price fees
  // at another character's Accounting/Broker Relations.
  const ownSent = Array.isArray(session?.own_skills);
  const live    = ownLive || (!ownSent && Array.isArray(session?.skills) && session.skills.length > 0);
  const useSnap = !live && snap && snap.skills.length > 0;

  const skillsArr = ownLive ? session.own_skills : (live ? session.skills : (useSnap ? snap.skills : []));
  const hasAnyStanding = st => !!st && (Object.keys(st.factions || {}).length > 0 || Object.keys(st.corps || {}).length > 0);
  const standings = (hasAnyStanding(session?.standings) ? session.standings : null)
    || (hasAnyStanding(snap?.standings) ? snap.standings : null)
    || session?.standings
    || { factions: {}, corps: {} };
  const implantsSrc = Array.isArray(session?.implants) && session.implants.length ? session.implants : snap?.implants;
  const implants  = Array.isArray(implantsSrc) ? implantsSrc : [];
  const skillMap  = {};
  skillsArr.forEach(s => {
    if (!s || !Number.isFinite(Number(s.skill_id))) return;   // tolerate malformed client-posted entries
    skillMap[Number(s.skill_id)] = Number(s.active_skill_level) || 0;
  });
  return {
    skillMap, standings, implants,
    skillsSource:    live ? 'session' : (useSnap ? 'snapshot' : 'none'),
    skillsUpdatedAt: live ? (session.cachedAt || null) : (useSnap ? snap.updatedAt : null),
  };
}

// ── Industry implants (v1.17.0) ───────────────────────────────────────────────
// Zainou 'Beancounter' hardwirings (slot 8). Only manufacturing-time implants are
// applied to True Profit ISK/hr; reprocessing implants are surfaced for the AI.
// type_id → { kind, pct, name }. (Verified type_ids for the BX series.)
const INDUSTRY_IMPLANTS = {
  27170: { kind: 'mfg_time',     pct: 1, name: "Zainou 'Beancounter' Industry BX-801" },
  27167: { kind: 'mfg_time',     pct: 2, name: "Zainou 'Beancounter' Industry BX-802" },
  27171: { kind: 'mfg_time',     pct: 4, name: "Zainou 'Beancounter' Industry BX-804" },
  27174: { kind: 'reprocessing', pct: 4, name: "Zainou 'Beancounter' Reprocessing RX-804" },
};

// Structure ME/TE/cost multipliers (Raitaru/Azbel/Sotiyo) are in lib/industry-data/structures.json.

/**
 * Calculate EVE broker fee and transaction tax rates for a character at a trade hub.
 *
 * Broker fee:
 *   max(1%, 3% − 0.3%×BrokerRelations − 0.03%×max(0,factionStanding) − 0.02%×max(0,corpStanding))
 * Transaction tax:
 *   max(0%, 7.5% × (1 − 11%×Accounting))
 *
 * @param {Object} skillMap  — { [skill_id]: level } from getCharacterSession
 * @param {Object} standings — { factions: {id: val}, corps: {id: val} }
 * @param {Object|undefined} hub — { faction_id, corp_id } from HUB_STANDINGS
 * @returns {{ brokerFeeRate, transactionTaxRate, brokerRelations, accounting, factionStanding, corpStanding }}
 */
// fixedBrokerFee: pass HUB_STRUCTURE_FEES[regionId] for player structures (no standings discount).
// When null, uses the standard NPC-standings formula.
function calcSalesFeeRates(skillMap, standings, hub, fixedBrokerFee = null) {
  const brokerRelations = skillMap[3446]  || 0;  // Broker Relations (skill_id 3446)
  const accounting      = skillMap[16622] || 0;  // Accounting       (skill_id 16622)
  const factionStanding = fixedBrokerFee !== null ? 0 : (standings.factions?.[hub?.faction_id] || 0);
  const corpStanding    = fixedBrokerFee !== null ? 0 : (standings.corps?.[hub?.corp_id]       || 0);

  const brokerFeeRate = fixedBrokerFee !== null
    ? fixedBrokerFee
    : Math.max(0.01,
        0.03
        - (0.003  * brokerRelations)
        - (0.0003 * Math.max(0, factionStanding))
        - (0.0002 * Math.max(0, corpStanding))
      );
  const transactionTaxRate = Math.max(0, 0.075 * (1 - 0.11 * accounting));

  return { brokerFeeRate, transactionTaxRate, brokerRelations, accounting, factionStanding, corpStanding };
}

module.exports = {
  sanitizeSkills, sanitizeStandings, sanitizeImplants, loadSkillSnapshots, saveSkillSnapshot, getCharacterSession,
  calcSalesFeeRates, INDUSTRY_IMPLANTS,
};
