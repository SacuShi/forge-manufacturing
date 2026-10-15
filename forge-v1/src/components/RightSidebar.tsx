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

import { useMemo, useState, useCallback, useRef, useEffect, type FC } from 'react';
import type { ItemDetail, ItemDetailApiResponse, EsiBlueprint, Market, TrueCostResponse, AltCharacter, JumpClone, MaterialStockCheckResponse, InterHubArbRow, InterHubHaulResult } from '../types';
import InterHubTradeView from './InterHubTradeView';
import ItemMaterialsSection from './ItemMaterialsSection';
import TrueProfitPanel from './TrueProfitPanel';
import { apiPost } from '../api/client';
import { formatISKDisplay as formatISK } from '../utils/format';

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
  /** Open the manufacturing setup modal (optionally scrolled to a section, e.g. 'haulage') */
  onOpenSettings:  (section?: 'haulage') => void;
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
  // v1.20 — market liquidity for the selected item (drives the "days to clear" note)
  selectedVolume:       number | null;
  selectedLiquidityRisk: string | null;
  /** 'jita' = this hub has no trading data for the item, so selectedVolume is Jita's */
  selectedVolumeSource?: 'hub' | 'jita' | null;
  // v1.17.1 — implant selector for True Profit ISK/hr (default: none)
  activeImplants:       number[];
  /** v1.32.0 — jump clones (each may have mfg implants; drives the clone selector options) */
  jumpClones:           JumpClone[];
  selectedImplants:     number[];
  onImplantsChange:     (implants: number[]) => void;
  // v1.35.0 — invention decryptor + manual probability bonus
  inventionDecryptorType:      string | null;
  onInventionDecryptorChange:  (type: string | null) => void;
  inventionProbBonus:          number;
  onInventionProbBonusChange:  (bonus: number) => void;
  // Inter-Hub Arb — non-null when the selected item was clicked from the arb tab.
  // RightSidebar renders the trade view instead of the manufacturing view.
  interHubContext?:           InterHubArbRow | null;
  interHubHaulData?:          InterHubHaulResult | null;
  interHubHaulLoading?:       boolean;
  /** v1.35.0 — opens the inter-hub haul config panel (independent from mfg haul) */
  onConfigureInterHubHaul?:   () => void;
  // v1.33.3 — live per-material stock check for the shortfall banner
  /** Hub where missing materials would actually be purchased */
  materialRegionId:     number;
  /** Display name of the materials hub (e.g. "Jita") for the stock-check message */
  materialMarketName:   string;
  /** Combined wallet ISK across in-scope characters */
  walletISK:            number;
}

// ── Constants ────────────────────────────────────────────────────────────────

import { itemIconUrl } from '../utils/icons';
import { jobQuantity } from '../utils/jobQuantity';
import { priceFromSupply } from '../utils/hubSupply';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  selectedVolume,
  selectedLiquidityRisk,
  selectedVolumeSource = null,
  activeImplants,
  jumpClones,
  selectedImplants,
  onImplantsChange,
  materialRegionId,
  materialMarketName,
  walletISK,
  inventionDecryptorType,
  onInventionDecryptorChange,
  inventionProbBonus,
  onInventionProbBonusChange,
  interHubContext            = null,
  interHubHaulData           = null,
  interHubHaulLoading        = false,
  onConfigureInterHubHaul    = () => {},
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

  // If the user owns a blueprint for this item, a server "Not manufacturable" error
  // is a false negative (LP-sourced BPCs not in SDE manufacturing table).
  const userHasBlueprint = !!selectedTypeId && ownedProductTypeIds.has(selectedTypeId);
  const effectiveTrueCostError = (trueCostError?.startsWith('Not manufacturable') && userHasBlueprint)
    ? 'Manufacturing cost data unavailable for this item — recipe not in database.'
    : trueCostError;

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

  // Effective ME — mirrors exactly what /api/true-cost uses (blueprint + structure + rigs).
  // Falls back to blueprint ME only before True Cost data loads, then upgrades.
  // When blueprint not owned: ME = 0 → raw quantities regardless of structure/rigs.
  const blueprintME = blueprint?.material_efficiency ?? 0;
  // The server returns the one material multiplier it priced the job with (blueprint ME ×
  // structure × the saved rigs that cover THIS item, each at its security-scaled value).
  const meFactor    = trueCostData?.manufacturing_setup?.material_multiplier
                      ?? Math.max(0, 1 - blueprintME / 100);

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

  // ── Chain drill-down: which top-level material rows are expanded ──────────
  const [expandedChains, setExpandedChains] = useState<Set<number>>(new Set());
  const toggleChain = useCallback((materialId: number) => {
    setExpandedChains(prev => {
      const next = new Set(prev);
      if (next.has(materialId)) next.delete(materialId); else next.add(materialId);
      return next;
    });
  }, []);
  // Collapse all when the selected item changes (new build = fresh tree)
  useEffect(() => { setExpandedChains(new Set()); }, [selectedTypeId]);

  // ── Multibuy copy ────────────────────────────────────────────────────────
  const [copiedShortfall, setCopiedShortfall] = useState(false);

  const copyShortfall = useCallback(() => {
    // Until True Profit has loaded, the multiplier ignores your structure and rigs, so the list
    // would over-state what to buy. Wait for the server's real multiplier.
    if (!apiDetail?.buildInfo?.materials || !trueCostData?.manufacturing_setup) return;
    const runs = Math.max(1, parseInt(runsInputVal, 10) || 1);
    // Use same effective ME as the material list (blueprint + structure + rig bonuses)
    const mf = meFactor;
    const lines = apiDetail.buildInfo.materials
      .map(m => ({
        m,
        short: Math.max(0, jobQuantity(m.needed, runs, mf) - m.have),
      }))
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
  }, [apiDetail, trueCostData, runsInputVal, meFactor]);

  // ── Shortfall list (materials short for the current runs/ME) ──────────────
  // Lifted out of the render IIFE so it can drive the stock-check fetch below.
  // ME + runs-adjusted: mirrors /api/true-cost — one rounding per job, ≥ 1 per run
  // Price a purchase of `qty` units of a material from its supply (the hub's own orders first, the
  // remainder imported from Jita) — the same algorithm /api/true-cost uses (utils/hubSupply.ts).
  const buyFor = (m: { supply?: import('../utils/hubSupply').MaterialSupply | null; unitCost?: number }, qty: number) => {
    if (m.supply) return priceFromSupply(m.supply, qty);
    return null;
  };

  const missing = useMemo(() => {
    if (!apiDetail?.buildInfo?.materials) return [];
    return apiDetail.buildInfo.materials
      .map(m => ({
        ...m,
        shortForRuns: Math.max(
          0,
          jobQuantity(m.needed, displayRuns, meFactor) - m.have
        ),
      }))
      .filter(m => m.shortForRuns > 0);
  }, [apiDetail, meFactor, displayRuns]);

  // ── Live per-material stock check (v1.33.3) ────────────────────────────────
  // Fires whenever there's a shortage, scoped only to the missing materials.
  // Proactive (not hover-triggered) — this is a single open item, not a table
  // of rows, so there's no hover-storm risk to guard against.
  const [stockCheck,        setStockCheck]        = useState<MaterialStockCheckResponse | null>(null);
  const [stockCheckOpen,    setStockCheckOpen]     = useState(false);
  const [stockRetry,        setStockRetry]         = useState(0);

  useEffect(() => {
    setStockCheckOpen(false); // collapse the expanded detail when the item/shortfall changes
    if (missing.length === 0) { setStockCheck(null); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    apiPost<MaterialStockCheckResponse>('/api/material-stock-check', {
      materials: missing.map(m => ({ materialId: m.materialId, needed: m.shortForRuns })),
      regionId:  materialRegionId,
      walletISK,
    })
      .then(res => {
        if (cancelled) return;
        setStockCheck(res && res.verdict ? res : null);
        // the hub's price cache was still loading: ask again shortly
        if (!(res && res.verdict) && res?.pricesWarm === false && stockRetry < 8) retryTimer = setTimeout(() => setStockRetry(n => n + 1), 5000);
      })
      .catch(() => { if (!cancelled) setStockCheck(null); });
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
    // missing is a derived array (new reference each render) — key on its actual
    // contents (material ids + shortfall qty) instead to avoid a refetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.map(m => `${m.materialId}:${m.shortForRuns}`).join(','), materialRegionId, walletISK, stockRetry]);

  // Since MainContent now passes product type_id, selectedTypeId IS the product typeId.
  // We only need a fallback strip for edge cases where blueprint type_id was passed.
  const rawName     = selectedName || apiDetail?.name || fallbackDetail?.name
                      || (selectedTypeId ? `Item #${selectedTypeId}` : '');
  const displayName = rawName.replace(/ Blueprint$/i, '');
  const iconUrl     = selectedTypeId ? itemIconUrl(selectedTypeId, 64) : '';

  // ── Inter-Hub: profitable buy orders fetch ───────────────────────────────
  // Fetches raw ESI buy orders at the sell hub for the selected item, then
  // filters to those where price > break-even (buy_at + all fees).
  const [profOrders,  setProfOrders]  = useState<{ count: number; volume: number; totalAtStation: number | null } | null>(null);
  const [profLoading, setProfLoading] = useState(false);
  const [profError,   setProfError]   = useState<string | null>(null);

  // Auto-fetch when item changes — reads from the in-memory ESI book (instant),
  // so no manual button press is needed.
  useEffect(() => {
    setProfOrders(null);
    setProfError(null);
    if (!interHubContext) return;
    const { product_id, sell_region_id, sell_into, net_profit } = interHubContext;
    const breakEven = sell_into - net_profit;
    let cancelled = false;
    setProfLoading(true);
    fetch(`/api/inter-hub-item-profitable?typeId=${product_id}&regionId=${sell_region_id}&breakEven=${breakEven.toFixed(2)}`)
      .then(r => r.json())
      .then((data: { profitableOrderCount: number; totalVolumeRemain: number; totalAtStation?: number; error?: string }) => {
        if (cancelled) return;
        if (data.error) { setProfError(data.error); return; }
        setProfOrders({ count: data.profitableOrderCount, volume: data.totalVolumeRemain, totalAtStation: data.totalAtStation ?? null });
      })
      .catch(e => { if (!cancelled) setProfError((e as Error).message); })
      .finally(() => { if (!cancelled) setProfLoading(false); });
    return () => { cancelled = true; };
  }, [interHubContext?.product_id, interHubContext?.sell_region_id]);

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
              if (interHubContext) {
                return (
                  <div style={{ marginTop: 4 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                      background: 'var(--color-accent-primary)',
                      color: 'white', borderRadius: 3, padding: '2px 7px',
                    }}>
                      ⟺ {interHubContext.buy_hub_name} → {interHubContext.sell_hub_name}
                    </span>
                  </div>
                );
              }
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
                  <span className="badge badge-no-bp">
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

        {/* ── Inter-Hub Trade View ────────────────────────────────────────── */}
        <InterHubTradeView interHubContext={interHubContext} interHubHaulData={interHubHaulData} interHubHaulLoading={interHubHaulLoading} onConfigureInterHubHaul={onConfigureInterHubHaul} profError={profError} profLoading={profLoading} profOrders={profOrders} />

        {/* ── Blueprint info block (BPO/BPC, ME, TE, Runs) ───────────────── */}
        {!interHubContext && blueprint && (
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
        {!interHubContext && detailLoading && (
          <div style={{ color: 'var(--color-text-tertiary)', fontSize: 11, textAlign: 'center', padding: 16 }}>
            <div className="loading-spinner" style={{ width: 20, height: 20, margin: '0 auto 8px' }} />
            Loading item details…
          </div>
        )}

        {/* ── API error (non-fatal) ────────────────────────────────────────── */}
        {!interHubContext && detailError && !detailLoading && (
          <div style={{ color: 'var(--color-danger)', fontSize: 11, textAlign: 'center', padding: 12 }}>
            ⚠ {detailError}
          </div>
        )}

        {/* ── Live data from /api/item-details ── */}
        <ItemMaterialsSection apiDetail={apiDetail} blueprints={blueprints} buyFor={buyFor} copiedShortfall={copiedShortfall} copyShortfall={copyShortfall} detailLoading={detailLoading} displayRuns={displayRuns} expandedChains={expandedChains} interHubContext={interHubContext} inventionDecryptorType={inventionDecryptorType} inventionProbBonus={inventionProbBonus} isJita={isJita} itemNames={itemNames} marketLabel={marketLabel} materialMarketName={materialMarketName} materialRegionId={materialRegionId} meFactor={meFactor} missing={missing} onInventionDecryptorChange={onInventionDecryptorChange} onInventionProbBonusChange={onInventionProbBonusChange} onSelectItem={onSelectItem} ownedProductTypeIds={ownedProductTypeIds} selectedMarket={selectedMarket} setStockCheckOpen={setStockCheckOpen} stockCheck={stockCheck} stockCheckOpen={stockCheckOpen} toggleChain={toggleChain} trueCostData={trueCostData} walletISK={walletISK} />

        {/* ── Fallback: precomputed financials (shown while apiDetail loads) ── */}
        {!interHubContext && !apiDetail && !detailLoading && fallbackDetail && (
          <>
            <div className="detail-section">
              <div className="detail-section-heading" title="GROSS estimate before your fees/blueprint — same baseline as the Market table and the AI. True Profit (your NET) loads below.">
                Gross Estimate (pre-fee)
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Sell Price</div>
                <div className="stat-card-value">{formatISK(fallbackDetail.sellPrice)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Est. Material Cost</div>
                <div className="stat-card-value">{formatISK(fallbackDetail.matCost)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Est. Gross Profit / Run</div>
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
                <div className="stat-card-label">Est. ISK / Hour</div>
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
        {!interHubContext && isBlueprintClick && !apiDetail && !detailLoading && !fallbackDetail && (
          <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 12,
            textAlign: 'center' }}>
            No market data for this blueprint.
            <br />Select an item from the Market tab for full analysis.
          </div>
        )}

        {/* ── True Profit — 4-box breakdown ──────────────────────────────── */}
        <TrueProfitPanel activeImplants={activeImplants} altCharacters={altCharacters} apiDetail={apiDetail} blueprintME={blueprintME} commitRuns={commitRuns} displayName={displayName} displayRuns={displayRuns} effectiveTrueCostError={effectiveTrueCostError} feeCharacterId={feeCharacterId} feeCharacterName={feeCharacterName} handleRunsChange={handleRunsChange} interHubContext={interHubContext} isBlueprintClick={isBlueprintClick} itemNames={itemNames} jumpClones={jumpClones} materialMarketName={materialMarketName} onFeeCharacterChange={onFeeCharacterChange} onImplantsChange={onImplantsChange} onOpenSettings={onOpenSettings} primaryCharacterName={primaryCharacterName} runsInputVal={runsInputVal} selectedImplants={selectedImplants} selectedLiquidityRisk={selectedLiquidityRisk} selectedMarket={selectedMarket} selectedTypeId={selectedTypeId} selectedVolume={selectedVolume} selectedVolumeSource={selectedVolumeSource} trueCostData={trueCostData} trueCostError={trueCostError} trueCostLoading={trueCostLoading} />

      </div>
    </aside>
  );
};

export default RightSidebar;
