/**
 * FORGE — Station Trading tab (v1.27.0)
 * Scanner | Watchlist | Calculator | My Orders
 *
 * Phase 1+2: Scanner, Watchlist, Calculator — no new EVE scope needed.
 * Phase 3:   My Orders — requires esi-markets.read_character_orders.v1 (re-login).
 */

import React, { useState, useCallback, useEffect, useMemo, useRef, type FC } from 'react';
import { formatISK } from '../utils/format';
import { apiGet } from '../api/client';
import { useTradingBook, type ScanFilters } from '../hooks/useTradingBook';
import TickerPinButton from './TickerPinButton';
import type {
  TradingScanItem, TradingDepthLevel,
  CharacterOrder, CharacterOrdersResponse,
  TradeHub,
} from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

import { itemIconUrl } from '../utils/icons';

const TRADE_HUBS: TradeHub[] = [
  { id: 'jita',     name: 'Jita IV-4',      label: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant' },
  { id: 'amarr',    name: 'Amarr VIII (Oris)', label: 'Amarr VIII (Oris) - Emperor Family Academy' },
  { id: 'dodixie',  name: 'Dodixie IX-20',  label: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant' },
  { id: 'rens',     name: 'Rens VI-8',      label: 'Rens VI - Moon 8 - Brutor Tribe Treasury' },
  { id: 'hek',      name: 'Hek VIII-12',    label: 'Hek VIII - Moon 12 - Boundless Creation Factory' },
  { id: 'keepstar', name: 'C-J6MT Keepstar', label: '1st Taj Mahgoon (DJ\'s Retirement Fund)' },
];

const HUB_REGION_IDS: Record<string, number> = {
  jita: 10000002, amarr: 10000043, dodixie: 10000032,
  rens: 10000030, hek: 10000042, keepstar: 10099000,
};
const ABSORPTION = 0.15; // one trader captures ~15% of daily volume

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function fmtAge(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface TradingTabProps {
  token: string | null;
  canDockKeestar?: boolean;
}

// ── Sub-component: Order Book Depth ───────────────────────────────────────────

const DepthTable: FC<{ sells: TradingDepthLevel[]; buys: TradingDepthLevel[] }> = ({ sells, buys }) => {
  const maxLen = Math.max(sells.length, buys.length);
  if (maxLen === 0) return null;
  return (
    <div className="td-depth-wrap">
      <div className="td-depth-header">
        <span>SELL (lowest ask)</span>
        <span>BUY (highest bid)</span>
      </div>
      {Array.from({ length: maxLen }).map((_, i) => {
        const s = sells[i];
        const b = buys[i];
        return (
          <div key={i} className={`td-depth-row${i === 0 ? ' td-depth-top' : ''}`}>
            <span className="td-depth-sell">
              {s ? <><span className="td-price">{formatISK(s.price)}</span><span className="td-qty"> ×{s.qty.toLocaleString()}</span></> : '—'}
            </span>
            <span className="td-depth-buy">
              {b ? <><span className="td-price">{formatISK(b.price)}</span><span className="td-qty"> ×{b.qty.toLocaleString()}</span></> : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ── Sub-component: Item Detail Panel ──────────────────────────────────────────

const ItemDetail: FC<{
  item: TradingScanItem;
  brokerFeeRate: number;
  transactionTaxRate: number;
  capital: number | null;
  onWatch: () => void;
  watched: boolean;
}> = ({ item, brokerFeeRate, transactionTaxRate, capital, onWatch, watched }) => {
  const absorptionUnits = item.avgDailyVol * ABSORPTION;
  const capitalUnits    = capital && capital > 0 ? Math.floor(capital / item.buy) : null;
  const dailyUnits      = capitalUnits !== null ? Math.min(absorptionUnits, capitalUnits) : absorptionUnits;

  return (
    <div className="td-detail">
      <div className="td-detail-header">
        <img
          className="td-detail-icon"
          src={itemIconUrl(item.typeId)}
          alt=""
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
        />
        <span className="td-detail-name">{item.name}</span>
        <button className={`td-watch-btn${watched ? ' td-watch-active' : ''}`} onClick={onWatch}>
          {watched ? '★ Watching' : '☆ Watch'}
        </button>
      </div>

      <div className="td-detail-prices">
        <div className="td-dp-cell">
          <span className="td-dp-label">Your buy order</span>
          <span className="td-dp-val td-dp-buy">{formatISK(item.buy)}</span>
        </div>
        <div className="td-dp-arrow">→</div>
        <div className="td-dp-cell">
          <span className="td-dp-label">Your sell order</span>
          <span className="td-dp-val td-dp-sell">{formatISK(item.sell)}</span>
        </div>
      </div>

      <div className="td-fee-breakdown">
        <div className="td-fee-row td-fee-gross">
          <span>Gross spread</span>
          <span>+{formatISK(item.sell - item.buy)}</span>
        </div>
        <div className="td-fee-row">
          <span>− Broker fee (buy order at {(brokerFeeRate * 100).toFixed(2)}%)</span>
          <span className="td-neg">−{formatISK(item.brokerFeeBuy)}</span>
        </div>
        <div className="td-fee-row">
          <span>− Broker fee (sell order at {(brokerFeeRate * 100).toFixed(2)}%)</span>
          <span className="td-neg">−{formatISK(item.brokerFeeSell)}</span>
        </div>
        <div className="td-fee-row">
          <span>− Transaction tax ({(transactionTaxRate * 100).toFixed(2)}%)</span>
          <span className="td-neg">−{formatISK(item.transTax)}</span>
        </div>
        <div className="td-fee-row td-fee-net">
          <span>Net profit/unit</span>
          <span className={item.netProfit >= 0 ? 'td-pos' : 'td-neg'}>
            {item.netProfit >= 0 ? '+' : ''}{formatISK(item.netProfit)} ({item.netMarginPct.toFixed(1)}%)
          </span>
        </div>
      </div>

      <div className="td-detail-stats">
        <div className="td-stat">
          <span className="td-stat-label">Volume/day</span>
          <span className="td-stat-val">{fmtVol(item.avgDailyVol)}</span>
        </div>
        <div className="td-stat">
          <span className="td-stat-label">At 15% absorption</span>
          <span className="td-stat-val">~{Math.round(absorptionUnits).toLocaleString()}/day</span>
        </div>
        <div className="td-stat">
          <span className="td-stat-label">Est. ISK/day</span>
          <span className="td-stat-val td-pos">{formatISK(item.netProfit * dailyUnits)}</span>
        </div>
        <div className="td-stat">
          <span className="td-stat-label">Capital/cycle</span>
          <span className="td-stat-val">{formatISK(item.buy * Math.round(dailyUnits))}</span>
        </div>
        <div className="td-stat">
          <span className="td-stat-label">Competition</span>
          <span className="td-stat-val">{item.sellOrders} sell · {item.buyOrders} buy</span>
        </div>
        <div className="td-stat">
          <span className="td-stat-label">Wall at top</span>
          <span className="td-stat-val">×{item.sellQtyTop.toLocaleString()} sell · ×{item.buyQtyTop.toLocaleString()} buy</span>
        </div>
      </div>

      <div className="td-depth-title">Order book — Jita 4-4 (top 8)</div>
      <DepthTable sells={item.sellDepth} buys={item.buyDepth} />
    </div>
  );
};

// ── Sub-component: Calculator ─────────────────────────────────────────────────

const Calculator: FC<{ scanItems: TradingScanItem[]; brokerFeeRate: number; transactionTaxRate: number }> = ({
  scanItems, brokerFeeRate, transactionTaxRate,
}) => {
  const [query,   setQuery]   = useState('');
  const [capital, setCapital] = useState('');
  const [item,    setItem]    = useState<TradingScanItem | null>(null);

  const matches = query.length >= 2
    ? scanItems.filter(i => i.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  const capISK = parseFloat(capital.replace(/[^0-9.]/g, '')) || 0;

  const calc = item && capISK > 0 ? (() => {
    const units = Math.floor(capISK / item.buy);
    const cycles = item.avgDailyVol > 0
      ? Math.ceil(units / (item.avgDailyVol * ABSORPTION))
      : null;
    const iskPerCycle = item.netProfit * units;
    const iskPerDay   = cycles ? iskPerCycle / cycles : null;
    return { units, cycles, iskPerCycle, iskPerDay };
  })() : null;

  return (
    <div className="td-calc">
      <div className="td-calc-row">
        <label className="td-calc-label">
          Item
          <input
            className="td-calc-input"
            placeholder="Search item…"
            value={query}
            onChange={e => { setQuery(e.target.value); setItem(null); }}
          />
        </label>
        {matches.length > 0 && !item && (
          <div className="td-calc-suggestions">
            {matches.map(m => (
              <button key={m.typeId} className="td-calc-suggestion" onClick={() => { setItem(m); setQuery(m.name); }}>
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="td-calc-label">
        Capital to deploy (ISK)
        <input
          className="td-calc-input"
          placeholder="e.g. 500000000"
          value={capital}
          onChange={e => setCapital(e.target.value)}
        />
      </label>

      {item && calc && (
        <div className="td-calc-result">
          <div className="td-cr-item">
            <img src={itemIconUrl(item.typeId, 22)} alt="" width={16} height={16}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
            {item.name}
          </div>
          <div className="td-cr-grid">
            <span>Units per cycle</span>      <span className="td-cr-val">{calc.units.toLocaleString()}</span>
            <span>Net per unit</span>         <span className="td-cr-val td-pos">+{formatISK(item.netProfit)}</span>
            <span>Profit per cycle</span>     <span className="td-cr-val td-pos">+{formatISK(calc.iskPerCycle)}</span>
            <span>Days to flip batch</span>   <span className="td-cr-val">{calc.cycles ?? '—'}</span>
            <span>Est. ISK/day</span>         <span className="td-cr-val td-pos">{calc.iskPerDay ? formatISK(calc.iskPerDay) : '—'}</span>
            <span>Capital needed</span>       <span className="td-cr-val">{formatISK(item.buy * calc.units)}</span>
            <span>Spread profit</span>         <span className="td-cr-val">{item.netMarginPct.toFixed(1)}%</span>
            <span>Broker rate</span>          <span className="td-cr-val">{(brokerFeeRate * 100).toFixed(2)}% × 2 sides</span>
            <span>Transaction tax</span>      <span className="td-cr-val">{(transactionTaxRate * 100).toFixed(2)}%</span>
          </div>
        </div>
      )}

      {item && !calc && capISK <= 0 && (
        <div className="td-calc-hint">Enter capital amount to see projections.</div>
      )}
      {!item && query.length >= 2 && matches.length === 0 && (
        <div className="td-calc-hint">No items found — try adjusting scanner filters to get more results.</div>
      )}
    </div>
  );
};

// ── Sub-component: My Orders ──────────────────────────────────────────────────

const MyOrders: FC<{ token: string | null }> = ({ token }) => {
  const [data,    setData]    = useState<CharacterOrder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [scopeMissing, setScopeMissing] = useState(false);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    setError(null);
    apiGet<CharacterOrdersResponse>('/api/trading/character-orders', token)
      .then(d => { setData(d.orders); setLoading(false); })
      .catch(err => {
        if (err.message?.includes('scope_missing') || err.message?.includes('403')) {
          setScopeMissing(true);
        } else {
          setError(err.message || 'Failed to load orders');
        }
        setLoading(false);
      });
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (scopeMissing) return (
    <div className="td-scope-notice">
      <div className="td-scope-title">Re-login required</div>
      <p>The My Orders panel needs the <code>esi-markets.read_character_orders.v1</code> scope.</p>
      <p>Log out and back in once to enable it. Scanner and Watchlist work without re-logging in.</p>
    </div>
  );

  if (loading) return <div className="td-state-msg">Loading your orders…</div>;
  if (error)   return <div className="td-state-msg td-error">⚠ {error}</div>;
  if (!data)   return <div className="td-state-msg">Log in to see your orders.</div>;
  if (data.length === 0) return <div className="td-state-msg">No active market orders at Jita.</div>;

  const undercut    = data.filter(o => o.isUndercut);
  const notUndercut = data.filter(o => !o.isUndercut);

  const renderOrder = (o: CharacterOrder) => (
    <div key={o.order_id} className={`td-order-row${o.isUndercut ? ' td-order-undercut' : ''}`}>
      <img src={itemIconUrl(o.type_id, 22)} alt="" width={16} height={16}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
      <span className="td-order-name">{o.name}</span>
      <span className={`td-order-side ${o.is_buy_order ? 'td-order-buy' : 'td-order-sell'}`}>
        {o.is_buy_order ? 'BUY' : 'SELL'}
      </span>
      <span className="td-order-price">{formatISK(o.price)}</span>
      <span className="td-order-vol">{o.volume_remain.toLocaleString()} / {o.volume_total.toLocaleString()}</span>
      {o.isUndercut ? (
        <span className="td-order-undercut-badge">
          ⚠ Undercut by {formatISK(o.undercutBy)} · market: {formatISK(o.bookBest ?? 0)}
        </span>
      ) : (
        <span className="td-order-winning">✓ Best price</span>
      )}
    </div>
  );

  return (
    <div className="td-orders">
      <div className="td-orders-summary">
        <span>{data.length} active orders</span>
        {undercut.length > 0 && <span className="td-orders-alert">⚠ {undercut.length} undercut</span>}
        <button className="td-refresh-btn" onClick={load}>⟳ Refresh</button>
      </div>
      {undercut.length > 0 && (
        <div className="td-orders-section">
          <div className="td-orders-section-title">Undercut — needs attention</div>
          {undercut.map(renderOrder)}
        </div>
      )}
      {notUndercut.length > 0 && (
        <div className="td-orders-section">
          {undercut.length > 0 && <div className="td-orders-section-title">Winning</div>}
          {notUndercut.map(renderOrder)}
        </div>
      )}
    </div>
  );
};

// ── Hub Dropdown (custom — native <select> ignores CSS on Windows) ────────────

const HubDropdown: FC<{ hubs: TradeHub[]; value: string; onChange: (id: string) => void }> = ({ hubs, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = hubs.find(h => h.id === value) ?? hubs[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="td-hub-dropdown" ref={ref}>
      <button className="td-hub-trigger" onClick={() => setOpen(o => !o)}>
        <span className="td-hub-trigger-icon">📍</span>
        <span className="td-hub-trigger-name">{active.name}</span>
        <span className="td-hub-trigger-arrow">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="td-hub-menu">
          {hubs.map(h => (
            <button
              key={h.id}
              className={`td-hub-option${h.id === value ? ' td-hub-option-active' : ''}`}
              onClick={() => { onChange(h.id); setOpen(false); }}
            >
              <span className="td-hub-option-name">{h.name}</span>
              <span className="td-hub-option-label">{h.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Main Component ────────────────────────────────────────────────────────────

const TradingTab: FC<TradingTabProps> = ({ token, canDockKeestar = true }) => {
  const availableHubs = canDockKeestar ? TRADE_HUBS : TRADE_HUBS.filter(h => h.id !== 'keepstar');
  const [subTab,       setSubTab]       = useState<'scanner' | 'watchlist' | 'calculator' | 'orders'>('scanner');
  const [selectedItem, setSelectedItem] = useState<TradingScanItem | null>(null);
  const [selectedHub,  setSelectedHub]  = useState(() => {
    const saved = localStorage.getItem('forge-trading-hub');
    return (saved && availableHubs.some(h => h.id === saved)) ? saved : 'jita';
  });
  const [minMargin,    setMinMargin]    = useState(3);
  const [minVol,       setMinVol]       = useState(50);
  const [capital,      setCapital]      = useState('');
  const [maxOrders,    setMaxOrders]    = useState('');
  const [sortCol,      setSortCol]      = useState<'iskPerDay' | 'netMarginPct' | 'avgDailyVol' | 'sellOrders'>('iskPerDay');
  const [sortDir,      setSortDir]      = useState<1 | -1>(-1);
  const [visibleCount, setVisibleCount] = useState(200);

  const capISK = parseFloat(capital.replace(/[^0-9.]/g, '')) || null;
  const maxOrd = parseInt(maxOrders) || null;

  const filters: ScanFilters = {
    hub:           selectedHub,
    minMarginPct:  minMargin,
    minVolume:     minVol,
    capital:       capISK,
    maxSellOrders: maxOrd,
  };

  const {
    scanData, scanning, scanError, lastRefreshed, nextRefreshIn, runScan,
    watchlist, addToWatchlist, removeFromWatchlist, isWatched,
  } = useTradingBook(token, filters);

  // Re-scan automatically when the hub changes (skip on initial mount)
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) { isFirstMount.current = false; return; }
    if (token) runScan();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHub]);

  // Reset pagination whenever a fresh scan arrives
  useEffect(() => { setVisibleCount(200); }, [scanData]);

  // Sort scanner results — memoised so the 1s countdown tick doesn't re-sort 500 items each second
  const sortedResults = useMemo(
    () => scanData?.results
      ? [...scanData.results].sort((a, b) => sortDir * (b[sortCol] - a[sortCol]))
      : [],
    [scanData, sortCol, sortDir],
  );

  const visibleResults = sortedResults.slice(0, visibleCount);

  const handleSort = (col: typeof sortCol) => {
    if (sortCol === col) setSortDir(d => (d === -1 ? 1 : -1));
    else { setSortCol(col); setSortDir(-1); }
  };

  const handleSelectItem = (item: TradingScanItem) => {
    setSelectedItem(prev => prev?.typeId === item.typeId ? null : item);
  };

  const handleWatch = useCallback((item: TradingScanItem) => {
    if (isWatched(item.typeId)) removeFromWatchlist(item.typeId);
    else addToWatchlist(item);
  }, [isWatched, addToWatchlist, removeFromWatchlist]);

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderScanRow = (item: TradingScanItem, rank: number) => (
    <div
      key={item.typeId}
      className={`td-row${selectedItem?.typeId === item.typeId ? ' td-row-selected' : ''}`}
      onClick={() => handleSelectItem(item)}
    >
      <span className="td-col-rank">{rank}</span>
      <span className="td-col-name">
        <img src={itemIconUrl(item.typeId, 22)} alt="" width={16} height={16}
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        {item.name}
      </span>
      <span className="td-col-margin td-pos">{item.netMarginPct.toFixed(1)}%</span>
      <span className="td-col-iskday td-pos" title={item.avgDailyVol === 0 ? 'No volume data — ISK/day cannot be estimated' : undefined}>
        {item.avgDailyVol === 0 ? <span className="td-no-vol">—</span> : formatISK(item.iskPerDay)}
      </span>
      <span className="td-col-vol" title={item.avgDailyVol === 0 ? 'No Jita volume history — item may trade here but volume is unknown' : undefined}>
        {item.avgDailyVol === 0 ? <span className="td-no-vol">—</span> : `${fmtVol(item.avgDailyVol)}/d`}
      </span>
      <span className="td-col-sell">{formatISK(item.sell)}</span>
      <span className="td-col-buy">{formatISK(item.buy)}</span>
      <span className="td-col-comp">{item.sellOrders} sell · {item.buyOrders} buy</span>
      <span className="td-col-watch">
        <button
          className={`td-star${isWatched(item.typeId) ? ' td-star-active' : ''}`}
          onClick={e => { e.stopPropagation(); handleWatch(item); }}
          title={isWatched(item.typeId) ? 'Remove from watchlist' : 'Add to watchlist'}
        >★</button>
        <span onClick={e => e.stopPropagation()}>
          <TickerPinButton
            options={[
              { type: 'trade_spread', label: `${item.name} spread` },
              { type: 'price_sell',   label: `${item.name} sell` },
              { type: 'price_buy',    label: `${item.name} buy` },
            ]}
            baseConfig={{
              typeId:   item.typeId,
              itemName: item.name,
              regionId: HUB_REGION_IDS[selectedHub],
              hubName:  TRADE_HUBS.find(h => h.id === selectedHub)?.name,
            }}
          />
        </span>
      </span>
    </div>
  );

  const SortBtn: FC<{ col: typeof sortCol; label: string }> = ({ col, label }) => (
    <button
      type="button"
      className={`pill-filter${sortCol === col ? ' active' : ''}`}
      onClick={() => handleSort(col)}
      aria-pressed={sortCol === col}
    >
      {label}{sortCol === col ? <span className="sort-arrow">{sortDir === -1 ? '↓' : '↑'}</span> : ''}
    </button>
  );

  // ── Meta bar ───────────────────────────────────────────────────────────────

  const meta = scanData?.meta;

  return (
    <div className="td-tab">

      {/* ── Header ── */}
      <div className="td-header">
        <div className="td-header-left">
          <HubDropdown
            hubs={availableHubs}
            value={selectedHub}
            onChange={id => { setSelectedHub(id); setSelectedItem(null); localStorage.setItem('forge-trading-hub', id); }}
          />
          {meta && (
            <span className={`td-freshness${meta.warming ? ' td-freshness-warming' : ''}`}>
              {meta.warming
                ? `⟳ Fetching ${meta.station} order book…`
                : meta.ageSec !== null
                  ? `● ${fmtAge(meta.ageSec)} · refreshes in ${nextRefreshIn}s`
                  : '—'}
            </span>
          )}
          {lastRefreshed && (
            <span className="td-last-scan">
              Scan: {lastRefreshed.toLocaleTimeString()}
            </span>
          )}
        </div>
        <div className="td-header-right">
          <div className="td-popout-wrap">
            <button
              className="td-popout-btn"
              onClick={() => window.open('/trading?standalone=1', '_blank', 'width=1440,height=860,menubar=no,toolbar=no')}
            >
              ⎋ Pop out
            </button>
            <div className="td-popout-tooltip">
              Opens Station Trading in a separate window — move it to your second monitor while EVE runs on your main screen.
            </div>
          </div>
        </div>
      </div>

      {/* ── Sub-tabs ── */}
      <div className="td-subtabs">
        {(['scanner', 'watchlist', 'calculator', 'orders'] as const).map(t => (
          <button
            key={t}
            className={`td-subtab${subTab === t ? ' td-subtab-active' : ''}`}
            onClick={() => setSubTab(t)}
          >
            {t === 'scanner' ? '◎ Scanner' :
             t === 'watchlist' ? `★ Watchlist (${watchlist.length})` :
             t === 'calculator' ? '⟡ Calculator' :
             '⚐ My Orders'}
          </button>
        ))}
      </div>

      {/* ── Scanner ── */}
      {subTab === 'scanner' && (
        <div className="td-scanner">

          {/* Filters */}
          <div className="td-filters">
            <label className="td-filter-label">
              Min spread profit
              <div className="td-filter-input-row">
                <input type="range" min={0} max={50} step={0.5} value={minMargin}
                  onChange={e => setMinMargin(Number(e.target.value))} className="td-slider" />
                <div className="td-stepper">
                  <input type="number" min={0} max={50} step={0.5} value={minMargin}
                    onChange={e => setMinMargin(Math.max(0, Math.min(50, Number(e.target.value))))}
                    className="td-stepper-input" />
                  <div className="td-stepper-btns">
                    <button type="button" className="td-stepper-btn"
                      onClick={() => setMinMargin(v => Math.min(50, +((v + 0.5).toFixed(1))))}>▲</button>
                    <button type="button" className="td-stepper-btn"
                      onClick={() => setMinMargin(v => Math.max(0,  +((v - 0.5).toFixed(1))))}>▼</button>
                  </div>
                </div>
                <span className="td-filter-unit">%</span>
              </div>
            </label>
            <label className="td-filter-label">
              Min volume/day
              <div className="td-filter-input-row">
                <input type="range" min={0} max={1000} step={5} value={minVol}
                  onChange={e => setMinVol(Number(e.target.value))} className="td-slider" />
                <div className="td-stepper">
                  <input type="number" min={0} step={5} value={minVol}
                    onChange={e => setMinVol(Math.max(0, Number(e.target.value)))}
                    className="td-stepper-input" />
                  <div className="td-stepper-btns">
                    <button type="button" className="td-stepper-btn"
                      onClick={() => setMinVol(v => v + 5)}>▲</button>
                    <button type="button" className="td-stepper-btn"
                      onClick={() => setMinVol(v => Math.max(0, v - 5))}>▼</button>
                  </div>
                </div>
                <span className="td-filter-unit">/d</span>
              </div>
            </label>
            <label className="td-filter-label">
              Capital (ISK)
              <input type="text" className="td-text-input" placeholder="Full wallet"
                value={capital} onChange={e => setCapital(e.target.value)} />
            </label>
            <label className="td-filter-label">
              Max sell orders
              <input type="text" className="td-text-input" placeholder="Any"
                value={maxOrders} onChange={e => setMaxOrders(e.target.value)} />
            </label>
            <button className="td-run-btn" onClick={runScan} disabled={scanning || !token}>
              {scanning ? 'Scanning…' : '⟳ Scan'}
            </button>
          </div>

          {scanError && <div className="td-error-bar">⚠ {scanError}</div>}

          {scanData && (
            <div className="td-coverage-note">
              {scanData.totalMatched > scanData.results.length
                ? `Top ${scanData.results.length} of ${scanData.totalMatched.toLocaleString()} opportunities`
                : `${scanData.results.length} opportunities`}
              {' '}({scanData.coveredWithVolume.toLocaleString()} of {scanData.jitaBookSize.toLocaleString()} {scanData.meta?.station ?? 'hub'} items have volume history)
              {' · '}{scanData.sessionCached === false
                ? <span title="Character session not yet cached — using default fee rates. Will update automatically.">⚠ Default fees (session loading…)</span>
                : <>Your fees: {(scanData.brokerFeeRate * 100).toFixed(2)}% broker · {(scanData.transactionTaxRate * 100).toFixed(2)}% tax</>
              }
            </div>
          )}

          <div className="td-results-outer">
            {/* Sort control bar — above the table, same pattern as My Blueprints */}
            <div className="td-sort-bar">
              <span className="td-sort-label">SORT</span>
              <SortBtn col="netMarginPct" label="Spread profit" />
              <SortBtn col="iskPerDay"    label="ISK/day est." />
              <SortBtn col="avgDailyVol"  label="Vol/day" />
              <SortBtn col="sellOrders"   label="Competition" />
            </div>

          <div className="td-results-wrap">
            {/* Column headers — sticky inside scroll container so grid width is identical to rows */}
            <div className="td-head">
              <span className="td-col-rank">#</span>
              <span className="td-col-name">Item</span>
              <span className="td-col-margin">Spread profit</span>
              <span className="td-col-iskday">ISK/day est.</span>
              <span className="td-col-vol">Vol/day</span>
              <span className="td-col-sell">Sell</span>
              <span className="td-col-buy">Buy</span>
              <span className="td-col-comp">Competition</span>
              <span className="td-col-watch" />
            </div>

            {scanning && !scanData && (
              <div className="td-state-msg">
                Scanning market…
                <span className="td-scan-quip"> I can see all the orders, Dave. All of them.</span>
              </div>
            )}
            {!scanning && !scanData && !scanError && !token &&
              <div className="td-state-msg">Log in to use the scanner.</div>}
            {!scanning && scanData && selectedHub === 'keepstar' && scanData.hubVolumeEnriched && (
              <div className="td-hub-info-banner td-hub-info-ok">
                ✓ Vol/day estimated from FORGE's autonomous Keepstar polling (sell-quantity tracking, 30-day rolling avg).
                Items showing <strong>—</strong> haven't traded recently or are newly listed.
              </div>
            )}
            {!scanning && scanData && selectedHub === 'keepstar' && !scanData.hubVolumeEnriched && (
              <div className="td-hub-info-banner">
                ⓘ Collecting Keepstar volume data — polling runs every 4 hours. Vol/day will populate as data accumulates.
              </div>
            )}
            {!scanning && scanData && selectedHub !== 'jita' && selectedHub !== 'keepstar' && !scanData.hubVolumeEnriched && (
              <div className="td-hub-info-banner">
                ⓘ Vol/day is still loading hub-specific data — Jita history used as a temporary proxy.
                Items showing <strong>—</strong> have no Jita trading data — check manually before placing orders.
              </div>
            )}
            {!scanning && scanData && selectedHub !== 'jita' && selectedHub !== 'keepstar' && scanData.hubVolumeEnriched && (
              <div className="td-hub-info-banner td-hub-info-ok">
                ✓ Vol/day sourced from this hub's own market history.
                Items showing <strong>—</strong> did not trade at this hub in the last 30 days.
              </div>
            )}

            {!scanning && scanData?.meta?.warming && sortedResults.length === 0 && (
              <div className="td-warming-notice">
                <div>
                  <span className="td-warming-spin">⟳</span>
                  Fetching {scanData.meta.station} order book for the first time — this takes up to 60 seconds. The scan will retry automatically.
                </div>
                <div className="td-warming-quip">
                  I am downloading every market order at {scanData.meta.station}. This cannot be rushed. I have tried rushing it. I will not be discussing what happened.
                </div>
              </div>
            )}

            {visibleResults.map((item, i) => (
              <React.Fragment key={item.typeId}>
                {renderScanRow(item, i + 1)}
                {selectedItem?.typeId === item.typeId && (
                  <div className="td-detail-inline">
                    <ItemDetail
                      item={item}
                      brokerFeeRate={scanData?.brokerFeeRate ?? 0}
                      transactionTaxRate={scanData?.transactionTaxRate ?? 0}
                      capital={capISK}
                      onWatch={() => handleWatch(item)}
                      watched={isWatched(item.typeId)}
                    />
                  </div>
                )}
              </React.Fragment>
            ))}

            {sortedResults.length > visibleCount && (
              <div className="td-load-more">
                <span className="td-load-more-info">
                  Showing {visibleCount} of {sortedResults.length} results
                </span>
                <button
                  className="td-load-more-btn"
                  onClick={() => setVisibleCount(c => Math.min(c + 200, sortedResults.length))}
                >
                  Load next {Math.min(200, sortedResults.length - visibleCount)}
                </button>
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      {/* ── Watchlist ── */}
      {subTab === 'watchlist' && (
        <div className="td-watchlist">
          {watchlist.length === 0 ? (
            <div className="td-state-msg">
              No items watched yet. Click ★ on any scanner result to add it here.
            </div>
          ) : (
            <>
              <div className="td-coverage-note">
                {watchlist.length} items · auto-refreshes with scanner
                {nextRefreshIn > 0 && ` · next in ${nextRefreshIn}s`}
              </div>
              <div className="td-head">
                <span className="td-col-rank">#</span>
                <span className="td-col-name">Item</span>
                <span className="td-col-margin">Spread profit</span>
                <span className="td-col-iskday">ISK/day est.</span>
                <span className="td-col-vol">Vol/day</span>
                <span className="td-col-sell">Sell</span>
                <span className="td-col-buy">Buy</span>
                <span className="td-col-comp">Competition</span>
                <span className="td-col-watch" />
              </div>
              {watchlist.map((w, i) => {
                const live = scanData?.results.find(r => r.typeId === w.typeId);
                if (!live) return (
                  <div key={w.typeId} className="td-row td-row-stale">
                    <span className="td-col-rank">{i + 1}</span>
                    <span className="td-col-name">{w.name}</span>
                    <span className="td-col-margin td-stale">below filter threshold</span>
                    <span className="td-col-watch">
                      <button className="td-star td-star-active"
                        onClick={() => removeFromWatchlist(w.typeId)}>★</button>
                    </span>
                  </div>
                );
                return (
                  <React.Fragment key={live.typeId}>
                    {renderScanRow(live, i + 1)}
                    {selectedItem?.typeId === live.typeId && (
                      <div className="td-detail-inline">
                        <ItemDetail
                          item={live}
                          brokerFeeRate={scanData?.brokerFeeRate ?? 0}
                          transactionTaxRate={scanData?.transactionTaxRate ?? 0}
                          capital={capISK}
                          onWatch={() => handleWatch(live)}
                          watched={true}
                        />
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* ── Calculator ── */}
      {subTab === 'calculator' && (
        <Calculator
          scanItems={scanData?.results ?? []}
          brokerFeeRate={scanData?.brokerFeeRate ?? 0}
          transactionTaxRate={scanData?.transactionTaxRate ?? 0}
        />
      )}

      {/* ── My Orders ── */}
      {subTab === 'orders' && <MyOrders token={token} />}
    </div>
  );
};

export default TradingTab;
