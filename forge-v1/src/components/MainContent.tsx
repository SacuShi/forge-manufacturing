/**
 * FORGE v1.0 — MainContent component
 *
 * Central flex-1 column with four tabs:
 *   market     — Sortable profitable items table (/api/top-profitable)
 *   blueprints — ESI blueprint library with ME/TE/runs, search, BPO filter
 *   assets     — ESI asset inventory with search
 *   jobs       — Active manufacturing jobs
 *
 * Tabs are navigated from the LeftSidebar nav, or via the tab bar at top.
 *
 * Owns: sort, filter state for the market tab; search/filter for blueprints.
 * Blueprint names are resolved via the itemNames Map (useItemNames hook).
 */

import { useState, useMemo, type FC } from 'react';
import type {
  MarketItem,
  SortField,
  SortDirection,
  EsiBlueprint,
  EsiAsset,
  ActiveJob,
} from '../types';
import ItemTable from './ItemTable';

// ── Types ────────────────────────────────────────────────────────────────────

interface MainContentProps {
  activeTab: string;
  onTabChange: (tab: string) => void;

  // Market tab
  marketItems: MarketItem[];
  marketLoading: boolean;
  marketError: string | null;
  selectedTypeId: number | null;
  /** Called when a market table row is clicked — only passes typeId */
  onMarketSelect: (typeId: number) => void;

  // Blueprints/Assets/Jobs tabs
  blueprints: EsiBlueprint[];
  assets: EsiAsset[];
  activeJobs: ActiveJob[];
  itemNames: Map<number, string>;

  /** Called when any item is selected (typeId + name) — opens RightSidebar */
  onSelectItem: (typeId: number, name: string) => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'market',     label: '◈ Market Opportunities' },
  { key: 'blueprints', label: '◈ Your blueprints' },
  { key: 'assets',     label: '◉ Assets' },
  { key: 'jobs',       label: '⚙ Jobs' },
];

// ── Component ────────────────────────────────────────────────────────────────

const MainContent: FC<MainContentProps> = ({
  activeTab,
  onTabChange,
  marketItems,
  marketLoading,
  marketError,
  selectedTypeId,
  onMarketSelect,
  blueprints,
  assets,
  activeJobs,
  itemNames,
  onSelectItem,
}) => {
  /* ── Market sort / filter state ─────────────────────────────────────────── */
  const [sortField,     setSortField]     = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterOwned,   setFilterOwned]   = useState<string>('all');

  /* ── Blueprint tab state ─────────────────────────────────────────────────── */
  const [bpSearch, setBpSearch] = useState('');
  const [bpFilter, setBpFilter] = useState<'all' | 'bpo' | 'bpc'>('all');

  /* ── Asset tab state ─────────────────────────────────────────────────────── */
  const [assetSearch, setAssetSearch] = useState('');

  /* ── Helpers ─────────────────────────────────────────────────────────────── */
  const getBpName = (typeId: number) =>
    itemNames.get(typeId) ?? `Blueprint #${typeId}`;

  /* ── Sort handler ────────────────────────────────────────────────────────── */
  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
  };

  /* ── Derived: filtered + sorted market items ─────────────────────────────── */
  const displayItems = useMemo<MarketItem[]>(() => {
    let list = [...marketItems];
    if (filterOwned !== 'all') {
      list = list.filter((i) => i.owned === filterOwned);
    }
    list.sort((a, b) => {
      const aVal = a[sortField as keyof MarketItem] as number;
      const bVal = b[sortField as keyof MarketItem] as number;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return list;
  }, [marketItems, filterOwned, sortField, sortDirection]);

  /* ── Derived: filtered blueprints ───────────────────────────────────────── */
  const filteredBps = useMemo(() => {
    return blueprints
      .filter((b) => {
        const name        = getBpName(b.type_id).toLowerCase();
        const matchSearch = !bpSearch || name.includes(bpSearch.toLowerCase());
        const matchFilter =
          bpFilter === 'all' ||
          (bpFilter === 'bpo' ? b.quantity === -1 : b.quantity > 0);
        return matchSearch && matchFilter;
      })
      .sort((a, b) => getBpName(a.type_id).localeCompare(getBpName(b.type_id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprints, bpSearch, bpFilter, itemNames]);

  /* ── Derived: grouped assets ─────────────────────────────────────────────── */
  const assetGroups = useMemo(() => {
    const g = new Map<string, { qty: number; typeId: number }>();
    assets.forEach((a) => {
      const name = itemNames.get(a.type_id) ?? `Item #${a.type_id}`;
      const prev = g.get(name);
      if (prev) {
        prev.qty += a.quantity;
      } else {
        g.set(name, { qty: a.quantity, typeId: a.type_id });
      }
    });
    return Array.from(g.entries())
      .sort(([, a], [, b]) => b.qty - a.qty)
      .filter(([name]) =>
        !assetSearch || name.toLowerCase().includes(assetSearch.toLowerCase())
      );
  }, [assets, itemNames, assetSearch]);

  /* ── Render ──────────────────────────────────────────────────────────────── */
  return (
    <main className="main-content" aria-label="Manufacturing data">

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div className="main-tabs" role="tablist" aria-label="Content area tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className={`main-tab${activeTab === t.key ? ' active' : ''}`}
            aria-selected={activeTab === t.key}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Market Opportunities ──────────────────────────────────────────── */}
      {activeTab === 'market' && (
        <>
          {/* Content header + filter row */}
          <div className="content-header" style={{ padding: '12px 20px 0' }}>
            <h1 className="content-title">Market Opportunities</h1>
            <span className="content-meta" aria-live="polite">
              {displayItems.length} item{displayItems.length !== 1 ? 's' : ''} · Jita 4-4
            </span>
          </div>

          <div className="filter-row" style={{ padding: '8px 20px' }}>
            <label className="filter-label" htmlFor="owned-filter">Blueprint owned:</label>
            <select
              id="owned-filter"
              className="filter-select"
              value={filterOwned}
              onChange={(e) => setFilterOwned(e.target.value)}
            >
              <option value="all">All</option>
              <option value="BPO">BPO only</option>
              <option value="BPC">BPC only</option>
              <option value="—">Not owned</option>
            </select>
          </div>

          {marketLoading && (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--color-text-tertiary)', fontSize: 13 }}>
              <div className="loading-spinner" style={{ width: 24, height: 24, marginRight: 10 }} />
              Loading market data…
            </div>
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
              />
            </div>
          )}
        </>
      )}

      {/* ── My Blueprints ─────────────────────────────────────────────────── */}
      {activeTab === 'blueprints' && (
        <div className="main-panel">
          {/* Search + filter controls */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            <input
              type="text"
              value={bpSearch}
              onChange={(e) => setBpSearch(e.target.value)}
              placeholder="Search blueprints…"
              className="filter-input"
              style={{ flex: 1 }}
              aria-label="Search blueprints"
            />
            {(['all', 'bpo', 'bpc'] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`btn${bpFilter === f ? ' active' : ''}`}
                onClick={() => setBpFilter(f)}
                style={{ fontSize: 10, padding: '5px 10px', letterSpacing: 1 }}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Blueprint list */}
          <div className="bp-list">
            {filteredBps.map((b) => {
              const name  = getBpName(b.type_id);
              const isBpo = b.quantity === -1;
              return (
                <div
                  key={b.item_id}
                  className="bp-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectItem(b.type_id, name)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(b.type_id, name)}
                >
                  <img
                    className="bp-icon"
                    src={`https://images.evetech.net/types/${b.type_id}/icon?size=32`}
                    alt={name}
                    loading="lazy"
                    crossOrigin="anonymous"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span className="bp-name">{name}</span>
                  <div className="bp-badges">
                    {isBpo
                      ? <span className="badge-bpo">BPO</span>
                      : <span className="badge-bpc">BPC</span>
                    }
                    <span className="badge-me">ME{b.material_efficiency}</span>
                    <span className="badge-te">TE{b.time_efficiency}</span>
                  </div>
                </div>
              );
            })}
            {filteredBps.length === 0 && (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12,
                padding: 24, textAlign: 'center' }}>
                {blueprints.length === 0 ? 'No blueprints found in your library.' : 'No blueprints match your search.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── My Assets ─────────────────────────────────────────────────────── */}
      {activeTab === 'assets' && (
        <div className="main-panel">
          <input
            type="text"
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            placeholder="Search assets…"
            className="filter-input"
            style={{ width: '100%', marginBottom: 10 }}
            aria-label="Search assets"
          />
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 220px)' }}>
            {assetGroups.slice(0, 500).map(([name, { qty, typeId }], i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 4px',
                  borderBottom: '0.5px solid var(--color-border-light)',
                  cursor: 'pointer',
                }}
                onClick={() => onSelectItem(typeId, name)}
              >
                <div style={{ display: 'flex', alignItems: 'center', flex: 1, gap: 8, minWidth: 0 }}>
                  <img
                    src={`https://images.evetech.net/types/${typeId}/icon?size=32`}
                    alt={name}
                    loading="lazy"
                    crossOrigin="anonymous"
                    style={{
                      width: 32,
                      height: 32,
                      flexShrink: 0,
                      borderRadius: 2,
                    }}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span style={{
                    fontSize: 12, color: 'var(--color-text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', flex: 1,
                  }}>
                    {name}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: 'var(--color-accent-primary)',
                  fontWeight: 500, flexShrink: 0, marginLeft: 8 }}>
                  ×{qty.toLocaleString()}
                </span>
              </div>
            ))}
            {assetGroups.length === 0 && (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12,
                padding: 24, textAlign: 'center' }}>
                {assets.length === 0 ? 'No assets found.' : 'No assets match your search.'}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Active Jobs ───────────────────────────────────────────────────── */}
      {activeTab === 'jobs' && (
        <div className="main-panel">
          {activeJobs.length === 0 ? (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13,
              padding: 24, textAlign: 'center' }}>
              No active manufacturing jobs
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeJobs.map((job, i) => (
                <div
                  key={i}
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    border: '0.5px solid var(--color-border-light)',
                    borderRadius: 4,
                    padding: '10px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                    {job.quantity > 1 ? `×${job.quantity} ` : ''}{job.name}
                  </span>
                  <span style={{
                    fontSize: 12,
                    color: job.done ? 'var(--color-success)' : 'var(--color-warning)',
                    fontWeight: 500,
                    flexShrink: 0,
                    marginLeft: 12,
                  }}>
                    {job.remaining}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </main>
  );
};

export default MainContent;
