/**
 * FORGE — CorpTab component
 *
 * Corp Blueprints, Assets, and Jobs — same visual treatment as personal tabs:
 *   • Blueprints: card layout with ISK/hr, Margin, Total ISK metrics + sort controls
 *   • Assets:     searchable table with Jita value column + click-to-open sidebar
 *   • Jobs:       same columns as personal Jobs tab, colour-coded by urgency
 */

import { useState, useEffect, useCallback, useRef, useMemo, type FC } from 'react';
import type {
  CorpStatus,
  CorpAccessStatus,
  CorpBlueprint,
  CorpAsset,
  CorpJob,
} from '../types';
import ForgeWait from './ForgeWait';
import { apiGet, apiPost } from '../api/client';
import { formatISK, formatMargin, formatBuildTime } from '../utils/format';
import { itemIconUrl } from '../utils/icons';

// ── Types ────────────────────────────────────────────────────────────────────

type CorpSubTab = 'blueprints' | 'assets' | 'jobs';
type BpSortField = 'iskPerHour' | 'margin' | 'profit' | 'name';

interface BlueprintProfit {
  profit:        number;
  margin:        number;
  iskPerHour:    number;
  sellPrice?:    number;
  materialCost?: number;
  buildTime?:    number;
  liquidityRisk?: string;
}

interface CorpTabProps {
  token:            string | null;
  corpStatus:       CorpStatus | null;
  accessStatus:     CorpAccessStatus | null;
  corpDataLoading?: boolean;
  regionId:         number;
  onSelectItem:     (typeId: number, name: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Verified 17 Sept 2026 against the SDE's ramActivities table (via
// https://github.com/esi/esi-issues/issues/894, which quotes it directly):
// activity_id 11 is "Reactions" (an alternate/legacy code alongside 9, not
// "Reverse Engineering" as this table previously claimed — that's activity_id
// 7, which wasn't represented here at all).
const ACTIVITY_LABELS: Record<number, string> = {
  1:  'Manufacturing', 3: 'TE Research', 4: 'ME Research',
  5:  'Copying',       7: 'Reverse Engineering', 8: 'Invention', 9: 'Reaction', 11: 'Reaction',
};

function timeRemaining(endDate: string | null): string {
  if (!endDate) return '—';
  const diff = new Date(endDate).getTime() - Date.now();
  if (diff <= 0) return 'Complete';
  return formatBuildTime(Math.floor(diff / 1000));
}

// Strip " Blueprint" suffix to get the product name, used for EVE icon URL
function productName(bpName: string): string {
  return bpName.replace(/ Blueprint$/i, '');
}

// ── Corp Blueprints sub-tab ──────────────────────────────────────────────────

interface CorpBlueprintsProps {
  token:        string | null;
  regionId:     number;
  onSelectItem: (typeId: number, name: string) => void;
}

const CorpBlueprintsView: FC<CorpBlueprintsProps> = ({ token, regionId, onSelectItem }) => {
  const [blueprints,  setBlueprints]  = useState<CorpBlueprint[]>([]);
  const [bpProfits,   setBpProfits]   = useState<Record<number, BlueprintProfit>>({});
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [search,      setSearch]      = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter,  setTypeFilter]  = useState<'all' | 'BPO' | 'BPC'>('all');
  const [total,       setTotal]       = useState(0);
  const [safetyHidden, setSafetyHidden] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [bpSort,      setBpSort]      = useState<BpSortField>('iskPerHour');
  const [bpSortDir,   setBpSortDir]   = useState<'asc' | 'desc'>('desc');

  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadIdRef    = useRef(0);
  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const myId = ++loadIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: '500', offset: '0', type: typeFilter,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      const data = await apiGet<{
        blueprints: CorpBlueprint[];
        meta: { total: number; safety_hidden?: number; last_refresh_at: string | null };
      }>(`/api/corp/blueprints?${params}`, token);
      if (myId !== loadIdRef.current) return; // stale — a newer request is in flight
      setBlueprints(data.blueprints);
      setTotal(data.meta.total);
      setSafetyHidden(data.meta.safety_hidden ?? 0);
      setLastRefresh(data.meta.last_refresh_at);
    } catch (e) {
      if (myId !== loadIdRef.current) return;
      setError((e as Error).message);
    } finally {
      if (myId !== loadIdRef.current) return;
      setLoading(false);
    }
  }, [token, typeFilter, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  // Fetch profitability for all loaded blueprint type_ids
  useEffect(() => {
    if (blueprints.length === 0) { setBpProfits({}); return; }
    const typeIds = [...new Set(blueprints.map(b => b.type_id))];
    let cancelled = false;
    apiPost<Record<number, BlueprintProfit>>(
      '/api/blueprint-profits',
      { blueprintTypeIds: typeIds, regionId },
    )
      .then(data => { if (!cancelled) setBpProfits(data || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [blueprints, regionId]);

  const handleRefresh = async () => {
    if (!token) return;
    setError(null);
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500);
    } catch (e) { setError((e as Error).message); }
  };

  const handleBpSort = (field: BpSortField) => {
    if (field === bpSort) setBpSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setBpSort(field); setBpSortDir(field === 'name' ? 'asc' : 'desc'); }
  };

  // Group blueprints by type_id (same ME wins; most runs wins for BPCs)
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map<number, CorpBlueprint[]>();
    blueprints.forEach(bp => {
      const arr = groups.get(bp.type_id);
      if (arr) arr.push(bp);
      else groups.set(bp.type_id, [bp]);
    });

    const entries = Array.from(groups.entries()).filter(([, copies]) => {
      if (typeFilter === 'BPO') return copies.some(c => c.bp_type === 'BPO');
      if (typeFilter === 'BPC') return copies.some(c => c.bp_type === 'BPC');
      return true;
    }).filter(([, copies]) => {
      if (!q) return true;
      return copies[0].name.toLowerCase().includes(q);
    });

    const dir = bpSortDir === 'asc' ? 1 : -1;
    const metric = (typeId: number): number | null => {
      const p = bpProfits[typeId];
      if (!p) return null;
      return bpSort === 'margin' ? p.margin : bpSort === 'profit' ? p.profit : p.iskPerHour;
    };
    entries.sort(([a, ac], [b, bc]) => {
      if (bpSort === 'name') return ac[0].name.localeCompare(bc[0].name);
      const va = metric(a), vb = metric(b);
      if (va == null && vb == null) return ac[0].name.localeCompare(bc[0].name);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va - vb) * dir;
    });
    return entries;
  }, [blueprints, search, typeFilter, bpProfits, bpSort, bpSortDir]);

  return (
    <div className="corp-sub-content">
      {/* Toolbar */}
      {safetyHidden > 0 && (
        <div className="bp-ownership-note" style={{ marginBottom: 10 }}>
          ⚠ {safetyHidden.toLocaleString()} item{safetyHidden === 1 ? ' is' : 's are'} locked in your corporation's Asset Safety and {safetyHidden === 1 ? "isn't" : "aren't"} listed here: they can't be used until released.
        </div>
      )}
      <div className="corp-toolbar">
        <input
          type="search"
          className="corp-search"
          placeholder="Search blueprints…"
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
          aria-label="Search corp blueprints"
        />
        <div className="pill-filter-group">
          {(['all', 'BPO', 'BPC'] as const).map(t => (
            <button key={t} type="button"
              className={`pill-filter${typeFilter === t ? ' active' : ''}`}
              onClick={() => setTypeFilter(t)}>
              {t === 'all' ? 'All' : t}
            </button>
          ))}
        </div>
        <button type="button" className="btn corp-refresh-btn"
          onClick={handleRefresh} disabled={loading}
          title="Fetch fresh data from ESI" aria-label="Refresh corp blueprints">
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {total} blueprints{lastRefresh && !isNaN(new Date(lastRefresh).getTime()) ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {/* Sort controls — same as personal Blueprints tab */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', letterSpacing: 0.5, marginRight: 2 }}>
          SORT
        </span>
        {([
          ['iskPerHour', 'ISK/hr'],
          ['margin',     'Margin'],
          ['profit',     'Total ISK'],
          ['name',       'Name'],
        ] as [BpSortField, string][]).map(([key, label]) => (
          <button key={key} type="button"
            className={`pill-filter${bpSort === key ? ' active' : ''}`}
            onClick={() => handleBpSort(key)} aria-pressed={bpSort === key}>
            {label}{bpSort === key ? <span className="sort-arrow">{bpSortDir === 'asc' ? '↑' : '↓'}</span> : ''}
          </button>
        ))}
      </div>

      {error && <div className="corp-error" role="alert">⚠ {error}</div>}
      {loading && <ForgeWait message="Loading corp blueprints…" detail="Pulling blueprint library from ESI — this can take a moment for large corps." quip="Accessing the corporate blueprint archive. I can account for all of them. I will continue to say that until I find one I cannot." />}

      {!loading && !error && grouped.length === 0 && (
        <div className="corp-empty">
          No blueprints found.{search ? ' Try clearing your search.' : ''}
        </div>
      )}

      {/* Card list — matches personal Blueprints tab layout */}
      {!loading && grouped.length > 0 && (
        <div className="bp-list">
          {grouped.map(([typeId, copies]) => {
            const bp    = copies[0]; // representative copy
            const isBpo = bp.bp_type === 'BPO';
            const pName = productName(bp.name);
            const p     = bpProfits[typeId];

            return (
              <div
                key={typeId}
                className="bp-card"
                role="button"
                tabIndex={0}
                onClick={() => onSelectItem(bp.product_id ?? typeId, pName)}
                onKeyDown={e => e.key === 'Enter' && onSelectItem(bp.product_id ?? typeId, pName)}
              >
                {/* Icon */}
                <div className={`bp-icon ${isBpo ? 'bp-icon-bpo' : 'bp-icon-bpc'}`}>
                  <img
                    src={itemIconUrl(typeId, 32, isBpo ? 'bp' : 'bpc')}
                    alt={bp.name}
                    width={32} height={32}
                    crossOrigin="anonymous"
                    onError={e => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                      const sib = (e.currentTarget as HTMLImageElement).nextSibling as HTMLElement | null;
                      if (sib) sib.style.display = 'inline';
                    }}
                  />
                  <span style={{ fontSize: 18, fontWeight: 700, display: 'none' }}>◇</span>
                </div>

                {/* Name + badges */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="bp-name">{bp.name}</span>
                  <div className="bp-badges">
                    <span className={isBpo ? 'badge-bpo' : 'badge-bpc'}>
                      {isBpo ? 'BPO' : `BPC${copies.length > 1 ? ` ×${copies.length}` : ''}`}
                    </span>
                    <span className="badge-me">ME{bp.me}</span>
                    <span className="badge-te">TE{bp.te}</span>
                    {bp.runs !== -1 && (
                      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                        {`${bp.runs} runs`}
                      </span>
                    )}
                  </div>
                </div>

                {/* Profitability metrics */}
                {p ? (
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
                ) : (
                  <div className="bp-metrics bp-metrics-empty">no market<br/>data</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Corp Assets sub-tab ──────────────────────────────────────────────────────

interface CorpAssetsProps {
  token:        string | null;
  onSelectItem: (typeId: number, name: string) => void;
}

const CorpAssetsView: FC<CorpAssetsProps> = ({ token, onSelectItem }) => {
  const [assets,          setAssets]          = useState<CorpAsset[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [search,          setSearch]          = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [total,           setTotal]           = useState(0);
  const [safetyHiddenA,    setSafetyHiddenA]   = useState(0);
  const [lastRefresh,     setLastRefresh]     = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({
        limit: '500',
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      const data = await apiGet<{
        assets: CorpAsset[];
        meta: { total: number; safety_hidden?: number; last_refresh_at: string | null };
      }>(`/api/corp/assets?${params}`, token);
      setAssets(data.assets);
      setTotal(data.meta.total);
      setSafetyHiddenA(data.meta.safety_hidden ?? 0);
      setLastRefresh(data.meta.last_refresh_at);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    if (!token) return; setError(null);
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="corp-sub-content">
      {safetyHiddenA > 0 && (
        <div className="bp-ownership-note" style={{ marginBottom: 10 }}>
          ⚠ {safetyHiddenA.toLocaleString()} item{safetyHiddenA === 1 ? ' is' : 's are'} locked in your corporation's Asset Safety and {safetyHiddenA === 1 ? "isn't" : "aren't"} listed here: they can't be used until released.
        </div>
      )}
      <div className="corp-toolbar">
        <input type="search" className="corp-search"
          placeholder="Search assets…" value={search}
          onChange={e => handleSearchChange(e.target.value)}
          aria-label="Search corp assets" />
        <button type="button" className="btn corp-refresh-btn"
          onClick={handleRefresh} disabled={loading}
          title="Fetch fresh data from ESI" aria-label="Refresh corp assets">
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {total} asset types{lastRefresh && !isNaN(new Date(lastRefresh).getTime()) ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {error && <div className="corp-error" role="alert">⚠ {error}</div>}
      {loading && <ForgeWait message="Loading corp assets…" detail="Fetching corp asset list and Jita valuations — please wait." quip="I am counting everything. Please do not move any assets while I am counting. I said please." />}

      {!loading && !error && assets.length === 0 && (
        <div className="corp-empty">No assets found.{search ? ' Try clearing your search.' : ''}</div>
      )}

      {!loading && assets.length > 0 && (
        <div className="corp-table-wrap">
          <table className="corp-table" aria-label="Corp assets">
            <thead>
              <tr>
                <th className="corp-th">Name</th>
                <th className="corp-th corp-th-right">Qty</th>
              </tr>
            </thead>
            <tbody>
              {assets.map(a => (
                <tr key={a.type_id} className="corp-row corp-row-clickable"
                  onClick={() => onSelectItem(a.type_id, a.name)}
                  role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && onSelectItem(a.type_id, a.name)}>
                  <td className="corp-td corp-td-name">{a.name}</td>
                  <td className="corp-td corp-td-right">{a.total_quantity.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── Corp Jobs sub-tab ────────────────────────────────────────────────────────

interface CorpJobsProps { token: string | null }

const CorpJobsView: FC<CorpJobsProps> = ({ token }) => {
  const [jobs,        setJobs]        = useState<CorpJob[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setError(null);
    try {
      const data = await apiGet<{
        jobs: CorpJob[];
        meta: { count: number; last_refresh_at: string | null };
      }>('/api/corp/jobs', token);
      setJobs(data.jobs);
      setLastRefresh(data.meta.last_refresh_at);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    if (!token) return; setError(null);
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="corp-sub-content">
      <div className="corp-toolbar">
        <button type="button" className="btn corp-refresh-btn"
          onClick={handleRefresh} disabled={loading}
          title="Fetch fresh data from ESI" aria-label="Refresh corp jobs">
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {jobs.length} active jobs{lastRefresh && !isNaN(new Date(lastRefresh).getTime()) ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}` : ''}
        </span>
      </div>

      {error && <div className="corp-error" role="alert">⚠ {error}</div>}
      {loading && <div className="corp-loading">Loading corp industry jobs…</div>}

      {!loading && !error && jobs.length === 0 && (
        <div className="corp-empty">No active corp industry jobs.</div>
      )}

      {!loading && jobs.length > 0 && (
        <div className="corp-table-wrap">
          <table className="corp-table" aria-label="Corp industry jobs">
            <thead>
              <tr>
                <th className="corp-th">Product</th>
                <th className="corp-th">Activity</th>
                <th className="corp-th corp-th-center">Runs</th>
                <th className="corp-th">Installer</th>
                <th className="corp-th">Status</th>
                <th className="corp-th corp-th-right">Time Remaining</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const remaining = timeRemaining(job.end_date);
                const done      = job.status === 'delivered' || remaining === 'Complete';
                const activity  = ACTIVITY_LABELS[job.activity_id ?? -1] ?? `Activity ${job.activity_id}`;
                const statusKey = (job.status || 'unknown').toLowerCase();
                return (
                  <tr key={job.job_id} className={`corp-row${done ? ' corp-row-done' : ''}`}>
                    <td className="corp-td corp-td-name">{job.product_name || job.blueprint_name}</td>
                    <td className="corp-td">{activity}</td>
                    <td className="corp-td corp-td-center">{job.runs ?? '—'}</td>
                    <td className="corp-td">{job.installer_name || '—'}</td>
                    <td className="corp-td">
                      <span className={`corp-job-status corp-job-status-${statusKey}`}>
                        {job.status ?? '—'}
                      </span>
                    </td>
                    <td className="corp-td corp-td-right" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {remaining}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── Main CorpTab component ────────────────────────────────────────────────────

const CorpTab: FC<CorpTabProps> = ({
  token, corpStatus, accessStatus, corpDataLoading, regionId, onSelectItem,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<CorpSubTab>('blueprints');

  if (corpDataLoading && (corpStatus === null || accessStatus === null)) {
    return (
      <div className="corp-not-configured">
        <span className="corp-nc-icon" aria-hidden="true">⏳</span>
        <h3 className="corp-nc-title">Checking corp access…</h3>
      </div>
    );
  }

  if (!corpStatus?.configured) {
    return (
      <div className="corp-not-configured">
        <span className="corp-nc-icon" aria-hidden="true">🏭</span>
        <h3 className="corp-nc-title">No Corporation Data</h3>
        <p className="corp-nc-desc">
          The selected character isn't in a player corporation, or their EVE permissions
          haven't been granted yet. Select a character with the Director role using the
          sidebar chips. If you are a Director and recently updated FORGE, log out and back
          in once to grant the corp data permissions.
        </p>
      </div>
    );
  }

  if (!accessStatus?.hasAccess) {
    return (
      <div className="corp-not-configured">
        <span className="corp-nc-icon" aria-hidden="true">🔒</span>
        <h3 className="corp-nc-title">{corpStatus.corp_name}</h3>
        <p className="corp-nc-desc">
          Corp data is only accessible to characters with the Director or CEO role.
          Access is checked against the <strong>currently selected character</strong> —
          if you have a Director on another character, select them using the character
          chips in the sidebar. If you are a Director and still see this, log out and
          back in to refresh EVE permissions.
        </p>
      </div>
    );
  }

  return (
    <div className="corp-content">
      {/* Sub-tab nav */}
      <div className="corp-sub-tabs" role="tablist" aria-label="Corp data sections">
        {(['blueprints', 'assets', 'jobs'] as CorpSubTab[]).map(tab => (
          <button key={tab} type="button" role="tab"
            aria-selected={activeSubTab === tab}
            className={`corp-sub-tab${activeSubTab === tab ? ' active' : ''}`}
            onClick={() => setActiveSubTab(tab)}>
            {tab === 'blueprints' && '📋 '}
            {tab === 'assets'     && '📦 '}
            {tab === 'jobs'       && '⚙ '}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        <div className="corp-sub-tab-spacer" />
        <span className="corp-corp-name-badge">{corpStatus.corp_name ?? 'Corp'}</span>
      </div>

      {activeSubTab === 'blueprints' && (
        <CorpBlueprintsView token={token} regionId={regionId} onSelectItem={onSelectItem} />
      )}
      {activeSubTab === 'assets' && (
        <CorpAssetsView token={token} onSelectItem={onSelectItem} />
      )}
      {activeSubTab === 'jobs' && (
        <CorpJobsView token={token} />
      )}
    </div>
  );
};

export default CorpTab;
