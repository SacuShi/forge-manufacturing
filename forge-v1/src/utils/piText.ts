// Wording for the PI Colonies "Est. daily value" lines. The numbers come from utils/piMath.ts (CCP's extractor formula
// and schematics). Factories fed by their own planet run only as often as that supply allows (as in game), so a
// shortfall normally means an input the planet makes none of, fed from another planet or bought.

export function fmtQty(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

export interface PiLineForText { label: string; made: number; used: number; net: number; }

/**
 * Hover text for one product line on a planet.
 * @param spareOn  your OTHER planets that have this product spare (made more than their own factories use)
 */
export function piLineTooltip(line: PiLineForText, spareOn: string[]): string {
  const allUsedHere = line.used > 0 && Math.abs(line.net) <= Math.max(1, line.made * 0.01);
  if (allUsedHere) {
    return `${line.label}: this planet makes ${fmtQty(line.made)}/day and its factories use all of it.`;
  }
  if (line.net >= 0) {
    return line.used > 0
      ? `${line.label}: this planet makes ${fmtQty(line.made)}/day; its factories use ${fmtQty(line.used)}/day, leaving ${fmtQty(line.net)}/day spare.`
      : `${line.label}: this planet makes ${fmtQty(line.made)}/day.`;
  }
  const short = -line.net;
  const idlePct = line.used > 0 ? Math.round((short / line.used) * 100) : 100;
  const made = line.made > 0
    ? `this planet makes ${fmtQty(line.made)}/day, but its factories need ${fmtQty(line.used)}/day when they run full time.`
    : `this planet makes none, and its factories need ${fmtQty(line.used)}/day when they run full time.`;
  const gap = line.made > 0
    ? ` Short ${fmtQty(short)}/day: ship that in, or the factories stand idle about ${idlePct}% of the time.`
    : ` Short ${fmtQty(short)}/day: ship it all in, or the factories can't run.`;
  const where = spareOn.length > 0
    ? ` Spare ${line.label} on ${spareOn.join(', ')} — counted there as spare output, so it cancels out in your portfolio total.`
    : ` None of your other planets has spare ${line.label}.`;
  return `${line.label}: ${made}${gap}${where} The negative ISK is the Jita sell value of the missing amount.`;
}
