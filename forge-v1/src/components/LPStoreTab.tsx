// FORGE — LP Store Calculator (v1.36.0)
// Shows LP store offers sorted by ISK/LP, with personal LP balance integration.

import { useState, useEffect, useCallback, useMemo, type FC } from 'react';
import type { LPOffer, LPFaction, LPCorp, LPStoreResponse, LPPoint } from '../types';
import { formatISK } from '../utils/format';
import ForgeWait from './ForgeWait';

import { itemIconUrl } from '../utils/icons';

const LS_FACTION  = 'forge_lp_faction';
const LS_CORP     = 'forge_lp_corp';
const LS_MIN_LP   = 'forge_lp_min_isk_per_lp';
const LS_MIN_VOL  = 'forge_lp_min_volume';
const LS_MY_LP    = 'forge_lp_my_only';
const LS_SORT_COL   = 'forge_lp_sort_col';
const LS_SORT_DIR   = 'forge_lp_sort_dir';
const LS_LP_PANEL   = 'forge_lp_panel_open';

type SortCol = 'item_name' | 'corp_name' | 'quantity' | 'lp_cost' | 'isk_cost' | 'net_isk' | 'isk_per_lp' | 'volume' | 'myLP' | 'maxBuys' | 'maxIsk';

// LPBalance is the same shape as LPPoint — alias for clarity within this component
type LPBalance = LPPoint;

interface LPStoreTabProps {
  onSelectItem:   (typeId: number, name: string) => void;
  selectedTypeId: number | null;
  lpPoints?:      LPPoint[];
  sellRegionId?:  number;
  token?:         string | null;
}

function fmtNum(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('en-GB');
}

function fmtVol(v: number | null): string {
  if (v == null) return '—';
  if (v >= 1_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toFixed(0);
}

function fmtLP(v: number): string {
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toFixed(0);
}

const LPStoreTab: FC<LPStoreTabProps> = ({ onSelectItem, selectedTypeId, lpPoints = [], sellRegionId = 10000002, token = null }) => {
  const [factions, setFactions]     = useState<LPFaction[]>([]);
  const [corps, setCorps]           = useState<LPCorp[]>([]);
  const [offers, setOffers]         = useState<LPOffer[]>([]);
  const [total, setTotal]           = useState(0);
  const [pricesLive, setPricesLive] = useState(false);
  const [hubName, setHubName]       = useState('Jita');
  const [taxRate, setTaxRate]       = useState<number | null>(null);
  const [taxCached, setTaxCached]   = useState(false);

  const [factionId, setFactionId]     = useState<number>(() => parseInt(localStorage.getItem(LS_FACTION) || '0', 10));
  const [corpId, setCorpId]           = useState<number>(() => parseInt(localStorage.getItem(LS_CORP)    || '0', 10));
  const [minIskPerLp, setMinIskPerLp] = useState<number>(() => parseInt(localStorage.getItem(LS_MIN_LP)  || '500', 10));
  const [minVolume, setMinVolume]     = useState<number>(() => parseInt(localStorage.getItem(LS_MIN_VOL) || '0',   10));
  const [myLPOnly, setMyLPOnly]       = useState<boolean>(() => localStorage.getItem(LS_MY_LP) !== 'false');
  const [category, setCategory]       = useState('');
  const [search, setSearch]           = useState('');
  const [sortCol, setSortCol]         = useState<SortCol>(() => (localStorage.getItem(LS_SORT_COL) as SortCol) || 'isk_per_lp');
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>(() => (localStorage.getItem(LS_SORT_DIR) as 'asc' | 'desc') || 'desc');
  const [lpPanelOpen, setLpPanelOpen] = useState<boolean>(() => localStorage.getItem(LS_LP_PANEL) !== 'false');

  const [offset, setOffset]           = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [dbEmpty, setDbEmpty]         = useState(false);
  const [expandedFactions, setExpandedFactions] = useState<Set<string>>(new Set());

  const toggleFactionExpand = (key: string) =>
    setExpandedFactions(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // LP balances come in pre-loaded via props (fetched in useAuth at login time)
  // lpPoints already has corp_name/faction_name from the server enrichment step
  const balances: LPBalance[] = useMemo(
    () => lpPoints.filter(p => p.lp > 0).sort((a, b) => b.lp - a.lp),
    [lpPoints]
  );

  // Load factions once
  useEffect(() => {
    fetch('/api/lp-store/factions')
      .then(r => r.json())
      .then(d => { if (d.factions?.length) setFactions(d.factions); else setDbEmpty(true); })
      .catch(() => setDbEmpty(true));
  }, []);

  // Build lookup: corp_id → LP balance
  const balanceMap = new Map(balances.map(b => [b.corp_id, b.lp]));
  const myCorpIds  = new Set(balances.map(b => b.corp_id));

  // Load corps when faction changes
  useEffect(() => {
    localStorage.setItem(LS_FACTION, String(factionId));
    setCorpId(0);
    if (factionId === 0) { setCorps([]); return; }
    fetch(`/api/lp-store/corps?factionId=${factionId}`)
      .then(r => r.json())
      .then(d => setCorps(d.corps || []))
      .catch(() => setCorps([]));
  }, [factionId]);

  useEffect(() => { localStorage.setItem(LS_CORP,    String(corpId)); },      [corpId]);
  useEffect(() => { localStorage.setItem(LS_MIN_LP,  String(minIskPerLp)); }, [minIskPerLp]);
  useEffect(() => { localStorage.setItem(LS_MIN_VOL, String(minVolume)); },   [minVolume]);
  useEffect(() => { localStorage.setItem(LS_MY_LP,   String(myLPOnly)); },    [myLPOnly]);

  const fetchOffers = useCallback((append = false, fetchOffset = 0) => {
    if (append) setLoadingMore(true);
    else { setLoading(true); setOffers([]); }
    setError(null);
    const params = new URLSearchParams({ limit: '500', offset: String(fetchOffset), regionId: String(sellRegionId) });
    if (corpId)         params.set('corpId',    String(corpId));
    else if (factionId) params.set('factionId', String(factionId));
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch(`/api/lp-store?${params}`, { headers })
      .then(r => r.json())
      .then((d: LPStoreResponse) => {
        setOffers(prev => append ? [...prev, ...(d.offers || [])] : (d.offers || []));
        setTotal(d.total || 0);
        setPricesLive(!!d.prices_live);
        if (d.hub_name) setHubName(d.hub_name);
        if (d.transaction_tax_rate != null) { setTaxRate(d.transaction_tax_rate); setTaxCached(!!d.session_cached); }
        if (append) setLoadingMore(false);
        else setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        if (append) setLoadingMore(false);
        else setLoading(false);
      });
  }, [factionId, corpId, sellRegionId]);

  useEffect(() => { setOffset(0); fetchOffers(false, 0); }, [fetchOffers]);

  // Derive sorted category list from all loaded offers
  const categories = [...new Set(offers.map(o => o.category_name).filter(Boolean) as string[])].sort();

  // Filter + annotate with personal LP data, then sort
  const filtered = offers
    .filter(o => {
      if (myLPOnly && balances.length > 0 && !myCorpIds.has(o.corp_id)) return false;
      if (category && o.category_name !== category) return false;
      if (o.isk_per_lp < minIskPerLp) return false;
      if (minVolume > 0 && (o.volume == null || o.volume < minVolume)) return false;
      if (search) {
        const q = search.toLowerCase();
        return o.item_name.toLowerCase().includes(q) || o.corp_name.toLowerCase().includes(q);
      }
      return true;
    })
    .map(o => {
      const myLP    = balanceMap.get(o.corp_id) ?? null;
      const maxBuys = (myLP != null && o.lp_cost > 0) ? Math.floor(myLP / o.lp_cost) : null;
      const maxIsk  = (maxBuys != null && o.net_isk > 0) ? maxBuys * o.net_isk : null;
      return { ...o, myLP, maxBuys, maxIsk };
    })
    .sort((a, b) => {
      const av = sortValue(a as typeof filtered[0]);
      const bv = sortValue(b as typeof filtered[0]);
      if (av === bv) return 0;
      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'desc' ? -cmp : cmp;
    });

  const showMyLPCols = balances.length > 0;

  function toggleSort(col: SortCol) {
    let dir: 'asc' | 'desc' = 'desc';
    if (sortCol === col) dir = sortDir === 'desc' ? 'asc' : 'desc';
    else if (col === 'item_name' || col === 'corp_name') dir = 'asc';
    setSortCol(col);
    setSortDir(dir);
    localStorage.setItem(LS_SORT_COL, col);
    localStorage.setItem(LS_SORT_DIR, dir);
  }

  function sortValue(o: typeof filtered[0]): number | string {
    switch (sortCol) {
      case 'item_name':  return o.item_name;
      case 'corp_name':  return o.corp_name;
      case 'quantity':   return o.quantity;
      case 'lp_cost':    return o.lp_cost;
      case 'isk_cost':   return o.isk_cost;
      case 'net_isk':    return o.net_isk;
      case 'isk_per_lp': return o.isk_per_lp;
      case 'volume':     return o.volume ?? -1;
      case 'myLP':       return o.myLP ?? -1;
      case 'maxBuys':    return o.maxBuys ?? -1;
      case 'maxIsk':     return o.maxIsk ?? -1;
      default:           return 0;
    }
  }

  if (dbEmpty) {
    return (
      <div style={{ padding: 40, color: 'var(--color-text-muted)', textAlign: 'center' }}>
        <p style={{ fontSize: 18, marginBottom: 12 }}>LP Store database is empty.</p>
        <p style={{ fontSize: 13 }}>Run <code>node sde-import.js</code> on the server to populate LP store data.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── LP Wallet Panel ── */}
      {(() => {
        const factionGroups = new Map<string, { total: number; corps: LPBalance[]; faction_id: number | null }>();
        for (const b of balances) {
          const key = b.faction_name || 'Other';
          if (!factionGroups.has(key)) factionGroups.set(key, { total: 0, corps: [], faction_id: b.faction_id });
          const g = factionGroups.get(key)!;
          g.total += b.lp;
          g.corps.push(b);
        }
        const sortedFactions = [...factionGroups.entries()].sort((a, b) => b[1].total - a[1].total);
        const grandTotal     = balances.reduce((s, b) => s + b.lp, 0);
        const hasData        = balances.length > 0;

        const togglePanel = () => {
          const next = !lpPanelOpen;
          setLpPanelOpen(next);
          localStorage.setItem(LS_LP_PANEL, String(next));
        };

        return (
          <div style={{
            flexShrink: 0,
            background: 'var(--color-bg-panel)',
            borderBottom: '2px solid var(--color-border-light)',
          }}>
            {/* Header row — always visible, click to collapse */}
            <div
              onClick={togglePanel}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px',
                cursor: 'pointer', userSelect: 'none',
                borderBottom: lpPanelOpen ? '1px solid var(--color-border-light)' : 'none',
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-accent-primary)', letterSpacing: '0.06em' }}>
                LP WALLET
              </span>
              {hasData && (
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {lpPanelOpen
                    ? `${sortedFactions.length} faction${sortedFactions.length !== 1 ? 's' : ''} · ${balances.length} corp${balances.length !== 1 ? 's' : ''}`
                    : <><span style={{ color: 'var(--color-profit)', fontWeight: 600 }}>{fmtLP(grandTotal)} LP</span>{' '}across {sortedFactions.length} faction{sortedFactions.length !== 1 ? 's' : ''}</>
                  }
                </span>
              )}
              {!hasData && (
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {lpPoints.length === 0 ? 'Log in with EVE Online to see your LP balances' : 'No LP found — earn LP by running missions or FW'}
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--color-text-muted)' }}>
                {lpPanelOpen ? '▲ Hide' : '▼ Show'}
              </span>
            </div>

            {/* Panel body */}
            {lpPanelOpen && (
              <div style={{ padding: '10px 12px' }}>

                {/* Not logged in / no LP */}
                {!hasData && (
                  <div style={{
                    padding: '12px 16px', borderRadius: 6,
                    background: 'var(--color-bg-input)', border: '1px solid var(--color-border-light)',
                    fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center',
                  }}>
                    {lpPoints.length === 0
                      ? 'Log in with EVE Online to see which corps you have LP with and how much each is worth.'
                      : 'No LP found on this character. Earn LP by running missions or Factional Warfare.'}
                  </div>
                )}

                {/* Faction accordion cards */}
                {hasData && (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                      {sortedFactions.map(([fName, group]) => {
                        const isExpanded = expandedFactions.has(fName);
                        const isActive   = myLPOnly && group.faction_id !== null && factionId === group.faction_id;
                        const logoUrl    = group.faction_id
                          ? `https://images.evetech.net/corporations/${group.faction_id}/logo?size=64`
                          : null;
                        return (
                          <div
                            key={fName}
                            style={{
                              borderRadius: 6, minWidth: 200, maxWidth: 260,
                              border: `1px solid ${isActive ? 'var(--color-accent-primary)' : 'var(--color-border-light)'}`,
                              background: isActive ? 'rgba(0,180,255,0.05)' : 'var(--color-bg-input)',
                              overflow: 'hidden',
                              transition: 'border-color 0.15s',
                            }}
                          >
                            {/* ── Collapsed header — always visible ── */}
                            <div
                              onClick={() => toggleFactionExpand(fName)}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                padding: '9px 12px', cursor: 'pointer', userSelect: 'none',
                                borderBottom: isExpanded ? '1px solid var(--color-border-light)' : 'none',
                              }}
                            >
                              {/* Faction logo */}
                              {logoUrl && (
                                <img
                                  src={logoUrl}
                                  alt={fName}
                                  width={36} height={36}
                                  style={{ borderRadius: 4, flexShrink: 0, imageRendering: 'auto' }}
                                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                />
                              )}
                              {/* LP + name */}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--color-profit)', lineHeight: 1.15 }}>
                                  {fmtLP(group.total)}
                                  <span style={{ fontSize: 9, color: 'var(--color-text-muted)', marginLeft: 3, fontWeight: 400 }}>LP</span>
                                </div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {fName}
                                </div>
                              </div>
                              {/* Expand chevron */}
                              <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>
                                {isExpanded ? '▲' : '▼'}
                              </span>
                            </div>

                            {/* ── Expanded: corp breakdown + filter button ── */}
                            {isExpanded && (
                              <div style={{ padding: '8px 12px 10px' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                                  {[...group.corps].sort((a, b) => b.lp - a.lp).map(b => (
                                    <div key={b.corp_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                      <img
                                        src={`https://images.evetech.net/corporations/${b.corp_id}/logo?size=32`}
                                        alt=""
                                        width={18} height={18}
                                        style={{ borderRadius: 2, flexShrink: 0 }}
                                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                                      />
                                      <span style={{ flex: 1, fontSize: 11, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {b.corp_name}
                                      </span>
                                      <span style={{ fontSize: 11, color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                                        {fmtLP(b.lp)}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation();
                                    if (isActive) { setFactionId(0); setMyLPOnly(false); }
                                    else { setFactionId(group.faction_id ?? 0); setMyLPOnly(true); }
                                  }}
                                  style={{
                                    width: '100%', fontSize: 10, padding: '4px 8px', borderRadius: 4,
                                    cursor: 'pointer', textAlign: 'center', fontWeight: 600,
                                    letterSpacing: '0.04em', textTransform: 'uppercase',
                                    background: isActive ? 'rgba(0,180,255,0.15)' : 'rgba(255,255,255,0.04)',
                                    border: `1px solid ${isActive ? 'var(--color-accent-primary)' : 'var(--color-border-light)'}`,
                                    color: isActive ? 'var(--color-accent-primary)' : 'var(--color-text-muted)',
                                  }}
                                >
                                  {isActive ? '✓ Filtering store — click to clear' : 'Filter store to this faction ↓'}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Sort pills */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: 'var(--color-text-muted)', letterSpacing: '0.05em', marginRight: 2 }}>SORT</span>
                      {(([
                        { col: 'isk_per_lp', label: 'ISK/LP'   },
                        { col: 'net_isk',    label: 'Net ISK'  },
                        { col: 'volume',     label: 'Vol/day'  },
                        { col: 'lp_cost',    label: 'LP Cost'  },
                        { col: 'isk_cost',   label: 'ISK Cost' },
                        { col: 'quantity',   label: 'Qty'      },
                        { col: 'item_name',  label: 'Item'     },
                        { col: 'corp_name',  label: 'Corp'     },
                        ...(showMyLPCols ? [
                          { col: 'myLP',    label: 'My LP'    },
                          { col: 'maxBuys', label: 'Max Buys' },
                          { col: 'maxIsk',  label: 'Max ISK'  },
                        ] : []),
                      ] as { col: SortCol; label: string }[])).map(({ col, label }) => (
                        <button
                          key={col}
                          type="button"
                          className={`pill-filter${sortCol === col ? ' active' : ''}`}
                          onClick={() => toggleSort(col)}
                        >
                          {label}{sortCol === col && <span className="sort-arrow">{sortDir === 'desc' ? '↓' : '↑'}</span>}
                        </button>
                      ))}
                      {myLPOnly && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setMyLPOnly(false); setFactionId(0); }}
                          style={{ marginLeft: 4, fontSize: 10, color: 'var(--color-accent-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                          × Clear filter
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Controls bar */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid var(--color-border-light)',
        background: 'var(--color-bg-panel)', alignItems: 'center', flexShrink: 0,
      }}>

        {/* My LP toggle — only when user has LP data */}
        {balances.length > 0 && (
          <>
            <button
              type="button"
              className={`pill-filter${myLPOnly ? ' active' : ''}`}
              onClick={() => { setMyLPOnly(!myLPOnly); setFactionId(0); setCorpId(0); }}
              title="Only show corps where you have LP"
            >
              ★ My LP Corps
            </button>
            <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 2px' }} />
          </>
        )}

        {/* Faction picker */}
        <select
          value={factionId}
          onChange={e => { setFactionId(parseInt(e.target.value, 10)); if (myLPOnly) setMyLPOnly(false); }}
          style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4,
                   background: 'var(--color-bg-input)', color: 'var(--color-text)',
                   border: '1px solid var(--color-border-light)' }}
        >
          <option value={0}>All Factions</option>
          {factions.map(f => (
            <option key={f.faction_id} value={f.faction_id}>
              {f.faction_name} ({f.corp_count} corps)
            </option>
          ))}
        </select>

        {/* Corp picker */}
        {corps.length > 0 && (
          <select
            value={corpId}
            onChange={e => setCorpId(parseInt(e.target.value, 10))}
            style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4,
                     background: 'var(--color-bg-input)', color: 'var(--color-text)',
                     border: '1px solid var(--color-border-light)' }}
          >
            <option value={0}>All Corps</option>
            {corps.map(c => (
              <option key={c.corp_id} value={c.corp_id}>
                {c.corp_name} ({c.offer_count})
              </option>
            ))}
          </select>
        )}

        <div style={{ width: 1, height: 20, background: 'var(--color-border-light)', margin: '0 2px' }} />

        {/* Min ISK/LP */}
        <label style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          Min ISK/LP
          <input
            type="number" min={0} step={100} value={minIskPerLp}
            onChange={e => setMinIskPerLp(parseInt(e.target.value, 10) || 0)}
            style={{ width: 70, fontSize: 12, padding: '2px 4px', borderRadius: 4,
                     background: 'var(--color-bg-input)', color: 'var(--color-text)',
                     border: '1px solid var(--color-border-light)' }}
          />
        </label>

        {/* Min Volume */}
        <label style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          Min Vol/day
          <input
            type="number" min={0} step={10} value={minVolume}
            onChange={e => setMinVolume(parseInt(e.target.value, 10) || 0)}
            style={{ width: 70, fontSize: 12, padding: '2px 4px', borderRadius: 4,
                     background: 'var(--color-bg-input)', color: 'var(--color-text)',
                     border: '1px solid var(--color-border-light)' }}
          />
        </label>

        {/* Category filter */}
        {categories.length > 0 && (
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            style={{ fontSize: 12, padding: '3px 6px', borderRadius: 4,
                     background: 'var(--color-bg-input)', color: 'var(--color-text)',
                     border: '1px solid var(--color-border-light)' }}
          >
            <option value="">All Types</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}

        {/* Search */}
        <input
          type="search" placeholder="Search item or corp…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ fontSize: 12, padding: '3px 8px', borderRadius: 4, flexGrow: 1, minWidth: 140,
                   background: 'var(--color-bg-input)', color: 'var(--color-text)',
                   border: '1px solid var(--color-border-light)' }}
        />

        <button type="button" onClick={() => { setOffset(0); fetchOffers(false, 0); }} disabled={loading} className="pill-filter" title="Refresh prices">
          ⟳ Refresh
        </button>

        <span style={{ fontSize: 11, color: pricesLive ? 'var(--color-profit)' : 'var(--color-text-muted)', marginLeft: 4 }}>
          {pricesLive ? `● ${hubName} live` : `○ ${hubName} pending`}
        </span>
        {taxRate != null && (
          <span
            title={taxCached ? 'Sales Tax based on your Accounting skill' : 'Character session not yet cached — using default rates. Will update on next refresh.'}
            style={{ fontSize: 11, color: taxCached ? 'var(--color-text-muted)' : 'var(--color-loss)', marginLeft: 4 }}
          >
            {taxCached ? `Tax ${(taxRate * 100).toFixed(2)}%` : `⚠ Tax ${(taxRate * 100).toFixed(2)}% (default)`}
          </span>
        )}

        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 'auto' }}>
          {filtered.length}{filtered.length < total ? ` / ${total}` : ''} offers
        </span>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
        {loading ? (
          <ForgeWait message="Loading LP offers…" quip="Consulting the quartermaster…" />
        ) : error ? (
          <div style={{ padding: 24, color: 'var(--color-loss)', fontSize: 13 }}>Error: {error}</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--color-text-muted)', fontSize: 13 }}>
            {myLPOnly && balances.length > 0
              ? 'No profitable offers found for your LP corps. Try lowering Min ISK/LP or disabling "My LP Corps".'
              : 'No offers match your filters. Try lowering Min ISK/LP or selecting a different faction.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg-panel)', position: 'sticky', top: 0, zIndex: 2 }}>
                {([
                  { label: 'Item',       left: true  },
                  { label: 'Corp',       left: true  },
                  { label: 'Qty',        left: false },
                  { label: 'LP Cost',    left: false },
                  { label: 'ISK Cost',   left: false },
                  { label: 'Req. Items', left: true  },
                  { label: `${hubName} Buy`, left: false },
                  { label: 'Net ISK',    left: false },
                  { label: 'ISK/LP',     left: false },
                  { label: 'Vol/day',    left: false },
                  ...(showMyLPCols ? [
                    { label: 'My LP',    left: false },
                    { label: 'Max Buys', left: false },
                    { label: 'Max ISK',  left: false },
                  ] : []),
                ] as { label: string; left: boolean }[]).map(h => (
                  <th key={h.label} style={{
                    padding: '5px 8px', textAlign: h.left ? 'left' : 'right',
                    color: 'var(--color-text-muted)', fontWeight: 500,
                    borderBottom: '1px solid var(--color-border-light)', whiteSpace: 'nowrap',
                  }}>
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((o, i) => {
                const isSelected = o.type_id === selectedTypeId;
                const hasMyLP    = o.myLP != null;
                // Affordability — only meaningful when we have the player's LP balances
                const canAfford  = showMyLPCols && hasMyLP && (o.maxBuys ?? 0) >= 1;
                const cantAfford = showMyLPCols && hasMyLP && (o.maxBuys ?? 0) === 0;
                const rowBg = isSelected
                  ? 'rgba(212, 150, 14, 0.20)'
                  : canAfford
                    ? 'rgba(0,255,100,0.13)'
                    : cantAfford
                      ? 'rgba(255,50,30,0.11)'
                      : i % 2 === 0 ? 'var(--color-bg-primary)' : 'var(--color-bg-secondary)';
                return (
                  <tr
                    key={`${o.corp_id}:${o.offer_id}`}
                    onClick={() => onSelectItem(o.type_id, o.item_name)}
                    style={{
                      cursor: 'pointer',
                      background: rowBg,
                      boxShadow: isSelected ? 'inset 0 0 0 1px rgba(212, 150, 14, 0.55)' : undefined,
                      opacity: cantAfford ? 0.55 : 1,
                    }}
                  >
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <img src={itemIconUrl(o.type_id, 32, /blueprint|reaction formula/i.test(o.item_name) ? 'bpc' : 'icon')} alt="" width={24} height={24}
                          style={{ borderRadius: 3, flexShrink: 0 }}
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        <span style={{ color: 'var(--color-accent-primary)' }}>{o.item_name}</span>
                        {canAfford && (
                          <span title={`You can buy ${fmtNum(o.maxBuys ?? null)} of these`} style={{
                            fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                            background: 'rgba(0,255,100,0.25)', color: '#00ff78', letterSpacing: '0.04em',
                          }}>BUYABLE</span>
                        )}
                        {cantAfford && showMyLPCols && (
                          <span title={`Need ${fmtNum(o.lp_cost)} LP — you have ${fmtNum(o.myLP ?? 0)}`} style={{
                            fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                            background: 'rgba(255,40,20,0.28)', color: '#ff4444', letterSpacing: '0.04em',
                          }}>LOW LP</span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                      {o.corp_name}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>{fmtNum(o.quantity)}</td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>
                      {fmtLP(o.lp_cost)} LP
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right',
                                 color: o.isk_cost > 0 ? 'var(--color-loss)' : 'var(--color-text-muted)' }}>
                      {o.isk_cost > 0 ? formatISK(o.isk_cost) : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', maxWidth: 220 }}>
                      {o.required_items.length === 0 ? (
                        <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                          {o.required_items.map(r => (
                            <span key={r.type_id} style={{ color: 'var(--color-text-muted)', whiteSpace: 'nowrap', fontSize: 11 }}>
                              {fmtNum(r.quantity)}× {r.name}
                              {r.unit_price > 0 && <span style={{ color: 'var(--color-loss)', marginLeft: 4 }}>({formatISK(r.total_cost)})</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>
                      {o.jita_buy > 0 ? formatISK(o.jita_buy) : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right',
                                 color: o.net_isk > 0 ? 'var(--color-profit)' : 'var(--color-loss)' }}>
                      {o.jita_buy > 0 ? formatISK(o.net_isk) : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600,
                                 color: o.isk_per_lp >= 1000 ? 'var(--color-profit)' : o.isk_per_lp >= 0 ? 'var(--color-text)' : 'var(--color-loss)' }}>
                      {o.jita_buy > 0 ? formatISK(o.isk_per_lp) : '—'}
                    </td>
                    <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--color-text-muted)' }}>
                      {fmtVol(o.volume)}
                    </td>
                    {showMyLPCols && (
                      <>
                        <td style={{ padding: '4px 8px', textAlign: 'right',
                                     color: hasMyLP ? 'var(--color-profit)' : 'var(--color-text-muted)' }}>
                          {hasMyLP ? fmtLP(o.myLP!) : '—'}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right',
                                     color: o.maxBuys ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
                          {fmtNum(o.maxBuys ?? null)}
                        </td>
                        <td style={{ padding: '4px 8px', textAlign: 'right', fontWeight: 600,
                                     color: o.maxIsk != null && o.maxIsk > 0 ? 'var(--color-profit)' : 'var(--color-text-muted)' }}>
                          {o.maxIsk != null && o.maxIsk > 0 ? formatISK(o.maxIsk) : '—'}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '6px 12px', fontSize: 11, color: 'var(--color-text-muted)',
        borderTop: '1px solid var(--color-border-light)', background: 'var(--color-bg-panel)', flexShrink: 0,
      }}>
        <span>ISK/LP = (hub buy × qty × (1 − sales tax) − ISK cost − required item costs) ÷ LP cost. Sales tax uses your Accounting skill. Click any row for item details.</span>
        {offers.length < total && offers.length > 0 && (
          <button
            type="button"
            className="pill-filter"
            disabled={loadingMore}
            onClick={() => {
              const next = offset + 500;
              setOffset(next);
              fetchOffers(true, next);
            }}
            style={{ flexShrink: 0 }}
          >
            {loadingMore ? '…' : `Load next 500 (${fmtNum(total - offers.length)} remaining)`}
          </button>
        )}
      </div>
    </div>
  );
};

export default LPStoreTab;
