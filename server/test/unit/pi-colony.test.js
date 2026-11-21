// Regression (Nov 2026): the AI advisor said players' colonies had "no factory outputs" although every planet ran
// P0 → P1 factories in game. ESI puts a factory pin's schematic id at the top level of the pin and leaves
// factory_details out; FORGE only read factory_details, so every factory was invisible to the AI and the PI tab.
// The pins below follow the live ESI shape (top-level schematic_id, no factory_details on factories).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pinSchematicId, normalisePins, planetDisplayName, summariseColony, buildPiSummary } = require('../../lib/pi-colony');
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
    expect(c.extracting).toEqual([{ product: 'Heavy Metals', tier: 'P0', extractors: 2, running: 1, qty_per_cycle: 7000, sell: 3, buy: 1 }]);
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
