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

import { useMemo, useState, useCallback, useRef, useEffect, Fragment, type FC } from 'react';
import type { ItemDetail, ItemDetailApiResponse, EsiBlueprint, Market, TrueCostResponse, AltCharacter, MaterialBreakdownResponse, BreakdownMaterial, JumpClone, MaterialStockCheckResponse, InterHubArbRow, InterHubHaulResult } from '../types';
import { INVENTION_DECRYPTORS } from '../types';
import { apiPost } from '../api/client';
import { formatISKDisplay as formatISK, formatPerDay, liquidityInfo } from '../utils/format';

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
  // v1.20 — market liquidity for the selected item (drives the "days to clear" note)
  selectedVolume:       number | null;
  selectedLiquidityRisk: string | null;
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

// v1.17.1 — manufacturing-time implants offered in the True Profit implant selector.
// Mirrors the server's INDUSTRY_IMPLANTS (mfg_time entries). type_id → {short, pct}.
const MFG_TIME_IMPLANTS: Record<number, { short: string; pct: number }> = {
  27170: { short: 'BX-801', pct: 1 },
  27167: { short: 'BX-802', pct: 2 },
  27171: { short: 'BX-804', pct: 4 },
};
const WHATIF_BX_IDS = [27170, 27167, 27171]; // always offered as "what-if"

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Chain drill-down (inline reaction / manufacturing tree) ───────────────────
// Module-level cache keyed by `${typeId}:${regionId}` so re-opening a node (or
// re-expanding after collapse) never refetches. Cleared on full page reload.
const breakdownCache = new Map<string, MaterialBreakdownResponse>();

interface ChainTreeProps {
  /** The product whose blueprint materials we expand (one level). */
  parentTypeId:    number;
  regionId:        number;
  ownedBlueprints: EsiBlueprint[];
  /** Nesting depth — drives indentation (1 = first sub-level). */
  depth:           number;
  onSelectItem:    (typeId: number, name: string) => void;
}

/** Lazily fetches + renders one level of sub-materials beneath a chain node. */
const ChainTree: FC<ChainTreeProps> = ({ parentTypeId, regionId, ownedBlueprints, depth, onSelectItem }) => {
  const cacheKey = `${parentTypeId}:${regionId}`;
  const [data, setData]       = useState<MaterialBreakdownResponse | null>(breakdownCache.get(cacheKey) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(false);

  useEffect(() => {
    const cached = breakdownCache.get(cacheKey);
    if (cached) { setData(cached); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    apiPost<MaterialBreakdownResponse>('/api/material-breakdown', {
      typeId: parentTypeId, regionId, ownedBlueprints,
    })
      .then(res => { if (!cancelled) { breakdownCache.set(cacheKey, res); setData(res); } })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // ownedBlueprints reference is stable per render of RightSidebar; key on the IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentTypeId, regionId]);

  const indent = 8 + depth * 12;

  if (loading) {
    return <div className="chain-sub-note" style={{ paddingLeft: indent }}>· loading chain…</div>;
  }
  if (error) {
    return <div className="chain-sub-note" style={{ paddingLeft: indent, color: 'var(--color-danger)' }}>· chain unavailable</div>;
  }
  if (!data || !data.materials.length) {
    return <div className="chain-sub-note" style={{ paddingLeft: indent }}>· no further breakdown</div>;
  }

  return (
    <>
      {data.materials.map(m => (
        <ChainRow
          key={m.materialId}
          mat={m}
          regionId={regionId}
          ownedBlueprints={ownedBlueprints}
          depth={depth}
          onSelectItem={onSelectItem}
        />
      ))}
    </>
  );
};

interface ChainRowProps {
  mat:             BreakdownMaterial;
  regionId:        number;
  ownedBlueprints: EsiBlueprint[];
  depth:           number;
  onSelectItem:    (typeId: number, name: string) => void;
}

/** One sub-material row inside the chain tree; expandable if it is itself producible. */
const ChainRow: FC<ChainRowProps> = ({ mat, regionId, ownedBlueprints, depth, onSelectItem }) => {
  const [open, setOpen] = useState(false);
  const isReaction = mat.activityId === 9;
  const indent     = 8 + depth * 12;

  const buyTotal   = mat.buyPricePerUnit * mat.quantity;
  const buildTotal = mat.mfgCostPerUnit != null ? mat.mfgCostPerUnit * mat.quantity : null;

  return (
    <>
      <div
        className="chain-row"
        style={{ paddingLeft: indent }}
        role="button"
        tabIndex={0}
        title={`Open ${mat.name} in market view`}
        onClick={() => onSelectItem(mat.materialId, mat.name)}
        onKeyDown={(e) => e.key === 'Enter' && onSelectItem(mat.materialId, mat.name)}
      >
        {/* Expand toggle (only when producible) */}
        {mat.canManufacture ? (
          <span
            className="chain-toggle"
            role="button"
            tabIndex={0}
            title={open ? 'Collapse' : `Expand ${isReaction ? 'reaction' : 'build'} chain`}
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setOpen(o => !o); } }}
            style={{
              color: isReaction ? 'var(--color-reaction)' : 'var(--color-accent-primary)',
              cursor: 'pointer', width: 12, flexShrink: 0, fontSize: 10,
            }}
          >
            {open ? '▾' : '▸'}
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}

        <img
          src={itemIconUrl(mat.materialId)}
          alt="" width={14} height={14} crossOrigin="anonymous"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
          style={{ flexShrink: 0, opacity: 0.85 }}
        />

        <span className="chain-name" style={{ flex: 1 }}>
          {mat.name}
          {mat.canManufacture && (
            <span style={{
              marginLeft: 4, fontSize: 8,
              color: isReaction ? 'var(--color-reaction)' : (mat.blueprintOwned ? 'var(--color-owned-bp)' : 'var(--color-accent-primary)'),
            }}>
              {isReaction ? '⚗ react' : (mat.blueprintOwned ? '⛓ owned' : '⛓ build')}
            </span>
          )}
          {mat.piTier && (
            <span style={{ marginLeft: 4, fontSize: 8, color: 'var(--color-reaction)' }}>PI·P{mat.piTier}</span>
          )}
        </span>

        <span className="chain-qty" style={{ fontSize: 9, color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
          ×{mat.quantity.toLocaleString()}
        </span>

        {/* Build-vs-buy verdict — the core chain insight */}
        <span style={{ fontSize: 9, flexShrink: 0, marginLeft: 4, textAlign: 'right' }}>
          {buildTotal != null ? (
            <>
              <span style={{
                color: mat.recommendation === 'buy' ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                fontWeight: mat.recommendation === 'buy' ? 700 : 400,
              }}>
                {formatISK(buyTotal)}
              </span>
              <span style={{ color: 'var(--color-text-tertiary)', opacity: 0.5 }}> / </span>
              <span style={{
                color: mat.recommendation === 'build' ? 'var(--color-success)' : 'var(--color-text-tertiary)',
                fontWeight: mat.recommendation === 'build' ? 700 : 400,
              }}>
                {formatISK(buildTotal)}
              </span>
            </>
          ) : (
            <span style={{ color: 'var(--color-text-tertiary)' }}>{formatISK(buyTotal)}</span>
          )}
        </span>
      </div>

      {open && mat.canManufacture && (
        <ChainTree
          parentTypeId={mat.materialId}
          regionId={regionId}
          ownedBlueprints={ownedBlueprints}
          depth={depth + 1}
          onSelectItem={onSelectItem}
        />
      )}
    </>
  );
};

// ── DecryptorSelect ───────────────────────────────────────────────────────────

interface DecryptorSelectProps {
  /** The currently selected decryptor type (use 'none' when no decryptor is active). */
  value: string;
  /** Called with the raw select value; callers map 'none' → null as needed. */
  onChange: (val: string) => void;
}

/** Controlled <select> listing all invention decryptors (including "none"). */
function DecryptorSelect({ value, onChange }: DecryptorSelectProps) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        fontSize: 10,
        background: 'var(--color-bg-elevated)',
        color: '#ff9800',
        border: '0.5px solid rgba(255,152,0,0.4)',
        borderRadius: 'var(--radius-sm)',
        padding: '2px 4px',
        cursor: 'pointer',
      }}
    >
      {INVENTION_DECRYPTORS.map(d => (
        <option key={d.type} value={d.type}>{d.name}</option>
      ))}
    </select>
  );
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
  selectedVolume,
  selectedLiquidityRisk,
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
  const effectiveME = trueCostData?.manufacturing_setup?.effective_me ?? blueprintME;
  const meFactor    = Math.max(0, 1 - effectiveME / 100);

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
    if (!apiDetail?.buildInfo?.materials) return;
    const runs = Math.max(1, parseInt(runsInputVal, 10) || 1);
    // Use same effective ME as the material list (blueprint + structure + rig bonuses)
    const mf = meFactor;
    const lines = apiDetail.buildInfo.materials
      .map(m => ({
        m,
        short: Math.max(0, Math.max(1, Math.ceil(m.needed * mf)) * runs - m.have),
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
  }, [apiDetail, runsInputVal, meFactor]);

  // ── Shortfall list (materials short for the current runs/ME) ──────────────
  // Lifted out of the render IIFE so it can drive the stock-check fetch below.
  // ME + runs-adjusted: mirrors /api/true-cost — max(1, ceil(qty × meFactor)) × runs
  const missing = useMemo(() => {
    if (!apiDetail?.buildInfo?.materials) return [];
    return apiDetail.buildInfo.materials
      .map(m => ({
        ...m,
        shortForRuns: Math.max(
          0,
          Math.max(1, Math.ceil(m.needed * meFactor)) * displayRuns - m.have
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

  useEffect(() => {
    setStockCheckOpen(false); // collapse the expanded detail when the item/shortfall changes
    if (missing.length === 0) { setStockCheck(null); return; }
    let cancelled = false;
    apiPost<MaterialStockCheckResponse>('/api/material-stock-check', {
      materials: missing.map(m => ({ materialId: m.materialId, needed: m.shortForRuns })),
      regionId:  materialRegionId,
      walletISK,
    })
      .then(res => { if (!cancelled) setStockCheck(res); })
      .catch(() => { if (!cancelled) setStockCheck(null); });
    return () => { cancelled = true; };
    // missing is a derived array (new reference each render) — key on its actual
    // contents (material ids + shortfall qty) instead to avoid a refetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.map(m => `${m.materialId}:${m.shortForRuns}`).join(','), materialRegionId, walletISK]);

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
        {interHubContext && (() => {
          // Use character's actual rates once loaded; fall back to Accounting V estimate while loading
          const taxRate    = interHubHaulData ? interHubHaulData.transaction_tax_rate : 0.03375;
          const brokerRate = interHubHaulData ? interHubHaulData.broker_fee_rate      : null;
          const taxAmount  = interHubContext.sell_into * taxRate;
          const brokerAmt  = brokerRate != null ? interHubContext.sell_into * brokerRate : null;
          const haulCost   = interHubHaulData?.haul_cost ?? 0;
          // net_profit (from arb row) used TAX=0.964 estimate; recalc with real rates once loaded
          const netProfitReal = interHubHaulData
            ? interHubContext.sell_into * (1 - taxRate) - interHubContext.buy_at
            : interHubContext.net_profit;
          const netMarginReal = interHubContext.buy_at > 0
            ? (netProfitReal / interHubContext.buy_at) * 100
            : interHubContext.net_margin_pct;
          const afterHaul  = interHubHaulData?.haul_enabled ? netProfitReal - haulCost : null;
          const row        = interHubContext;
          const haul       = interHubHaulData;
          const haulLabel  = haul?.haul_enabled
            ? `${haul.method_label}${(haul.contracts ?? 0) > 1 ? `, ${haul.contracts} contracts` : ''}`
            : null;

          const rowStyle: React.CSSProperties = {
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            gap: 8, padding: '3px 0',
          };
          const labelStyle: React.CSSProperties = {
            fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0,
          };
          const valueStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, textAlign: 'right' };

          return (
            <>
              {/* Price breakdown */}
              <div className="detail-section">
                <div className="detail-section-heading">Trade Breakdown</div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* Buy at */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>Buy at (sell orders, {row.buy_hub_name})</span>
                    <span style={valueStyle}>{formatISK(row.buy_at)}</span>
                  </div>
                  {(row.sell_orders_at_buy != null || row.sell_vol_at_buy != null) && (
                    <div style={{ ...rowStyle, marginTop: -2, marginBottom: 2 }}>
                      <span
                        style={{ ...labelStyle, fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}
                        title="Total units remaining across all sell orders at this hub — not all are at the displayed best price"
                      >
                        {row.sell_orders_at_buy != null ? `${row.sell_orders_at_buy.toLocaleString()} sell orders` : ''}
                        {row.sell_orders_at_buy != null && row.sell_vol_at_buy != null ? ' · ' : ''}
                        {row.sell_vol_at_buy != null ? `${row.sell_vol_at_buy.toLocaleString()} units total depth` : ''}
                      </span>
                    </div>
                  )}

                  {/* Haul */}
                  {interHubHaulLoading ? (
                    <div style={{ ...rowStyle }}>
                      <span style={labelStyle}>Haul cost</span>
                      <span style={{ ...valueStyle, color: 'var(--color-text-tertiary)', fontSize: 11 }}>calculating…</span>
                    </div>
                  ) : haul?.haul_enabled ? (
                    <div style={rowStyle}>
                      <span style={labelStyle}>Haul ({haulLabel}{haul.jumps > 0 ? `, ${haul.jumps} jumps` : ''})</span>
                      <span style={{ ...valueStyle, color: haulCost > 0 ? 'var(--color-danger)' : 'var(--color-text-tertiary)' }}>
                        {haulCost > 0 ? `−${formatISK(haulCost)}` : '—'}
                      </span>
                    </div>
                  ) : (
                    <div style={rowStyle}>
                      <span style={labelStyle}>Haul cost</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ ...valueStyle, color: 'var(--color-text-tertiary)', fontSize: 10 }}>not configured</span>
                        <button
                          type="button"
                          onClick={onConfigureInterHubHaul}
                          title="Configure inter-hub haulage"
                          style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 10,
                            background: 'rgba(79,195,247,0.12)',
                            border: '0.5px solid rgba(79,195,247,0.35)',
                            color: 'var(--color-accent-primary)',
                            cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                          }}
                        >
                          ⚙ Configure haulage
                        </button>
                      </span>
                    </div>
                  )}

                  {/* Sales tax — rate from Accounting skill once haul data loads */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>
                      Transaction tax
                      {haul ? ` (Accounting ${haul.accounting_level}, ${(taxRate * 100).toFixed(2)}%)` : ' (est. Acct V)'}
                    </span>
                    <span style={{ ...valueStyle, color: 'var(--color-danger)' }}>−{formatISK(taxAmount)}</span>
                  </div>

                  {/* Broker fee — only applicable when placing sell orders (not filling buy orders) */}
                  {brokerAmt != null && (
                    <div style={rowStyle}>
                      <span style={labelStyle}>
                        Broker fee if placing orders
                        {haul ? ` (BR ${haul.broker_relations}, ${(brokerRate! * 100).toFixed(2)}%)` : ''}
                      </span>
                      <span style={{ ...valueStyle, color: 'var(--color-warning)', fontSize: 11 }}>
                        −{formatISK(brokerAmt)}
                      </span>
                    </div>
                  )}

                  {/* Divider */}
                  <div style={{ height: 0.5, background: 'var(--color-border-light)', margin: '6px 0' }} />

                  {/* Sell into — merged with profitable order breakdown */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>Sell into (buy orders, {row.sell_hub_name})</span>
                    <span style={valueStyle}>{formatISK(row.sell_into)}</span>
                  </div>
                  {/* Profitable order summary — auto-loads, same data source as totals */}
                  <div style={{ ...rowStyle, marginTop: 2, alignItems: 'flex-start' }}>
                    {profLoading && (
                      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}>
                        Checking orders…
                      </span>
                    )}
                    {profError && !profLoading && (
                      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}>
                        {row.buy_orders_at_sell != null ? `${row.buy_orders_at_sell.toLocaleString()} buy orders total` : ''}
                      </span>
                    )}
                    {profOrders && (
                      <div style={{ paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                          {(profOrders.totalAtStation ?? row.buy_orders_at_sell ?? 0).toLocaleString()} buy orders total
                          {row.buy_vol_at_sell != null ? ` · ${row.buy_vol_at_sell.toLocaleString()} units` : ''}
                        </span>
                        <span style={{ fontSize: 9, color: profOrders.count > 0 ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
                          {profOrders.count > 0
                            ? `${profOrders.count.toLocaleString()} profitable · ${profOrders.volume.toLocaleString()} units to fill`
                            : 'No profitable orders at current prices'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Net profit summary */}
              <div className="detail-section">
                <div className="detail-section-heading">Net Result</div>
                <div style={{ display: 'grid', gridTemplateColumns: afterHaul !== null ? '1fr 1fr 1fr' : '1fr 1fr', gap: 4 }}>
                  <div className="stat-card" style={{ textAlign: 'center' }}>
                    <div className="stat-card-label">PROFIT / UNIT</div>
                    <div className="stat-card-value" style={{
                      color: netProfitReal > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                      fontSize: 13,
                    }}>
                      {formatISK(netProfitReal)}
                    </div>
                  </div>
                  <div className="stat-card" style={{ textAlign: 'center' }}>
                    <div className="stat-card-label">MARGIN</div>
                    <div className="stat-card-value" style={{
                      color: netMarginReal >= 10 ? 'var(--color-success)' : netMarginReal >= 5 ? 'var(--color-warning)' : 'var(--color-text-secondary)',
                      fontSize: 13,
                    }}>
                      {netMarginReal.toFixed(1)}%
                    </div>
                  </div>
                  {afterHaul !== null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">AFTER HAUL</div>
                      <div className="stat-card-value" style={{
                        color: afterHaul > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 13,
                      }}>
                        {formatISK(afterHaul)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Cargo stats */}
              <div className="detail-section">
                <div className="detail-section-heading">Cargo &amp; Volume</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {row.volume_m3 > 0 && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">VOL / UNIT</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {row.volume_m3 < 1 ? row.volume_m3.toFixed(3) : row.volume_m3.toFixed(2)} m³
                      </div>
                    </div>
                  )}
                  {row.isk_per_m3 != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">ISK / M³</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>{formatISK(row.isk_per_m3)}</div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">VOL / DAY</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {row.avg_daily_volume >= 1000
                          ? (row.avg_daily_volume / 1000).toFixed(1) + 'k'
                          : row.avg_daily_volume.toFixed(0)}
                      </div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">EST. DAILY</div>
                      <div className="stat-card-value" style={{
                        color: netProfitReal > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 12,
                      }}>
                        {formatISK(netProfitReal * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                  {afterHaul !== null && row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center', gridColumn: '1 / -1' }}>
                      <div className="stat-card-label">EST. DAILY (AFTER HAUL)</div>
                      <div className="stat-card-value" style={{
                        color: (afterHaul * row.avg_daily_volume) > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 12,
                      }}>
                        {formatISK(afterHaul * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                </div>

                {/* Jump count from haul data */}
                {(haul?.jumps ?? 0) > 0 && (
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    Route: {row.buy_hub_name} → {row.sell_hub_name} · {haul!.jumps} jump{haul!.jumps !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              {/* ── Capital & Risk ─────────────────────────────────────── */}
              <div className="detail-section" style={{ marginTop: 0 }}>
                <div className="detail-section-heading">Capital &amp; Risk</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  <div className="stat-card" style={{ textAlign: 'center' }}
                    title="Cash tied up per unit while in transit (buy price + haul cost)">
                    <div className="stat-card-label">CAPITAL / UNIT</div>
                    <div className="stat-card-value" style={{ fontSize: 12 }}>
                      {formatISK(row.buy_at + (haul?.haul_enabled ? haulCost : 0))}
                    </div>
                  </div>
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}
                      title="Full capital needed to move one day's worth of volume">
                      <div className="stat-card-label">DAILY CAPITAL</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {formatISK((row.buy_at + (haul?.haul_enabled ? haulCost : 0)) * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                  {netProfitReal > 0 && row.buy_at > 0 && (
                    <div className="stat-card" style={{ textAlign: 'center' }}
                      title="How many units you need to sell to recover one unit's capital outlay">
                      <div className="stat-card-label">BREAK-EVEN UNITS</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {Math.ceil(row.buy_at / netProfitReal).toLocaleString()}
                      </div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && row.avg_daily_volume < 5 && (
                    <div className="stat-card" style={{ textAlign: 'center', gridColumn: netProfitReal > 0 && row.buy_at > 0 ? undefined : '1 / -1' }}
                      title="Low daily volume — orders may sit unsold for extended periods">
                      <div className="stat-card-label" style={{ color: 'var(--color-warning)' }}>⚠ THIN MARKET</div>
                      <div className="stat-card-value" style={{ fontSize: 11, color: 'var(--color-warning)' }}>
                        {row.avg_daily_volume.toFixed(1)} / day
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}

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

        {/* ── Live data from /api/item-details ────────────────────────────── */}
        {!interHubContext && apiDetail && !detailLoading && (
          <>
            {/* Build readiness badge — only positive/negative ownership; missing-materials moved below Limited Stock */}
            {apiDetail.buildInfo && (
              <div style={{ padding: '6px 12px' }}>
                {apiDetail.buildInfo.blueprintOwned && apiDetail.buildInfo.canBuild && (
                  <span className="status-badge can-build">✓ Can Build Now</span>
                )}
                {!apiDetail.buildInfo.blueprintOwned && (
                  <span className="status-badge no-bp">✗ No Blueprint</span>
                )}
              </div>
            )}

            {/* Price history sparkline */}
            {apiDetail.priceHistory && apiDetail.priceHistory.length > 0 && (() => {
              const prices     = apiDetail.priceHistory!.map((d) => d.average);
              const min        = Math.min(...prices);
              const max        = Math.max(...prices);
              const range      = max - min;
              const latest     = prices[prices.length - 1];
              const isKeestar  = apiDetail.priceHistorySource === 'keepstar';
              const days       = apiDetail.priceHistory!.length;
              const heading    = isKeestar
                ? `C-J6MT Price (${days} Days)`
                : 'Jita Price (90 Days)';
              return (
                <div className="detail-section">
                  <div className="detail-section-heading">
                    {heading}
                    {!isJita && !isKeestar && (
                      <span style={{ float: 'right', fontSize: 10, fontWeight: 400,
                        color: 'var(--color-text-tertiary)', letterSpacing: 0 }}>
                        history always Jita
                      </span>
                    )}
                    {isKeestar && days < 30 && (
                      <span style={{ float: 'right', fontSize: 10, fontWeight: 400,
                        color: 'var(--color-text-tertiary)', letterSpacing: 0 }}>
                        accumulating…
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

            {/* ── Contract pricing (v1.12.0) — distinct amber callout ────────── */}
            {apiDetail.contractPricing && (
              <div className="detail-section contract-pricing">
                <div className="contract-pricing-heading">
                  ◆ CONTRACT PRICING — {apiDetail.contractPricing.regionName}
                </div>
                <div className="contract-pricing-sub">live single-item contracts</div>

                <div className="price-grid" style={{ marginTop: 6 }}>
                  <div>
                    <div className="price-cell-label">LOWEST LISTED</div>
                    <div className="price-cell-value contract-price">
                      {formatISK(apiDetail.contractPricing.low)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">SUGGESTED SELL</div>
                    <div className="price-cell-value contract-price-suggested">
                      {formatISK(apiDetail.contractPricing.suggested)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">HIGHEST LISTED</div>
                    <div className="price-cell-value contract-price">
                      {formatISK(apiDetail.contractPricing.high)}
                    </div>
                  </div>
                </div>

                <div className="contract-rationale">
                  “{apiDetail.contractPricing.rationale}”
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
                {/* v1.19.0 — money figures (material cost, profit, ISK/hr) live ONLY in the
                    True Profit panel below, to avoid showing competing numbers for the same
                    item. This section is purely the build's material requirements. */}
                <div className="mat-section-heading">Materials required</div>

                {/* Materials list — every row is clickable → drills into that item */}
                <div className="mat-list">
                  {apiDetail.buildInfo.materials.map((mat) => {
                    // ME + runs-adjusted needed — mirrors /api/true-cost formula exactly:
                    //   max(1, ceil(base_qty × meFactor)) × runs
                    // meFactor = 1 when blueprint not owned (ME 0), actual ME when owned.
                    const needForRuns  = Math.max(1, Math.ceil(mat.needed * meFactor)) * displayRuns;
                    const shortForRuns = Math.max(0, needForRuns - mat.have);
                    const ok           = shortForRuns <= 0;
                    // canManufacture: set by server from blueprints DB (any game blueprint exists)
                    // isOwned: user personally owns a blueprint for this material
                    const isChain     = mat.canManufacture ?? ownedProductTypeIds.has(mat.materialId);
                    const isOwned     = ownedProductTypeIds.has(mat.materialId);
                    const isExpanded  = expandedChains.has(mat.materialId);
                    return (
                      <Fragment key={mat.materialId}>
                      <div
                        className={`mat-row mat-row-clickable${ok ? ' mat-ok' : ' mat-bad'}`}
                        role="button"
                        tabIndex={0}
                        title={`Click to view market data for ${mat.name}`}
                        onClick={() => onSelectItem(mat.materialId, mat.name)}
                        onKeyDown={(e) => e.key === 'Enter' && onSelectItem(mat.materialId, mat.name)}
                      >
                        {/* Material icon */}
                        <span className="mat-icon">
                          <img
                            src={itemIconUrl(mat.materialId)}
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
                            <span
                              role="button"
                              tabIndex={0}
                              title={isExpanded ? 'Collapse production chain' : 'Expand production chain'}
                              onClick={(e) => { e.stopPropagation(); toggleChain(mat.materialId); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); toggleChain(mat.materialId); } }}
                              className={`mat-badge ${isOwned ? 'mat-badge-own' : 'mat-badge-chain'}`}>
                              {isExpanded ? '▾' : '▸'} ⛓ {isOwned ? 'owned' : 'chain'}
                            </span>
                          )}
                          {mat.piTier && (
                            <span className="mat-badge mat-badge-pi">
                              PI·P{mat.piTier}
                            </span>
                          )}
                        </span>

                        {/* Have / needed counts — runs-adjusted */}
                        <span className="mat-qty">
                          {mat.have.toLocaleString()}/{needForRuns.toLocaleString()}
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

                      {/* Inline production-chain tree (lazy-loaded on badge click) */}
                      {isChain && isExpanded && (
                        <ChainTree
                          parentTypeId={mat.materialId}
                          regionId={selectedMarket.id}
                          ownedBlueprints={blueprints}
                          depth={1}
                          onSelectItem={onSelectItem}
                        />
                      )}
                      </Fragment>
                    );
                  })}
                </div>

                {/* v1.33.3 — Buyable Now / Limited Stock / Can't Afford pill (shown first) */}
                {missing.length > 0 && stockCheck && (() => {
                  const STOCK_CHECK_CFG = {
                    ok:      { icon: '✓', label: 'Buyable Now',    color: 'var(--color-success)', bg: 'rgba(76, 175, 80, 0.08)',  border: 'rgba(76, 175, 80, 0.2)' },
                    mixed:   { icon: '⚠', label: 'Limited Stock',  color: 'var(--color-warning)', bg: 'rgba(255, 152, 0, 0.08)', border: 'rgba(255, 152, 0, 0.2)' },
                    blocked: { icon: '✗', label: "Can't Afford",   color: 'var(--color-danger)',  bg: 'rgba(244, 67, 54, 0.08)', border: 'rgba(244, 67, 54, 0.2)' },
                  } as const;
                  const cfg = STOCK_CHECK_CFG[stockCheck.verdict];

                  const thinNames = stockCheck.materials
                    .filter(m => !m.covered)
                    .map(m => itemNames.get(m.materialId) ?? `Material #${m.materialId}`);

                  const message = stockCheck.verdict === 'ok'
                    ? `Missing materials are available on the ${materialMarketName} market — buying them now costs ${formatISK(stockCheck.totalCost)}, within your ${formatISK(walletISK)} wallet. Use Multibuy below to purchase the shortfall.`
                    : stockCheck.verdict === 'mixed'
                    ? `${thinNames.join(', ')} ${thinNames.length === 1 ? 'has' : 'have'} limited stock on the ${materialMarketName} market right now — not enough listed to fill the full shortage. The rest can be bought for ~${formatISK(stockCheck.totalCost)}.`
                    : `Materials are in stock on the ${materialMarketName} market, but buying them (${formatISK(stockCheck.totalCost)}) would exceed your ${formatISK(walletISK)} wallet.`;

                  return (
                    <div style={{ marginTop: 6 }}>
                      <div
                        role="button"
                        tabIndex={0}
                        title={message}
                        onClick={(e) => { e.stopPropagation(); setStockCheckOpen(o => !o); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setStockCheckOpen(o => !o); } }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                          fontSize: 10, cursor: 'pointer', color: cfg.color,
                          background: cfg.bg, border: `0.5px solid ${cfg.border}`,
                          borderRadius: 3, padding: '6px 8px',
                        }}
                      >
                        <span>{cfg.icon} {cfg.label}</span>
                        <span style={{ opacity: 0.6, fontSize: 8 }}>{stockCheckOpen ? '▾' : '▸'}</span>
                      </div>
                      {stockCheckOpen && (
                        <div style={{
                          marginTop: 4, fontSize: 10, color: 'var(--color-text-secondary)',
                          padding: '6px 8px', background: 'var(--color-bg-primary)',
                          border: '0.5px solid var(--color-border-light)', borderRadius: 3,
                        }}>
                          {message}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Missing Materials banner + Multibuy — full-width, below stock-check pill */}
                {missing.length > 0 && (() => {
                  const shortfallTotal = missing.reduce(
                    (s, m) => s + m.shortForRuns * (m.unitCost ?? 0), 0
                  );
                  const canAffordShortfall = shortfallTotal > 0 && walletISK >= shortfallTotal;
                  return (
                    <>
                      <div style={{
                        marginTop: 6, padding: '6px 8px', borderRadius: 3,
                        background: 'rgba(244, 67, 54, 0.08)', border: '0.5px solid rgba(244, 67, 54, 0.2)',
                        fontSize: 10, color: 'var(--color-danger)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      }}>
                        <span>
                          ⚠ Missing Materials · {missing.length} material{missing.length !== 1 ? 's' : ''} short
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
                            borderRadius: 3, padding: '2px 7px', fontSize: 9,
                            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {copiedShortfall ? '✓ Copied!' : '📋 Multibuy'}
                        </button>
                      </div>
                      {canAffordShortfall && (
                        <div style={{
                          marginTop: 3, padding: '4px 8px', borderRadius: 3,
                          background: 'rgba(76, 175, 80, 0.07)', border: '0.5px solid rgba(76, 175, 80, 0.25)',
                          fontSize: 10, color: 'var(--color-success)',
                        }}>
                          ✓ You have enough ISK to buy the missing materials
                        </div>
                      )}
                    </>
                  );
                })()}

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

            {/* ── Invention origin (T2 items) ───────────────────────────────── */}
            {apiDetail.inventionInfo && (() => {
              const decr = INVENTION_DECRYPTORS.find(d => d.type === (inventionDecryptorType || 'none')) ?? INVENTION_DECRYPTORS[0];
              // Prefer the server's authoritative, skill-and-rig-aware probability
              // (/api/true-cost's calcInventionCost — factors in science/encryption
              // skills and invention rigs, which this naive fallback doesn't) once
              // it's loaded; the naive base×decryptor-only estimate below is only
              // for the brief window before trueCostData arrives. Previously this
              // stat card ALWAYS used the naive number even after the authoritative
              // one loaded, while the cost card a few rows down (see hasSkills
              // below) already preferred it — the two disagreed for any character
              // with science/encryption skills or invention rigs, which is nearly
              // every real T2 inventor.
              const skillProb  = trueCostData?.invention_cost?.effective_probability;
              const naiveProb  = Math.min(1, apiDetail.inventionInfo.baseProbability * (1 + decr.probMult / 100) + (inventionProbBonus / 100));
              const adjProb     = skillProb ?? naiveProb;
              const adjAttempts = 1 / adjProb;
              const hasSkillProb = skillProb != null;
              const adjRuns = apiDetail.inventionInfo.outputRuns + decr.runs;
              return (
                <div className="detail-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div className="detail-section-heading" style={{ marginBottom: 0 }}>Invention</div>
                    <DecryptorSelect
                      value={inventionDecryptorType || 'none'}
                      onChange={val => onInventionDecryptorChange(val === 'none' ? null : val)}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                    Invented from:{' '}
                    <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
                      {apiDetail.inventionInfo.t1BlueprintName ?? `Blueprint #${apiDetail.inventionInfo.t1BlueprintId}`}
                    </span>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 2 }}>
                    <div className="stat-card-label">
                      Chance per attempt
                      {hasSkillProb
                        ? <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(your skills + decryptor)</span>
                        : <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(base prob, no skills)</span>
                      }
                    </div>
                    <div className="stat-card-value" style={{ fontWeight: 600 }}>
                      {(adjProb * 100).toFixed(1)}%
                      {(decr.probMult !== 0 || hasSkillProb) && (
                        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10, marginLeft: 4 }}>
                          (base {(apiDetail.inventionInfo.baseProbability * 100).toFixed(1)}%)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 2 }}>
                    <div className="stat-card-label">Expected attempts per BPC</div>
                    <div className="stat-card-value">{adjAttempts.toFixed(2)}×</div>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 6 }}>
                    <div className="stat-card-label">Runs per invented BPC</div>
                    <div className="stat-card-value">
                      {adjRuns}
                      {decr.runs !== 0 && <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10, marginLeft: 4 }}>(base {apiDetail.inventionInfo.outputRuns})</span>}
                    </div>
                  </div>
                  {decr.type !== 'none' && (
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                      Decryptor: ME{decr.me >= 0 ? '+' : ''}{decr.me} · TE{decr.te >= 0 ? '+' : ''}{decr.te} on output BPC
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Datacores per attempt:</div>
                  {apiDetail.inventionInfo.datacores.map(dc => (
                    <div key={dc.materialId} className="stat-card" style={{ marginBottom: 2 }}>
                      <div className="stat-card-label">{dc.name} ×{dc.quantity}</div>
                      <div className="stat-card-value">{dc.unitPrice > 0 ? formatISK(dc.unitPrice) + '/ea' : '—'}</div>
                    </div>
                  ))}
                  {(() => {
                    const skillCost = trueCostData?.invention_cost?.per_bpc_cost;
                    const displayCost = skillCost ?? (apiDetail.inventionInfo.perBpcCost > 0 ? apiDetail.inventionInfo.perBpcCost : null);
                    if (!displayCost) return null;
                    const hasSkills = skillCost != null;
                    return (
                      <div className="stat-card" style={{ marginTop: 4, borderTop: '1px solid var(--color-border)' }}>
                        <div className="stat-card-label">
                          Est. cost/BPC
                          {hasSkills
                            ? <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(your skills + decryptor)</span>
                            : <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(base prob, no skills)</span>
                          }
                        </div>
                        <div className="stat-card-value" style={{ color: 'var(--color-danger)' }}>
                          {formatISK(displayCost)}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* ── Invention options (T1 items) ──────────────────────────────── */}
            {apiDetail.inventionOptions && apiDetail.inventionOptions.length > 0 && (() => {
              const decr = INVENTION_DECRYPTORS.find(d => d.type === (inventionDecryptorType || 'none')) ?? INVENTION_DECRYPTORS[0];
              return (
                <div className="detail-section" style={{
                  border: '1px solid rgba(255,152,0,0.35)', borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px', background: 'rgba(255,152,0,0.04)',
                }}>
                  {/* Header row with decryptor selector */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div className="detail-section-heading" style={{ color: '#ff9800', marginBottom: 0 }}>
                      Can Invent Into (T2)
                    </div>
                    <DecryptorSelect
                      value={inventionDecryptorType || 'none'}
                      onChange={val => onInventionDecryptorChange(val === 'none' ? null : val)}
                    />
                  </div>

                  {/* Decryptor stats badge (when one is selected) */}
                  {decr.type !== 'none' && (
                    <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.75, marginBottom: 8, padding: '3px 6px', background: 'rgba(255,152,0,0.08)', borderRadius: 'var(--radius-sm)', border: '0.5px solid rgba(255,152,0,0.2)' }}>
                      {decr.name}: {decr.probMult > 0 ? '+' : ''}{decr.probMult}% chance · {decr.runs >= 0 ? '+' : ''}{decr.runs} runs · ME{decr.me >= 0 ? '+' : ''}{decr.me} · TE{decr.te >= 0 ? '+' : ''}{decr.te}
                    </div>
                  )}

                  {/* Probability bonus input */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, flexShrink: 0 }}>Extra prob bonus %</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={inventionProbBonus}
                      onChange={e => onInventionProbBonusChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                      style={{ width: 48, fontSize: 10, background: 'var(--color-bg-elevated)', color: 'var(--color-text-primary)', border: '0.5px solid rgba(255,152,0,0.3)', borderRadius: 'var(--radius-sm)', padding: '2px 4px', textAlign: 'right' }}
                    />
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>rigs / implants</span>
                  </div>

                  {/* Datacores */}
                  {apiDetail.inventionDatacores && apiDetail.inventionDatacores.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, marginBottom: 4 }}>Datacores per attempt:</div>
                      {apiDetail.inventionDatacores.map(dc => (
                        <div key={dc.materialId} className="stat-card" style={{ marginBottom: 2, border: '0.5px solid rgba(255,152,0,0.2)' }}>
                          <div className="stat-card-label" style={{ color: '#ff9800', opacity: 0.85 }}>{dc.name} ×{dc.quantity}</div>
                          <div className="stat-card-value">{dc.unitPrice > 0 ? formatISK(dc.unitPrice) + '/ea' : '—'}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* T2 outcome list */}
                  <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, marginBottom: 4 }}>T2 outcomes — click to view item:</div>
                  {apiDetail.inventionOptions.map(opt => {
                    const adjProb = Math.min(1, opt.baseProbability * (1 + decr.probMult / 100) + (inventionProbBonus / 100));
                    const adjRuns = opt.outputRuns + decr.runs;
                    return (
                      <div
                        key={opt.t2BlueprintId}
                        className="stat-card"
                        style={{ marginBottom: 3, cursor: 'pointer', border: '0.5px solid rgba(255,152,0,0.3)' }}
                        role="button" tabIndex={0}
                        onClick={() => onSelectItem(opt.t2ProductId, opt.t2Name)}
                        onKeyDown={(e) => e.key === 'Enter' && onSelectItem(opt.t2ProductId, opt.t2Name)}
                      >
                        <div className="stat-card-label" style={{ color: '#ff9800' }}>
                          {opt.t2Name}
                          <span style={{ color: 'rgba(255,152,0,0.55)', marginLeft: 6 }}>
                            {(adjProb * 100).toFixed(1)}% / attempt
                            {adjRuns > 1 && ` · ${adjRuns} runs`}
                          </span>
                        </div>
                        <div className="stat-card-value" style={{ textAlign: 'right' }}>
                          {opt.t2SellPrice > 0 ? <span style={{ color: 'var(--color-success)' }}>{formatISK(opt.t2SellPrice)}</span> : '—'}
                          {opt.perBpcCost > 0 && (
                            <span style={{ color: 'rgba(255,152,0,0.55)', fontSize: 10, marginLeft: 6 }}>(cost ~{formatISK(opt.perBpcCost)})</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </>
        )}

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
        {!interHubContext && selectedTypeId && (
          <div className="detail-section">
            <div className="detail-section-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>True Profit (Net)</span>
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
              {/* v1.9.1 — Free-entry build runs input (hidden for non-manufacturable items) */}
              {!effectiveTrueCostError?.startsWith('Not manufacturable') && (
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
              )}
            </div>

            {/* v1.22 — Honesty badge: True Profit assumes you OWN the blueprint (ME-researched,
                free). When the user owns neither a BPO nor a BPC for this item, that's a silent
                flatter — flag that the acquisition cost isn't in the figure. (Phase 0 of the
                BPC-cost feature; full per-run BPC pricing is a later phase.) */}
            {!isBlueprintClick && apiDetail?.buildInfo && !apiDetail.buildInfo.blueprintOwned && (
              <div
                className="bp-ownership-note"
                title={
                  "You don't own a BPO or BPC for this item. True Profit does NOT include the cost of obtaining one. " +
                  "For T1 items, buy a BPO from the market (one-time cost, unlimited runs). " +
                  "For T2/T3, buy a BPC from contracts or invent one — this is a real per-run cost not reflected here."
                }
              >
                ⚠ You don't own a blueprint for this item — obtain a BPC or BPO before manufacturing. Acquisition cost not included in True Profit.
              </div>
            )}

            {/* v1.17.1 — Implant selector (hidden for non-manufacturable items) */}
            {!effectiveTrueCostError?.startsWith('Not manufacturable') && (() => {
              const opts: Array<{ value: string; label: string; ids: number[] }> = [
                { value: '', label: 'No implants (default)', ids: [] },
              ];
              const seen = new Set<number>();

              // Current active clone implants
              for (const id of activeImplants) {
                const imp = MFG_TIME_IMPLANTS[id];
                if (!imp || seen.has(id)) continue;
                opts.push({ value: `c${id}`, label: `Current clone — ${imp.short} (−${imp.pct}% time)`, ids: [id] });
                seen.add(id);
              }

              // Jump clones — only show clones that have at least one mfg-time implant
              jumpClones.forEach((clone, idx) => {
                const cloneMfgIds = clone.implants.filter(id => id in MFG_TIME_IMPLANTS);
                if (cloneMfgIds.length === 0) return;
                // Build a compact label from the implant shortnames
                const impLabels = cloneMfgIds.map(id => MFG_TIME_IMPLANTS[id].short).join(', ');
                opts.push({
                  value: `j${clone.jumpCloneId}`,
                  label: `Jump clone ${idx + 1} — ${impLabels}`,
                  ids: clone.implants,
                });
              });

              // What-if options for implants not already shown
              for (const id of WHATIF_BX_IDS) {
                if (seen.has(id)) continue;
                const imp = MFG_TIME_IMPLANTS[id];
                opts.push({ value: `w${id}`, label: `What-if: ${imp.short} (−${imp.pct}% time)`, ids: [id] });
              }

              // Determine the currently selected option value
              const curId = selectedImplants[0];
              let curValue = '';
              if (curId) {
                if (activeImplants.includes(curId)) {
                  curValue = `c${curId}`;
                } else {
                  // Check if it matches a jump clone selection
                  const matchedClone = jumpClones.find(c => c.implants.includes(curId));
                  curValue = matchedClone ? `j${matchedClone.jumpCloneId}` : `w${curId}`;
                }
              }

              return (
                <div className="implant-selector">
                  <span className="implant-selector-label">💊 Implants</span>
                  <select
                    className="fee-char-select"
                    value={curValue}
                    title="Implants affect build time → ISK/hr only (not material cost). Default applies none."
                    onChange={(e) => {
                      const opt = opts.find(o => o.value === e.target.value);
                      onImplantsChange(opt ? opt.ids : []);
                    }}
                    aria-label="Implant set to apply to ISK/hr"
                    style={{ flex: 1 }}
                  >
                    {opts.map(o => <option key={o.value || 'none'} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              );
            })()}

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

            {trueCostData && !trueCostLoading && trueCostData.sell_price_anomaly && (
              <div style={{ fontSize: 11, color: 'var(--color-warning, #e8a838)', padding: '4px 0 2px',
                            display: 'flex', alignItems: 'center', gap: 5 }}>
                <span>⚠</span>
                Outlier sell order — profit uses median price, not lowest ask.
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
                  {/* Tooltip — shows full effective ME breakdown */}
                  <div className="cost-tooltip">
                    {(() => {
                      const isT2    = trueCostData.manufacturing_setup?.is_t2 ?? false;
                      const bpMe    = trueCostData.manufacturing_setup?.blueprint_me   ?? blueprintME;
                      const t2Base  = trueCostData.manufacturing_setup?.t2_base_me     ?? null;
                      const decrMe  = trueCostData.manufacturing_setup?.decryptor_me_bonus ?? null;
                      const strMe   = trueCostData.manufacturing_setup?.structure_me_bonus ?? 0;
                      const rigMe   = trueCostData.manufacturing_setup?.rig_me_bonus   ?? 0;
                      const effME   = trueCostData.manufacturing_setup?.effective_me   ?? bpMe;
                      const effFac  = Math.max(0, 1 - effME / 100);
                      const rawCost = effME > 0
                        ? trueCostData.total_material_cost / effFac
                        : trueCostData.total_material_cost;
                      const saving  = rawCost - trueCostData.total_material_cost;
                      const meColor = (n: number) => n >= 0 ? 'var(--color-success)' : 'var(--color-warning)';
                      return (
                        <>
                          {isT2 ? (
                            <>
                              <div className="cost-tooltip-row">
                                <span>T2 BPC base ME</span>
                                <span style={{ color: meColor(t2Base ?? 0) }}>{t2Base}%</span>
                              </div>
                              {decrMe !== null && decrMe !== 0 && (
                                <div className="cost-tooltip-row">
                                  <span>Decryptor ME</span>
                                  <span style={{ color: meColor(decrMe) }}>{decrMe > 0 ? '+' : ''}{decrMe}%</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="cost-tooltip-row">
                              <span>Blueprint ME</span>
                              <span style={{ color: meColor(bpMe) }}>{bpMe}%</span>
                            </div>
                          )}
                          {strMe > 0 && (
                            <div className="cost-tooltip-row">
                              <span>Structure ME</span>
                              <span style={{ color: 'var(--color-success)' }}>+{strMe}%</span>
                            </div>
                          )}
                          {rigMe > 0 && (
                            <div className="cost-tooltip-row">
                              <span>Rig ME ({rigMe.toFixed(1)}% total)</span>
                              <span style={{ color: 'var(--color-success)' }}>+{rigMe.toFixed(1)}%</span>
                            </div>
                          )}
                          {(isT2 || strMe > 0 || rigMe > 0) && (
                            <div className="cost-tooltip-row" style={{
                              borderTop: '0.5px solid rgba(79,195,247,0.15)',
                              marginTop: 3, paddingTop: 3,
                            }}>
                              <span>Effective ME</span>
                              <span style={{ color: meColor(effME), fontWeight: 600 }}>
                                {effME.toFixed(1)}%
                              </span>
                            </div>
                          )}
                          {effME > 0 && (
                            <>
                              <div className="cost-tooltip-row">
                                <span>Base cost (ME 0)</span>
                                <span>{formatISK(rawCost)}</span>
                              </div>
                              <div className="cost-tooltip-row">
                                <span>ME saving ({effME.toFixed(1)}%)</span>
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

                {/* Box 4b — Invention Cost (T2 items only) */}
                {trueCostData.invention_cost && (
                  <div className="cost-box invention-cost">
                    <span className="cost-box-label">Invention</span>
                    <span className="cost-box-value" style={{ color: 'var(--color-danger)' }}>
                      {formatISK(trueCostData.invention_cost.total)}
                    </span>
                    <div className="cost-tooltip">
                      <div className="cost-tooltip-row">
                        <span>Base chance / attempt</span>
                        <span>{(trueCostData.invention_cost.base_probability * 100).toFixed(1)}%</span>
                      </div>
                      {trueCostData.invention_cost.skill_bonus > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Skill factor</span>
                          <span>×{trueCostData.invention_cost.skill_factor.toFixed(3)}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.decryptor_type !== 'none' && trueCostData.invention_cost.decryptor && (
                        <div className="cost-tooltip-row">
                          <span>Decryptor ({INVENTION_DECRYPTORS.find(d => d.type === trueCostData.invention_cost!.decryptor_type)?.name ?? trueCostData.invention_cost.decryptor_type})</span>
                          <span>×{(1 + trueCostData.invention_cost.decryptor.probMult / 100).toFixed(2)}</span>
                        </div>
                      )}
                      {(trueCostData.invention_cost.rig_bonus > 0 || trueCostData.invention_cost.prob_bonus > 0) && (
                        <div className="cost-tooltip-row">
                          <span>Rig / bonus</span>
                          <span>+{((trueCostData.invention_cost.rig_bonus + trueCostData.invention_cost.prob_bonus) * 100).toFixed(1)} pp</span>
                        </div>
                      )}
                      <div className="cost-tooltip-row">
                        <span style={{ fontWeight: 600 }}>Effective chance / attempt</span>
                        <span style={{ fontWeight: 600 }}>{(trueCostData.invention_cost.effective_probability * 100).toFixed(1)}%</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>Expected attempts per BPC</span>
                        <span>{trueCostData.invention_cost.expected_attempts.toFixed(2)}×</span>
                      </div>
                      {trueCostData.invention_cost.output_runs > 1 && (
                        <div className="cost-tooltip-row">
                          <span>Runs per invented BPC</span>
                          <span>{trueCostData.invention_cost.output_runs}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.decryptor && trueCostData.invention_cost.decryptor_type !== 'none' && (
                        <div className="cost-tooltip-row">
                          <span>Output BPC ME / TE</span>
                          <span>{trueCostData.invention_cost.decryptor.me >= 0 ? '+' : ''}{trueCostData.invention_cost.decryptor.me} / {trueCostData.invention_cost.decryptor.te >= 0 ? '+' : ''}{trueCostData.invention_cost.decryptor.te}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      {trueCostData.invention_cost.datacores.map(dc => (
                        <div key={dc.materialId} className="cost-tooltip-row">
                          <span>{dc.name} ×{dc.quantity}</span>
                          <span>{formatISK(dc.unitPrice)}/ea</span>
                        </div>
                      ))}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row">
                        <span>Datacores (×{trueCostData.invention_cost.expected_attempts.toFixed(2)} att{trueCostData.invention_cost.output_runs > 1 ? ` ÷ ${trueCostData.invention_cost.output_runs} runs` : ''})</span>
                        <span>{formatISK(trueCostData.invention_cost.datacores_cost)}</span>
                      </div>
                      {trueCostData.invention_cost.decryptor_type !== 'none' && (
                        <div className="cost-tooltip-row">
                          <span>Decryptor (×{trueCostData.invention_cost.expected_attempts.toFixed(2)} att{trueCostData.invention_cost.output_runs > 1 ? ` ÷ ${trueCostData.invention_cost.output_runs} runs` : ''})</span>
                          <span>{trueCostData.invention_cost.decryptor_cost > 0 ? formatISK(trueCostData.invention_cost.decryptor_cost) : '(price unknown)'}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.job_cost > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Invention job fees</span>
                          <span>{formatISK(trueCostData.invention_cost.job_cost)}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total ({trueCostData.runs} run{trueCostData.runs !== 1 ? 's' : ''})</span>
                        <span>{formatISK(trueCostData.invention_cost.total)}</span>
                      </div>
                      {trueCostData.invention_cost.skills.length > 0 && (
                        <div className="cost-tooltip-setup">
                          Skills: {trueCostData.invention_cost.skills.map(s => `L${s.level}`).join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                )}

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
                      <span className="cost-box-label">True Profit (Net)</span>
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

                        {/* Invention overhead */}
                        {trueCostData.invention_cost && (
                          <div className="cost-tooltip-row">
                            <span>− Invention</span>
                            <span style={{ color: 'var(--color-danger)' }}>
                              −{formatISK(trueCostData.invention_cost.total)}
                            </span>
                          </div>
                        )}

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

            {/* ── Market liquidity — can you actually sell it? (v1.20) ── */}
            {(selectedVolume != null || selectedLiquidityRisk === 'contract_only') && (() => {
              const liq  = liquidityInfo(selectedLiquidityRisk);
              const vol  = selectedVolume ?? 0;
              // Units to offload ≈ runs (1 output/run for the high-value items this
              // matters for). A rough, honestly-hedged "days to clear" — not a promise.
              const days = vol > 0 ? Math.ceil(displayRuns / vol) : 0;

              let body;
              if (selectedLiquidityRisk === 'contract_only') {
                body = <>Not sold on the open market — moves via <strong>contracts</strong> only. The daily-volume signal doesn&rsquo;t apply here.</>;
              } else if (selectedLiquidityRisk === 'low_volume') {
                body = <>Thin market — only <strong>{formatPerDay(vol)}</strong> trade. Your {displayRuns}-run batch ≈ <strong>{days} day{days !== 1 ? 's' : ''}</strong> to clear; expect to undercut to sell faster.</>;
              } else if (liq.dot === 'danger') {
                body = <><strong>{liq.label}.</strong> {liq.tip}</>;
              } else {
                body = <>Liquid — market trades <strong>{formatPerDay(vol)}</strong>. Your {displayRuns}-run batch should sell without moving the price.</>;
              }

              return (
                <div className="liquidity-note" title={liq.tip}>
                  <span className={`liq-dot liq-${liq.dot}`} aria-hidden="true" />
                  <span>{body}</span>
                </div>
              );
            })()}

            {/* ── Throughput: effective build time + ISK/hr (v1.17.0) ── */}
            {trueCostData && !trueCostLoading && trueCostData.time && trueCostData.time.base_build_seconds > 0 && (() => {
              const t = trueCostData.time;
              const fmtDur = (s: number) => {
                if (!s || s <= 0) return '—';
                const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
                if (d > 0) return `${d}d ${h}h`;
                if (h > 0) return `${h}h ${m}m`;
                return `${m}m`;
              };
              const tip =
                `Effective build time for ${trueCostData.runs} run(s): ${fmtDur(t.effective_build_seconds)} ` +
                `(base ${fmtDur(t.base_build_seconds)}).\n` +
                `Applied: TE ${t.te_pct}%, Industry L${t.industry_level} (−${4 * t.industry_level}%), ` +
                `Adv. Industry L${t.advanced_industry_level} (−${3 * t.advanced_industry_level}%), ` +
                `structure TE −${t.structure_te_bonus_pct}%` +
                (t.mfg_implant ? `, ${t.mfg_implant.name} (−${t.mfg_implant.pct}%)` : ', no mfg-time implant') +
                `.\nISK/hr = True Profit ÷ build hours.` +
                (t.reproc_implant ? `\nAlso plugged in: ${t.reproc_implant.name} (+${t.reproc_implant.pct}% reprocessing).` : '');
              return (
                <div className="iskhr-row" title={tip}>
                  <span className="iskhr-time">⏱ {fmtDur(t.effective_build_seconds)}</span>
                  <span className="iskhr-value" style={{ color: t.isk_per_hour >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {formatISK(t.isk_per_hour)}/hr
                  </span>
                  {t.mfg_implant
                    ? <span className="iskhr-implant" title={t.mfg_implant.name}>💊 −{t.mfg_implant.pct}%</span>
                    : <span className="iskhr-implant iskhr-implant-none">no implant</span>}
                </div>
              );
            })()}

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
