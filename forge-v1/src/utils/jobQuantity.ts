/**
 * Material units a whole manufacturing job needs. EVE rounds ONCE per job (not per run) and
 * never goes below 1 unit per run. Mirrors server/lib/industry-math.js so the shopping list in the
 * sidebar always matches the True Profit figures.
 */
export function jobQuantity(baseQty: number, runs: number, multiplier: number): number {
  const r = Math.max(1, Math.floor(runs) || 1);
  return Math.max(r, Math.ceil(Math.round(baseQty * r * multiplier * 100) / 100));
}
