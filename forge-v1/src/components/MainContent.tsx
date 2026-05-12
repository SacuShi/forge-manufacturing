/**
 * FORGE v1.0 — MainContent component
 *
 * Central flex-1 column containing the tab bar and the active tab's content.
 *
 * Tabs:
 *   1. Market Opportunities (default) — sortable ItemTable
 *   2. My Blueprints                  — placeholder for v1.1
 *
 * Owns:
 *   - Active tab state
 *   - Sort field + direction state (passed down to ItemTable)
 *   - Owned filter state (applied before sorting)
 *
 * Selection events bubble up to App via onSelect so the RightSidebar
 * and ItemTable selection highlight stay in sync.
 */

import { useState, useMemo, type FC } from 'react';
import type { MarketItem, TabId, SortField, SortDirection } from '../types';
import ItemTable from './ItemTable';

// ── Types ────────────────────────────────────────────────────────────────────

interface MainContentProps {
  items: MarketItem[];
  selectedTypeId: number | null;
  onSelect: (typeId: number) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

const MainContent: FC<MainContentProps> = ({ items, selectedTypeId, onSelect }) => {
  /* ── Local state ─────────────────────────────────────────────────────────── */
  const [activeTab,     setActiveTab]     = useState<TabId>('market');
  const [sortField,     setSortField]     = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterOwned,   setFilterOwned]   = useState<string>('all');

  /* ── Handlers ────────────────────────────────────────────────────────────── */

  /**
   * Toggle direction when clicking the same column; reset to descending
   * when switching to a new column (highest values first is the natural
   * default for profit/margin/iskPerHour).
   */
  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
  };

  /* ── Derived data ────────────────────────────────────────────────────────── */

  /** Filter then sort the item list; recomputed only when inputs change */
  const displayItems = useMemo<MarketItem[]>(() => {
    let list = [...items];

    if (filterOwned !== 'all') {
      list = list.filter((item) => item.owned === filterOwned);
    }

    list.sort((a, b) => {
      // All SortField values are numeric keys on MarketItem
      const aVal = a[sortField as keyof MarketItem] as number;
      const bVal = b[sortField as keyof MarketItem] as number;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return list;
  }, [items, filterOwned, sortField, sortDirection]);

  const ownedCount = items.filter((i) => i.owned !== '—').length;

  /* ── Render ──────────────────────────────────────────────────────────────── */

  return (
    <main className="main-content" aria-label="Manufacturing data">

      {/* ── Content header ────────────────────────────────────────────────── */}
      <div className="content-header">
        <h1 className="content-title">
          {activeTab === 'market' ? 'Market Opportunities' : 'My Blueprints'}
        </h1>
        <span className="content-meta" aria-live="polite">
          {activeTab === 'market'
            ? `${displayItems.length} item${displayItems.length !== 1 ? 's' : ''} · Jita 4-4 · updated just now`
            : `${ownedCount} blueprints`}
        </span>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="tabs" role="tablist" aria-label="Content area tabs">
        {(['market', 'blueprints'] as TabId[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`tab-${tab}`}
            className="tab-btn"
            aria-selected={activeTab === tab}
            aria-controls={`tabpanel-${tab}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'market' ? 'Market Opportunities' : 'My Blueprints'}
          </button>
        ))}
      </div>

      {/* ── Filter row (market tab only) ──────────────────────────────────── */}
      {activeTab === 'market' && (
        <div className="filter-row">
          <label className="filter-label" htmlFor="owned-filter">
            Owned:
          </label>
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
      )}

      {/* ── Tab panels ────────────────────────────────────────────────────── */}
      <div
        id="tabpanel-market"
        role="tabpanel"
        aria-labelledby="tab-market"
        hidden={activeTab !== 'market'}
        style={{ flex: 1, display: activeTab === 'market' ? 'flex' : 'none', flexDirection: 'column', overflow: 'hidden' }}
      >
        <ItemTable
          items={displayItems}
          selectedTypeId={selectedTypeId}
          sortField={sortField}
          sortDirection={sortDirection}
          onSort={handleSort}
          onSelect={onSelect}
        />
      </div>

      <div
        id="tabpanel-blueprints"
        role="tabpanel"
        aria-labelledby="tab-blueprints"
        hidden={activeTab !== 'blueprints'}
        style={{
          flex: 1,
          display: activeTab === 'blueprints' ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-tertiary)',
          fontSize: '14px',
          opacity: 0.6,
        }}
      >
        Blueprint management coming in v1.1
      </div>

    </main>
  );
};

export default MainContent;
