import { useState, useEffect, type FC } from 'react';
import type { BreakdownMaterial, EsiBlueprint, MaterialBreakdownResponse } from '../types';
import { INVENTION_DECRYPTORS } from '../types';
import { apiPost } from '../api/client';
import { formatISKDisplay as formatISK } from '../utils/format';
import { itemIconUrl } from '../utils/icons';
import { onActivateKey } from '../utils/a11y';

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
export const ChainTree: FC<ChainTreeProps> = ({ parentTypeId, regionId, ownedBlueprints, depth, onSelectItem }) => {
  const cacheKey = `${parentTypeId}:${regionId}`;
  const [fetchedData, setData] = useState<MaterialBreakdownResponse | null>(null);
  // A cached breakdown is read straight from the cache; the fetched one covers everything else.
  const data = breakdownCache.get(cacheKey) ?? fetchedData;
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(false);
  const [retry, setRetry]     = useState(0);   // bumps while the hub's prices are still loading

  useEffect(() => {
    if (breakdownCache.has(cacheKey)) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded request loader: marks loading before the request
    setLoading(true);
    setError(false);
    apiPost<MaterialBreakdownResponse>('/api/material-breakdown', {
      typeId: parentTypeId, regionId, ownedBlueprints,
    })
      .then(res => { if (!cancelled) { breakdownCache.set(cacheKey, res); setData(res); } })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        // most likely the hub's prices are still loading (HTTP 503): try again a few times
        if (retry < 4) retryTimer = setTimeout(() => setRetry(n => n + 1), 6000);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
    // ownedBlueprints reference is stable per render of RightSidebar; key on the IDs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentTypeId, regionId, retry]);

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
        onKeyDown={onActivateKey(() => onSelectItem(mat.materialId, mat.name))}
      >
        {/* Expand toggle (only when producible) */}
        {mat.canManufacture ? (
          <button type="button"
            className="btn-reset chain-toggle"
            title={open ? 'Collapse' : `Expand ${isReaction ? 'reaction' : 'build'} chain`}
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            style={{
              color: isReaction ? 'var(--color-reaction)' : 'var(--color-accent-primary)',
              cursor: 'pointer', width: 12, flexShrink: 0, fontSize: 10,
            }}
          >
            {open ? '▾' : '▸'}
          </button>
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
          {(mat.priceScope === 'jita' || mat.priceScope === 'history' || mat.priceScope === 'none') && (
            <span className="price-source-hist" title={mat.priceScope === 'jita'
              ? 'None for sale at this hub — the buy price is Jita\'s current lowest sell (imported).'
              : mat.priceScope === 'history' ? 'No sell orders at this hub or Jita — the 30-day average.' : 'No price available.'}>
              {mat.priceScope === 'jita' ? 'J' : mat.priceScope === 'history' ? '~' : '?'}
            </span>
          )}
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
export function DecryptorSelect({ value, onChange }: DecryptorSelectProps) {
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
