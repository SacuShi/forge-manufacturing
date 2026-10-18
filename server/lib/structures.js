'use strict';
// Player structures a character builds in: looking one up in ESI, and learning which structure type and rigs a
// character uses from their job history (so the Mfg Setup can suggest them).

const { dbGet, dbRun } = require('./db');
const { esiFetch } = require('./esi');

// ═══════════════════════════════════════════════════════════════════════════
// Mfg Setup helpers + structure-fit registry
// ═══════════════════════════════════════════════════════════════════════════

const INT32_MAX_ID = 2147483647;

const STRUCTURE_LEARN_INTERVAL_MS   = 6 * 60 * 60 * 1000;   // between automatic attempts that did ESI work

const STRUCTURE_LEARN_FORCED_GAP_MS = 10 * 60 * 1000;       // minimum gap for the settings-save path

const STRUCTURE_FAIL_TTL_MS         = 24 * 60 * 60 * 1000;  // remember a 403/404 per (character, structure)

const STRUCTURE_FAIL_BUDGET_PER_HOUR = 20;                  // server-wide cap on FAILED lookups (ESI error budget is per IP)

const structureLearnAt      = new Map();                    // characterId -> last learn attempt that did ESI work (ms)

const structureLookupFailAt = new Map();                    // `${characterId}:${structureId}` -> ms of last 403/404

let   structureFailWindow   = { start: 0, count: 0 };

// Player-structure ids are int64 above the NPC-station range; must be a safe integer to be used in a URL.
const isPlayerStructureId = n => Number.isSafeInteger(n) && n > INT32_MAX_ID;

// A structure's system/type never change, but WHO may know about it does: a cached row is only used
// for a character whose own token has already resolved it (structure_access), otherwise the lookup
// is repeated with that character's token. Only 403/404 are remembered (per character, 24 h) —
// never 429/5xx — and failed lookups are capped server-wide per hour so a malformed or hostile
// client can't burn the shared IP's ESI error budget.
async function lookupStructure(structureId, token, characterId) {
  if (!token || !isPlayerStructureId(structureId)) return null;
  const cid = Number(characterId);

  const known = await dbGet(
    `SELECT k.* FROM known_structures k
       JOIN structure_access a ON a.structure_id = k.structure_id
      WHERE k.structure_id = ? AND a.character_id = ?`,
    [structureId, cid]
  );
  if (known && known.solar_system_id) return known;

  const failKey  = `${cid}:${structureId}`;
  const failedAt = structureLookupFailAt.get(failKey);
  if (failedAt && Date.now() - failedAt < STRUCTURE_FAIL_TTL_MS) return null;

  const now = Date.now();
  if (now - structureFailWindow.start > 3600 * 1000) structureFailWindow = { start: now, count: 0 };
  if (structureFailWindow.count >= STRUCTURE_FAIL_BUDGET_PER_HOUR) return null;

  try {
    const r = await esiFetch(
      `https://esi.evetech.net/latest/universe/structures/${structureId}/?datasource=tranquility`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    );
    // If ESI reports the error budget is getting low, stop making these optional lookups for the hour.
    const remain = parseInt(r.headers.get('x-esi-error-limit-remain') || '', 10);
    if (Number.isFinite(remain) && remain < 30) structureFailWindow.count = STRUCTURE_FAIL_BUDGET_PER_HOUR;

    if (!r.ok) {
      structureFailWindow.count++;
      if (r.status === 403 || r.status === 404) {
        if (structureLookupFailAt.size > 5000) structureLookupFailAt.clear();
        structureLookupFailAt.set(failKey, now);
      }
      return null;
    }
    const d = await r.json();
    if (!Number.isSafeInteger(d.solar_system_id) || !Number.isSafeInteger(d.type_id)) return null;
    const iso = new Date().toISOString();
    await dbRun(
      `INSERT INTO known_structures (structure_id, name, solar_system_id, type_id, owner_id, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(structure_id) DO UPDATE SET
         name = excluded.name, solar_system_id = excluded.solar_system_id,
         type_id = excluded.type_id, owner_id = excluded.owner_id, last_seen = excluded.last_seen`,
      [structureId, String(d.name || '').slice(0, 200), d.solar_system_id, d.type_id,
       Number.isSafeInteger(d.owner_id) ? d.owner_id : null, iso, iso]
    );
    await dbRun(
      `INSERT INTO structure_access (structure_id, character_id, verified_at) VALUES (?, ?, ?)
       ON CONFLICT(structure_id, character_id) DO UPDATE SET verified_at = excluded.verified_at`,
      [structureId, cid, iso]
    );
    return { structure_id: structureId, name: d.name, solar_system_id: d.solar_system_id, type_id: d.type_id, owner_id: d.owner_id };
  } catch (_) {
    return null;   // timeout/network error: not cached, retried on the next (throttled) attempt
  }
}

async function recordFitReport(characterId, structureId, s) {
  await dbRun(
    `INSERT INTO structure_fit_reports (structure_id, character_id, structure_type_id, system_id, rig_ids, facility_tax, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(structure_id, character_id) DO UPDATE SET
       structure_type_id = excluded.structure_type_id, system_id = excluded.system_id,
       rig_ids = excluded.rig_ids, facility_tax = excluded.facility_tax, reported_at = excluded.reported_at`,
    [structureId, characterId, s.structure_type_id, s.system_id, s.rig_ids || '[]', s.facility_tax || 0, new Date().toISOString()]
  );
  // Once the real structure is known, the "unidentified" placeholder row is obsolete.
  if (structureId) {
    await dbRun('DELETE FROM structure_fit_reports WHERE character_id = ? AND structure_id = 0', [characterId]);
  }
}

// Record this character's saved setup against the structure it builds in. The structure is
// identified from the character's own manufacturing jobs: a job's facility_id resolves (via ESI,
// with the character's token) to a system + structure type, and it counts only when exactly one
// facility matches the setup's system and structure type. Ambiguous → stored unidentified (id 0).
async function learnStructureFit(characterId, token, jobs, { force = false } = {}) {
  const cid = Number(characterId);
  // Automatic attempts at most every 6 h after real ESI work; the settings-save path (force) at most
  // every 10 min — so alternating session posts and settings saves can't multiply ESI lookups.
  const minGap = force ? STRUCTURE_LEARN_FORCED_GAP_MS : STRUCTURE_LEARN_INTERVAL_MS;
  if (Date.now() - (structureLearnAt.get(cid) || 0) < minGap) return;

  const s = await dbGet(
    'SELECT system_id, structure_type_id, rig_ids, facility_tax FROM character_industry_settings WHERE character_id = ?',
    [cid]
  );
  if (!s || !s.system_id || !s.structure_type_id) return;

  const counts = new Map();
  for (const j of (Array.isArray(jobs) ? jobs : []).slice(0, 500)) {
    const fid = Number(j?.facilityId ?? j?.facility_id);
    const act = j?.activityId ?? j?.activity_id;
    if (isPlayerStructureId(fid) && act === 1) counts.set(fid, (counts.get(fid) || 0) + 1);
  }
  const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  // Throttle only after real work (ESI lookups). With no jobs yet there is nothing to identify,
  // and the next session post must be free to try again once jobs have loaded.
  if (candidates.length > 0) structureLearnAt.set(cid, Date.now());

  const matches = [];
  for (const fid of candidates) {
    const st = await lookupStructure(fid, token, cid);
    if (st && st.solar_system_id === s.system_id && st.type_id === s.structure_type_id) matches.push(st);
  }
  const matched = matches.length === 1 ? matches[0] : null;

  // No new match: keep the structure we already linked while it still agrees with the saved
  // setup; drop the link if the setup moved to a different system/structure type.
  let structureId = matched ? matched.structure_id : 0;
  if (!matched) {
    const cur = await dbGet('SELECT structure_id FROM character_industry_settings WHERE character_id = ?', [cid]);
    if (cur && cur.structure_id) {
      const st = await dbGet('SELECT solar_system_id, type_id FROM known_structures WHERE structure_id = ?', [cur.structure_id]);
      if (st && st.solar_system_id === s.system_id && st.type_id === s.structure_type_id) {
        structureId = cur.structure_id;
      } else {
        await dbRun('UPDATE character_industry_settings SET structure_id = NULL, structure_name = NULL WHERE character_id = ?', [cid]);
      }
    }
  }

  await recordFitReport(cid, structureId, s);
  if (matched) {
    await dbRun(
      'UPDATE character_industry_settings SET structure_id = ?, structure_name = ? WHERE character_id = ?',
      [matched.structure_id, matched.name || null, cid]
    );
  }
}

module.exports = { INT32_MAX_ID, isPlayerStructureId, lookupStructure, recordFitReport, learnStructureFit };
