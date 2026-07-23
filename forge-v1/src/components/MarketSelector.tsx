/**
 * FORGE v1.1 — MarketSelector component
 *
 * Dropdown for switching between the six known EVE trade hubs.
 *
 * v1.3.0: Accepts an optional `label` prop (e.g. "Source" / "Market") so two
 * instances can be placed side-by-side in the Header for independent material-
 * sourcing and selling-hub selection.
 */

import type { FC } from 'react';
import type { Market } from '../types';

// ── Constants ────────────────────────────────────────────────────────────────

export const MARKETS: Market[] = [
  { id: 10000002, name: 'Jita',      region: 'The Forge',   type: 'hisec'   },
  { id: 10000043, name: 'Amarr',     region: 'Domain',      type: 'hisec'   },
  { id: 10000032, name: 'Dodixie',   region: 'Sinq Laison', type: 'hisec'   },
  { id: 10000042, name: 'Hek',       region: 'Metropolis',  type: 'hisec'   },
  { id: 10000030, name: 'Rens',      region: 'Heimatar',    type: 'hisec'   },
  { id: 10000041, name: 'Syndicate', region: 'Syndicate',   type: 'nullsec' },
  { id: 10099000, name: 'C-J6MT',   region: 'Keepstar',    type: 'nullsec' },
];

// ── Types ────────────────────────────────────────────────────────────────────

interface MarketSelectorProps {
  selectedMarket: Market;
  onMarketChange: (market: Market) => void;
  loading?:       boolean;
  /**
   * Short label rendered before the icon, e.g. "Source" or "Market".
   * When omitted the selector renders without a label (single-hub legacy mode).
   */
  label?:         string;
  /** Accessible label for the <select> element — defaults to `${label} hub`. */
  ariaLabel?:     string;
  /** When true, hides the C-J6MT Keepstar option (user lacks docking rights). */
  hideKeestar?:   boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Returns a tooltip explaining which price is used for this selector role.
 * Both hubs use the lowest sell (ask) price — the tooltip clarifies what
 * that means practically for Source vs Market so the user isn't surprised.
 */
function getTooltip(label: string | undefined, hubName: string): string {
  if (label === 'Buy in') {
    return (
      `Material costs use ${hubName} sell price (lowest ask) — ` +
      `the price you pay to buy ingredients immediately from sell orders. ` +
      `Using buy-order prices would be cheaper but assumes you wait for fills.`
    );
  }
  if (label === 'Sell at') {
    return (
      `Revenue uses ${hubName} sell price (lowest ask) — ` +
      `assumes you list finished goods at the current cheapest price. ` +
      `Actual revenue depends on how aggressively you undercut.`
    );
  }
  return `${hubName} market hub`;
}

export const MarketSelector: FC<MarketSelectorProps> = ({
  selectedMarket,
  onMarketChange,
  loading      = false,
  label,
  ariaLabel,
  hideKeestar  = false,
}) => {
  const visibleMarkets = hideKeestar ? MARKETS.filter(m => m.id !== 10099000) : MARKETS;
  return (
  <div
    className="market-selector"
    title={getTooltip(label, selectedMarket.name)}
  >

    {/* Optional role label — "Source:" or "Market:" */}
    {label && (
      <span className="market-selector-label" aria-hidden="true">
        {label}:
      </span>
    )}

    <span className="market-selector-icon" aria-hidden="true">◎</span>

    <select
      className="market-dropdown"
      value={selectedMarket.id}
      disabled={loading}
      aria-label={ariaLabel ?? (label ? `${label} hub` : 'Select market hub')}
      onChange={(e) => {
        const market = MARKETS.find((m) => m.id === parseInt(e.target.value, 10));
        if (market) onMarketChange(market);
      }}
    >
      {visibleMarkets.map((market) => (
        <option key={market.id} value={market.id}>
          {market.name}{market.type === 'nullsec' ? ' [NULLSEC]' : ''}
        </option>
      ))}
    </select>

    {loading && (
      <span className="market-selector-loading" aria-label="Loading prices">…</span>
    )}
  </div>
  );
};
