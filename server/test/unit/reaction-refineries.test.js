// Reactions in refineries: the Athanor/Tatara and reactor-rig numbers are CCP's own (ESI dogma, SDE), checked 22 Nov 2026:
//   Tatara 35836 strReactionTimeMultiplier (2721) = 0.75, Athanor 35835 has none; rigSize (1547) Athanor 2 = M, Tatara 3 = L
//   Reactor time rigs: RefRigTimeBonus (2713) -20 (I) / -24 (II); material rigs: RefRigMatBonus (2714) -2 / -2.4
//   lowSecModifier 1, nullSecModifier 1.1, no highSecModifier (not allowed in high-sec)
//   Reactions skill (45746) -4%/level; Advanced Industry (3388) does not touch reaction time.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IM = require('../../lib/industry-math');

const ATHANOR = 35835, TATARA = 35836, RAITARU = 35825;
const COMP_TIME_I = 46484, COMP_MAT_I = 46486, COMP_MAT_II = 46487, HYB_TIME_I = 46488, L_EFF_I = 46496, L_EFF_II = 46497;
const COMPOSITE_GROUP = 429, HYBRID_GROUP = 974, BIO_GROUP = 712, FORGED_GROUP = 4096;
const near = (a, b) => expect(a).toBeCloseTo(b, 10);

describe('refinery game data (from CCP)', () => {
  it('Tatara cuts reaction time 25%, Athanor does not; sizes come from rigSize', () => {
    expect(IM.STRUCTURES[TATARA]).toMatchObject({ refinery: true, rigSize: 'L', timeMult: 0.75, matMult: 1, costMult: 1 });
    expect(IM.STRUCTURES[ATHANOR]).toMatchObject({ refinery: true, rigSize: 'M', timeMult: 1, matMult: 1, costMult: 1 });
    expect(IM.STRUCTURE_RIG_SIZE[ATHANOR]).toBe('M');
    expect(IM.STRUCTURE_RIG_SIZE[TATARA]).toBe('L');
    expect(IM.STRUCTURE_RIG_SIZE[RAITARU]).toBe('M');   // engineering complexes unchanged
  });

  it('reactor rig values match the dogma attributes', () => {
    expect(IM.RIGS[COMP_TIME_I]).toMatchObject({ reaction: true, size: 'M', timePct: 20, matPct: 0, sec: { hi: 0, low: 1, null: 1.1 } });
    expect(IM.RIGS[COMP_MAT_I]).toMatchObject({ reaction: true, size: 'M', matPct: 2, timePct: 0 });
    expect(IM.RIGS[COMP_MAT_II].matPct).toBe(2.4);
    expect(IM.RIGS[L_EFF_I]).toMatchObject({ size: 'L', matPct: 2, timePct: 20 });
    expect(IM.RIGS[L_EFF_II]).toMatchObject({ size: 'L', matPct: 2.4, timePct: 24 });
    expect(Object.values(IM.RIGS).filter(r => r.reaction)).toHaveLength(14);
  });

  it('rig coverage follows the SDE affected groups', () => {
    expect(IM.productFamily(428)).toBe('reaction_composite');   // simple (intermediate) reactions
    expect(IM.productFamily(COMPOSITE_GROUP)).toBe('reaction_composite');
    expect(IM.productFamily(4932)).toBe('reaction_composite');
    expect(IM.productFamily(HYBRID_GROUP)).toBe('reaction_hybrid');
    expect(IM.productFamily(BIO_GROUP)).toBe('reaction_biochemical');
    expect(IM.productFamily(FORGED_GROUP)).toBe('reaction_biochemical');
    expect([...IM.RIGS[L_EFF_I].matCovers].sort()).toEqual(['reaction_biochemical', 'reaction_composite', 'reaction_hybrid']);
  });
});

describe('describeSetup with refineries', () => {
  it('fits M reactor rigs to an Athanor and L reactor rigs to a Tatara', () => {
    expect(IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [COMP_TIME_I, COMP_MAT_I], systemSecurity: -0.5 }).rigs).toHaveLength(2);
    expect(IM.describeSetup({ structureTypeId: TATARA, rigIds: [L_EFF_I], systemSecurity: -0.5 }).rigs).toHaveLength(1);
  });

  it('ignores a rig of the wrong size or the wrong kind', () => {
    const wrongSize = IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [L_EFF_I] });
    expect(wrongSize.rigs).toHaveLength(0);
    expect(wrongSize.ignoredRigIds).toEqual([L_EFF_I]);
    expect(IM.describeSetup({ structureTypeId: TATARA, rigIds: [COMP_TIME_I] }).rigs).toHaveLength(0);
    // a reactor rig in an engineering complex, and an engineering rig in a refinery
    expect(IM.describeSetup({ structureTypeId: RAITARU, rigIds: [COMP_TIME_I] }).rigs).toHaveLength(0);
    expect(IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [43866] }).rigs).toHaveLength(0);
  });

  it('scales by the system\'s security; high-sec gives nothing, unknown security uses the lowsec value', () => {
    const rigTime = sec => IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [COMP_TIME_I], systemSecurity: sec }).rigs[0].effTimePct;
    near(rigTime(0.2), 20);
    near(rigTime(-0.4), 22);
    near(rigTime(0.9), 0);
    near(rigTime(null), 20);
  });
});

describe('reactionModifiers', () => {
  const skills = { 45746: 5 };   // Reactions V = -20%

  it('with nothing saved only the Reactions skill applies, and Advanced Industry does nothing', () => {
    const none = IM.describeSetup({});
    near(IM.reactionModifiers(none, COMPOSITE_GROUP, skills).timeMult, 0.8);
    near(IM.reactionModifiers(none, COMPOSITE_GROUP, { ...skills, 3388: 5 }).timeMult, 0.8);
    near(IM.reactionModifiers(none, COMPOSITE_GROUP, skills).matMult, 1);
    near(IM.reactionModifiers(none, COMPOSITE_GROUP, {}).timeMult, 1);
  });

  it('Tatara stacks 25% on the skill; an Athanor adds nothing', () => {
    const tatara  = IM.describeSetup({ structureTypeId: TATARA });
    const athanor = IM.describeSetup({ structureTypeId: ATHANOR });
    near(IM.reactionModifiers(tatara, COMPOSITE_GROUP, skills).timeMult, 0.8 * 0.75);
    near(IM.reactionModifiers(athanor, COMPOSITE_GROUP, skills).timeMult, 0.8);
  });

  it('time rig (null-sec 1.1) on a Tatara: 0.8 x 0.75 x (1 - 0.22) for composites only', () => {
    const setup = IM.describeSetup({ structureTypeId: TATARA, rigIds: [L_EFF_I], systemSecurity: -0.3 });
    near(IM.reactionModifiers(setup, COMPOSITE_GROUP, skills).timeMult, 0.8 * 0.75 * 0.78);
    near(IM.reactionModifiers(setup, HYBRID_GROUP, skills).timeMult, 0.8 * 0.75 * 0.78);   // the L rig covers all three
    near(IM.reactionModifiers(setup, 12345, skills).timeMult, 0.8 * 0.75);                  // a group no reactor rig covers
  });

  it('a composite ME rig does nothing for hybrid products, and ME comes from the rig only', () => {
    const setup = IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [COMP_MAT_II, HYB_TIME_I], systemSecurity: -0.5 });
    near(IM.reactionModifiers(setup, COMPOSITE_GROUP, skills).matMult, 1 - 0.024 * 1.1);
    near(IM.reactionModifiers(setup, HYBRID_GROUP, skills).matMult, 1);
    near(IM.reactionModifiers(setup, HYBRID_GROUP, skills).timeMult, 0.8 * (1 - 0.2 * 1.1));
    expect(IM.reactionModifiers(setup, COMPOSITE_GROUP, skills).costMult).toBe(1);
  });

  it('time-only rig leaves materials alone and vice versa', () => {
    const t = IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [COMP_TIME_I], systemSecurity: 0.2 });
    near(IM.reactionModifiers(t, COMPOSITE_GROUP, {}).matMult, 1);
    const m = IM.describeSetup({ structureTypeId: ATHANOR, rigIds: [COMP_MAT_I], systemSecurity: 0.2 });
    near(IM.reactionModifiers(m, COMPOSITE_GROUP, {}).timeMult, 1);
    near(IM.reactionModifiers(m, COMPOSITE_GROUP, {}).matMult, 0.98);
  });
});

describe('manufacturing is untouched', () => {
  it('an engineering complex setup gives the same numbers as before', () => {
    const setup = IM.describeSetup({ structureTypeId: RAITARU, rigIds: [43866], systemSecurity: 0.2 });
    expect(setup.rigs).toHaveLength(1);
    const mods = IM.modifiersForProduct(setup, 0);
    near(mods.matMult, 0.99);
    near(mods.timeMult, 0.85);
  });
});
