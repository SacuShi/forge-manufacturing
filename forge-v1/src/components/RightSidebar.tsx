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

import { useMemo, useState, useCallback, useRef, type FC } from 'react';
import type { ItemDetail, ItemDetailApiResponse, EsiBlueprint, Market, TrueCostResponse, AltCharacter } from '../types';

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
  /** Currently selected market hub — drives price label and re-fetch */
  selectedMarket:  Market;
  /** True Profit breakdown from /api/true-cost */
  trueCostData:    TrueCostResponse | null;
  trueCostLoading: boolean;
  trueCostError:   string | null;
  onClose:         () => void;
  /** Open the manufacturing setup modal */
  onOpenSettings:  () => void;
  /** Called when a material row or chain item is clicked — drills into that item */
  onSelectItem:    (typeId: number, name: string) => void;
  /** Navigate back one step in the drill-down history */
  onBack?:         () => void;
  /** True when there is at least one entry in the back-stack */
  canGoBack?:      boolean;
  // v1.5 — Multi-character fee selector
  altCharacters:        AltCharacter[];
  primaryCharacterName: string;
  /** null = use primary character's fees */
  feeCharacterId:       number | null;
  feeCharacterName:     string;
  onFeeCharacterChange: (characterId: number | null) => void;
  // v1.6 — Build runs selector
  buildRuns:            number;
  onBuildRunsChange:    (runs: number) => void;
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
  selectedMarket,
  trueCostData,
  trueCostLoading,
  trueCostError,
  onClose,
  onOpenSettings,
  onSelectItem,
  onBack,
  canGoBack = false,
  altCharacters,
  primaryCharacterName,
  feeCharacterId,
  feeCharacterName,
  onFeeCharacterChange,
  buildRuns,
  onBuildRunsChange,
}) => {
  const isJita       = selectedMarket.id === 10000002;
  const marketLabel  = `${selectedMarket.name}${selectedMarket.type === 'nullsec' ? ' [NULLSEC]' : ''}`;
  const sidebarClass = `sidebar-right${detailOpen ? ' detail-open' : ''}`;

  // ── ALL hooks must be called before any early return ─────────────────────

  // Reverse name→typeId map (for product icon + chain item detection)
  const nameToTypeId = useMemo(() => {
    const m = new Map<string, number>();
    itemNames.forEach((name, typeId) => m.set(name.toLowerCase(), typeId));
    return m;
  }, [itemNames]);

  /**
   * Map: productTypeId → EsiBlueprint
   * Allows detecting a blueprint even when the caller passed the PRODUCT type_id
   * (which is what MainContent now does so /api/item-details gets correct data).
   * Also builds the set of owned product type IDs for chain item badges.
   */
  const { productToBlueprintMap, ownedProductTypeIds } = useMemo(() => {
    const ptbMap = new Map<number, EsiBlueprint>();
    const ownedSet = new Set<number>();
    blueprints.forEach((bp) => {
      const bpName = itemNames.get(bp.type_id);
      if (!bpName) return;
      const productName = bpName.replace(/ Blueprint$/i, '').toLowerCase();
      const pid = nameToTypeId.get(productName);
      if (pid) {
        // Always prefer BPO (quantity === -1) over any BPC.
        // Without this guard, the last entry in the ESI array wins —
        // which is typically the BPC — so the panel showed BPC info
        // even when the user clicked the BPO card.
        const isBpo = bp.quantity === -1;
        if (!ptbMap.has(pid) || isBpo) {
          ptbMap.set(pid, bp);
        }
        ownedSet.add(pid);
      }
    });
    return { productToBlueprintMap: ptbMap, ownedProductTypeIds: ownedSet };
  }, [blueprints, itemNames, nameToTypeId]);

  /**
   * Detect blueprint:
   *   1. Direct match — selectedTypeId is a blueprint type_id (legacy/edge case)
   *   2. Product match — selectedTypeId is the product type_id (normal blueprint tab click)
   */
  const blueprint = useMemo(() => {
    if (!selectedTypeId) return undefined;
    return blueprints.find((b) => b.type_id === selectedTypeId)
        ?? productToBlueprintMap.get(selectedTypeId);
  }, [selectedTypeId, blueprints, productToBlueprintMap]);

  const isBlueprintClick = blueprint !== undefined;
  const isBpo            = blueprint?.quantity === -1;

  // ── Build runs free-input ────────────────────────────────────────────────
  // Local string state for immediate display feedback; parent (App.tsx) is
  // notified via onBuildRunsChange, debounced 600ms so True Profit only
  // recalculates once the user stops typing (not on every keystroke).
  const [runsInputVal,  setRunsInputVal]  = useState(String(buildRuns));
  const runsDebounceRef                   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived runs used for material list and shortfall display (live, not debounced)
  const displayRuns = Math.max(1, parseInt(runsInputVal, 10) || buildRuns);

  const handleRunsChange = useCallback((raw: string) => {
    setRunsInputVal(raw);
    if (runsDebounceRef.current) clearTimeout(runsDebounceRef.current);
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 1) {
      runsDebounceRef.current = setTimeout(() => onBuildRunsChange(n), 600);
    }
  }, [onBuildRunsChange]);

  const commitRuns = useCallback(() => {
    if (runsDebounceRef.current) clearTimeout(runsDebounceRef.current);
    const n = Math.max(1, parseInt(runsInputVal, 10) || 1);
    setRunsInputVal(String(n));
    onBuildRunsChange(n);
  }, [runsInputVal, onBuildRunsChange]);

  // ── Multibuy copy ────────────────────────────────────────────────────────
  const [copiedShortfall, setCopiedShortfall] = useState(false);

  const copyShortfall = useCallback(() => {
    if (!apiDetail?.buildInfo?.materials) return;
    const runs = Math.max(1, parseInt(runsInputVal, 10) || 1);
    const lines = apiDetail.buildInfo.materials
      .map(m => ({ m, short: Math.max(0, m.needed * runs - m.have) }))
      .filter(({ short }) => short > 0)
      .map(({ m, short }) => `${m.name} ${short}`);
    if (lines.length === 0) return;
    const text = lines.join('\n');
    const apply = () => { setCopiedShortfall(true); setTimeout(() => setCopiedShortfall(false), 2000); };
    navigator.clipboard.writeText(text).then(apply).catch(() => {
      // Fallback for contexts without clipboard API permission
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        apply();
      } catch (_) { /* silent — clipboard unavailable */ }
    });
  }, [apiDetail, runsInputVal]);

  // Since MainContent now passes product type_id, selectedTypeId IS the product typeId.
  // We only need a fallback strip for edge cases where blueprint type_id was passed.
  const rawName     = selectedName || apiDetail?.name || fallbackDetail?.name
                      || (selectedTypeId ? `Item #${selectedTypeId}` : '');
  const displayName = rawName.replace(/ Blueprint$/i, '');
  const iconUrl     = selectedTypeId ? `${ICON_BASE}/${selectedTypeId}/icon?size=64` : '';

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

        {/* ── Back button (shown when drill-down history exists) ───────────── */}
        {canGoBack && (
          <div style={{ padding: '8px 0 10px' }}>
            <button
              type="button"
              className="btn"
              onClick={onBack}
              aria-label="Go back to previous item"
            >
              ← Back
            </button>
          </div>
        )}

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
            {/* ── Owned / Not Owned indicator ──────────────────────────── */}
            {(() => {
              const isOwned = selectedTypeId ? ownedProductTypeIds.has(selectedTypeId) : false;
              if (isBlueprintClick && blueprint) {
                // Clicked directly from blueprints tab — show exact type + ME/TE
                return (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                    <span className={isBpo ? 'badge badge-bpo' : 'badge badge-bpc'}>
                      {isBpo ? '✓ BPO Owned' : '✓ BPC Owned'}
                    </span>
                  </div>
                );
              }
              if (isOwned) {
                // Clicked from market/material — they own a blueprint for this
                const bp = selectedTypeId ? productToBlueprintMap.get(selectedTypeId) : undefined;
                const type = bp ? (bp.quantity === -1 ? 'BPO' : 'BPC') : 'BP';
                return (
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <span className={type === 'BPO' ? 'badge badge-bpo' : 'badge badge-bpc'}>
                      ✓ {type} Owned
                    </span>
                  </div>
                );
              }
              // No blueprint owned
              return (
                <div style={{ marginTop: 4 }}>
                  <span className="badge badge-none" style={{
                    background: 'rgba(244, 67, 54, 0.12)',
                    color: 'var(--color-danger)',
                    border: '0.5px solid rgba(244, 67, 54, 0.3)',
                  }}>
                    ✗ No Blueprint
                  </span>
                </div>
              );
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
                  <div className="detail-section-heading">
                    Jita Price (90 Days)
                    {!isJita && (
                      <span style={{ float: 'right', fontSize: 10, fontWeight: 400,
                        color: 'var(--color-text-tertiary)', letterSpacing: 0 }}>
                        history always Jita
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--color-success)', fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
                    {formatISK(latest)}
                  </div>
                  <div className="sparkline">
                    {prices.slice(-30).map((p, i) => {
                      const height = range > 0 ? ((p - min) / range) * 100 : 50;
                      return (
                        <div
                          // Combine index with price value: switching items produces a
                          // different set of values so React replaces bars cleanly.
                          key={`bar-${i}-${Math.round(p)}`}
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
                <div className="detail-section-heading">Current {marketLabel} Market</div>

                {/* Warn when there are no live sell orders — price estimated from history */}
                {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0 && (
                  <div className="price-hist-notice">
                    ⚠ No live sell orders — prices below estimated from 30-day trade average
                  </div>
                )}

                <div className="price-grid">
                  <div>
                    <div className="price-cell-label">
                      LOWEST SELL
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? <span className="price-cell-label-hist"> (no orders)</span>
                        : null}
                    </div>
                    <div className="price-cell-value" style={{ color: 'var(--color-danger)' }}>
                      {apiDetail.currentPrice.sell > 0
                        ? formatISK(apiDetail.currentPrice.sell)
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? '30D AVG TRADE' : 'MEDIAN'}
                    </div>
                    <div className="price-cell-value" style={{ color: 'var(--color-accent-primary)' }}>
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? formatISK(apiDetail.currentPrice.avg30d!)
                        : formatISK(apiDetail.currentPrice.median)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">HIGHEST BUY</div>
                    <div className="price-cell-value" style={{ color: 'var(--color-success)' }}>
                      {apiDetail.currentPrice.buy > 0
                        ? formatISK(apiDetail.currentPrice.buy)
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
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
                {apiDetail.buildInfo.sellPriceSource === 'history_30d' && (
                  <div className="price-hist-notice" style={{ marginBottom: 6 }}>
                    ⚠ No live sell orders — profit estimated from 30-day trade average
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                  <div className="stat-card">
                    <div className="stat-card-label">Material Cost</div>
                    <div className="stat-card-value">{formatISK(apiDetail.buildInfo.totalCost)}</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-card-label">
                      Profit / Run
                      {apiDetail.buildInfo.sellPriceSource === 'history_30d' && (
                        <span className="price-source-hist" title="Based on 30-day average — no live sell orders">~</span>
                      )}
                    </div>
                    <div
                      className="stat-card-value"
                      style={{ color: apiDetail.buildInfo.profit > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}
                    >
                      {formatISK(apiDetail.buildInfo.profit)}
                    </div>
                  </div>
                </div>

                {/* Materials list — every row is clickable → drills into that item */}
                <div className="mat-list">
                  {apiDetail.buildInfo.materials.map((mat) => {
                    // Runs-adjusted shortage — server sends 1-run values; multiply here
                    const needForRuns  = mat.needed * displayRuns;
                    const shortForRuns = Math.max(0, needForRuns - mat.have);
                    const ok           = shortForRuns <= 0;
                    // canManufacture: set by server from blueprints DB (any game blueprint exists)
                    // isOwned: user personally owns a blueprint for this material
                    const isChain = mat.canManufacture ?? ownedProductTypeIds.has(mat.materialId);
                    const isOwned = ownedProductTypeIds.has(mat.materialId);
                    return (
                      <div
                        key={mat.materialId}
                        className={`mat-row mat-row-clickable${ok ? ' mat-ok' : ' mat-bad'}`}
                        role="button"
                        tabIndex={0}
                        title={isChain
                          ? `Click to view production chain for ${mat.name}${isOwned ? ' (you own this blueprint)' : ''}`
                          : `Click to view market data for ${mat.name}`}
                        onClick={() => onSelectItem(mat.materialId, mat.name)}
                        onKeyDown={(e) => e.key === 'Enter' && onSelectItem(mat.materialId, mat.name)}
                      >
                        {/* Material icon */}
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

                        {/* Have/need tick */}
                        <span style={{
                          color: ok ? 'var(--color-success)' : 'var(--color-danger)',
                          fontWeight: 700,
                          fontSize: 12,
                          flexShrink: 0,
                          width: 14,
                        }}>
                          {ok ? '✓' : '✗'}
                        </span>

                        {/* Name + chain badge + PI tier badge */}
                        <span className="mat-name" style={{ flex: 1 }}>
                          {mat.name}
                          {isChain && (
                            <span style={{
                              marginLeft: 5,
                              fontSize: 9,
                              background: isOwned
                                ? 'rgba(192, 132, 252, 0.2)'
                                : 'rgba(79, 195, 247, 0.12)',
                              color: isOwned ? '#c084fc' : 'var(--color-accent-primary)',
                              border: `0.5px solid ${isOwned
                                ? 'rgba(192, 132, 252, 0.35)'
                                : 'rgba(79, 195, 247, 0.3)'}`,
                              borderRadius: 2,
                              padding: '1px 4px',
                              verticalAlign: 'middle',
                              cursor: 'pointer',
                            }}>
                              ⛓ {isOwned ? 'owned' : 'chain'}
                            </span>
                          )}
                          {mat.piTier && (
                            <span style={{
                              marginLeft: 4,
                              fontSize: 9,
                              background: 'rgba(251, 191, 36, 0.12)',
                              color: '#fbbf24',
                              border: '0.5px solid rgba(251, 191, 36, 0.3)',
                              borderRadius: 2,
                              padding: '1px 4px',
                              verticalAlign: 'middle',
                              flexShrink: 0,
                            }}>
                              PI·P{mat.piTier}
                            </span>
                          )}
                        </span>

                        {/* Have / needed counts — runs-adjusted */}
                        <span className="mat-qty">
                          {fmtN(mat.have)}/{fmtN(needForRuns)}
                        </span>

                        {/* Per-material cost — runs-adjusted */}
                        {mat.unitCost != null && mat.unitCost > 0 && (
                          <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)',
                            marginLeft: 4, flexShrink: 0 }}>
                            {formatISK(mat.unitCost * needForRuns)}
                          </span>
                        )}

                        {/* Drill-in arrow hint */}
                        <span style={{
                          fontSize: 9,
                          color: 'var(--color-text-tertiary)',
                          marginLeft: 3,
                          flexShrink: 0,
                          opacity: 0.6,
                        }}>▶</span>
                      </div>
                    );
                  })}
                </div>

                {/* Shortage summary + Multibuy copy */}
                {(() => {
                  // Runs-adjusted: recompute shortfall here (server sends 1-run values)
                  const missing = apiDetail.buildInfo!.materials
                    .map(m => ({
                      ...m,
                      shortForRuns: Math.max(0, m.needed * displayRuns - m.have),
                    }))
                    .filter(m => m.shortForRuns > 0);
                  if (missing.length === 0) return null;
                  const shortfallTotal = missing.reduce(
                    (s, m) => s + m.shortForRuns * (m.unitCost ?? 0), 0
                  );
                  return (
                    <div style={{ marginTop: 6, padding: '6px 8px', borderRadius: 3,
                      background: 'rgba(244, 67, 54, 0.08)', border: '0.5px solid rgba(244, 67, 54, 0.2)',
                      fontSize: 10, color: 'var(--color-danger)',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span>
                        {missing.length} material{missing.length !== 1 ? 's' : ''} short
                        {shortfallTotal > 0 && <> · {formatISK(shortfallTotal)} to buy</>}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); copyShortfall(); }}
                        title={`Copy shortfall list to clipboard in EVE Multibuy format.\nPaste directly into the Multibuy window (right-click → Paste).\nQuantities are raw blueprint amounts × runs (before ME adjustment).`}
                        style={{
                          background: copiedShortfall
                            ? 'rgba(76, 175, 80, 0.18)' : 'rgba(244, 67, 54, 0.15)',
                          color: copiedShortfall
                            ? 'var(--color-success)' : 'var(--color-danger)',
                          border: `0.5px solid ${copiedShortfall
                            ? 'rgba(76, 175, 80, 0.4)' : 'rgba(244, 67, 54, 0.35)'}`,
                          borderRadius: 3,
                          padding: '2px 7px',
                          fontSize: 9,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          flexShrink: 0,
                          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {copiedShortfall ? '✓ Copied!' : '📋 Multibuy'}
                      </button>
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

        {/* ── True Profit — 4-box breakdown ──────────────────────────────── */}
        {selectedTypeId && (
          <div className="detail-section">
            <div className="detail-section-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>True Profit</span>
              {/* v1.5 — Fee character selector (only shown when alts are loaded) */}
              {altCharacters.length > 0 && (
                <select
                  className="fee-char-select"
                  value={feeCharacterId ?? 'primary'}
                  title={`Fees calculated using ${feeCharacterName}'s skills & standings`}
                  onChange={(e) => onFeeCharacterChange(
                    e.target.value === 'primary' ? null : Number(e.target.value)
                  )}
                  aria-label="Character to use for fee calculations"
                >
                  <option value="primary">{primaryCharacterName}</option>
                  {altCharacters.map((a) => (
                    <option key={a.characterId} value={a.characterId} disabled={a.loading}>
                      {a.loading ? 'Loading…' : a.name}
                    </option>
                  ))}
                </select>
              )}
              {/* v1.9.1 — Free-entry build runs input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>×</span>
                <input
                  type="number"
                  className="fee-char-select"
                  value={runsInputVal}
                  min={1}
                  step={1}
                  style={{ width: 64, textAlign: 'center', paddingRight: 2 }}
                  onChange={(e) => handleRunsChange(e.target.value)}
                  onBlur={commitRuns}
                  onKeyDown={(e) => e.key === 'Enter' && commitRuns()}
                  aria-label="Number of manufacturing runs"
                  title="Type any number of runs — True Profit updates when you stop typing"
                />
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>runs</span>
              </div>
            </div>

            {trueCostLoading && (
              <div style={{ textAlign: 'center', padding: '12px 0',
                color: 'var(--color-text-tertiary)', fontSize: 11 }}>
                <div className="loading-spinner"
                  style={{ width: 16, height: 16, margin: '0 auto 6px' }} />
                Calculating…
              </div>
            )}

            {trueCostError && !trueCostLoading && (
              <div style={{
                color: trueCostError.startsWith('Not manufacturable')
                  ? 'var(--color-text-tertiary)'
                  : 'var(--color-danger)',
                fontSize: 11, padding: '8px 0', textAlign: 'center'
              }}>
                {trueCostError.startsWith('Not manufacturable')
                  ? <>ℹ Not manufacturable — this item comes from the LP store,<br/>drops, or contracts only.</>
                  : <>⚠ {trueCostError}</>}
              </div>
            )}

            {trueCostData && !trueCostLoading && !trueCostData.prices_warm && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', padding: '4px 0 2px',
                            display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: 'var(--color-accent-primary)' }}>⟳</span>
                Using cached estimates — live prices updating in background.
              </div>
            )}

            {trueCostData && !trueCostLoading && (
              <div className="cost-breakdown-row">

                {/* Box 1 — Material Cost (with tooltip explaining ME reduction) */}
                <div className="cost-box material">
                  <span className="cost-box-label">Materials</span>
                  <span className="cost-box-value">
                    {formatISK(trueCostData.total_material_cost)}
                  </span>
                  {/* Tooltip */}
                  <div className="cost-tooltip">
                    {(() => {
                      const me = blueprint?.material_efficiency ?? 0;
                      const meFactor = Math.max(0, 1 - me / 100);
                      const rawCost = me > 0
                        ? trueCostData.total_material_cost / meFactor
                        : trueCostData.total_material_cost;
                      const saving = rawCost - trueCostData.total_material_cost;
                      return (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Blueprint ME</span>
                            <span style={{ color: 'var(--color-success)' }}>{me}%</span>
                          </div>
                          {me > 0 && (
                            <>
                              <div className="cost-tooltip-row">
                                <span>Base cost (ME 0)</span>
                                <span>{formatISK(rawCost)}</span>
                              </div>
                              <div className="cost-tooltip-row">
                                <span>ME saving ({me}%)</span>
                                <span style={{ color: 'var(--color-success)' }}>
                                  −{formatISK(saving)}
                                </span>
                              </div>
                              <div className="cost-tooltip-divider" />
                            </>
                          )}
                          <div className="cost-tooltip-row total">
                            <span>Adjusted cost</span>
                            <span>{formatISK(trueCostData.total_material_cost)}</span>
                          </div>
                          <div className="cost-tooltip-setup">
                            Material quantities in the list below assume an
                            unresearched original. Your blueprint's ME research
                            reduces actual consumption when you build.
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Box 2 — Manufacturing Fees (with tooltip) */}
                <div className={`cost-box mfg-fees${trueCostData.setup_configured ? '' : ' unconfigured'}`}>
                  <span className="cost-box-label">Mfg Fees</span>
                  {trueCostData.setup_configured ? (
                    <span className="cost-box-value">
                      {formatISK(trueCostData.mfg_fees.total)}
                    </span>
                  ) : (
                    <span className="cost-box-value cost-box-unknown">
                      ?{' '}
                      <button
                        type="button"
                        className="cost-configure-link"
                        onClick={onOpenSettings}
                      >
                        Configure
                      </button>
                    </span>
                  )}
                  {/* Tooltip */}
                  {trueCostData.setup_configured && (
                    <div className="cost-tooltip">
                      <div className="cost-tooltip-row">
                        <span>Est. Item Value</span>
                        <span>{formatISK(trueCostData.mfg_fees.estimated_item_value)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>
                          System Cost
                          {trueCostData.manufacturing_setup.sci_raw > 0 && (
                            <span style={{ opacity: 0.65, fontSize: 10 }}>
                              {' '}({(trueCostData.manufacturing_setup.sci_raw * 100).toFixed(2)}% SCI)
                            </span>
                          )}
                        </span>
                        <span>{formatISK(trueCostData.mfg_fees.system_cost_index)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>Facility Tax</span>
                        <span>{formatISK(trueCostData.mfg_fees.facility_tax)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>SCC Surcharge</span>
                        <span>{formatISK(trueCostData.mfg_fees.scc_surcharge)}</span>
                      </div>
                      {trueCostData.mfg_fees.alpha_clone_tax > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Alpha Tax</span>
                          <span>{formatISK(trueCostData.mfg_fees.alpha_clone_tax)}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total</span>
                        <span>{formatISK(trueCostData.mfg_fees.total)}</span>
                      </div>
                      <div className="cost-tooltip-setup">
                        {trueCostData.manufacturing_setup.system_name}
                        {' · '}
                        {trueCostData.manufacturing_setup.structure_label}
                        {' · '}
                        {trueCostData.manufacturing_setup.facility_tax_pct}% tax
                      </div>
                    </div>
                  )}
                </div>

                {/* Box 3 — Sales Tax (with tooltip) */}
                <div className="cost-box sales-tax">
                  <span className="cost-box-label">Sales Tax</span>
                  <span className="cost-box-value">
                    {formatISK(trueCostData.sales_tax.total)}
                  </span>
                  {/* Tooltip */}
                  <div className="cost-tooltip">
                    <div className="cost-tooltip-row">
                      <span>
                        Broker Fee
                        ({(trueCostData.sales_tax.broker_fee_rate * 100).toFixed(2)}%)
                      </span>
                      <span>{formatISK(trueCostData.sales_tax.broker_fee)}</span>
                    </div>
                    <div className="cost-tooltip-sub">
                      Broker Relations {trueCostData.sales_tax.broker_relations_level}
                    </div>
                    <div className="cost-tooltip-sub">
                      Faction standing: {trueCostData.sales_tax.faction_standing.toFixed(2)}
                    </div>
                    <div className="cost-tooltip-sub">
                      Corp standing: {trueCostData.sales_tax.corp_standing.toFixed(2)}
                    </div>
                    <div className="cost-tooltip-row">
                      <span>
                        Transaction Tax
                        ({(trueCostData.sales_tax.transaction_tax_rate * 100).toFixed(2)}%)
                      </span>
                      <span>{formatISK(trueCostData.sales_tax.transaction_tax)}</span>
                    </div>
                    <div className="cost-tooltip-sub">
                      Accounting {trueCostData.sales_tax.accounting_level}
                    </div>
                    <div className="cost-tooltip-divider" />
                    <div className="cost-tooltip-row total">
                      <span>Total</span>
                      <span>{formatISK(trueCostData.sales_tax.total)}</span>
                    </div>
                  </div>
                </div>

                {/* Box 4 — True Profit (with full formula + haulage breakdown tooltip) */}
                {(() => {
                  const h = trueCostData.haul_cost;
                  const leg1Active = h.leg1_method !== 'user_defined' || h.leg1_rate > 0;
                  const leg2Active = h.leg2_method !== 'user_defined' || h.leg2_rate > 0;
                  const haulConfigured = leg1Active || leg2Active;
                  // True when every active leg is self-haul (no contracted freight cost)
                  const allSelfHaul =
                    haulConfigured &&
                    (!leg1Active || h.leg1_method === 'self_haul') &&
                    (!leg2Active || h.leg2_method === 'self_haul');
                  // Provider haul is active if any leg uses a contracted/user-rate method
                  const hasProviderHaul =
                    (leg1Active && h.leg1_method !== 'self_haul') ||
                    (leg2Active && h.leg2_method !== 'self_haul');

                  const haulMethodLabel = (
                    method: string,
                    ship: string | null,
                    label: string | null,
                  ): string => {
                    if (method === 'red_frog')   return 'Red Frog';
                    if (method === 'black_frog') return 'Black Frog';
                    if (method === 'pushx')      return 'PushX';
                    if (method === 'self_haul')  return ship ? `Self-haul (${ship})` : 'Self-haul';
                    return label || 'User rate';
                  };

                  return (
                    <div className={`cost-box true-profit${trueCostData.true_profit >= 0 ? ' positive' : ' negative'}`}>
                      <span className="cost-box-label">True Profit</span>
                      <span className="cost-box-value">
                        {formatISK(trueCostData.true_profit)}
                      </span>
                      <span className="cost-box-margin">
                        {trueCostData.true_margin.toFixed(1)}%
                      </span>
                      {/* Tooltip — full formula so users can verify the math */}
                      <div className="cost-tooltip">

                        {/* ── Formula rows ─────────────────────────── */}
                        <div className="cost-tooltip-row">
                          <span>Sell Revenue</span>
                          <span>{formatISK(trueCostData.sell_price * trueCostData.runs)}</span>
                        </div>
                        <div className="cost-tooltip-row">
                          <span>− Materials</span>
                          <span style={{ color: 'var(--color-danger)' }}>
                            −{formatISK(trueCostData.total_material_cost)}
                          </span>
                        </div>
                        {trueCostData.setup_configured && (
                          <div className="cost-tooltip-row">
                            <span>− Mfg Fees</span>
                            <span style={{ color: 'var(--color-danger)' }}>
                              −{formatISK(trueCostData.mfg_fees.total)}
                            </span>
                          </div>
                        )}
                        <div className="cost-tooltip-row">
                          <span>− Sales Tax</span>
                          <span style={{ color: 'var(--color-danger)' }}>
                            −{formatISK(trueCostData.sales_tax.total)}
                          </span>
                        </div>

                        {/* ── Haulage — always present, detail varies by config ── */}
                        {haulConfigured ? (
                          <>
                            {/* Summary line */}
                            <div className="cost-tooltip-row">
                              <span>− Haulage</span>
                              <span style={{
                                color: h.total > 0
                                  ? 'var(--color-danger)'
                                  : 'var(--color-text-tertiary)',
                              }}>
                                {h.total > 0
                                  ? `−${formatISK(h.total)}`
                                  : allSelfHaul ? '— (self-haul)' : '— (loading)'}
                              </span>
                            </div>
                            {/* Leg 1 — Materials in */}
                            {leg1Active && (
                              <div className="cost-tooltip-sub">
                                {h.leg1_method === 'self_haul'
                                  ? `Materials in: ${haulMethodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)} — no freight cost`
                                  : `Materials in: ${haulMethodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)}` +
                                    (h.leg1_cost > 0
                                      ? ` · ${formatISK(h.leg1_cost)}`
                                      : h.leg1_jumps > 0 ? ' · loading…' : ' · same location')
                                }
                              </div>
                            )}
                            {/* Leg 2 — Goods out */}
                            {leg2Active && (
                              <div className="cost-tooltip-sub">
                                {h.leg2_method === 'self_haul'
                                  ? `Goods out: ${haulMethodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)} — no freight cost`
                                  : `Goods out: ${haulMethodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)}` +
                                    (h.leg2_cost > 0
                                      ? ` · ${formatISK(h.leg2_cost)}`
                                      : h.leg2_jumps > 0 ? ' · loading…' : ' · same location')
                                }
                              </div>
                            )}
                          </>
                        ) : (
                          /* Haulage not configured — show as greyed-out formula line */
                          <div className="cost-tooltip-row" style={{ opacity: 0.45 }}>
                            <span>− Haulage</span>
                            <span style={{ color: 'var(--color-text-tertiary)' }}>
                              — not configured
                            </span>
                          </div>
                        )}

                        <div className="cost-tooltip-divider" />
                        <div className="cost-tooltip-row total">
                          <span>= True Profit</span>
                          <span style={{
                            color: trueCostData.true_profit >= 0
                              ? 'var(--color-success)'
                              : 'var(--color-danger)',
                          }}>
                            {formatISK(trueCostData.true_profit)}
                          </span>
                        </div>
                        <div className="cost-tooltip-row">
                          <span>Margin</span>
                          <span style={{
                            color: trueCostData.true_margin >= 0
                              ? 'var(--color-success)'
                              : 'var(--color-danger)',
                          }}>
                            {trueCostData.true_margin.toFixed(2)}%
                          </span>
                        </div>

                        {/* ── Explanatory footer ──────────────────── */}
                        <div className="cost-tooltip-setup" style={{ marginTop: 8, borderTop: '0.5px solid var(--color-border-light)', paddingTop: 6 }}>
                          The opportunity list shows an estimated spread assuming
                          an unresearched blueprint and no taxes — useful for
                          comparing items at a glance. This figure is what actually
                          lands in your wallet: your blueprint's ME research trims
                          material consumption, CONCORD collects its mandatory SCC
                          levy, your structure charges its facility fee, and the
                          broker's cut and transaction tax are applied based on your
                          skills and standings.
                          {allSelfHaul &&
                            ' Self-haul is selected — no contracted freight cost is included in this figure.'
                          }
                          {haulConfigured && !allSelfHaul &&
                            ' Haulage costs are included, covering both the inbound materials run and the outbound finished-goods run.'
                          }
                          {!haulConfigured &&
                            ' Haulage is not configured — open ⚙ Mfg Setup → Haulage to include freight costs.'
                          }
                        </div>
                        {!trueCostData.setup_configured && (
                          <div className="cost-tooltip-setup">
                            Manufacturing fees not included — configure your
                            structure and system in ⚙ Mfg Setup for a complete
                            picture.
                          </div>
                        )}
                        {/* Volume loading warning — only when a provider is selected but volumes haven't loaded */}
                        {hasProviderHaul && h.total === 0 && (
                          <div className="cost-tooltip-setup" style={{ color: 'var(--color-warning)', opacity: 0.85 }}>
                            ⟳ Haulage volumes are loading — item packaged volumes
                            are needed to calculate freight costs. If this persists,
                            run sde-import.js on the server.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

              </div>
            )}

            {/* ── Haul box row — shown when any haul is configured ── */}
            {trueCostData && !trueCostLoading && (() => {
              const h = trueCostData.haul_cost;
              // Show box if any method is non-default or rates > 0
              const leg1Active = h.leg1_method !== 'user_defined' || h.leg1_rate > 0;
              const leg2Active = h.leg2_method !== 'user_defined' || h.leg2_rate > 0;
              if (!leg1Active && !leg2Active) return null;

              const methodLabel = (m: string, ship: string | null, label: string | null) => {
                if (m === 'red_frog')   return 'Red Frog';
                if (m === 'black_frog') return 'Black Frog';
                if (m === 'pushx')      return 'PushX';
                if (m === 'self_haul')  return ship ? `Self — ${ship}` : 'Self-Haul';
                return label || 'User-Defined';
              };

              const jumpStr = (j: number) => j > 0 ? ` · ${j} jump${j !== 1 ? 's' : ''}` : '';

              return (
                <div className="cost-breakdown-row" style={{ marginTop: 4 }}>
                  <div className="cost-box haulage" style={{ flex: '0 0 calc(50% - 4px)' }}>
                    <span className="cost-box-label">Haulage</span>
                    <span className="cost-box-value">
                      {h.total > 0 ? formatISK(h.total) : '—'}
                    </span>
                    <div className="cost-tooltip">
                      {/* Leg 1 */}
                      {leg1Active && h.leg1_jumps > 0 ? (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Materials in{jumpStr(h.leg1_jumps)}</span>
                            <span>{h.leg1_cost > 0 ? formatISK(h.leg1_cost) : '—'}</span>
                          </div>
                          <div className="cost-tooltip-sub">
                            {methodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)}
                            {h.leg1_volume_m3 > 0 && ` · ${Math.round(h.leg1_volume_m3).toLocaleString()} m³`}
                            {h.leg1_isk_per_m3_effective > 0 && ` · ${Math.round(h.leg1_isk_per_m3_effective).toLocaleString()} ISK/m³`}
                            {h.leg1_contracts > 1 && ` · ${h.leg1_contracts} contracts`}
                          </div>
                        </>
                      ) : (
                        <div className="cost-tooltip-row">
                          <span>Materials in</span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>
                            {leg1Active && h.leg1_jumps === 0 ? 'Same location' : 'Not configured'}
                          </span>
                        </div>
                      )}
                      {/* Leg 2 */}
                      {leg2Active && h.leg2_jumps > 0 ? (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Goods out{jumpStr(h.leg2_jumps)}</span>
                            <span>{h.leg2_cost > 0 ? formatISK(h.leg2_cost) : '—'}</span>
                          </div>
                          <div className="cost-tooltip-sub">
                            {methodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)}
                            {h.leg2_volume_m3 > 0 && ` · ${Math.round(h.leg2_volume_m3).toLocaleString()} m³`}
                            {h.leg2_isk_per_m3_effective > 0 && ` · ${Math.round(h.leg2_isk_per_m3_effective).toLocaleString()} ISK/m³`}
                            {h.leg2_contracts > 1 && ` · ${h.leg2_contracts} contracts`}
                          </div>
                        </>
                      ) : (
                        <div className="cost-tooltip-row">
                          <span>Goods out</span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>
                            {leg2Active && h.leg2_jumps === 0 ? 'Same location' : 'Not configured'}
                          </span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total Haul</span>
                        <span style={{ color: 'var(--color-warning)' }}>
                          {h.total > 0 ? formatISK(h.total) : '— awaiting volume data'}
                        </span>
                      </div>
                      {h.total === 0 && (
                        <div className="cost-tooltip-setup" style={{ color: 'var(--color-warning)', opacity: 0.8 }}>
                          ⟳ Run node sde-import.js on the server to calculate volumes.
                        </div>
                      )}
                      {h.provider_rates_as_of && (
                        <div className="cost-tooltip-setup">
                          Provider rates as of {h.provider_rates_as_of} — verify at provider website.
                        </div>
                      )}
                      <div className="cost-tooltip-setup">
                        Haul cost deducted from True Profit. Adjust in ⚙ Mfg Setup → Haulage.
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {!trueCostData && !trueCostLoading && !trueCostError && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', padding: '6px 0' }}>
                Select an item to see True Profit.
              </div>
            )}
          </div>
        )}

      </div>
    </aside>
  );
};

export default RightSidebar;
