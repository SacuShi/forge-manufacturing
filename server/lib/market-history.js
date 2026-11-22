'use strict';
// One reading of CCP's market history (ESI /markets/{region}/history/) for every caller.
//
// ESI returns one row per day ON WHICH THE ITEM TRADED, oldest first; days with no trades are simply
// missing. So "the last 30 rows" can span months for a thin market, and dividing their volume by the
// row count overstates how much sells per day. Daily volume is therefore the total traded in the
// last 30 CALENDAR days divided by 30.
//
// The average price keeps its old meaning — the mean of CCP's daily average price over the most
// recent 30 trading days — because it is a price estimate for items with no live orders, and an
// older trade is still the best evidence of what the item sells for.

const DAY_MS = 86_400_000;

/**
 * @param {Array<{date: string, volume?: number, average?: number}>} history  ESI history rows
 * @param {number} [now]   ms timestamp (tests pass a fixed one)
 * @param {number} [days]  window length in calendar days
 * @returns {{ avgDailyVolume: number, avgPrice: number, tradingDays: number }}
 *   tradingDays = rows with trades inside the calendar window
 */
function summariseHistory(history, now = Date.now(), days = 30) {
  if (!Array.isArray(history) || history.length === 0) return { avgDailyVolume: 0, avgPrice: 0, tradingDays: 0 };
  // Today (UTC) is not over yet and ESI has no row for it: the window is the `days` whole days before it.
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const windowStart = todayStart - days * DAY_MS;
  let volume = 0, tradingDays = 0;
  for (const d of history) {
    const t = Date.parse(d?.date);
    if (!Number.isFinite(t) || t < windowStart || t >= todayStart) continue;
    volume += Number(d.volume) || 0;
    tradingDays++;
  }
  const sorted = [...history].filter(d => Number.isFinite(Date.parse(d?.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const recent = sorted.slice(-30);
  const avgPrice = recent.length > 0 ? recent.reduce((s, d) => s + (Number(d.average) || 0), 0) / recent.length : 0;
  return { avgDailyVolume: volume / days, avgPrice, tradingDays };
}

module.exports = { summariseHistory };
