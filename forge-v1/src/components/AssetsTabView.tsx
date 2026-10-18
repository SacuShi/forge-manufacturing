import AssetSafetyPanel from './AssetSafetyPanel';
import { itemIconUrl } from '../utils/icons';
import { type EsiAsset } from '../types';
import type { FC, Dispatch, SetStateAction } from 'react';

interface AssetsTabViewProps {
  activeTab: string;
  assetExportSet: Set<string>;
  assetSearch: string;
  assetSort: "qty" | "name" | "location";
  assetSortDir: 1 | -1;
  bpcTypeIds: Set<number>;
  bpoTypeIds: Set<number>;
  expandedLocs: Set<number>;
  hideAssetSafety: boolean;
  lastExportIdx: number | null;
  locationGroups: { locationId: number; items: { name: string; qty: number; typeId: number; locationId: number; }[]; }[];
  locationLabelFor: (id: number) => string | undefined;
  onSelectItem: (typeId: number, name: string) => void;
  rawAssets: EsiAsset[];
  safetyHoldings: { typeId: number; qty: number; }[];
  safetyUnvaluedTypes: number;
  safetyValuable: { typeId: number; qty: number; }[];
  safetyWrapCount: number;
  sendToAppraise: () => void;
  setAssetExportSet: Dispatch<SetStateAction<Set<string>>>;
  setAssetSearch: Dispatch<SetStateAction<string>>;
  setAssetSort: Dispatch<SetStateAction<"qty" | "name" | "location">>;
  setAssetSortDir: Dispatch<SetStateAction<1 | -1>>;
  setExpandedLocs: Dispatch<SetStateAction<Set<number>>>;
  setHideAssetSafety: Dispatch<SetStateAction<boolean>>;
  setLastExportIdx: Dispatch<SetStateAction<number | null>>;
  visibleItemKeys: string[];
}

const AssetsTabView: FC<AssetsTabViewProps> = ({ activeTab, assetExportSet, assetSearch, assetSort, assetSortDir, bpcTypeIds, bpoTypeIds, expandedLocs, hideAssetSafety, lastExportIdx, locationGroups, locationLabelFor, onSelectItem, rawAssets, safetyHoldings, safetyUnvaluedTypes, safetyValuable, safetyWrapCount, sendToAppraise, setAssetExportSet, setAssetSearch, setAssetSort, setAssetSortDir, setExpandedLocs, setHideAssetSafety, setLastExportIdx, visibleItemKeys }) => {
  return (
    <>
{activeTab === 'assets' && (
        <div className="main-panel">
          {/* Usage hint */}
          <div style={{
            fontSize: 11, color: 'var(--color-text-tertiary)',
            marginBottom: 8, lineHeight: 1.5,
          }}>
            Click a line to select it · <strong style={{ color: 'var(--color-text-secondary)' }}>Shift+click</strong> to extend the selection · <strong style={{ color: 'var(--color-text-secondary)' }}>Ctrl+click</strong> to add or remove individual lines · then click <strong style={{ color: 'var(--color-accent-primary)' }}>Appraise →</strong> to value them using FORGE's live market data.
          </div>

          <input
            type="text"
            value={assetSearch}
            onChange={(e) => setAssetSearch(e.target.value)}
            placeholder="Search assets…"
            className="filter-input"
            style={{ width: '100%', marginBottom: 8 }}
            aria-label="Search assets"
          />
          {/* Appraise toolbar — appears when items are selected via Ctrl/Shift+click */}
          {assetExportSet.size > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
              padding: '6px 10px', borderRadius: 4,
              background: 'rgba(212, 150, 14, 0.07)',
              border: '0.5px solid rgba(212, 150, 14, 0.3)',
            }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flex: 1 }}>
                {assetExportSet.size} item{assetExportSet.size !== 1 ? 's' : ''} selected
              </span>
              <button
                onClick={sendToAppraise}
                title="Appraise selected items using FORGE's live market data"
                style={{
                  background: 'rgba(79,195,247,0.12)',
                  color: 'var(--color-accent-primary)',
                  border: '0.5px solid var(--color-accent-primary)',
                  borderRadius: 3, padding: '3px 12px', fontSize: 10,
                  cursor: 'pointer', fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                Appraise →
              </button>
              <button
                onClick={() => { setAssetExportSet(new Set()); setLastExportIdx(null); }}
                title="Clear selection"
                style={{
                  background: 'transparent', color: 'var(--color-text-tertiary)',
                  border: '0.5px solid var(--color-border-light)',
                  borderRadius: 3, padding: '3px 8px', fontSize: 10,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >✕</button>
            </div>
          )}

          {/* Asset Safety: these items can't be used, so they are hidden by default and kept out of every calculation */}
          {(safetyHoldings.length > 0 || safetyWrapCount > 0) && (
            <AssetSafetyPanel holdings={safetyValuable} unvaluedTypes={safetyUnvaluedTypes} wrapCount={safetyWrapCount} hidden={hideAssetSafety} />
          )}

          {/* Sort pills — Location/Qty sorts groups; Item sorts within each group */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
            {(['location', 'qty', 'name'] as const).map((field) => {
              const labels = { location: 'Location', qty: 'Quantity', name: 'Item' };
              const active = assetSort === field;
              return (
                <button
                  key={field}
                  type="button"
                  className={`pill-filter${active ? ' active' : ''}`}
                  aria-pressed={active}
                  onClick={() => {
                    if (active) setAssetSortDir(d => (d === -1 ? 1 : -1));
                    else { setAssetSort(field); setAssetSortDir(field === 'qty' ? -1 : 1); }
                  }}
                >
                  {labels[field]}
                  {active && <span className="sort-arrow">{assetSortDir === -1 ? '↓' : '↑'}</span>}
                </button>
              );
            })}
            {safetyHoldings.length > 0 && (
              <button
                type="button"
                className={`pill-filter${hideAssetSafety ? ' active' : ''}`}
                aria-pressed={hideAssetSafety}
                style={{ marginLeft: 'auto' }}
                title={hideAssetSafety
                  ? 'Asset Safety items are hidden — click to show them'
                  : 'Asset Safety items are shown — click to hide them'}
                onClick={() => { setHideAssetSafety(h => !h); setAssetExportSet(new Set()); setLastExportIdx(null); }}
              >
                {hideAssetSafety ? 'Display' : 'Hide'} Asset Safety items ({safetyHoldings.length})
              </button>
            )}
          </div>
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 250px)' }}>
            {[...locationGroups].sort((a, b) => {
              const dir = assetSortDir;
              if (assetSort === 'qty') {
                const qa = a.items.reduce((s, it) => s + it.qty, 0);
                const qb = b.items.reduce((s, it) => s + it.qty, 0);
                return (qa - qb) * dir;
              }
              // Location sort (default) and Item sort both sort groups by location name
              const la = locationLabelFor(a.locationId) ?? '';
              const lb = locationLabelFor(b.locationId) ?? '';
              return la.localeCompare(lb) * (assetSort === 'name' ? 1 : dir);
            }).map(({ locationId, items }) => {
              const locationLabel = locationLabelFor(locationId);
              const isCollapsed   = !expandedLocs.has(locationId);
              const sortedItems   = assetSort === 'name'
                ? [...items].sort((a, b) => a.name.localeCompare(b.name) * assetSortDir)
                : [...items].sort((a, b) => b.qty - a.qty);
              const totalItems = items.length;

              return (
                <div key={locationId}>
                  {/* Location section header */}
                  <button
                    type="button"
                    className="btn-reset"
                    aria-expanded={!isCollapsed}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      background: 'var(--color-bg-tertiary)',
                      borderBottom: '1px solid var(--color-border)',
                      borderTop: '1px solid var(--color-border)',
                      cursor: 'pointer',
                      userSelect: 'none',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                    }}
                    onClick={() => setExpandedLocs(prev => {
                      const next = new Set(prev);
                      if (next.has(locationId)) next.delete(locationId);
                      else next.add(locationId);
                      return next;
                    })}
                  >
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', minWidth: 10 }}>
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-accent-primary)', flex: 1 }}>
                      {locationLabel ?? '…'}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {totalItems} {totalItems === 1 ? 'item' : 'items'}
                    </span>
                  </button>

                  {/* Item rows within this location */}
                  {!isCollapsed && sortedItems.map(({ name, qty, typeId }, i) => {
                    const itemKey     = `${typeId}:${locationId}`;
                    const isSelected  = assetExportSet.has(itemKey);
                    return (
                      <button
                        type="button"
                        className="btn-reset"
                        aria-pressed={isSelected}
                        key={itemKey}
                        title="Click to select · Shift+click to range-select · Ctrl+click to add/remove"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 12px 6px 28px',
                          borderBottom: '0.5px solid var(--color-border-light)',
                          cursor: 'pointer',
                          userSelect: 'none',
                          background: isSelected
                            ? 'rgba(212, 150, 14, 0.20)'
                            : i % 2 === 0 ? 'var(--color-bg-primary)' : 'var(--color-bg-secondary)',
                          boxShadow: isSelected
                            ? 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)'
                            : undefined,
                        }}
                        onMouseEnter={e => {
                          if (!isSelected)
                            (e.currentTarget as HTMLElement).style.boxShadow = 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)';
                        }}
                        onMouseLeave={e => {
                          if (!isSelected)
                            (e.currentTarget as HTMLElement).style.boxShadow = '';
                        }}
                        onClick={(e) => {
                          const idx = visibleItemKeys.indexOf(itemKey);
                          if (e.shiftKey && lastExportIdx !== null) {
                            // Shift+click: range-select from the last clicked item
                            const lo = Math.min(lastExportIdx, idx);
                            const hi = Math.max(lastExportIdx, idx);
                            setAssetExportSet(prev => {
                              const next = new Set(prev);
                              for (let j = lo; j <= hi; j++) next.add(visibleItemKeys[j]);
                              return next;
                            });
                          } else if (e.ctrlKey || e.metaKey) {
                            // Ctrl+click: toggle this item without affecting others
                            setAssetExportSet(prev => {
                              const next = new Set(prev);
                              if (next.has(itemKey)) next.delete(itemKey); else next.add(itemKey);
                              return next;
                            });
                            setLastExportIdx(idx);
                          } else {
                            // Plain click: single-select this item, open detail panel
                            setAssetExportSet(new Set([itemKey]));
                            setLastExportIdx(idx);
                            onSelectItem(typeId, name);
                          }
                        }}
                      >
                        {/* Fixed-size wrapper preserves layout even when the icon 404s */}
                        <div style={{ width: 28, height: 28, flexShrink: 0, borderRadius: 2, overflow: 'hidden', background: 'var(--color-bg-tertiary)' }}>
                          <img
                            src={itemIconUrl(typeId, 32, bpoTypeIds.has(typeId) ? 'bp' : bpcTypeIds.has(typeId) ? 'bpc' : 'icon')}
                            alt=""
                            loading="lazy"
                            crossOrigin="anonymous"
                            style={{ width: 28, height: 28, display: 'block' }}
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                          />
                        </div>
                        {/* Name + quantity grouped left so qty sits beside the name */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
                          <div style={{
                            fontSize: 12,
                            color: 'var(--color-text-secondary)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}>
                            {name}
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--color-accent-primary)', fontWeight: 500, flexShrink: 0 }}>
                            ×{qty.toLocaleString()}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {locationGroups.length === 0 && (
              <div style={{ color: 'var(--color-text-tertiary)', fontSize: 12,
                padding: 24, textAlign: 'center' }}>
                {rawAssets.length === 0 ? 'No assets found.'
                  : (hideAssetSafety && safetyHoldings.length > 0 && !assetSearch)
                    ? 'Everything you own is locked in Asset Safety (hidden). Switch off “Hide Asset Safety” to see it.'
                    : 'No assets match your search.'}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default AssetsTabView;
