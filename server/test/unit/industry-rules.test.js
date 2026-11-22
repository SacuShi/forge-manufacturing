// CCP-accuracy audit (Nov 2026): industry rules that were wrong, each checked against CCP's data.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IM = require('../../lib/industry-math');
const { inventionChance } = require('../../lib/invention');

describe('job cost per activity', () => {
  it('uses each activity\'s SCC rate (4%, but 2% for ME/TE research since Jul 2025)', () => {
    expect(IM.jobCost({ eiv: 1e6 }).scc).toBe(40000);
    expect(IM.jobCost({ eiv: 1e6, activity: 'reaction' }).scc).toBe(40000);
    expect(IM.jobCost({ eiv: 1e6, activity: 'researching_material_efficiency' }).scc).toBe(20000);
  });

  it('reads the cost index for the right activity (CCP has one per activity)', () => {
    const byActivity = { manufacturing: { 30000142: 0.1728 }, reaction: { 30000142: 0.0014 } };
    expect(IM.costIndexFor(byActivity, 'manufacturing', 30000142)).toBe(0.1728);
    expect(IM.costIndexFor(byActivity, 'reaction', 30000142)).toBe(0.0014);
    expect(IM.costIndexFor(byActivity, 'invention', 30000142)).toBe(0);
  });

  it('charges 0.25% facility tax at NPC stations and caps owner tax at 10%', () => {
    expect(IM.effectiveFacilityTax(null)).toBe(0.0025);
    expect(IM.effectiveFacilityTax({ structure_type_id: null, facility_tax: 5 })).toBe(0.0025);
    expect(IM.effectiveFacilityTax({ structure_type_id: 35825, facility_tax: 2.5 })).toBe(0.025);
    expect(IM.effectiveFacilityTax({ structure_type_id: 35825, facility_tax: 50 })).toBe(0.10);
  });

  it('matches EVE Ref for an invention attempt: base = 2% of the product\'s one-run EIV', () => {
    // EVE Ref /v1/industry/cost?product_id=12003: one-run manufacturing EIV 122,031,103 → job_cost_base 2,440,622.
    const base = IM.scienceJobBase(122031103);
    expect(base).toBeCloseTo(2440622.06, 2);
    const job = IM.jobCost({ eiv: base, sci: 0.0014, activity: 'invention' });
    expect(job.scc).toBeCloseTo(base * 0.04, 6);
    expect(job.system).toBeCloseTo(base * 0.0014, 6);
  });
});

describe('invented T2 blueprints and invention chance', () => {
  it('start at ME 2 / TE 4 (EVE University "Invention")', () => {
    expect(IM.T2_BPC_BASE_ME).toBe(2);
    expect(IM.T2_BPC_BASE_TE).toBe(4);
  });

  it('chance = base × (1 + sciences/30 + encryption/40) × (1 + decryptor%)', () => {
    expect(inventionChance({ baseProbability: 0.3, scienceLevels: [4, 4], encryptionLevel: 4 })).toBeCloseTo(0.3 * (1 + 8 / 30 + 4 / 40), 10);
    expect(inventionChance({ baseProbability: 0.3, scienceLevels: [5, 5], encryptionLevel: 5, decryptorProbMult: 20 }))
      .toBeCloseTo(0.3 * (1 + 10 / 30 + 5 / 40) * 1.2, 10);
    expect(inventionChance({ baseProbability: 0.9, scienceLevels: [5, 5], encryptionLevel: 5, decryptorProbMult: 90 })).toBe(1);
  });
});

describe('reactions', () => {
  it('only the Reactions skill and the refinery change reaction time — not Advanced Industry', () => {
    // CCP dogma: Advanced Industry (3388) never modifies reactionTimeMultiplier (2662).
    expect(IM.reactionTimeMultiplier({ skillMap: { 45746: 5, 3388: 5 } })).toBeCloseTo(0.8, 10);
    expect(IM.reactionTimeMultiplier({ skillMap: { 45746: 5 }, refineryTimeMult: 0.75 })).toBeCloseTo(0.6, 10); // Tatara
  });
});

describe('jobs from either source', () => {
  it('reads the activity id from raw ESI jobs and from the browser\'s ActiveJob shape', () => {
    expect(IM.jobActivityId({ activity_id: 9 })).toBe(9);
    expect(IM.jobActivityId({ activityId: 1 })).toBe(1);
    expect(IM.jobActivityId({})).toBeNull();
  });
});
