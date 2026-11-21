'use strict';
// Reading a PI colony layout from ESI (GET /characters/{id}/planets/{planet_id}/) and turning it into
// a plain summary of what the colony really does: what it extracts, what its factories make, what is
// sitting in storage. Pure functions only (no ESI, no database), so they can be unit tested.

// A factory pin's schematic id. ESI's schema has two places for it: `factory_details.schematic_id` and a
// top-level `schematic_id`. Live data puts it at the top level and leaves `factory_details` out, so reading
// only `factory_details` made every factory invisible (Nov 2026). Read both; the nested one wins if present.
function pinSchematicId(pin) {
  const id = pin?.factory_details?.schematic_id ?? pin?.schematic_id;
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Gives every factory pin a `factory_details.schematic_id`, whichever field ESI used, so all code that reads
// `factory_details` (server and PI tab) sees the factories. Returns new pin objects; the input is not changed.
function normalisePins(pins) {
  if (!Array.isArray(pins)) return [];
  return pins.map(pin => {
    const sid = pinSchematicId(pin);
    if (!sid || pin.factory_details?.schematic_id === sid) return pin;
    return { ...pin, factory_details: { ...(pin.factory_details || {}), schematic_id: sid } };
  });
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV',
  'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

// "Tanoo I" — the name the game shows: solar system name + the planet's celestial index in Roman numerals.
function planetDisplayName(systemName, planetIndex) {
  if (!systemName || !Number.isInteger(planetIndex) || planetIndex < 1) return null;
  return `${systemName} ${ROMAN[planetIndex] || planetIndex}`;
}

function tierLabel(tier) {
  return Number.isInteger(tier) ? `P${tier}` : null;
}

// One colony → { planet, type, ccu_level, extracting, producing, stored, ... }.
// lookups: productNames {typeId: {name, piTier}}, schematics {sid: {name}}, factoryOutputs {sid: typeId},
//          prices {typeId: {sell, buy}}, planetNames {planetId: name}, now (ms, for extractor expiry).
function summariseColony(colony, lookups = {}) {
  const { productNames = {}, schematics = {}, factoryOutputs = {}, prices = {}, planetNames = {} } = lookups;
  const now = lookups.now ?? Date.now();
  const pins = Array.isArray(colony?.pins) ? colony.pins : [];

  const nameOf  = tid => productNames[tid]?.name || `Type ${tid}`;
  const tierOf  = tid => tierLabel(productNames[tid]?.piTier);
  const priceOf = tid => {
    const p = prices[tid] || {};
    return { sell: Math.round(p.sell || 0), buy: Math.round(p.buy || 0) };
  };

  // Extractors, grouped by the P0 they pull up.
  const extracting = new Map();
  for (const pin of pins) {
    const tid = pin.extractor_details?.product_type_id;
    if (!tid) continue;
    const e = extracting.get(tid) || {
      product: nameOf(tid), tier: tierOf(tid) || 'P0', extractors: 0, running: 0, qty_per_cycle: 0, ...priceOf(tid),
    };
    e.extractors += 1;
    e.qty_per_cycle += pin.extractor_details.qty_per_cycle || 0;
    const expiry = pin.expiry_time ? Date.parse(pin.expiry_time) : NaN;
    if (Number.isFinite(expiry) && expiry > now) e.running += 1;
    extracting.set(tid, e);
  }

  // Factories, grouped by what they make.
  const producing = new Map();
  for (const pin of pins) {
    const sid = pinSchematicId(pin);
    if (!sid) continue;
    const outTid = factoryOutputs[sid];
    const key = outTid || `s${sid}`;
    const f = producing.get(key) || {
      product: outTid ? nameOf(outTid) : (schematics[sid]?.name || `Schematic ${sid}`),
      tier:    outTid ? tierOf(outTid) : null,
      factories: 0,
      ...(outTid ? priceOf(outTid) : { sell: 0, buy: 0 }),
    };
    f.factories += 1;
    producing.set(key, f);
  }

  // Everything held in storage, launchpads and the command centre (not factory input buffers).
  const stored = new Map();
  for (const pin of pins) {
    if (pin.extractor_details || pinSchematicId(pin)) continue;
    for (const c of (pin.contents || [])) {
      if (!c?.type_id || !c.amount) continue;
      const s = stored.get(c.type_id) || { product: nameOf(c.type_id), tier: tierOf(c.type_id), amount: 0 };
      s.amount += c.amount;
      stored.set(c.type_id, s);
    }
  }

  const byTierThenName = (a, b) => String(a.tier).localeCompare(String(b.tier)) || a.product.localeCompare(b.product);

  return {
    planet:      planetNames[colony.planet_id] || colony.planet_name || `Planet ${colony.planet_id}`,
    planet_id:   colony.planet_id,
    type:        colony.planet_type,
    ccu_level:   colony.upgrade_level ?? null,
    num_pins:    pins.length || colony.num_pins || 0,
    extracting:  [...extracting.values()].sort(byTierThenName),
    producing:   [...producing.values()].sort(byTierThenName),
    stored:      [...stored.values()].sort((a, b) => b.amount - a.amount).slice(0, 12),
    last_update: colony.last_update ?? null,
    ...(colony.error ? { error: 'Layout could not be read from ESI for this planet' } : {}),
  };
}

// The get_pi_summary tool result: every colony plus totals the advisor can quote directly.
function buildPiSummary(piData, { maxColonies = null, now } = {}) {
  const colonies = Array.isArray(piData?.colonies) ? piData.colonies : [];
  const lookups = {
    productNames:   piData?.productNames   || {},
    schematics:     piData?.schematics     || {},
    factoryOutputs: piData?.factoryOutputs || {},
    prices:         piData?.prices         || {},
    planetNames:    piData?.planetNames    || {},
    now,
  };
  const summary = colonies.map(c => summariseColony(c, lookups));
  const factoryTotal = summary.reduce((n, c) => n + c.producing.reduce((m, p) => m + p.factories, 0), 0);
  const highestTier = summary
    .flatMap(c => c.producing.map(p => p.tier))
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    colony_count: summary.length,
    ...(Number.isInteger(maxColonies) ? { max_colonies: maxColonies, free_colony_slots: Math.max(0, maxColonies - summary.length) } : {}),
    factory_count: factoryTotal,
    highest_tier_produced: highestTier,
    colonies: summary,
    note: 'This is the colony layout exactly as EVE reports it. extracting = extractor heads pulling P0 (running = extractor programs not yet expired). ' +
      'producing = what the factories on that planet make (P1/P2/P3/P4) with how many factories make it. stored = what is sitting in storage, ' +
      'launchpads and the command centre. sell/buy are current Jita prices per unit. EVE only refreshes this data when the player opens ' +
      'the colony in game (see last_update). Describe the player\'s setup from these fields; do not say a planet has no factories if producing lists any. ' +
      'If max_colonies is given, it already accounts for the Interplanetary Consolidation skill. Do not suggest more planets when free_colony_slots is 0.',
  };
}

module.exports = { pinSchematicId, normalisePins, planetDisplayName, summariseColony, buildPiSummary };
