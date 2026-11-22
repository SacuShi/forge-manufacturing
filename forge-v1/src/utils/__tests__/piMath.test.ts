import { describe, it, expect } from 'vitest';
import { extractorCycleOutputs, extractorUnitsPerDay, colonyDailyFlows, valueDailyFlows, runFactoriesOnSupply, type SchematicRecipe } from '../piMath';

// PI maths audit (Nov 2026). The same numbers are checked on the server in server/test/unit/pi-colony.test.js.

// Literal port of CCP's Python reference (developers.eveonline.com/docs/guides/pi/), kept separate from FORGE's code.
function ccpReference(totalCycles: number, cycleTime: number, qty: number): number[] {
  const barWidth = cycleTime / 900.0;
  const out: number[] = [];
  for (let cycle = 0; cycle < totalCycles; cycle++) {
    const t = (cycle + 0.5) * barWidth;
    const decayValue = qty / (1 + t * 0.012);
    const phaseShift = Math.pow(qty, 0.7);
    const sinStuff = Math.max((Math.cos(phaseShift + t * (1 / 12)) + Math.cos(phaseShift / 2 + t * 0.2) + Math.cos(t * 0.5)) / 3, 0);
    out.push(barWidth * decayValue * (1 + 0.8 * sinStuff));
  }
  return out;
}
// CCP's documented example: 171000 s program, 30-minute cycles, qty_per_cycle 6965.
const INSTALL = '2026-11-20T00:00:00.000Z';
const EXPIRY  = new Date(Date.parse(INSTALL) + 171000e3).toISOString();
const NOW     = Date.parse(INSTALL) + 3600e3;

const HEAVY = 2272, TOXIC = 2400, SCHEM = 131;
const recipes: Record<number, SchematicRecipe> = {
  [SCHEM]: { outputTypeId: TOXIC, outputQty: 20, cycleTime: 1800, inputs: [{ typeId: HEAVY, qty: 3000 }] },
};
const extractor = { extractor_details: { product_type_id: HEAVY, qty_per_cycle: 6965, cycle_time: 1800, install_time: INSTALL, expiry_time: EXPIRY } };
const factory   = { factory_details: { schematic_id: SCHEM } };

describe('extractors follow CCP\'s published formula', () => {
  it('matches CCP\'s reference cycle by cycle', () => {
    const mine = extractorCycleOutputs(6965, 1800, INSTALL, EXPIRY);
    const ref  = ccpReference(95, 1800, 6965);
    expect(mine).toHaveLength(95);
    mine.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 9));
  });

  it('averages 398,837 units/day on CCP\'s example', () => {
    expect(extractorUnitsPerDay(6965, 1800, INSTALL, EXPIRY)).toBeCloseTo(398837.3504, 3);
  });

  it('gives no figure when the program window is unknown', () => {
    expect(extractorUnitsPerDay(6965, 1800, undefined, EXPIRY)).toBeNull();
  });
});

describe('colony daily balance', () => {
  const tierOf = (t: number) => (t === TOXIC ? 1 : 0);
  const sellOf = (t: number) => (t === TOXIC ? 410.6 : 3.4);

  it('values P0 turned into P1 on the same planet once, not twice', () => {
    const flows = colonyDailyFlows([extractor, factory], recipes, NOW);
    const lines = valueDailyFlows(flows, tierOf, sellOf, 0);
    const heavy = lines.find(l => l.typeId === HEAVY)!;
    const toxic = lines.find(l => l.typeId === TOXIC)!;
    expect(heavy.made).toBeCloseTo(398837.35, 1);
    expect(heavy.used).toBe(144000);                       // 1 factory × 48 runs × 3000
    expect(heavy.net).toBeCloseTo(254837.35, 1);
    expect(toxic.net).toBe(960);                           // 48 runs × 20
    const total = lines.reduce((s, l) => s + l.netISK, 0);
    expect(total).toBeCloseTo(254837.35 * 3.4 + 960 * 410.6, 0);
  });

  it('ignores extractors whose program has finished', () => {
    const flows = colonyDailyFlows([extractor], recipes, Date.parse(EXPIRY) + 1);
    expect(flows.size).toBe(0);
  });

  it('charges a shortfall at Jita sell plus import tax (half the export rate)', () => {
    const flows = colonyDailyFlows([factory], recipes, NOW);          // factory fed from another planet
    const [heavy] = valueDailyFlows(flows, tierOf, sellOf, 0.1).filter(l => l.typeId === HEAVY);
    expect(heavy.net).toBe(-144000);
    expect(heavy.grossISK).toBeCloseTo(-144000 * 3.4, 6);
    expect(heavy.taxISK).toBeCloseTo(144000 * 5 * 0.1 * 0.5, 6);
    expect(heavy.netISK).toBeCloseTo(-144000 * 3.4 - 144000 * 5 * 0.1 * 0.5, 6);
  });

  it('charges export tax on a surplus', () => {
    const flows = colonyDailyFlows([extractor, factory], recipes, NOW);
    const toxic = valueDailyFlows(flows, tierOf, sellOf, 0.1).find(l => l.typeId === TOXIC)!;
    expect(toxic.taxISK).toBeCloseTo(960 * 400 * 0.1, 6);
  });
});

// Nov 2026: pilots' real cards. EVE only cycles a factory when its inputs are there, so factories fed by the planet's
// own extractors/factories run at the pace that supply allows — the planet is never "short" of something it makes.
// Recipes from CCP's SDE (planetSchematics): P0→P1 3000 → 20 per 1800 s; Coolant / Consumer Electronics 40 + 40 → 5 per 3600 s.
describe('factories run on the supply their own planet makes', () => {
  const AQ = 2268, IONIC = 2309, WATER = 3645, ELEC = 2390, COOLANT = 9832;
  const NONCS = 2306, HEAVY = 2272, CHIRAL = 2401, TOXIC = 2400, CE = 9836;
  const p0p1 = (input: number, output: number, factories: number) => ({ outputTypeId: output, outputQty: 20, inputs: [{ typeId: input, qty: 3000 }], runsPerDay: 48 * factories });
  const p2 = (a: number, b: number, output: number, factories: number) => ({ outputTypeId: output, outputQty: 5, inputs: [{ typeId: a, qty: 40 }, { typeId: b, qty: 40 }], runsPerDay: 24 * factories });
  const run = (extracted: Record<number, number>, groups: Parameters<typeof runFactoriesOnSupply>[1]) => {
    const flows = new Map(Object.entries(extracted).map(([k, v]) => [Number(k), { made: v, used: 0 }]));
    runFactoriesOnSupply(flows, groups, (tid, key, n) => {
      if (!tid || !(n > 0)) return;
      const f = flows.get(tid) ?? { made: 0, used: 0 }; f[key] += n; flows.set(tid, f);
    });
    return flows;
  };

  it('Gas planet: 2 Water + 2 Electrolytes feed 3 Coolant — Coolant runs 2/3 of the time, nothing is short', () => {
    const f = run({ [AQ]: 362_500, [IONIC]: 359_600 }, [p0p1(AQ, WATER, 2), p0p1(IONIC, ELEC, 2), p2(ELEC, WATER, COOLANT, 3)]);
    expect(f.get(WATER)).toEqual({ made: 1920, used: 1920 });
    expect(f.get(ELEC)).toEqual({ made: 1920, used: 1920 });
    expect(f.get(COOLANT)!.made).toBeCloseTo(240, 9);          // not 360: inputs for 2/3 of the runs
    expect(f.get(AQ)!.made - f.get(AQ)!.used).toBeCloseTo(74_500, 6);
  });

  it('Lava planet: 3 Chiral Structures factories get half the Non-CS Crystals they could use, so CE runs half the time', () => {
    const f = run({ [NONCS]: 216_100, [HEAVY]: 455_700 },
      [p0p1(NONCS, CHIRAL, 3), p0p1(HEAVY, TOXIC, 3), p2(TOXIC, CHIRAL, CE, 3)]);
    expect(f.get(NONCS)!.used).toBeCloseTo(216_100, 6);         // all of it, never more
    expect(f.get(CHIRAL)!.made).toBeCloseTo(216_100 / 3000 * 20, 6);
    expect(f.get(CE)!.made).toBeCloseTo(360 * (216_100 / 432_000), 6);
    for (const [, v] of f) expect(v.made - v.used).toBeGreaterThanOrEqual(-1e-6);   // no shortfall anywhere
  });

  it('an input the planet makes none of is shipped in: those factories run full time and show the shortfall', () => {
    const f = run({}, [p2(ELEC, WATER, COOLANT, 1)]);
    expect(f.get(COOLANT)!.made).toBe(120);
    expect(f.get(WATER)).toEqual({ made: 0, used: 960 });
  });
});
