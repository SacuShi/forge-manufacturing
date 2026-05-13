/**
 * FORGE v1.0 — RightSidebar component
 *
 * Fixed 280px right panel. Shows full item analysis for the selected item.
 *
 * When a blueprint is clicked (selectedTypeId matches an ESI blueprint type_id):
 *   - Shows the PRODUCT icon (not the generic blueprint icon)
 *   - Shows BPO/BPC badge, ME/TE, runs remaining
 *   - Materials list with have/needed tick (✓) or cross (✗)
 *   - Material cost breakdown per ingredient
 *   - Chain items flagged (materials the user can themselves manufacture)
 *
 * Data sources (in priority order):
 *   1. apiDetail (ItemDetailApiResponse) — live from /api/item-details
 *      Contains: price history, market prices, material breakdown, build cost.
 *   2. fallbackDetail (ItemDetail) — derived from top-profitable results.
 *      Shown immediately while apiDetail is loading.
 *
 * Security:
 *   - All icon URLs use numeric typeId only.
 *   - No dangerouslySetInnerHTML.
 */

import { useMemo, type FC } from 'react';
import type { ItemDetail, ItemDetailApiResponse, EsiBlueprint } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

interface RightSidebarProps {
  selectedTypeId:  number | null;
  selectedName:    string;
  /** Fallback: derived from top-profitable data (immediate, no extra fetch) */
  fallbackDetail:  ItemDetail | null;
  /** Live detail from /api/item-details (richer: materials, sparkline, prices) */
  apiDetail:       ItemDetailApiResponse | null;
  detailLoading:   boolean;
  detailError:     string | null;
  detailOpen:      boolean;
  blueprints:      EsiBlueprint[];
  /** Item name map (typeId → name) — used for product icon lookup + chain detection */
  itemNames:       Map<number, string>;
  onClose:         () => void;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ICON_BASE = 'https://images.evetech.net/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatISK(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + 'T ISK';
  if (abs >= 1e9)  return (n / 1e9).toFixed(2) + 'B ISK';
  if (abs >= 1e6)  return (n / 1e6).toFixed(1) + 'M ISK';
  if (abs >= 1e3)  return (n / 1e3).toFixed(0) + 'K ISK';
  return Math.round(n).toLocaleString() + ' ISK';
}

function fmtN(n: number): string {
  return n.toLocaleString();
}

// ── Component ────────────────────────────────────────────────────────────────

const RightSidebar: FC<RightSidebarProps> = ({
  selectedTypeId,
  selectedName,
  fallbackDetail,
  apiDetail,
  detailLoading,
  detailError,
  detailOpen,
  blueprints,
  itemNames,
  onClose,
}) => {
  const sidebarClass = `sidebar-right${detailOpen ? ' detail-open' : ''}`;

  // ── ALL hooks must be called before any early return ─────────────────────

  // Reverse name→typeId map (for product icon + chain item detection)
  const nameToTypeId = useMemo(() => {
    const m = new Map<string, number>();
    itemNames.forEach((name, typeId) => m.set(name.toLowerCase(), typeId));
    return m;
  }, [itemNames]);

  // Set of product type IDs the user can manufacture (for chain item badges)
  const ownedProductTypeIds = useMemo(() => {
    const s = new Set<number>();
    blueprints.forEach((bp) => {
      const bpName = itemNames.get(bp.type_id);
      if (!bpName) return;
      const productName = bpName.replace(/ Blueprint$/i, '').toLowerCase();
      const pid = nameToTypeId.get(productName);
      if (pid) s.add(pid);
    });
    return s;
  }, [blueprints, itemNames, nameToTypeId]);

  // Blueprint detection + product type_id lookup — all computed before any return
  const blueprint        = blueprints.find((b) => b.type_id === (selectedTypeId ?? -1));
  const isBlueprintClick = blueprint !== undefined;
  const isBpo            = blueprint?.quantity === -1;

  const productTypeId = useMemo<number | null>(() => {
    if (!selectedTypeId || !isBlueprintClick) return null;
    const bpName = selectedName || itemNames.get(selectedTypeId) || '';
    const productName = bpName.replace(/ Blueprint$/i, '').toLowerCase();
    return nameToTypeId.get(productName) ?? null;
  }, [selectedTypeId, selectedName, isBlueprintClick, itemNames, nameToTypeId]);

  // Derived display values (safe to compute even when selectedTypeId is null)
  const displayTypeId = (isBlueprintClick && productTypeId) ? productTypeId : (selectedTypeId ?? 0);
  const iconUrl       = selectedTypeId ? `${ICON_BASE}/${displayTypeId}/icon?size=64` : '';
  const rawName       = selectedName || apiDetail?.name || fallbackDetail?.name
                        || (selectedTypeId ? `Item #${selectedTypeId}` : '');
  const displayName   = isBlueprintClick ? rawName.replace(/ Blueprint$/i, '') : rawName;

  /* ── Empty state — rendered AFTER all hooks ──────────────────────────────── */
  if (!selectedTypeId) {
    return (
      <aside className={sidebarClass} aria-label="Item detail">
        <div className="detail-empty">
          <div className="detail-empty-icon" aria-hidden="true">⊕</div>
          <p>Select an item to see its analysis</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={sidebarClass} aria-label={`${displayName} detail analysis`}>
      <div className="detail-panel">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="detail-hero">
          <div className="detail-icon">
            <img
              src={iconUrl}
              alt=""
              width={64}
              height={64}
              crossOrigin="anonymous"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="detail-item-name">{displayName}</div>
            {fallbackDetail && (
              <div className="detail-item-cat">{fallbackDetail.category || 'Manufacturing'}</div>
            )}
            {/* Owned status badge (market-click fallback OR blueprint-click) */}
            {(fallbackDetail || isBlueprintClick) && (() => {
              const owned = isBlueprintClick
                ? (isBpo ? 'BPO' : 'BPC')
                : fallbackDetail?.owned;
              return owned ? (
                <span className={
                  owned === 'BPO' ? 'badge badge-bpo' :
                  owned === 'BPC' ? 'badge badge-bpc' :
                  'badge badge-none'
                }>
                  {owned}
                </span>
              ) : null;
            })()}
          </div>
          <button
            type="button"
            className="detail-close-btn"
            onClick={onClose}
            aria-label="Close detail panel"
          >
            ×
          </button>
        </div>

        {/* ── Blueprint info block (BPO/BPC, ME, TE, Runs) ───────────────── */}
        {blueprint && (
          <div className="detail-section" style={{ paddingBottom: 6 }}>
            <div className="detail-section-heading">Blueprint Details</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 4 }}>
              <div className="stat-card" style={{ textAlign: 'center' }}>
                <div className="stat-card-label">TYPE</div>
                <div className="stat-card-value" style={{ fontSize: 12 }}>
                  {isBpo ? 'BPO' : 'BPC'}
                </div>
              </div>
              <div className="stat-card" style={{ textAlign: 'center' }}>
                <div className="stat-card-label">ME</div>
                <div className="stat-card-value" style={{ color: 'var(--color-success)', fontSize: 12 }}>
                  {blueprint.material_efficiency}%
                </div>
              </div>
              <div className="stat-card" style={{ textAlign: 'center' }}>
                <div className="stat-card-label">TE</div>
                <div className="stat-card-value" style={{ color: 'var(--color-warning)', fontSize: 12 }}>
                  {blueprint.time_efficiency}%
                </div>
              </div>
              <div className="stat-card" style={{ textAlign: 'center' }}>
                <div className="stat-card-label">RUNS</div>
                <div className="stat-card-value" style={{ fontSize: 12 }}>
                  {isBpo ? '∞' : blueprint.runs}
                </div>
              </div>
            </div>
            {!isBpo && (
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {blueprint.runs} run{blueprint.runs !== 1 ? 's' : ''} remaining on this BPC
              </div>
            )}
          </div>
        )}

        {/* ── Loading indicator ───────────────────────────────────────────── */}
        {detailLoading && (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 11, textAlign: 'center', padding: 16 }}>
            <div className="loading-spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
            Loading item details…
          </div>
        )}

        {/* ── API error (non-fatal) ────────────────────────────────────────── */}
        {detailError && !detailLoading && (
          <div style={{ color: 'var(--color-danger)', fontSize: 11, textAlign: 'center', padding: 12 }}>
            ⚠ {detailError}
          </div>
        )}

        {/* ── Live data from /api/item-details ────────────────────────────── */}
        {apiDetail && !detailLoading && (
          <>
            {/* Build readiness badge */}
            {apiDetail.buildInfo && (
              <div style={{ padding: '6px 12px' }}>
                {apiDetail.buildInfo.blueprintOwned && apiDetail.buildInfo.canBuild && (
                  <span className="status-badge can-build">✓ Can Build Now</span>
                )}
                {apiDetail.buildInfo.blueprintOwned && !apiDetail.buildInfo.canBuild && (
                  <span className="status-badge missing">⚠ Missing Materials</span>
                )}
                {!apiDetail.buildInfo.blueprintOwned && (
                  <span className="status-badge no-bp">✗ No Blueprint</span>
                )}
              </div>
            )}

            {/* Price history sparkline */}
            {apiDetail.priceHistory && apiDetail.priceHistory.length > 0 && (() => {
              const prices = apiDetail.priceHistory!.map((d) => d.average);
              const min    = Math.min(...prices);
              const max    = Math.max(...prices);
              const range  = max - min;
              const latest = prices[prices.length - 1];
              return (
                <div className="detail-section">
                  <div className="detail-section-heading">Jita Price (90 Days)</div>
                  <div style={{ color: 'var(--color-success)', fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
                    {formatISK(latest)}
                  </div>
                  <div className="sparkline">
                    {prices.slice(-30).map((p, i) => {
                      const height = range > 0 ? ((p - min) / range) * 100 : 50;
                      return (
                        <div
                          key={i}
                          className="sparkline-bar"
                          style={{ height: `${Math.max(height, 4)}%` }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Current market prices */}
            {apiDetail.currentPrice && (
              <div className="detail-section">
                <div className="detail-section-heading">Current Jita Market</div>
                <div className="price-grid">
                  <div>
                    <div className="price-cell-label">LOWEST SELL</div>
                    <div className="price-cell-value" style={{ color: 'var(--color-danger)' }}>
                      {formatISK(apiDetail.currentPrice.sell)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">MEDIAN</div>
                    <div className="price-cell-value" style={{ color: 'var(--color-accent-primary)' }}>
                      {formatISK(apiDetail.currentPrice.median)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">HIGHEST BUY</div>
                    <div className="price-cell-value" style={{ color: 'var(--color-success)' }}>
                      {formatISK(apiDetail.currentPrice.buy)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Build requirements + materials ───────────────────────────── */}
            {apiDetail.buildInfo && (
              <div className="detail-section">
                <div className="detail-section-heading">
                  Build Requirements
                  <span style={{ float: 'right', fontSize: 10, color: 'var(--color-text-tertiary)',
                    fontWeight: 400, letterSpacing: 0 }}>
                    have / needed
                  </span>
                </div>

                {/* Cost summary row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                  <div className="stat-card">
                    <div className="stat-card-label">Material Cost</div>
                    <div className="stat-card-value">{formatISK(apiDetail.buildInfo.totalCost)}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-card-label">Profit / Run</div>
                    <div
                      className="stat-card-value"
                      style={{ color: apiDetail.buildInfo.profit > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                    >
                      {formatISK(apiDetail.buildInfo.profit)}
                    </div>
                  </div>
                </div>

                {/* Materials list */}
                <div className="mat-list">
                  {apiDetail.buildInfo.materials.map((mat, i) => {
                    const ok       = mat.shortage <= 0;
                    const isChain  = ownedProductTypeIds.has(mat.materialId);
                    return (
                      <div key={i} className={`mat-row${ok ? ' mat-ok' : ' mat-bad'}`}>
                        <span className="mat-icon">
                          <img
                            src={`${ICON_BASE}/${mat.materialId}/icon?size=32`}
                            alt=""
                            width={16}
                            height={16}
                            crossOrigin="anonymous"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                            }}
                          />
                        </span>
                        <span className="mat-name" style={{ flex: 1 }}>
                          <span style={{
                            color: ok ? 'var(--color-success)' : 'var(--color-danger)',
                            fontWeight: 700,
                            marginRight: 4,
                          }}>
                            {ok ? '✓' : '✗'}
                          </span>
                          {mat.name}
                          {/* Chain item badge — user has a BP to manufacture this */}
                          {isChain && (
                            <span style={{
                              marginLeft: 4,
                              fontSize: 9,
                              background: 'rgba(192, 132, 252, 0.2)',
                              color: '#c084fc',
                              border: '0.5px solid rgba(192, 132, 252, 0.35)',
                              borderRadius: 2,
                              padding: '1px 4px',
                              verticalAlign: 'middle',
                            }}>
                              ⛓ chain
                            </span>
                          )}
                        </span>
                        <span className="mat-qty">
                          {fmtN(mat.have)}/{fmtN(mat.needed)}
                        </span>
                        {/* Per-material cost if available */}
                        {mat.totalCost != null && mat.totalCost > 0 && (
                          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)',
                            marginLeft: 4, flexShrink: 0 }}>
                            {formatISK(mat.totalCost)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Shortage summary */}
                {(() => {
                  const missing = apiDetail.buildInfo!.materials.filter((m) => m.shortage > 0);
                  if (missing.length === 0) return null;
                  const shortfallTotal = missing.reduce((s, m) => s + (m.shortfallCost ?? 0), 0);
                  return (
                    <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 3,
                      background: 'rgba(244, 67, 54, 0.08)', border: '0.5px solid rgba(244, 67, 54, 0.2)',
                      fontSize: 10, color: 'var(--color-danger)' }}>
                      {missing.length} material{missing.length !== 1 ? 's' : ''} short
                      {shortfallTotal > 0 && <> · {formatISK(shortfallTotal)} to buy</>}
                    </div>
                  );
                })()}

                {apiDetail.buildInfo.profitMargin !== 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    Margin: {apiDetail.buildInfo.profitMargin.toFixed(1)}%
                  </div>
                )}
              </div>
            )}

            {/* Description */}
            {apiDetail.description && (
              <div className="description-text">
                {apiDetail.description.length > 240
                  ? apiDetail.description.substring(0, 240) + '…'
                  : apiDetail.description}
              </div>
            )}
          </>
        )}

        {/* ── Fallback: precomputed financials (shown while apiDetail loads) ── */}
        {!apiDetail && !detailLoading && fallbackDetail && (
          <>
            <div className="detail-section">
              <div className="detail-section-heading">Financials</div>
              <div className="stat-card">
                <div className="stat-card-label">Sell Price</div>
                <div className="stat-card-value">{formatISK(fallbackDetail.sellPrice)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Material Cost</div>
                <div className="stat-card-value">{formatISK(fallbackDetail.matCost)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Profit / Run</div>
                <div
                  className="stat-card-value"
                  style={{ color: fallbackDetail.profitPerRun > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                >
                  {formatISK(fallbackDetail.profitPerRun)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Margin</div>
                <div className="stat-card-value">{fallbackDetail.margin.toFixed(1)}%</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">ISK / Hour</div>
                <div className="stat-card-value">{formatISK(fallbackDetail.iskPerHour)}</div>
              </div>
            </div>

            <div className="detail-section">
              <div className="detail-section-heading">Blueprint</div>
              <div className="stat-card">
                <div className="stat-card-label">Build Time</div>
                <div className="stat-card-value">{fallbackDetail.buildTime}</div>
              </div>
            </div>
          </>
        )}

        {/* ── Blueprint click with no apiDetail yet — show what we have ── */}
        {isBlueprintClick && !apiDetail && !detailLoading && !fallbackDetail && (
          <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 12,
            textAlign: 'center' }}>
            No market data for this blueprint.
            <br />Select an item from the Market tab for full analysis.
          </div>
        )}

      </div>
    </aside>
  );
};

export default RightSidebar;
