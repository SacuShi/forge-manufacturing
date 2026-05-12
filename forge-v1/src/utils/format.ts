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
 * @example formatISK(47200000)  → "47.2M"
 * @example formatISK(-800000)   → "−0.8M"
 * @example formatISK(4827300000) → "4.8B"
 */
export function formatISK(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';

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
