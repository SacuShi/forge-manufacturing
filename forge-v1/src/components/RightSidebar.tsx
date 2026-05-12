/**
 * FORGE v1.0 — RightSidebar component
 *
 * Fixed 280px right panel. Shows full item analysis for the selected item.
 *
 * Data sources (in priority order):
 *   1. apiDetail (ItemDetailApiResponse) — live from /api/item-details
 *      Contains: price history sparkline, live market prices, material
 *      breakdown with have/needed, build cost, profit.
 *   2. fallbackDetail (ItemDetail) — derived from top-profitable results
 *      Shown immediately while apiDetail is loading.
 *
 * On tablet (<1200px): overlays as a fixed right panel, toggled by detailOpen.
 *
 * Security:
 *   - All icon URLs use numeric typeId only.
 *   - No dangerouslySetInnerHTML.
 */

import type { FC } from 'react';
import type { ItemDetail, ItemDetailApiResponse, EsiBlueprint } from '../types';

// ── Types ────────────────────────────────────────────────────────────────────

interface RightSidebarProps {
  selectedTypeId: number | null;
  selectedName: string;
  /** Fallback: derived from top-profitable data (immediate, no extra fetch) */
  fallbackDetail: ItemDetail | null;
  /** Live detail from /api/item-details (richer: materials, sparkline, prices) */
  apiDetail: ItemDetailApiResponse | null;
  detailLoading: boolean;
  detailError: string | null;
  detailOpen: boolean;
  blueprints: EsiBlueprint[];
  onClose: () => void;
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
  onClose,
}) => {
  const sidebarClass = `sidebar-right${detailOpen ? ' detail-open' : ''}`;

  /* ── Empty state ─────────────────────────────────────────────────────────── */
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

  const iconUrl = `${ICON_BASE}/${selectedTypeId}/icon?size=64`;
  const name    = selectedName || apiDetail?.name || fallbackDetail?.name || `Item #${selectedTypeId}`;
  const blueprint = blueprints.find((b) => b.type_id === selectedTypeId);
  const runsText = blueprint
    ? (blueprint.quantity === -1 ? 'Unlimited' : `${blueprint.runs}`)
    : null;

  return (
    <aside className={sidebarClass} aria-label={`${name} detail analysis`}>
      <div className="detail-panel">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="detail-hero">
          <div className="detail-icon">
            <img
              src={iconUrl}
              alt=""
              width={64}
              height={64}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="detail-item-name">{name}</div>
            {fallbackDetail && (
              <div className="detail-item-cat">{fallbackDetail.category || 'Manufacturing'}</div>
            )}
            {fallbackDetail && (
              <span className={
                fallbackDetail.owned === 'BPO' ? 'badge badge-bpo' :
                fallbackDetail.owned === 'BPC' ? 'badge badge-bpc' :
                'badge badge-none'
              }>
                {fallbackDetail.owned}
              </span>
            )}
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

        {/* ── Runs remaining (for BPC/BPO) ───────────────────────────────── */}
        {blueprint && (
          <div style={{
            padding: '8px 12px',
            borderBottom: '1px solid var(--color-border-light)',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            display: 'flex',
            justifyContent: 'space-between',
          }}>
            <span>Runs remaining</span>
            <span style={{ fontWeight: 500, color: 'var(--color-accent-primary)' }}>
              {runsText}
            </span>
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
            {/* Build status badge */}
            {apiDetail.buildInfo && (
              <div style={{ marginBottom: 10 }}>
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

            {/* Build analysis & materials */}
            {apiDetail.buildInfo && (
              <div className="detail-section">
                <div className="detail-section-heading">Build Requirements</div>
                <div className="mat-list" style={{ marginBottom: 10 }}>
                  {apiDetail.buildInfo.materials.map((mat, i) => (
                    <div key={i} className={`mat-row${mat.shortage > 0 ? ' mat-bad' : ' mat-ok'}`}>
                      <span className="mat-name">
                        <span className="mat-icon">
                          <img
                            src={`${ICON_BASE}/${mat.materialId}/icon?size=32`}
                            alt=""
                            width={14}
                            height={14}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                            }}
                          />
                        </span>
                        {mat.shortage > 0 ? '✗' : '✓'} {mat.name}
                      </span>
                      <span className="mat-qty">{fmtN(mat.have)}/{fmtN(mat.needed)}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                  <div className="stat-card">
                    <div className="stat-card-label">Build Cost</div>
                    <div className="stat-card-value">{formatISK(apiDetail.buildInfo.totalCost)}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-card-label">Profit</div>
                    <div
                      className="stat-card-value"
                      style={{ color: apiDetail.buildInfo.profit > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                    >
                      {formatISK(apiDetail.buildInfo.profit)}
                    </div>
                  </div>
                </div>
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

        {/* ── Fallback: precomputed financials (shown if no apiDetail yet) ── */}
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
                <div className="stat-card-value">
                  {fallbackDetail.margin.toFixed(1)}%
                </div>
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

      </div>
    </aside>
  );
};

export default RightSidebar;
