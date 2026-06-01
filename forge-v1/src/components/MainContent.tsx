// FORGE v1.0 — MainContent: market/blueprints/assets/jobs/corp tabs

import { useState, useMemo, useEffect, type FC } from 'react';
import type {
  MarketItem,
  SortField,
  SortDirection,
  EsiBlueprint,
  EsiAsset,
  ActiveJob,
  CorpStatus,
  CorpAccessStatus,
} from '../types';
import ItemTable from './ItemTable';
import CorpTab   from './CorpTab';

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
  onLoadMoreMarket?: () => void;
  marketLoadingMore?: boolean;
  marketHasMore?: boolean;
  /** v1.7 — show Haul/unit column when true (haulage configured in industry settings) */
  haulConfigured?: boolean;
  /** Controlled search query — parent handles the server-side search */
  marketSearchQuery: string;
  marketSearching: boolean;
  onMarketSearch: (query: string) => void;

  // Blueprints/Assets/Jobs tabs
  blueprints: EsiBlueprint[];
  assets: EsiAsset[];
  activeJobs: ActiveJob[];
  itemNames: Map<number, string>;

  /** Called when any item is selected (typeId + name) — opens RightSidebar */
  onSelectItem: (typeId: number, name: string) => void;

  // v1.4.0 — Corp tab props
  token:            string | null;
  corpStatus:       CorpStatus | null;
  accessStatus:     CorpAccessStatus | null;
  corpDataLoading?: boolean;
  /** v1.5 — item_id → character name; populated when alts are loaded; empty = no badges */
  blueprintOwnerMap?: Map<number, string>;
}

// Stable empty map used as the default for blueprintOwnerMap.
// Using `new Map()` inline as a default parameter creates a new reference on every
// render, which would invalidate any memo or effect that lists it as a dependency.
const EMPTY_BP_OWNER_MAP = new Map<number, string>();

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'market',     label: '◈ Market Opportunities' },
  { key: 'blueprints', label: '◈ Your blueprints' },
  { key: 'assets',     label: '◉ Assets' },
  { key: 'jobs',       label: '⚙ Jobs' },
  { key: 'corp',       label: '🏭 Corp' },      // v1.4.0
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
  onLoadMoreMarket,
  marketLoadingMore,
  marketHasMore,
  haulConfigured = false,
  blueprints,
  assets,
  activeJobs,
  itemNames,
  onSelectItem,
  marketSearchQuery,
  marketSearching,
  onMarketSearch,
  token,
  corpStatus,
  accessStatus,
  corpDataLoading,
  blueprintOwnerMap = EMPTY_BP_OWNER_MAP,
}) => {
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterOwned, setFilterOwned] = useState<string>('all');
  const [bpSearch, setBpSearch] = useState('');
  const [bpFilter, setBpFilter] = useState<'all' | 'bpo' | 'bpc'>('all');
  const [bpMetadata, setBpMetadata] = useState<Record<number, number>>({});
  const [assetSearch, setAssetSearch] = useState('');

  const getBpName = (typeId: number) =>
    itemNames.get(typeId) ?? `Blueprint #${typeId}`;

  // Reverse name→typeId map for icon lookups
  const nameToTypeId = useMemo(() => {
    const m = new Map<string, number>();
    itemNames.forEach((name, typeId) => m.set(name.toLowerCase(), typeId));
    return m;
  }, [itemNames]);

  // Blueprint type_id → product type_id (strips " Blueprint" suffix for icon lookup)
  const getProductTypeId = (bpTypeId: number): number | null => {
    const bpName = itemNames.get(bpTypeId);
    if (!bpName) return null;
    const productName = bpName.replace(/ Blueprint$/i, '').toLowerCase();
    return nameToTypeId.get(productName) ?? null;
  };

  const activityLabel = (id: number | undefined): string => {
    switch (id) {
      case 1:  return 'Mfg';
      case 3:  return 'TE Research';
      case 4:  return 'ME Research';
      case 5:  return 'Copying';
      case 8:  return 'Invention';
      case 9:  return 'Reaction';
      case 11: return 'Rev.Eng';
      default: return '';
    }
  };

  useEffect(() => {
    if (!blueprints || blueprints.length === 0) return;

    const typeIds = blueprints.map(b => b.type_id);

    fetch('/api/blueprint-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blueprintTypeIds: typeIds })
    })
      .then(res => res.json())
      .then(metadata => setBpMetadata(metadata))
      .catch(err => console.error('Failed to load blueprint metadata:', err));
  }, [blueprints]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
  };

  const displayItems = useMemo<MarketItem[]>(() => {
    let list = [...marketItems];

    // Ownership pill filter (still applied on top of search results)
    if (filterOwned === 'can-build') {
      list = list.filter((i) => i.canBuild);
    } else if (filterOwned === 'BPO' || filterOwned === 'BPC') {
      list = list.filter((i) => i.owned === filterOwned);
    }

    list.sort((a, b) => {
      const aVal = a[sortField as keyof MarketItem] as number;
      const bVal = b[sortField as keyof MarketItem] as number;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return list;
  }, [marketItems, filterOwned, sortField, sortDirection]);

  // BPO = runs===-1, BPC = runs>=0
  const groupedBps = useMemo(() => {
    const q = bpSearch.trim().toLowerCase();

    // Step 1 — type filter (all / bpo / bpc)
    const filtered = blueprints.filter((b) => {
      const isBpo = b.runs === -1;
      if (bpFilter === 'bpo') return isBpo;
      if (bpFilter === 'bpc') return !isBpo;
      return true;
    });

    // Step 2 — group by type_id
    const groups = new Map<number, typeof blueprints>();
    filtered.forEach((b) => {
      const arr = groups.get(b.type_id);
      if (arr) arr.push(b);
      else groups.set(b.type_id, [b]);
    });

    // Step 3 — name search + sort
    return Array.from(groups.entries())
      .filter(([typeId]) => {
        if (!q) return true;
        return getBpName(typeId).toLowerCase().includes(q);
      })
      .sort(([a], [b]) => getBpName(a).localeCompare(getBpName(b)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprints, bpSearch, bpFilter, itemNames]);

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

  return (
    <main className="main-content" aria-label="Manufacturing data">

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
                showHaulColumn={haulConfigured}
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

          {/* Blueprint list — grouped by type_id */}
          <div className="bp-list">
            {groupedBps.map(([typeId, copies]) => {
              const name          = getBpName(typeId);
              // BPO = all copies have runs===-1 (originals never mix with BPCs in same type_id group)
              const isBpo         = copies[0].runs === -1;
              const metaLevel     = bpMetadata[typeId] ?? 0;
              const isT2          = metaLevel === 1;
              const productTypeId = getProductTypeId(typeId);
              const selectId      = productTypeId ?? typeId;
              const selectName    = name.replace(/ Blueprint$/i, '');

              // For display: use first copy's ME/TE (BPOs have one entry; BPCs may vary)
              const firstCopy = copies[0];

              return (
                <div
                  key={typeId}
                  className="bp-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectItem(selectId, selectName)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(selectId, selectName)}
                >
                  {/* Product icon */}
                  <div className={`bp-icon ${isT2 ? 'bp-icon-t2' : (isBpo ? 'bp-icon-bpo' : 'bp-icon-bpc')}`}>
                    {productTypeId ? (
                      <img
                        src={`https://images.evetech.net/types/${productTypeId}/icon?size=32`}
                        alt={name}
                        width={32}
                        height={32}
                        crossOrigin="anonymous"
                        onError={(e) => {
                          const el = e.currentTarget as HTMLImageElement;
                          el.style.display = 'none';
                          const next = el.nextSibling as HTMLElement | null;
                          if (next) next.style.display = 'inline';
                        }}
                      />
                    ) : null}
                    <span style={{ fontSize: 18, fontWeight: 700, display: productTypeId ? 'none' : 'inline' }}>
                      ◇
                    </span>
                  </div>

                  {/* Name + badges + per-copy runs */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="bp-name">{name}</span>
                    <div className="bp-badges">
                      {isBpo ? (
                        <>
                          <span className="badge-bpo">BPO</span>
                          <span className="badge-me">ME{firstCopy.material_efficiency}</span>
                          <span className="badge-te">TE{firstCopy.time_efficiency}</span>
                        </>
                      ) : (
                        <>
                          <span className="badge-bpc">
                            BPC{copies.length > 1 ? ` ×${copies.length}` : ''}
                          </span>
                          <span className="badge-me">ME{firstCopy.material_efficiency}</span>
                          <span className="badge-te">TE{firstCopy.time_efficiency}</span>
                        </>
                      )}
                      {/* v1.5 — Owner badge: shown when multiple characters are loaded */}
                      {blueprintOwnerMap.size > 0 && blueprintOwnerMap.get(firstCopy.item_id) && (
                        <span className="bp-owner-badge">
                          {blueprintOwnerMap.get(firstCopy.item_id)}
                        </span>
                      )}
                    </div>

                    {/* Per-copy run counts — only for BPCs */}
                    {!isBpo && copies.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                        {copies
                          .slice()
                          .sort((a, b) => b.runs - a.runs)
                          .map((c) => (
                            <span
                              key={c.item_id}
                              style={{
                                fontSize: 10,
                                color: 'var(--color-text-tertiary)',
                                background: 'var(--color-bg-primary)',
                                border: '0.5px solid var(--color-border-light)',
                                borderRadius: 2,
                                padding: '1px 4px',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {c.runs}r
                              {c.material_efficiency !== firstCopy.material_efficiency ||
                               c.time_efficiency     !== firstCopy.time_efficiency
                                ? ` ME${c.material_efficiency} TE${c.time_efficiency}`
                                : ''}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {groupedBps.length === 0 && (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12,
                padding: 24, textAlign: 'center' }}>
                {blueprints.length === 0
                  ? 'No blueprints found in your library.'
                  : 'No blueprints match your search.'}
              </div>
            )}
          </div>
        </div>
      )}

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
            {assetGroups.map(([name, { qty, typeId }]) => (
              <div
                key={typeId}
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

      {activeTab === 'jobs' && (
        <div className="main-panel">
          {activeJobs.length === 0 ? (
            <div style={{ color: 'var(--color-text-tertiary)', fontSize: 13,
              padding: 24, textAlign: 'center' }}>
              No active industry jobs
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeJobs.map((job) => {
                const label = activityLabel(job.activityId);
                return (
                <div
                  key={`${job.name}-${job.remaining}-${job.activityId ?? 0}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`View details for ${job.name}`}
                  onClick={() => onSelectItem(job.typeId, job.name)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(job.typeId, job.name)}
                  style={{
                    background: 'var(--color-bg-tertiary)',
                    border: '0.5px solid var(--color-border-light)',
                    borderRadius: 4,
                    padding: '10px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'border-color 0.1s, background 0.1s',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-accent-primary)';
                    (e.currentTarget as HTMLDivElement).style.background  = 'var(--color-bg-secondary)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-border-light)';
                    (e.currentTarget as HTMLDivElement).style.background  = 'var(--color-bg-tertiary)';
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                    <img
                      src={`https://images.evetech.net/types/${job.typeId}/icon?size=32`}
                      alt={job.name}
                      loading="lazy"
                      crossOrigin="anonymous"
                      style={{ width: 32, height: 32, flexShrink: 0, borderRadius: 2, opacity: 0.9 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {label && (
                        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)',
                          letterSpacing: '0.5px', marginBottom: 2, textTransform: 'uppercase' }}>
                          {label}
                        </div>
                      )}
                      <span style={{ fontSize: 13, color: 'var(--color-text-secondary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                        {job.quantity > 1 ? `×${job.quantity} ` : ''}{job.name}
                      </span>
                    </div>
                  </div>
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
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* v1.4.0 — Corp tab */}
      {activeTab === 'corp' && (
        <CorpTab
          token={token}
          corpStatus={corpStatus}
          accessStatus={accessStatus}
          corpDataLoading={corpDataLoading}
        />
      )}

    </main>
  );
};

export default MainContent;
