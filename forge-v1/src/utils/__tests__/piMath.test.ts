import { describe, it, expect } from 'vitest';
import { extractorCycleOutputs, extractorUnitsPerDay, colonyDailyFlows, valueDailyFlows, type SchematicRecipe } from '../piMath';

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
