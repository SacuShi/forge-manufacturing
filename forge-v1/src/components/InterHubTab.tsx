// FORGE — Inter-Hub Arbitrage tab
// Finds items where buying at sell orders in hub A and filling buy orders at hub B
// yields a net profit after 3.375% sales tax (Accounting L5 assumed).

import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import type { InterHubArbRow, InterHubArbResponse } from '../types';
import { MARKETS } from '../data/markets';
import ForgeWait from './ForgeWait';
import { itemIconUrl } from '../utils/icons';
import InterHubHaulConfig from './InterHubHaulConfig';
import { useLatestRequest } from '../hooks/useLatestRequest';

interface CharacterSkillData {
  characterId: number;
  name:        string;
  skills:      Array<{ skill_id: number; active_skill_level: number }>;
}

interface InterHubTabProps {
  onSelectArbItem:    (typeId: number, name: string, row: InterHubArbRow) => void;
  selectedTypeId:     number | null;
  haulConfigOpen?:    boolean;
  onHaulConfigOpen?:  () => void;
  onHaulConfigClose?: () => void;
  token?:             string;
  characters?:        CharacterSkillData[];
  onHaulSaved?:       () => void;
  canDockKeestar?:    boolean;
}

const HUB_NAMES: Record<number, string> = {
  10000002: 'Jita',
  10000043: 'Amarr',
  10000032: 'Dodixie',
  10000042: 'Hek',
  10000030: 'Rens',
  10000041: 'Syndicate',
  10099000: 'C-J6MT',
};

type SortKey = 'est_daily_profit' | 'net_profit' | 'net_margin_pct' | 'isk_per_m3' | 'avg_daily_volume';

const SORT_LABELS: Record<SortKey, string> = {
  est_daily_profit: 'Est. Daily ISK',
  net_profit:       'Profit/unit',
  net_margin_pct:   'Margin %',
  isk_per_m3:       'ISK/m³',
  avg_daily_volume: 'Volume',
};

const LS_BUY  = 'forge_arb_buy_hub';
const LS_SELL = 'forge_arb_sell_hub';
const LS_MARG = 'forge_arb_min_margin';
const PAGE_SIZE = 100;

function fmtVol(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return v.toFixed(0);
}

// ISK formatter that always appends the unit so bare numbers are never ambiguous.
function fmtISKCol(v: number | null): string {
  if (v == null) return '—';
  const abs  = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B ISK`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M ISK`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}K ISK`;
  return `${sign}${Math.round(abs).toLocaleString()} ISK`;
}

function fmtIskM3(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1e9)  return (v / 1e9).toFixed(1) + 'B ISK/m³';
  if (v >= 1e6)  return (v / 1e6).toFixed(1) + 'M ISK/m³';
  if (v >= 1e3)  return (v / 1e3).toFixed(1) + 'K ISK/m³';
  return v.toFixed(0) + ' ISK/m³';
}

function marginColor(pct: number): string {
  if (pct >= 20) return 'var(--color-success)';
  if (pct >= 10) return 'var(--color-warning)';
  return 'var(--color-text-secondary)';
}

const InterHubTab: FC<InterHubTabProps> = ({
  onSelectArbItem,
  selectedTypeId,
  haulConfigOpen    = false,
  onHaulConfigOpen,
  onHaulConfigClose = () => {},
  token             = '',
  characters        = [],
  onHaulSaved,
  canDockKeestar    = true,
}) => {
  const availableMarkets = canDockKeestar ? MARKETS : MARKETS.filter(m => m.id !== 10099000);
  const [buyHub,      setBuyHub]      = useState<number>(() => parseInt(localStorage.getItem(LS_BUY)  || '10000002', 10));
  const [sellHub,     setSellHub]     = useState<number>(() => parseInt(localStorage.getItem(LS_SELL) || '10000043', 10));
  const [minMargin,   setMinMargin]   = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem(LS_MARG) || '5');
    return Math.max(1, Math.min(100, saved));
  });
  const [sortBy,      setSortBy]      = useState<SortKey>('est_daily_profit');
  const [results,     setResults]     = useState<InterHubArbRow[]>([]);
  const [hasMore,     setHasMore]     = useState(false);
  const [totalLoaded, setTotalLoaded] = useState(0);
  const [loading,     setLoading]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const latest = useLatestRequest();

  const fetchPage = useCallback(async (
    buy: number, sell: number, margin: number, sort: SortKey, offset: number, append: boolean
  ) => {
    if (buy === sell) return;
    // A fresh load (filters changed) starts a new generation; "load more" belongs to the current one. Anything
    // from an older generation is dropped when it arrives.
    const generation = append ? latest.current() : latest.begin();
    if (append) {
      if (loadingMoreRef.current) return;
      loadingMoreRef.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError(null);
    }

    try {
      const url = `/api/inter-hub-arb?buyHub=${buy}&sellHub=${sell}&minMargin=${margin}&sortBy=${sort}&limit=${PAGE_SIZE}&offset=${offset}`;
      const r = await fetch(url);
      const data: InterHubArbResponse = await r.json();
      if (!r.ok) throw new Error((data as { error?: string }).error || `HTTP ${r.status}`);
      if (!latest.isCurrent(generation)) return;

      if (append) {
        setResults(prev => [...prev, ...data.results]);
        setTotalLoaded(prev => prev + data.results.length);
      } else {
        setResults(data.results);
        setTotalLoaded(data.results.length);
      }
      setHasMore(data.has_more);
    } catch (e) {
      if (!append && latest.isCurrent(generation)) {
        setError((e as Error).message);
        setResults([]);
      }
    } finally {
      if (append) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      } else if (latest.isCurrent(generation)) {
        setLoading(false);
      }
    }
  }, [latest]);

  // Reset + reload on any filter change
  useEffect(() => {
    setTotalLoaded(0);
    fetchPage(buyHub, sellHub, minMargin, sortBy, 0, false);
  }, [fetchPage, buyHub, sellHub, minMargin, sortBy]);

  const handleLoadMore = useCallback(() => {
    fetchPage(buyHub, sellHub, minMargin, sortBy, totalLoaded, true);
  }, [fetchPage, buyHub, sellHub, minMargin, sortBy, totalLoaded]);

  const handleBuyHub = (id: number) => {
    setBuyHub(id);
    localStorage.setItem(LS_BUY, String(id));
  };
  const handleSellHub = (id: number) => {
    setSellHub(id);
    localStorage.setItem(LS_SELL, String(id));
  };
  const handleSwap = () => {
    const tmp = buyHub;
    handleBuyHub(sellHub);
    handleSellHub(tmp);
  };
  const handleMarginChange = (v: number) => {
    setMinMargin(v);
    localStorage.setItem(LS_MARG, String(v));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Controls bar */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
        padding: '12px 20px', borderBottom: '0.5px solid var(--color-border-light)',
        background: 'var(--color-bg-secondary)', flexShrink: 0,
      }}>

        {/* Buy hub */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5 }}>BUY FROM</span>
          <select
            className="market-dropdown"
            value={buyHub}
            onChange={e => handleBuyHub(parseInt(e.target.value, 10))}
            aria-label="Buy hub"
          >
            {availableMarkets.map(m => (
              <option key={m.id} value={m.id} disabled={m.id === sellHub}>
                {m.name}{m.type === 'nullsec' ? ' [NS]' : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Swap button */}
        <button
          type="button"
          className="btn"
          onClick={handleSwap}
          title="Swap buy / sell hubs"
          style={{ padding: '5px 10px', fontSize: 14, letterSpacing: 0 }}
          aria-label="Swap hubs"
        >
          ⟺
        </button>

        {/* Sell hub */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5 }}>SELL INTO</span>
          <select
            className="market-dropdown"
            value={sellHub}
            onChange={e => handleSellHub(parseInt(e.target.value, 10))}
            aria-label="Sell hub"
          >
            {availableMarkets.map(m => (
              <option key={m.id} value={m.id} disabled={m.id === buyHub}>
                {m.name}{m.type === 'nullsec' ? ' [NS]' : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 4px' }} />

        {/* Min margin slider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5 }}>MIN MARGIN</span>
          <input
            type="range" min={1} max={100} step={1} value={minMargin}
            onChange={e => handleMarginChange(Number(e.target.value))}
            className="td-slider"
            style={{ width: 90 }}
            aria-label="Minimum margin percentage"
          />
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {minMargin}%
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 4px' }} />

        {/* Sort */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5 }}>SORT</span>
          {(Object.keys(SORT_LABELS) as SortKey[]).map(key => (
            <button
              key={key}
              type="button"
              className={`pill-filter${sortBy === key ? ' active' : ''}`}
              onClick={() => setSortBy(key)}
              aria-pressed={sortBy === key}
            >
              {SORT_LABELS[key]}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 4px' }} />

        {/* Haulage config pill */}
        <button
          type="button"
          className={`pill-filter${haulConfigOpen ? ' active' : ''}`}
          onClick={onHaulConfigOpen}
          title="Configure inter-hub haulage"
        >
          ⚙ Haulage
        </button>

        {/* Result count */}
        {!loading && results.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {totalLoaded} loaded{hasMore ? '+' : ''}
          </span>
        )}
      </div>

      {/* Inter-Hub haul config strip */}
      <InterHubHaulConfig
        open={haulConfigOpen}
        onClose={onHaulConfigClose}
        token={token}
        characters={characters}
        onSaved={onHaulSaved}
      />

      {/* Content area */}
      {loading && (
        <ForgeWait
          message="Scanning inter-hub spreads…"
          detail="Comparing sell orders and buy orders across hubs — please wait."
          quip="Cross-referencing the trade winds of New Eden. This is what I live for."
        />
      )}

      {!loading && error && (
        <div style={{ padding: 24, color: 'var(--color-danger)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {!loading && !error && results.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          No opportunities found with ≥{minMargin}% net margin on this route.
          <br />
          <span style={{ fontSize: 11, marginTop: 6, display: 'block' }}>
            Try a lower minimum margin or swap the hub direction.
          </span>
        </div>
      )}

      {!loading && !error && results.length > 0 && (
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{
                position: 'sticky', top: 0, zIndex: 1,
                background: 'var(--color-bg-secondary)',
                borderBottom: '0.5px solid var(--color-border-light)',
              }}>
                <th style={thStyle()}>Item</th>
                <th style={thStyle('right')}>Buy at ({HUB_NAMES[buyHub] ?? ''})</th>
                <th style={thStyle('right')}>Sell into ({HUB_NAMES[sellHub] ?? ''})</th>
                <th style={{ ...thStyle('right'), color: sortBy === 'net_margin_pct' ? 'var(--color-accent-primary)' : undefined }}>Margin %</th>
                <th style={{ ...thStyle('right'), color: sortBy === 'net_profit'     ? 'var(--color-accent-primary)' : undefined }}>Net / unit</th>
                <th style={{ ...thStyle('right'), color: sortBy === 'isk_per_m3'     ? 'var(--color-accent-primary)' : undefined }}>ISK / m³</th>
                <th style={{ ...thStyle('right'), color: sortBy === 'avg_daily_volume'  ? 'var(--color-accent-primary)' : undefined }}>Vol / day</th>
                <th style={{ ...thStyle('right'), color: sortBy === 'est_daily_profit'  ? 'var(--color-accent-primary)' : undefined }}>Est. daily</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row, i) => {
                const isSelected = selectedTypeId === row.product_id;
                return (
                  <tr
                    key={`${row.product_id}-${i}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`View details for ${row.product_name}`}
                    onClick={() => onSelectArbItem(row.product_id, row.product_name, row)}
                    onKeyDown={e => e.key === 'Enter' && onSelectArbItem(row.product_id, row.product_name, row)}
                    style={{
                      borderBottom: '0.5px solid var(--color-border-light)',
                      background: isSelected
                        ? 'rgba(212, 150, 14, 0.20)'
                        : i % 2 === 0 ? 'var(--color-bg-primary)' : 'var(--color-bg-secondary)',
                      boxShadow: isSelected ? 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)' : undefined,
                      cursor: 'pointer',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.boxShadow = 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.boxShadow = '';
                    }}
                  >
                    <td style={tdStyle()}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <img
                          src={itemIconUrl(row.product_id)}
                          alt=""
                          width={24} height={24}
                          loading="lazy"
                          crossOrigin="anonymous"
                          style={{ borderRadius: 2, flexShrink: 0, opacity: 0.9 }}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          color: isSelected ? 'var(--color-accent-primary)' : 'var(--color-text-secondary)',
                        }}>
                          {row.product_name}
                        </span>
                      </div>
                    </td>
                    <td style={tdStyle('right')}>{fmtISKCol(row.buy_at)}</td>
                    <td style={tdStyle('right')}>{fmtISKCol(row.sell_into)}</td>
                    <td style={{ ...tdStyle('right'), color: marginColor(row.net_margin_pct), fontWeight: 600 }}>
                      {row.net_margin_pct.toFixed(1)}%
                    </td>
                    <td style={{ ...tdStyle('right'), color: 'var(--color-success)' }}>
                      {fmtISKCol(row.net_profit)}
                    </td>
                    <td style={tdStyle('right')}>{fmtIskM3(row.isk_per_m3)}</td>
                    <td style={tdStyle('right')}>{fmtVol(row.avg_daily_volume)}</td>
                    <td style={{
                      ...tdStyle('right'),
                      fontWeight: row.est_daily_profit && row.est_daily_profit > 1e8 ? 600 : undefined,
                    }}>
                      {row.est_daily_profit ? fmtISKCol(row.est_daily_profit) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Load more / end indicator */}
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
            {hasMore ? (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  style={{ letterSpacing: '1px', minWidth: 160 }}
                >
                  {loadingMore
                    ? <><span className="spin" style={{ display: 'inline-block', marginRight: 6 }}>◈</span>Loading…</>
                    : 'Load next 100  ↓'}
                </button>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                  {totalLoaded} loaded
                </span>
              </>
            ) : (
              <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                {totalLoaded} item{totalLoaded !== 1 ? 's' : ''} — end of results
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function thStyle(align: 'left' | 'right' = 'left'): React.CSSProperties {
  return {
    padding: '8px 12px',
    textAlign: align,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.5,
    color: 'var(--color-text-tertiary)',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  };
}

function tdStyle(align: 'left' | 'right' = 'left'): React.CSSProperties {
  return {
    padding: '7px 12px',
    textAlign: align,
    fontSize: 12,
    whiteSpace: 'nowrap',
    maxWidth: align === 'left' ? 220 : undefined,
  };
}

export default InterHubTab;
