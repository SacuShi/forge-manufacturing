import ForgeWait from './ForgeWait';
import ItemTable from './ItemTable';
import { type MarketItem, type SortField, type SortDirection } from '../types';
import type { FC, Dispatch, SetStateAction } from 'react';

interface MarketTabViewProps {
  activeTab: string;
  displayItems: MarketItem[];
  filterOwned: string;
  handleSort: (field: SortField) => void;
  haulConfigured: boolean;
  marketError: string | null;
  marketHasMore: boolean | undefined;
  marketItems: MarketItem[];
  marketLoading: boolean;
  marketLoadingMore: boolean | undefined;
  marketSearching: boolean;
  marketSearchQuery: string;
  onLoadMoreMarket: (() => void) | undefined;
  onMarketSearch: (query: string) => void;
  onMarketSelect: (typeId: number) => void;
  regionId: number;
  selectedTypeId: number | null;
  setFilterOwned: Dispatch<SetStateAction<string>>;
  sortDirection: SortDirection;
  sortField: SortField;
}

const MarketTabView: FC<MarketTabViewProps> = ({ activeTab, displayItems, filterOwned, handleSort, haulConfigured, marketError, marketHasMore, marketItems, marketLoading, marketLoadingMore, marketSearching, marketSearchQuery, onLoadMoreMarket, onMarketSearch, onMarketSelect, regionId, selectedTypeId, setFilterOwned, sortDirection, sortField }) => {
  return (
    <>
{activeTab === 'market' && (
        <>
          {/* Content header + filter row */}
          <div className="content-header" style={{ padding: '12px 20px 0' }}>
            <h1 className="content-title">Market Opportunities</h1>
            <span className="content-meta" aria-live="polite">
              {marketSearching
                ? 'Searching…'
                : marketSearchQuery.trim().length >= 2
                  ? `${displayItems.length} result${displayItems.length !== 1 ? 's' : ''} for "${marketSearchQuery.trim()}"`
                  : `${displayItems.length} item${displayItems.length !== 1 ? 's' : ''}`}
            </span>
          </div>

          <div className="filter-row" style={{ padding: '8px 20px', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* Name search — server-side, searches full DB */}
            <div style={{ position: 'relative' }}>
              <input
                type="text"
                value={marketSearchQuery}
                onChange={(e) => onMarketSearch(e.target.value)}
                placeholder="Search all items…"
                className="filter-input"
                style={{ width: 170, paddingRight: marketSearchQuery ? 22 : undefined }}
                aria-label="Search all market items"
              />
              {marketSearchQuery && (
                <button
                  type="button"
                  onClick={() => onMarketSearch('')}
                  aria-label="Clear search"
                  style={{
                    position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--color-text-tertiary)', fontSize: 13, lineHeight: 1, padding: 0,
                  }}
                >×</button>
              )}
            </div>

            {/* Ownership pill filters */}
            <div style={{ display: 'flex', gap: 4 }}>
              {(['all', 'can-build', 'BPO', 'BPC'] as const).map((v) => {
                const labels: Record<string, string> = {
                  'all': 'All', 'can-build': '✓ Can Build', 'BPO': 'BPO', 'BPC': 'BPC',
                };
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setFilterOwned(v)}
                    className={`pill-filter${filterOwned === v ? ' active' : ''}`}
                    aria-pressed={filterOwned === v}
                  >
                    {labels[v]}
                  </button>
                );
              })}
            </div>

            {/* Mini stats bar */}
            {marketItems.length > 0 && (() => {
              const buildable  = marketItems.filter((i) => i.canBuild).length;
              const topProfit  = Math.max(...marketItems.map((i) => i.profitPerRun));
              const avgMargin  = marketItems.reduce((s, i) => s + i.margin, 0) / marketItems.length;
              const fmt = (n: number) =>
                n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' :
                n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' :
                n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(Math.round(n));
              return (
                <div className="market-stats-bar">
                  <span><span className="stat-hi">{buildable}</span> buildable now</span>
                  <span className="stat-sep">·</span>
                  <span>Top: <span className="stat-hi">{fmt(topProfit)} ISK</span></span>
                  <span className="stat-sep">·</span>
                  <span>Avg margin: <span className="stat-hi">{avgMargin.toFixed(1)}%</span></span>
                </div>
              );
            })()}
          </div>

          {marketLoading && (
            <ForgeWait
              message="Loading market opportunities…"
              detail="Fetching your blueprints and calculating profitability against live Jita prices — please wait."
              quip="I am cross-referencing 47,000 market orders. I want you to know I find this deeply satisfying."
            />
          )}
          {marketError && !marketLoading && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--color-danger)', fontSize: 13 }}>
              Failed to load market data: {marketError}
            </div>
          )}
          {!marketLoading && !marketError && (
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <ItemTable
                items={displayItems}
                selectedTypeId={selectedTypeId}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleSort}
                onSelect={onMarketSelect}
                showHaulColumn={haulConfigured}
                regionId={regionId}
              />
              {!marketSearchQuery && (marketHasMore || marketLoadingMore) && (
                <div style={{
                  flexShrink: 0,
                  padding: '10px 20px',
                  borderTop: '0.5px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={onLoadMoreMarket}
                    disabled={marketLoadingMore}
                    style={{ letterSpacing: '1px', minWidth: 160 }}
                  >
                    {marketLoadingMore
                      ? <><span className="spin" style={{ display: 'inline-block', marginRight: 6 }}>◈</span>Loading…</>
                      : `Load next 50  ↓`}
                  </button>
                  <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    {marketItems.length} loaded
                  </span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
};

export default MarketTabView;
