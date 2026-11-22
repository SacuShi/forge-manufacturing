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

// An extractor's program times. ESI's spec puts expiry_time / install_time / last_cycle_start on the PIN, not in
// extractor_details (which only has cycle_time, heads, head_radius, product_type_id, qty_per_cycle). The PI tab
// read them from extractor_details, so every working extractor showed "Not running" (Nov 2026).
// An extractor with no expiry_time has no program installed.
const EXTRACTOR_TIME_FIELDS = ['expiry_time', 'install_time', 'last_cycle_start'];

// Returns new pin objects (the input is not changed) so that everything reading the nested fields sees them:
//  - every factory pin gets `factory_details.schematic_id`, whichever field ESI used;
//  - every extractor pin gets its program times copied into `extractor_details` as well.
function normalisePins(pins) {
  if (!Array.isArray(pins)) return [];
  return pins.map(pin => {
    let out = pin;
    const sid = pinSchematicId(pin);
    if (sid && pin.factory_details?.schematic_id !== sid) {
      out = { ...out, factory_details: { ...(pin.factory_details || {}), schematic_id: sid } };
    }
    if (pin.extractor_details) {
      const times = {};
      for (const f of EXTRACTOR_TIME_FIELDS) {
        if (pin[f] && !pin.extractor_details[f]) times[f] = pin[f];
      }
      if (Object.keys(times).length) out = { ...out, extractor_details: { ...pin.extractor_details, ...times } };
    }
    return out;
  });
}

// When an extractor's program ends (ms), from the pin or (older shape) extractor_details. null = no program.
function extractorExpiry(pin) {
  const iso = pin?.expiry_time ?? pin?.extractor_details?.expiry_time;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
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

// ── PI maths (kept identical to forge-v1/src/utils/piMath.ts; both are tested against the same numbers) ───────────

// CCP's published extractor formula (developers.eveonline.com/docs/guides/pi/, "Extraction calculation").
// Cycle i yields barWidth × decay × (1 + 0.8 × sinStuff), with barWidth = cycleTime / 900 s. ESI's qty_per_cycle is
// the 15-minute base value, so a 30-minute cycle starts at about twice it.
const PI_DECAY_FACTOR = 0.012; // dogma attribute 1683 default
const PI_NOISE_FACTOR = 0.8;   // dogma attribute 1687 default

function extractorCycleOutputs(qtyPerCycle, cycleTimeSec, installIso, expiryIso) {
  if (!installIso || !expiryIso || !(qtyPerCycle > 0) || !(cycleTimeSec > 0)) return [];
  const numCycles = Math.floor((Date.parse(expiryIso) - Date.parse(installIso)) / 1000 / cycleTimeSec);
  if (!(numCycles > 0)) return [];
  const barWidth = cycleTimeSec / 900;
  const phaseShift = Math.pow(qtyPerCycle, 0.7);
  const out = [];
  for (let i = 0; i < numCycles; i++) {
    const t = (i + 0.5) * barWidth;
    const decayValue = qtyPerCycle / (1 + t * PI_DECAY_FACTOR);
    const sinA = Math.cos(phaseShift + t * (1 / 12));
    const sinB = Math.cos(phaseShift / 2 + t * 0.2);
    const sinC = Math.cos(t * 0.5);
    const sinStuff = Math.max((sinA + sinB + sinC) / 3, 0);
    out.push(barWidth * decayValue * (1 + PI_NOISE_FACTOR * sinStuff));
  }
  return out;
}

// Average units/day over the whole program, or null when the program window is unknown.
function extractorUnitsPerDay(qtyPerCycle, cycleTimeSec, installIso, expiryIso) {
  const cycles = extractorCycleOutputs(qtyPerCycle, cycleTimeSec, installIso, expiryIso);
  if (!cycles.length) return null;
  return (cycles.reduce((s, v) => s + v, 0) / cycles.length) * (86400 / cycleTimeSec);
}

// What one colony makes and uses per day, by type: Map typeId → { made, used }.
// Running extractors only; factories assumed to run full time (EVE doesn't report factory state).
// schematicInfo: { [schematicId]: { outputTypeId, outputQty, cycleTime, inputs: [{ typeId, qty }] } } from CCP data.
function colonyDailyFlows(colony, { schematicInfo = {}, now = Date.now() } = {}) {
  const flows = new Map();
  const groups = new Map();   // one entry per schematic: its factories' combined runs/day
  const add = (tid, key, n) => {
    if (!tid || !(n > 0)) return;
    const f = flows.get(tid) || { made: 0, used: 0 };
    f[key] += n;
    flows.set(tid, f);
  };
  for (const pin of (colony?.pins || [])) {
    const ex = pin.extractor_details;
    if (ex?.product_type_id) {
      const expiry = extractorExpiry(pin);
      if (expiry === null || expiry <= now) continue; // no program, or finished: extracting nothing
      const install = pin.install_time ?? ex.install_time;
      add(ex.product_type_id, 'made', extractorUnitsPerDay(ex.qty_per_cycle, ex.cycle_time, install, pin.expiry_time ?? ex.expiry_time) ?? 0);
      continue;
    }
    const sid = pinSchematicId(pin);
    const s = sid ? schematicInfo[sid] : null;
    if (!s || !(s.cycleTime > 0)) continue;
    const g = groups.get(sid) || { outputTypeId: s.outputTypeId, outputQty: s.outputQty, inputs: s.inputs || [], runsPerDay: 0 };
    g.runsPerDay += 86400 / s.cycleTime;
    groups.set(sid, g);
  }
  runFactoriesOnSupply(flows, [...groups.values()], add);
  return flows;
}

// EVE only cycles a factory when its inputs are there. An input this planet makes (extracted, or made by its own
// factories) is shared between the factories that use it, and they run only as often as that supply allows — no
// shortage is invented. An input this planet makes NONE of must come from another planet, so those factories are
// assumed to be fed and run full time (that input shows as a shortfall). Lower tiers run first.
// Same rule as forge-v1/src/utils/piMath.ts.
function runFactoriesOnSupply(flows, groups, add) {
  const producedHere = new Set(groups.map(g => g.outputTypeId));
  let pending = groups;
  for (let pass = 0; pending.length > 0 && pass < 8; pass++) {
    const waiting = new Set(pending.map(g => g.outputTypeId));
    let ready = pending.filter(g => g.inputs.every(i => !waiting.has(i.typeId) || i.typeId === g.outputTypeId));
    if (ready.length === 0) ready = pending;
    const demand = new Map();
    for (const g of ready) for (const i of g.inputs) demand.set(i.typeId, (demand.get(i.typeId) || 0) + g.runsPerDay * i.qty);
    const share = new Map();
    for (const [tid, need] of demand) {
      const f = flows.get(tid);
      const made = f?.made || 0;
      share.set(tid, made <= 0 && !producedHere.has(tid) ? 1 : Math.min(1, Math.max(0, made - (f?.used || 0)) / need));
    }
    for (const g of ready) {
      const u = g.inputs.reduce((m, i) => Math.min(m, share.has(i.typeId) ? share.get(i.typeId) : 1), 1);
      add(g.outputTypeId, 'made', g.runsPerDay * u * g.outputQty);
      for (const i of g.inputs) add(i.typeId, 'used', g.runsPerDay * u * i.qty);
    }
    pending = pending.filter(g => !ready.includes(g));
  }
}

// Ranks PI factory recipes by net ISK/day for ONE factory running full time.
// recipes: [{ typeId, name, tier, outputQty, cycleTime, inputs: [{ typeId, qty, tier }] | null (unknown) }]
// prices: { typeId: { sell, buy } }, baseValue: { tier: ISK } (POCO base), taxRate: 0..1.
// net = output × sell − inputs × their sell − export tax (output) − import tax (inputs, half the export rate).
function rankPiRecipes({ recipes, prices = {}, baseValue = {}, taxRate = 0.1 }) {
  return recipes.map(r => {
    const runsPerDay  = r.cycleTime > 0 ? 86400 / r.cycleTime : 0;
    const unitsPerDay = runsPerDay * r.outputQty;
    const sell        = prices[r.typeId]?.sell ?? 0;
    const buy         = prices[r.typeId]?.buy  ?? 0;
    const grossPerDay = unitsPerDay * sell;
    const exportTax   = unitsPerDay * (baseValue[r.tier] ?? 0) * taxRate;
    let inputCostPerDay = null;
    let importTax       = 0;
    let inputsPriced    = true;
    if (Array.isArray(r.inputs)) {
      inputCostPerDay = 0;
      for (const inp of r.inputs) {
        const perDay = runsPerDay * inp.qty;
        const inSell = prices[inp.typeId]?.sell ?? 0;
        if (!(inSell > 0)) inputsPriced = false;
        inputCostPerDay += perDay * inSell;
        importTax       += perDay * (baseValue[inp.tier] ?? 0) * taxRate * 0.5;
      }
    }
    const taxPerDay = exportTax + importTax;
    return {
      typeId: r.typeId, name: r.name, tier: r.tier,
      unitsPerDay: Math.round(unitsPerDay),
      sell, buy, grossPerDay,
      inputCostPerDay,                       // null = recipe inputs unknown
      inputsPriced,                          // false = an input has no Jita price, so net is overstated
      taxPerDay,
      netPerDay: grossPerDay - (inputCostPerDay ?? 0) - taxPerDay,
    };
  }).sort((a, b) => b.netPerDay - a.netPerDay);
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
      product: nameOf(tid), tier: tierOf(tid) || 'P0', extractors: 0, running: 0, expired: 0, no_program: 0,
      program_ends_in_hours: null, qty_per_cycle: 0, ...priceOf(tid),
    };
    e.extractors += 1;
    e.qty_per_cycle += pin.extractor_details.qty_per_cycle || 0;
    const expiry = extractorExpiry(pin);
    if (expiry === null) e.no_program += 1;
    else if (expiry <= now) e.expired += 1;
    else {
      e.running += 1;
      const hours = Math.round((expiry - now) / 360_000) / 10; // one decimal
      if (e.program_ends_in_hours === null || hours < e.program_ends_in_hours) e.program_ends_in_hours = hours;
    }
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

  // Daily balance: what the colony makes, what its own factories use, and what is left over (or short).
  // value_per_day = net × Jita sell, before POCO tax (the player's tax rate isn't known here).
  const flows = colonyDailyFlows(colony, { schematicInfo: lookups.schematicInfo || {}, now });
  for (const [tid, e] of extracting) e.est_per_day = Math.round(flows.get(tid)?.made || 0);
  const dailyFlow = [...flows.entries()].map(([tid, f]) => {
    const net = f.made - f.used;
    return {
      product: nameOf(tid), tier: tierOf(tid),
      made_per_day: Math.round(f.made), used_per_day: Math.round(f.used), net_per_day: Math.round(net),
      value_per_day: Math.round(net * (prices[tid]?.sell || 0)),
    };
  }).sort(byTierThenName);

  return {
    planet:      planetNames[colony.planet_id] || colony.planet_name || `Planet ${colony.planet_id}`,
    planet_id:   colony.planet_id,
    type:        colony.planet_type,
    ccu_level:   colony.upgrade_level ?? null,
    num_pins:    pins.length || colony.num_pins || 0,
    extracting:  [...extracting.values()].sort(byTierThenName),
    producing:   [...producing.values()].sort(byTierThenName),
    daily_flow:  dailyFlow,
    est_value_per_day: dailyFlow.reduce((s, l) => s + l.value_per_day, 0),
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
    schematicInfo:  piData?.schematicInfo  || {},
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
    est_value_per_day: summary.reduce((s, c) => s + c.est_value_per_day, 0),
    colonies: summary,
    note: 'This is the colony layout exactly as EVE reports it. extracting = extractor heads pulling P0: running = programs still going ' +
      '(est_per_day uses CCP\'s extractor decay formula over the whole program). daily_flow = per product per day: made, used by that ' +
      'planet\'s own factories, and net. Factories fed by the planet\'s own extractors/factories run only as often as that supply ' +
      'allows (as in game), so a planet is never short of something it makes; a negative net is an input the planet makes NONE of, ' +
      'which must come from another planet or be bought. value_per_day = net × Jita sell, ' +
      'before POCO tax; est_value_per_day adds these up, so P0 turned into P1 on the same planet is not counted twice. Factory figures ' +
      'assume a factory fed from another planet runs full time. extracting status: running = programs still going ' +
      '(program_ends_in_hours = the soonest one to finish), expired = program finished and needs restarting, no_program = no program set. ' +
      'producing = what the factories on that planet make (P1/P2/P3/P4) with how many factories make it. EVE does NOT report whether a ' +
      'factory is mid-cycle or waiting for input, so never say factories are idle, stopped or not running; a factory listed under producing ' +
      'is installed and set to make that product. Only extractor programs have a running/expired status. stored = what is sitting in storage, ' +
      'launchpads and the command centre. sell/buy are current Jita prices per unit. EVE only refreshes this data when the player opens ' +
      'the colony in game (see last_update). Describe the player\'s setup from these fields; do not say a planet has no factories if producing lists any. ' +
      'If max_colonies is given, it already accounts for the Interplanetary Consolidation skill. Do not suggest more planets when free_colony_slots is 0.',
  };
}

module.exports = {
  pinSchematicId, normalisePins, extractorExpiry, planetDisplayName, summariseColony, buildPiSummary,
  extractorCycleOutputs, extractorUnitsPerDay, colonyDailyFlows, runFactoriesOnSupply, rankPiRecipes,
};
