/**
 * FORGE v1.1 — MarketSelector component
 *
 * Dropdown for switching between EVE market hubs.
 * Replaces the static "◎ Jita 4-4 ▾" teaser in the Header.
 * Jita is the default; switching to another hub triggers a live price fetch.
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
];

// ── Types ────────────────────────────────────────────────────────────────────

interface MarketSelectorProps {
  selectedMarket: Market;
  onMarketChange: (market: Market) => void;
  loading?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export const MarketSelector: FC<MarketSelectorProps> = ({
  selectedMarket,
  onMarketChange,
  loading = false,
}) => (
  <div className="market-selector">
    <span className="market-selector-icon" aria-hidden="true">◎</span>
    <select
      id="market-select"
      className="market-dropdown"
      value={selectedMarket.id}
      disabled={loading}
      aria-label="Select market hub"
      onChange={(e) => {
        const market = MARKETS.find((m) => m.id === parseInt(e.target.value));
        if (market) onMarketChange(market);
      }}
    >
      {MARKETS.map((market) => (
        <option key={market.id} value={market.id}>
          {market.name}{market.type === 'nullsec' ? ' [NULLSEC]' : ''}
        </option>
      ))}
    </select>
    {loading && <span className="market-selector-loading" aria-label="Loading prices">…</span>}
  </div>
);
