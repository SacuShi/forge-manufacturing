// Regression (Nov 2026): the AI advisor said players' colonies had "no factory outputs" although every planet ran
// P0 → P1 factories in game. ESI puts a factory pin's schematic id at the top level of the pin and leaves
// factory_details out; FORGE only read factory_details, so every factory was invisible to the AI and the PI tab.
// The pins below follow the live ESI shape (top-level schematic_id, no factory_details on factories).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pinSchematicId, normalisePins, planetDisplayName, summariseColony, buildPiSummary,
  extractorCycleOutputs, extractorUnitsPerDay, colonyDailyFlows, rankPiRecipes,
} = require('../../lib/pi-colony');
const { createAiTools } = require('../../lib/ai-tools');

const NOW = Date.parse('2026-11-21T12:00:00Z');
const HEAVY = 2272, TOXIC = 2400, SCHEM_TOXIC = 131, CC = 2524, LAUNCHPAD = 2544;

// A lava colony: command centre, launchpad, 2 extractors pulling Heavy Metals, 3 basic factories making Toxic Metals.
const lavaColony = {
  planet_id: 40000002, planet_type: 'lava', upgrade_level: 5, num_pins: 7, solar_system_id: 30000001,
  last_update: '2026-11-21T10:00:00Z',
  pins: [
    { pin_id: 1, type_id: CC, contents: [{ type_id: TOXIC, amount: 1200 }] },
    { pin_id: 2, type_id: LAUNCHPAD, contents: [{ type_id: TOXIC, amount: 3000 }, { type_id: HEAVY, amount: 500 }] },
    { pin_id: 3, type_id: 2408, expiry_time: '2026-11-23T00:00:00Z',
      extractor_details: { product_type_id: HEAVY, qty_per_cycle: 4000, cycle_time: 1800, heads: [] } },
    { pin_id: 4, type_id: 2408, expiry_time: '2026-11-20T00:00:00Z',
      extractor_details: { product_type_id: HEAVY, qty_per_cycle: 3000, cycle_time: 1800, heads: [] } },
    { pin_id: 5, type_id: 2469, schematic_id: SCHEM_TOXIC, contents: [{ type_id: HEAVY, amount: 3000 }] },
    { pin_id: 6, type_id: 2469, schematic_id: SCHEM_TOXIC },
    { pin_id: 7, type_id: 2469, schematic_id: SCHEM_TOXIC },
  ],
};

const piData = {
  colonies:       [lavaColony],
  productNames:   { [HEAVY]: { name: 'Heavy Metals', piTier: 0 }, [TOXIC]: { name: 'Toxic Metals', piTier: 1 } },
  schematics:     { [SCHEM_TOXIC]: { name: 'Toxic Metals', cycleTime: 1800 } },
  factoryOutputs: { [SCHEM_TOXIC]: TOXIC },
  prices:         { [HEAVY]: { sell: 3.4, buy: 1 }, [TOXIC]: { sell: 410.6, buy: 350 } },
  planetNames:    { 40000002: 'Tanoo I' },
};

describe('PI factory pins', () => {
  it('reads the schematic id from the top level or from factory_details', () => {
    expect(pinSchematicId({ schematic_id: 131 })).toBe(131);
    expect(pinSchematicId({ factory_details: { schematic_id: 126 } })).toBe(126);
    expect(pinSchematicId({ factory_details: { schematic_id: 126 }, schematic_id: 999 })).toBe(126);
    expect(pinSchematicId({ type_id: CC })).toBeNull();
    expect(pinSchematicId({ schematic_id: 0 })).toBeNull();
  });

  it('copies a top-level schematic id into factory_details without changing other pins', () => {
    const out = normalisePins(lavaColony.pins);
    expect(out.filter(p => p.factory_details?.schematic_id === SCHEM_TOXIC)).toHaveLength(3);
    expect(out[0]).toBe(lavaColony.pins[0]);              // non-factory pin passed through untouched
    expect(lavaColony.pins[4].factory_details).toBeUndefined(); // input not mutated
    expect(normalisePins(undefined)).toEqual([]);
  });

  // Regression (Nov 2026): ESI puts an extractor's expiry_time / install_time on the PIN; the PI tab read them from
  // extractor_details, so every working extractor showed "Not running".
  it('copies extractor program times into extractor_details for the PI tab', () => {
    const pin = { pin_id: 3, type_id: 2408, expiry_time: '2026-11-23T00:00:00Z', install_time: '2026-11-20T00:00:00Z',
      last_cycle_start: '2026-11-21T11:30:00Z', extractor_details: { product_type_id: HEAVY, qty_per_cycle: 4000, cycle_time: 1800 } };
    const [out] = normalisePins([pin]);
    expect(out.extractor_details).toEqual({
      product_type_id: HEAVY, qty_per_cycle: 4000, cycle_time: 1800,
      expiry_time: '2026-11-23T00:00:00Z', install_time: '2026-11-20T00:00:00Z', last_cycle_start: '2026-11-21T11:30:00Z',
    });
    expect(out.expiry_time).toBe('2026-11-23T00:00:00Z');   // pin-level copy kept
    expect(pin.extractor_details.expiry_time).toBeUndefined(); // input not mutated
  });

  it('leaves an extractor with no program without an expiry', () => {
    const pin = { pin_id: 9, type_id: 2408, extractor_details: { product_type_id: HEAVY, qty_per_cycle: 0, cycle_time: 1800 } };
    expect(normalisePins([pin])[0]).toBe(pin);
  });

  it('names planets the way the game does', () => {
    expect(planetDisplayName('Tanoo', 1)).toBe('Tanoo I');
    expect(planetDisplayName('Tanoo', 9)).toBe('Tanoo IX');
    expect(planetDisplayName(undefined, 3)).toBeNull();
  });
});

describe('PI colony summary for the AI advisor', () => {
  it('lists the factories and what they make, not just the P0', () => {
    const c = summariseColony(lavaColony, { ...piData, now: NOW });
    expect(c.planet).toBe('Tanoo I');
    expect(c.ccu_level).toBe(5);
    expect(c.producing).toEqual([{ product: 'Toxic Metals', tier: 'P1', factories: 3, sell: 411, buy: 350 }]);
    expect(c.extracting).toHaveLength(1);
    expect(c.extracting[0]).toMatchObject({
      product: 'Heavy Metals', tier: 'P0', extractors: 2, running: 1, expired: 1, no_program: 0,
      program_ends_in_hours: 36, qty_per_cycle: 7000, sell: 3, buy: 1,
    });
  });

  it('counts an extractor with no program separately from an expired one', () => {
    const idle = { ...lavaColony, pins: [{ pin_id: 9, type_id: 2408, extractor_details: { product_type_id: HEAVY, qty_per_cycle: 0, cycle_time: 1800 } }] };
    expect(summariseColony(idle, { ...piData, now: NOW }).extracting[0])
      .toMatchObject({ extractors: 1, running: 0, expired: 0, no_program: 1, program_ends_in_hours: null });
  });

  it('tells the advisor that factory running state is not reported', () => {
    expect(buildPiSummary(piData, { now: NOW }).note).toMatch(/never say factories are idle/);
  });

  it('counts stored goods but not factory input buffers', () => {
    const c = summariseColony(lavaColony, { ...piData, now: NOW });
    expect(c.stored).toEqual([
      { product: 'Toxic Metals', tier: 'P1', amount: 4200 },
      { product: 'Heavy Metals', tier: 'P0', amount: 500 },
    ]);
  });

  it('reports colony slots and the highest tier produced', () => {
    const s = buildPiSummary(piData, { maxColonies: 5, now: NOW });
    expect(s).toMatchObject({ colony_count: 1, max_colonies: 5, free_colony_slots: 4, factory_count: 3, highest_tier_produced: 'P1' });
    expect(buildPiSummary(piData, { now: NOW })).not.toHaveProperty('max_colonies');
  });
});

describe('get_pi_summary tool', () => {
  const baseDeps = {
    CORP_BP_USABLE_SQL: '', PORT: 0, REGIONS: {}, VALID_REGIONS: [], dbAll: async () => [], dbGet: async () => null,
    ensureCorpDataFresh: async () => {}, esiFetch: async () => ({ ok: false }), getItemPricesAllRegions: async () => ({}),
    hubBooks: {}, resolveViewerCorpAccess: async () => null, security: {},
  };
  const call = (fetch) => createAiTools({ ...baseDeps, fetch }).executeAiTool(
    { name: 'get_pi_summary', input: {} },
    { characterId: 123, req: { headers: { authorization: 'Bearer t' } }, jobs: [], blueprints: [], assets: [] },
  );
  const reply = (status, contentType, body) => async () => ({
    ok: status === 200, status, headers: { get: () => contentType },
    json: async () => JSON.parse(body), text: async () => body,
  });

  it('gives the model the factories ESI reports', async () => {
    const r = await call(reply(200, 'application/json; charset=utf-8', JSON.stringify(piData)));
    expect(r.colonies[0].producing[0]).toMatchObject({ product: 'Toxic Metals', tier: 'P1', factories: 3 });
  });

  it('turns an HTML error page into a plain tool error instead of a JSON parse failure', async () => {
    const r = await call(reply(502, 'text/html', '<!DOCTYPE html><html></html>'));
    expect(r.error).toBe('PI colony data unavailable (HTTP 502)');
  });
});

// ── PI maths (Nov 2026 audit). The same numbers are checked in forge-v1/src/utils/__tests__/piMath.test.ts ────────
// Literal port of CCP's Python reference (developers.eveonline.com/docs/guides/pi/), kept separate from FORGE's code.
function ccpReference(totalCycles, cycleTime, qty) {
  const barWidth = cycleTime / 900.0;
  const out = [];
  for (let cycle = 0; cycle < totalCycles; cycle++) {
    const t = (cycle + 0.5) * barWidth;
    const decayValue = qty / (1 + t * 0.012);
    const phaseShift = Math.pow(qty, 0.7);
    const sinStuff = Math.max((Math.cos(phaseShift + t * (1 / 12)) + Math.cos(phaseShift / 2 + t * 0.2) + Math.cos(t * 0.5)) / 3, 0);
    out.push(barWidth * decayValue * (1 + 0.8 * sinStuff));
  }
  return out;
}
// CCP's documented example: 171000 s program (1d 23h 30m), 30-minute cycles, qty_per_cycle 6965.
const CCP_INSTALL = '2026-11-20T00:00:00.000Z';
const CCP_EXPIRY  = new Date(Date.parse(CCP_INSTALL) + 171000e3).toISOString();

describe('PI maths: extractors follow CCP\'s published formula', () => {
  it('matches CCP\'s reference cycle by cycle', () => {
    const mine = extractorCycleOutputs(6965, 1800, CCP_INSTALL, CCP_EXPIRY);
    const ref  = ccpReference(95, 1800, 6965);
    expect(mine).toHaveLength(95);
    mine.forEach((v, i) => expect(v).toBeCloseTo(ref[i], 9));
  });

  it('averages 398,837 units/day on CCP\'s example (not the flat 334,320 or the half-size decay-only figure)', () => {
    expect(extractorUnitsPerDay(6965, 1800, CCP_INSTALL, CCP_EXPIRY)).toBeCloseTo(398837.3504, 3);
  });

  it('gives no figure when the program window is unknown', () => {
    expect(extractorUnitsPerDay(6965, 1800, undefined, CCP_EXPIRY)).toBeNull();
    expect(extractorUnitsPerDay(6965, 0, CCP_INSTALL, CCP_EXPIRY)).toBeNull();
  });
});

describe('PI maths: colony daily balance', () => {
  // CCP recipe: Toxic Metals (P1) = 3000 Heavy Metals → 20 per 30 minutes.
  const schematicInfo = { [SCHEM_TOXIC]: { outputTypeId: TOXIC, outputQty: 20, cycleTime: 1800, inputs: [{ typeId: HEAVY, qty: 3000 }] } };

  it('counts what factories make and what they use, per day', () => {
    const flows = colonyDailyFlows(lavaColony, { schematicInfo, now: NOW });
    expect(flows.get(TOXIC)).toEqual({ made: 3 * 48 * 20, used: 0 });        // 3 factories × 48 runs × 20
    expect(flows.get(HEAVY).used).toBe(3 * 48 * 3000);                       // 432,000 Heavy Metals a day
    expect(flows.get(HEAVY).made).toBe(0);  // pin 3 has no install_time (window unknown); pin 4 has finished
  });

  it('values P0 turned into P1 on the same planet once, not twice', () => {
    const planet = {
      planet_id: 1, pins: [
        { pin_id: 1, type_id: 2408, install_time: CCP_INSTALL, expiry_time: CCP_EXPIRY,
          extractor_details: { product_type_id: HEAVY, qty_per_cycle: 6965, cycle_time: 1800 } },
        { pin_id: 2, type_id: 2469, schematic_id: SCHEM_TOXIC },
      ],
    };
    const now = Date.parse(CCP_INSTALL) + 3600e3;
    const s = summariseColony(planet, { ...piData, schematicInfo, now });
    const heavy = s.daily_flow.find(l => l.product === 'Heavy Metals');
    const toxic = s.daily_flow.find(l => l.product === 'Toxic Metals');
    expect(heavy).toMatchObject({ made_per_day: 398837, used_per_day: 144000, net_per_day: 254837 });
    expect(toxic).toMatchObject({ made_per_day: 960, used_per_day: 0, net_per_day: 960 });
    // Only the spare Heavy Metals and the Toxic Metals are worth anything.
    expect(s.est_value_per_day).toBe(Math.round(254837.35 * 3.4) + Math.round(960 * 410.6));
    expect(s.extracting[0].est_per_day).toBe(398837);
  });
});

describe('PI maths: market rankings', () => {
  const prices = { 10: { sell: 1000 }, 11: { sell: 900 }, 20: { sell: 30000 }, 30: { sell: 2_000_000 }, 31: { sell: 100_000 } };
  const base = { 0: 5, 1: 400, 2: 7200, 3: 60000, 4: 1200000 };

  it('takes the inputs and both taxes off a P2 recipe', () => {
    const [r] = rankPiRecipes({ recipes: [{ typeId: 20, name: 'P2', tier: 2, outputQty: 5, cycleTime: 3600,
      inputs: [{ typeId: 10, qty: 40, tier: 1 }, { typeId: 11, qty: 40, tier: 1 }] }], prices, baseValue: base, taxRate: 0.1 });
    expect(r.unitsPerDay).toBe(120);                                   // 5 × 24
    expect(r.grossPerDay).toBe(120 * 30000);
    expect(r.inputCostPerDay).toBe(24 * 40 * 1000 + 24 * 40 * 900);    // 960 of each input a day
    expect(r.taxPerDay).toBeCloseTo(120 * 7200 * 0.1 + 1920 * 400 * 0.1 * 0.5, 6);
    expect(r.netPerDay).toBeCloseTo(r.grossPerDay - r.inputCostPerDay - r.taxPerDay, 6);
  });

  it('runs P4 on CCP\'s 1-hour cycle (it was wrongly 24 hours)', () => {
    const [r] = rankPiRecipes({ recipes: [{ typeId: 30, name: 'P4', tier: 4, outputQty: 1, cycleTime: 3600,
      inputs: [{ typeId: 31, qty: 6, tier: 3 }] }], prices, baseValue: base, taxRate: 0 });
    expect(r.unitsPerDay).toBe(24);
    expect(r.netPerDay).toBe(24 * 2_000_000 - 24 * 6 * 100_000);
  });

  it('flags unknown inputs instead of treating them as free', () => {
    const [r] = rankPiRecipes({ recipes: [{ typeId: 20, name: 'P2', tier: 2, outputQty: 5, cycleTime: 3600, inputs: null }], prices, baseValue: base });
    expect(r.inputCostPerDay).toBeNull();
    const [u] = rankPiRecipes({ recipes: [{ typeId: 20, name: 'P2', tier: 2, outputQty: 5, cycleTime: 3600,
      inputs: [{ typeId: 999, qty: 40, tier: 1 }] }], prices, baseValue: base });
    expect(u.inputsPriced).toBe(false);
  });
});

// Same rule as forge-v1/src/utils/piMath.ts: factories fed by their own planet run on that supply (no invented shortfall).
describe('factories run on the supply their own planet makes (server copy)', () => {
  const { runFactoriesOnSupply } = require('../../lib/pi-colony');
  it('Gas planet: 2 Water + 2 Electrolytes feed 3 Coolant → 240 Coolant/day, nothing short', () => {
    const flows = new Map([[2268, { made: 362500, used: 0 }], [2309, { made: 359600, used: 0 }]]);
    const add = (tid, key, n) => { if (!tid || !(n > 0)) return; const f = flows.get(tid) || { made: 0, used: 0 }; f[key] += n; flows.set(tid, f); };
    const p0p1 = (i, o, n) => ({ outputTypeId: o, outputQty: 20, inputs: [{ typeId: i, qty: 3000 }], runsPerDay: 48 * n });
    runFactoriesOnSupply(flows, [p0p1(2268, 3645, 2), p0p1(2309, 2390, 2),
      { outputTypeId: 9832, outputQty: 5, inputs: [{ typeId: 2390, qty: 40 }, { typeId: 3645, qty: 40 }], runsPerDay: 72 }], add);
    expect(flows.get(3645)).toEqual({ made: 1920, used: 1920 });
    expect(flows.get(9832).made).toBeCloseTo(240, 9);
  });
});
