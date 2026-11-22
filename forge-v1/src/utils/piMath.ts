/**
 * PI maths for the PI Colonies tab. Kept identical to server/lib/pi-colony.js (the AI advisor's copy); both are
 * tested against the same numbers.
 */

// ── Extractors: CCP's published formula ────────────────────────────────────────
// developers.eveonline.com/docs/guides/pi/, "Extraction calculation". For cycle i (cycle time in seconds, as ESI gives it):
//   barWidth  = cycleTime / 900                    (the formula works in 15-minute units)
//   t         = (i + 0.5) × barWidth
//   decay     = qtyPerCycle / (1 + t × 0.012)      (decay factor, dogma attribute 1683)
//   sinStuff  = max((cos(p + t/12) + cos(p/2 + t×0.2) + cos(t×0.5)) / 3, 0),  p = qtyPerCycle^0.7
//   output(i) = barWidth × decay × (1 + 0.8 × sinStuff)   (noise factor, dogma attribute 1687)
// ESI's qty_per_cycle is the 15-minute base value, so a 30-minute cycle starts at about twice it. An earlier version
// left out barWidth and the noise term and understated extraction by about half (Nov 2026).

const DECAY_FACTOR = 0.012;
const NOISE_FACTOR = 0.8;

/** Units each cycle of the program yields, in order. Empty if the program window is unknown or invalid. */
export function extractorCycleOutputs(
  qtyPerCycle: number, cycleTimeSec: number, installTime?: string, expiryTime?: string,
): number[] {
  if (!installTime || !expiryTime || !(qtyPerCycle > 0) || !(cycleTimeSec > 0)) return [];
  const numCycles = Math.floor((Date.parse(expiryTime) - Date.parse(installTime)) / 1000 / cycleTimeSec);
  if (!(numCycles > 0)) return [];
  const barWidth = cycleTimeSec / 900;
  const phaseShift = Math.pow(qtyPerCycle, 0.7);
  const out: number[] = [];
  for (let i = 0; i < numCycles; i++) {
    const t = (i + 0.5) * barWidth;
    const decayValue = qtyPerCycle / (1 + t * DECAY_FACTOR);
    const sinA = Math.cos(phaseShift + t * (1 / 12));
    const sinB = Math.cos(phaseShift / 2 + t * 0.2);
    const sinC = Math.cos(t * 0.5);
    const sinStuff = Math.max((sinA + sinB + sinC) / 3, 0);
    out.push(barWidth * decayValue * (1 + NOISE_FACTOR * sinStuff));
  }
  return out;
}

/** Average units/day over the whole program, or null when the program window is unknown. */
export function extractorUnitsPerDay(
  qtyPerCycle: number, cycleTimeSec: number, installTime?: string, expiryTime?: string,
): number | null {
  const cycles = extractorCycleOutputs(qtyPerCycle, cycleTimeSec, installTime, expiryTime);
  if (!cycles.length) return null;
  return (cycles.reduce((s, v) => s + v, 0) / cycles.length) * (86400 / cycleTimeSec);
}

// ── Colony daily balance ───────────────────────────────────────────────────────

/** CCP's recipe for one schematic (from the server's SDE tables). */
export interface SchematicRecipe {
  outputTypeId: number;
  outputQty:    number;
  cycleTime:    number;              // seconds
  inputs:       Array<{ typeId: number; qty: number }>;
  inputsUnknown?: boolean;           // recipe not in the SDE tables: inputs can't be subtracted
}

export interface FlowPin {
  extractor_details?: {
    product_type_id?: number; qty_per_cycle?: number; cycle_time?: number;
    expiry_time?: string; install_time?: string;
  };
  factory_details?: { schematic_id: number };
}

/**
 * What one colony makes and what its own factories use, per type per day: Map typeId → { made, used }.
 * Running extractors only (no program / finished = nothing). Factories are assumed to run full time,
 * since EVE doesn't report factory state.
 */
export function colonyDailyFlows(
  pins: FlowPin[], recipes: Record<number, SchematicRecipe>, now = Date.now(),
): Map<number, { made: number; used: number }> {
  const flows = new Map<number, { made: number; used: number }>();
  const groups = new Map<number, FactoryGroup>();   // one entry per schematic: its factories' combined runs/day
  const add = (tid: number | undefined, key: 'made' | 'used', n: number) => {
    if (!tid || !(n > 0)) return;
    const f = flows.get(tid) ?? { made: 0, used: 0 };
    f[key] += n;
    flows.set(tid, f);
  };
  for (const pin of pins) {
    const ex = pin.extractor_details;
    if (ex?.product_type_id) {
      const expiry = ex.expiry_time ? Date.parse(ex.expiry_time) : NaN;
      if (!Number.isFinite(expiry) || expiry <= now) continue;
      add(ex.product_type_id, 'made',
        extractorUnitsPerDay(ex.qty_per_cycle ?? 0, ex.cycle_time ?? 0, ex.install_time, ex.expiry_time) ?? 0);
      continue;
    }
    const sid = pin.factory_details?.schematic_id;
    const r = sid ? recipes[sid] : undefined;
    if (!r || !(r.cycleTime > 0)) continue;
    const g = groups.get(sid!) ?? { outputTypeId: r.outputTypeId, outputQty: r.outputQty, inputs: r.inputs, runsPerDay: 0 };
    g.runsPerDay += 86400 / r.cycleTime;
    groups.set(sid!, g);
  }
  runFactoriesOnSupply(flows, [...groups.values()], add);
  return flows;
}

interface FactoryGroup { outputTypeId: number; outputQty: number; inputs: Array<{ typeId: number; qty: number }>; runsPerDay: number; }

/**
 * EVE only cycles a factory when its inputs are there. An input this planet makes (extracted, or made by its own
 * factories) is shared between the factories that use it, and they run only as often as that supply allows — no
 * shortage is invented. An input this planet makes NONE of must come from another planet, so those factories are
 * assumed to be fed and run full time (that input shows as a shortfall). Lower tiers run first. Same rule as
 * server/lib/pi-colony.js.
 */
export function runFactoriesOnSupply(
  flows: Map<number, { made: number; used: number }>, groups: FactoryGroup[],
  add: (tid: number | undefined, key: 'made' | 'used', n: number) => void,
): void {
  const producedHere = new Set(groups.map(g => g.outputTypeId));
  let pending = groups;
  for (let pass = 0; pending.length > 0 && pass < 8; pass++) {
    const waiting = new Set(pending.map(g => g.outputTypeId));
    let ready = pending.filter(g => g.inputs.every(i => !waiting.has(i.typeId) || i.typeId === g.outputTypeId));
    if (ready.length === 0) ready = pending;
    const demand = new Map<number, number>();
    for (const g of ready) for (const i of g.inputs) demand.set(i.typeId, (demand.get(i.typeId) ?? 0) + g.runsPerDay * i.qty);
    const share = new Map<number, number>();
    for (const [tid, need] of demand) {
      const f = flows.get(tid);
      const made = f?.made ?? 0;
      share.set(tid, made <= 0 && !producedHere.has(tid) ? 1 : Math.min(1, Math.max(0, made - (f?.used ?? 0)) / need));
    }
    for (const g of ready) {
      const u = g.inputs.reduce((m, i) => Math.min(m, share.get(i.typeId) ?? 1), 1);
      add(g.outputTypeId, 'made', g.runsPerDay * u * g.outputQty);
      for (const i of g.inputs) add(i.typeId, 'used', g.runsPerDay * u * i.qty);
    }
    pending = pending.filter(g => !ready.includes(g));
  }
}

/** CCP's customs base value per unit by tier: export tax = base × rate, import tax = half that. */
export const PI_BASE_VALUE: Record<number, number> = { 0: 5, 1: 400, 2: 7200, 3: 60000, 4: 1200000 };

export interface ValueLine {
  typeId:  number;
  tier:    number;
  made:    number;   // per day
  used:    number;   // per day, by this colony's own factories
  net:     number;   // made − used; negative = an input this colony makes none of (fed from another planet)
  grossISK: number;  // net × Jita sell (negative = value of the missing amount)
  taxISK:   number;  // export tax on a surplus, import tax on a shortfall
  netISK:   number;
  hasPrice: boolean;
}

/**
 * Values a colony's daily balance. Only what is left over is worth anything: P0 turned into P1 on the same planet is
 * not counted twice. A shortfall (factory input made elsewhere) counts against this colony at Jita sell plus import
 * tax, so the portfolio total (sum of all colonies) nets out transfers between planets.
 */
export function valueDailyFlows(
  flows: Map<number, { made: number; used: number }>,
  tierOf: (typeId: number) => number,
  sellOf: (typeId: number) => number,
  pocoTaxRate: number,
): ValueLine[] {
  const lines: ValueLine[] = [];
  for (const [typeId, { made, used }] of flows) {
    const net  = made - used;
    const tier = tierOf(typeId);
    const sell = sellOf(typeId);
    const base = PI_BASE_VALUE[tier] ?? 0;
    const grossISK = net * sell;
    const taxISK   = net >= 0 ? net * base * pocoTaxRate : -net * base * pocoTaxRate * 0.5;
    lines.push({ typeId, tier, made, used, net, grossISK, taxISK, netISK: grossISK - taxISK, hasPrice: sell > 0 });
  }
  return lines.sort((a, b) => a.tier - b.tier || b.netISK - a.netISK);
}
