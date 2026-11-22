// Deploy 3 of the Nov 2026 CCP-accuracy audit: the AI advisor reads jobs in the shape the browser sends them,
// counts slots the way CCP does, and its prompt no longer carries the wrong facts the audit found.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildPlayerContext } = require('../../lib/ai-context');
const { createAiTools } = require('../../lib/ai-tools');
const IM = require('../../lib/industry-math');

// Session jobs, exactly as useAuth's toActiveJobs builds them
const JOBS = [
  { name: 'Rifter', typeId: 587, quantity: 10, activityId: 1, status: 'active', endDate: '2026-11-23T10:00:00Z', blueprintTypeId: 691 },
  { name: 'Fernite Carbide', typeId: 16673, quantity: 20, activityId: 9, status: 'paused', endDate: '2026-11-23T10:00:00Z' },
  { name: 'Crystallite Alloy', typeId: 16670, quantity: 5, activityId: 11, status: 'ready', endDate: '2026-11-20T10:00:00Z' },
];
const skill = (id, lvl) => ({ skill_id: id, active_skill_level: lvl });
const base = { blueprints: [], assets: [], wallet: 0, total_sp: 0, planets: [], implants: [] };

describe('AI player context', () => {
  it('lists session jobs by name, runs and activity (never "undefined ×undefined")', async () => {
    const ctx = await buildPlayerContext({ ...base, jobs: JOBS, skills: [] });
    expect(ctx).toContain('Rifter ×10 [Manufacturing]');
    expect(ctx).toContain('Fernite Carbide ×20 [Reaction] (paused)');
    expect(ctx).toContain('Crystallite Alloy ×5 [Reaction] (ready)');
    expect(ctx).not.toMatch(/undefined/);
  });
  it('slot counts include the Advanced skills; reprocessing starts from the 50% station base', async () => {
    const skills = [skill(3387, 5), skill(24625, 5), skill(45748, 4), skill(45749, 2), skill(3385, 5), skill(3389, 5)];
    const ctx = await buildPlayerContext({ ...base, jobs: [], skills });
    expect(ctx).toContain('Concurrent mfg jobs: 11');
    expect(ctx).toContain('concurrent reaction jobs: 7');
    expect(ctx).toContain(`${(50 * 1.15 * 1.1).toFixed(1)}%`);
  });
});

describe('get_active_jobs tool', () => {
  const { executeAiTool } = createAiTools({
    CORP_BP_USABLE_SQL: '1=1', PORT: 0, REGIONS: {}, VALID_REGIONS: [], dbAll: async () => [], dbGet: async () => undefined,
    ensureCorpDataFresh: async () => {}, esiFetch: async () => ({ ok: true, json: async () => [] }), fetch: async () => ({ ok: true, json: async () => ({}) }),
    getItemPricesAllRegions: async () => ({}), hubBooks: {}, resolveViewerCorpAccess: async () => ({ allowed: false }), security: {},
  });
  const run = (input) => executeAiTool({ name: 'get_active_jobs', input }, { characterId: 1, req: { headers: {} }, jobs: JOBS, blueprints: [], assets: [] });
  it('filters reactions whether ESI says 9 or 11, and reports the real fields', async () => {
    const r = await run({ activityFilter: 'reaction' });
    expect(r.total).toBe(2);
    expect(r.jobs.map((j) => j.status)).toEqual(['paused', 'ready']);
    const all = await run({});
    expect(all.jobs[0]).toMatchObject({ product: 'Rifter', activity: 'Manufacturing', runs: 10, status: 'active' });
  });
});

describe('shared activity rules', () => {
  it('7 is reverse engineering; 9 and 11 are reactions', () => {
    expect(IM.activityLabel(7)).toBe('Reverse Engineering');
    expect(IM.isReactionActivity(9) && IM.isReactionActivity(11)).toBe(true);
    expect(IM.isReactionActivity(1)).toBe(false);
  });
});

describe('AI prompt facts (audit corrections stay corrected)', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '../../lib/ai-prompt.js'), 'utf8');
  it.each([
    ['no stale 3.6% sales tax', /3\.6% sales tax/],
    ['Advanced Industry gives no slots', /Advanced Industry L5 → 11 slots|21 total/],
    ['reactor rigs do give ME', /no structure\/rig ME bonus/],
    ['capitals can be built in an Azbel', /cannot be built in Raitaru\/Azbel/],
    ['jump freighters are invented', /NOT invented \(Jump Freighters/],
    ['T3 destroyers are not Triglavian', /Triglavian\/Sleeper components/],
    ['P3 is made from P2', /P1\+P2 or P2\+P2/],
  ])('%s', (_label, wrong) => { expect(prompt).not.toMatch(wrong); });
  it('states the structure broker fee and the Amarr discount', () => {
    expect(prompt).toMatch(/0\.5% SCC surcharge/);
    expect(prompt).toMatch(/10 Nov 2026 until 10 May 2027/);
  });
});
