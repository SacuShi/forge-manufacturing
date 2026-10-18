import request from 'supertest';
import { inject } from 'vitest';
import fs from 'node:fs';

const SKILLS = [3380, 3388, 3446, 16622, 11452, 11441, 45746].map((id) => ({ skill_id: id, active_skill_level: 5 }));

/** An authenticated client for one test character (the test preload reads the character id from a header). */
export function as(characterId) {
  const base = () => request(inject('baseUrl'));
  const auth = (r) => r.set('x-test-char', String(characterId)).set('Authorization', 'Bearer test');
  return {
    get: (url) => auth(base().get(url)),
    post: (url, body) => auth(base().post(url)).send(body),
  };
}

export const anonymous = () => request(inject('baseUrl'));

/** Saves industry settings and a session for a character, as the browser does after login. */
export async function login(characterId, { settings = {}, session = {} } = {}) {
  const pilot = as(characterId);
  const s = await pilot.post('/api/industry-settings', {
    system_id: 30000142, system_name: 'Jita', structure_type_id: null, rig_ids: [], facility_tax: 0, ...settings,
  });
  if (s.status !== 200) throw new Error('settings failed: ' + JSON.stringify(s.body));
  const d = await pilot.post('/api/session-data', {
    assets: [], blueprints: [], skills: SKILLS, standings: { factions: {}, corps: {} }, jobs: [], wallet: 1e9, ...session,
  });
  if (d.status !== 200) throw new Error('session failed: ' + JSON.stringify(d.body));
  return pilot;
}

/** Polls an endpoint until the server has warmed its price cache (it answers "loading" until then). */
export async function untilWarm(call, isWarm = (b) => b && b.prices_warm !== false, tries = 40) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await call();
    if (res.status === 200 && isWarm(res.body)) return res;
    await new Promise((r) => setTimeout(r, 500));
  }
  return res;
}

export const upstreamCalls = () => fs.readFileSync(inject('callLogFile'), 'utf8').split('\n').filter(Boolean);
