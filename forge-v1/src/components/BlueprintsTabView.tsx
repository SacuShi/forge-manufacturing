import { itemIconUrl } from '../utils/icons';
import { formatISK, formatMargin } from '../utils/format';
import type { BlueprintProfit, EsiBlueprint } from '../types';
import type { FC, Dispatch, SetStateAction } from 'react';

type BpSortField = 'name' | 'iskPerHour' | 'margin' | 'profit' | 'level';

interface BlueprintsTabViewProps {
  activeTab: string;
  blueprintOwnerMap: Map<number, string>;
  blueprints: EsiBlueprint[];
  bpBuildableOnly: boolean;
  bpFilter: "all" | "bpo" | "bpc";
  bpMetadata: Record<number, { metaLevel: number; productTypeId: number | null; }>;
  bpProfits: Record<number, BlueprintProfit>;
  bpSearch: string;
  bpSort: BpSortField;
  bpSortDir: "asc" | "desc";
  getBpName: (typeId: number) => string;
  getProductTypeIdByName: (bpTypeId: number) => number | null;
  groupedBps: [number, EsiBlueprint[]][];
  handleBpSort: (field: BpSortField) => void;
  onSelectItem: (typeId: number, name: string) => void;
  safetyBlueprintCount: number;
  selectedTypeId: number | null;
  setBpBuildableOnly: Dispatch<SetStateAction<boolean>>;
  setBpFilter: Dispatch<SetStateAction<"all" | "bpo" | "bpc">>;
  setBpSearch: Dispatch<SetStateAction<string>>;
}

const BlueprintsTabView: FC<BlueprintsTabViewProps> = ({ activeTab, blueprintOwnerMap, blueprints, bpBuildableOnly, bpFilter, bpMetadata, bpProfits, bpSearch, bpSort, bpSortDir, getBpName, getProductTypeIdByName, groupedBps, handleBpSort, onSelectItem, safetyBlueprintCount, selectedTypeId, setBpBuildableOnly, setBpFilter, setBpSearch }) => {
  return (
    <>
{activeTab === 'blueprints' && (
        <div className="main-panel">
          {safetyBlueprintCount > 0 && (
            <div className="bp-ownership-note" style={{ marginBottom: 10 }}>
              ⚠ {safetyBlueprintCount.toLocaleString()} blueprint{safetyBlueprintCount === 1 ? ' is' : 's are'} locked in Asset Safety, so {safetyBlueprintCount === 1 ? 'it isn\'t' : 'they aren\'t'} listed
              here and can&apos;t be used to build anything until released (see the Assets tab for the release cost).
            </div>
          )}
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
            <button
              type="button"
              className={`pill-filter${bpBuildableOnly ? ' active' : ''}`}
              onClick={() => setBpBuildableOnly((v) => !v)}
              aria-pressed={bpBuildableOnly}
              title="Owned materials fully cover the build, or your wallet covers the shortfall"
            >
              ✓ Can Build Now
            </button>
          </div>

          {/* Sort controls — same metrics as Market Opportunities (selected hub) */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5, marginRight: 2 }}>
              SORT
            </span>
            {([
              ['iskPerHour', 'ISK/hr'],
              ['margin',     'Margin'],
              ['profit',     'Total ISK'],
              ['level',      'Level'],
              ['name',       'Name'],
            ] as [BpSortField, string][]).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`pill-filter${bpSort === key ? ' active' : ''}`}
                onClick={() => handleBpSort(key)}
                aria-pressed={bpSort === key}
              >
                {label}{bpSort === key ? <span className="sort-arrow">{bpSortDir === 'asc' ? '↑' : '↓'}</span> : ''}
              </button>
            ))}
          </div>

          {/* Blueprint list — grouped by type_id */}
          <div className="bp-list">
            {groupedBps.map(([typeId, copies]) => {
              const name          = getBpName(typeId);
              // BPO = all copies have runs===-1 (originals never mix with BPCs in same type_id group)
              const isBpo         = copies[0].runs === -1;
              const metaLevel     = bpMetadata[typeId]?.metaLevel ?? 0;
              const isT2          = metaLevel === 1;
              const productTypeId = bpMetadata[typeId]?.productTypeId ?? getProductTypeIdByName(typeId);
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
                  data-selected={selectId === selectedTypeId ? 'true' : undefined}
                  onClick={() => onSelectItem(selectId, selectName)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(selectId, selectName)}
                >
                  {/* Blueprint icon — /bp for BPO (blue), /bpc for BPC (pale), or T2 tint via CSS */}
                  <div className={`bp-icon ${isT2 ? 'bp-icon-t2' : (isBpo ? 'bp-icon-bpo' : 'bp-icon-bpc')}`}>
                    <img
                      src={itemIconUrl(typeId, 32, isBpo ? 'bp' : 'bpc')}
                      alt=""
                      width={32}
                      height={32}
                      crossOrigin="anonymous"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
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

                  {/* Profitability metrics (selected hub) — active sort highlighted */}
                  {(() => {
                    const p = bpProfits[typeId];
                    if (!p) {
                      return <div className="bp-metrics bp-metrics-empty">no market<br/>data</div>;
                    }
                    return (
                      <div className="bp-metrics">
                        <div className={`bp-metric${bpSort === 'iskPerHour' ? ' active' : ''}`}>
                          <span className="bp-metric-label">ISK/hr</span>
                          <span className="bp-metric-val" style={{ color: p.iskPerHour > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {formatISK(p.iskPerHour)}
                          </span>
                        </div>
                        <div className={`bp-metric${bpSort === 'margin' ? ' active' : ''}`}>
                          <span className="bp-metric-label">Margin</span>
                          <span className="bp-metric-val">{formatMargin(p.margin)}</span>
                        </div>
                        <div className={`bp-metric${bpSort === 'profit' ? ' active' : ''}`}>
                          <span className="bp-metric-label">Total ISK</span>
                          <span className="bp-metric-val" style={{ color: p.profit > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {formatISK(p.profit)}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
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
    </>
  );
};

export default BlueprintsTabView;
