/**
 * FORGE v1.0 — Formatting and colour utilities
 *
 * Pure functions for rendering ISK values, percentages, and
 * deriving semantic colour classes from numeric data.
 * No side effects, no React — safe to use anywhere.
 */

// ── ISK formatting ──────────────────────────────────────────────────────────

/**
 * Formats an ISK amount into a compact human-readable string.
 * Negative values are prefixed with a minus sign.
 *
 * @example formatISK(47200000)      → "47.2M"
 * @example formatISK(-800000)       → "−0.8M"
 * @example formatISK(4827300000)    → "4.8B"
 * @example formatISK(4800000000000) → "4.8T"
 * @example formatISK(null)          → "—"
 */
export function formatISK(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';

  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toLocaleString()}`;
}

/**
 * Formats an ISK-per-hour value with a "/hr" suffix.
 * @example formatISKPerHour(178000000) → "178.0M/hr"
 */
export function formatISKPerHour(value: number): string {
  return `${formatISK(value)}/hr`;
}

/**
 * Like formatISK but appends " ISK" — used in calculation-result panels
 * (e.g. RightSidebar) where the currency unit adds clarity.
 * @example formatISKDisplay(47200000) → "47.2M ISK"
 * @example formatISKDisplay(null)     → "—"
 */
export function formatISKDisplay(value: number | null | undefined): string {
  const base = formatISK(value);
  return base === '—' ? '—' : `${base} ISK`;
}

// ── Semantic colour classes ─────────────────────────────────────────────────

/**
 * Returns a CSS class name corresponding to the semantic colour for a
 * profit margin percentage:
 *   ≥ 25%  → "success"  (green)
 *   10–25% → "warning"  (amber)
 *   < 10%  → "danger"   (red, includes negative)
 */
export function marginColourClass(margin: number): 'success' | 'warning' | 'danger' {
  if (margin >= 25) return 'success';
  if (margin >= 10) return 'warning';
  return 'danger';
}

/**
 * Returns "success" for positive values and "danger" for zero or negative.
 * Used for profit/ISK-per-hour cells.
 */
export function profitColourClass(value: number): 'success' | 'danger' {
  return value > 0 ? 'success' : 'danger';
}

// ── Margin display ──────────────────────────────────────────────────────────

/**
 * Formats a margin percentage with an explicit '+' prefix when positive.
 * @example formatMargin(38.2)  → "+38.2%"
 * @example formatMargin(-1.2)  → "−1.2%"
 */
export function formatMargin(margin: number): string {
  if (margin < 0) return `−${Math.abs(margin).toFixed(1)}%`;
  return `+${margin.toFixed(1)}%`;
}

// ── Market liquidity ──────────────────────────────────────────────────────────

/**
 * Formats a mean daily traded volume into a compact "/day" string.
 * Null/zero means the precompute hasn't enriched this item yet.
 * @example formatPerDay(1843) → "1.8K/day"
 * @example formatPerDay(2)    → "2/day"
 */
export function formatPerDay(volume: number | null | undefined): string {
  if (volume == null || volume <= 0) return '—';
  if (volume >= 1e6) return `${(volume / 1e6).toFixed(1)}M/day`;
  if (volume >= 1e3) return `${(volume / 1e3).toFixed(1)}K/day`;
  if (volume >= 100) return `${Math.round(volume)}/day`;
  // Thin markets: keep one decimal so 1.5/day ≠ 2/day
  return `${volume.toFixed(volume < 10 ? 1 : 0)}/day`;
}

/**
 * Maps a precompute liquidity_risk classification to a display descriptor.
 * `null`/'' means the item passed every liquidity check → liquid.
 * `low_volume` is a soft warning (thin but tradeable); the rest are hard risks.
 */
export function liquidityInfo(risk: string | null | undefined): {
  dot: 'success' | 'warning' | 'danger' | 'muted';
  label: string;
  tip: string;
} {
  switch (risk) {
    case 'low_volume':
      return { dot: 'warning', label: 'Thin', tip: 'Thin market — high margin but slow to liquidate. You may move only a few per day.' };
    case 'contract_only':
      return { dot: 'muted', label: 'Contract', tip: 'Not sold on the regional market — only moves via contracts. Volume figure does not apply.' };
    case 'extreme_margin':
      return { dot: 'danger', label: 'Suspect', tip: 'Margin exceeds 500% — likely a phantom/scam price, not a real spread.' };
    case 'no_buy_orders':
      return { dot: 'danger', label: 'No bids', tip: 'No buy orders against a high sell price — price may be unreliable.' };
    case 'suspicious_spread':
      return { dot: 'danger', label: 'Suspect', tip: 'Spread over 90% — unusual; treat the sell price with caution.' };
    default:
      return { dot: 'success', label: 'Liquid', tip: 'Healthy daily volume for its price tier — should sell at the listed price.' };
  }
}

// ── Build time ───────────────────────────────────────────────────────────────

/**
 * Converts a build time in seconds (as stored in precomputed_profits)
 * into a compact human-readable string.
 * @example formatBuildTime(11520)  → "3h 12m"
 * @example formatBuildTime(2700)   → "45m"
 * @example formatBuildTime(86400)  → "24h"
 */
export function formatBuildTime(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
