/**
 * FORGE v1.4.0 — CorpTab component
 *
 * Renders the Corp section of the main content area.
 * Manages its own sub-tab state: Blueprints | Assets | Jobs.
 *
 * Handles three top-level states:
 *   1. Corp data loading → spinner
 *   2. Corp not configured → "Not set up" placeholder
 *   3. Corp configured, no Director/CEO access → access-denied placeholder
 *   4. Corp configured, access granted → sub-tab data views
 *
 * Data fetching is lazy — loads when the sub-tab becomes active,
 * with a manual Refresh button to pull fresh ESI data.
 */

import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import type {
  CorpStatus,
  CorpAccessStatus,
  CorpBlueprint,
  CorpAsset,
  CorpJob,
} from '../types';
import { apiGet, apiPost } from '../api/client';
import { formatBuildTime } from '../utils/format';

// ── Types ────────────────────────────────────────────────────────────────────

type CorpSubTab = 'blueprints' | 'assets' | 'jobs';

interface CorpTabProps {
  token:            string | null;
  corpStatus:       CorpStatus | null;
  accessStatus:     CorpAccessStatus | null;
  /** True while useCorpData is fetching status + access on first tab activation */
  corpDataLoading?: boolean;
}

// ── Activity label map ───────────────────────────────────────────────────────

const ACTIVITY_LABELS: Record<number, string> = {
  1:  'Manufacturing',
  3:  'TE Research',
  4:  'ME Research',
  5:  'Copying',
  8:  'Invention',
  9:  'Reaction',
  11: 'Rev. Engineering',
};

// ── Sub-tab: Blueprints ──────────────────────────────────────────────────────

interface CorpBlueprintsProps { token: string | null }

const CorpBlueprintsView: FC<CorpBlueprintsProps> = ({ token }) => {
  const [blueprints, setBlueprints] = useState<CorpBlueprint[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [search,     setSearch]     = useState('');
  // debouncedSearch is what actually drives the API call — updated 300 ms after typing stops
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'BPO' | 'BPC'>('all');
  const [total,      setTotal]      = useState(0);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [sortField,   setSortField]   = useState<'name' | 'me' | 'te' | 'runs'>('name');
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc');

  // Debounce: only update debouncedSearch 300 ms after the user stops typing
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  };
  // Clean up on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit:  '200',
        offset: '0',
        type:   typeFilter,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      const data = await apiGet<{
        blueprints: CorpBlueprint[];
        meta: { total: number; last_refresh_at: string | null };
      }>(`/api/corp/blueprints?${params}`, token);
      setBlueprints(data.blueprints);
      setTotal(data.meta.total);
      setLastRefresh(data.meta.last_refresh_at);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, typeFilter, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    if (!token) return;
    setError(null); // clear any stale error before refresh
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500); // brief delay to let server-side ESI refresh complete
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleSort = (field: typeof sortField) => {
    if (field === sortField) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sorted = [...blueprints].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortField === 'me')   cmp = a.me   - b.me;
    else if (sortField === 'te')   cmp = a.te   - b.te;
    else if (sortField === 'runs') cmp = a.runs - b.runs;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const SortArrow: FC<{ field: typeof sortField }> = ({ field }) =>
    field === sortField ? (
      <span className="sort-arrow">{sortDir === 'asc' ? '↑' : '↓'}</span>
    ) : null;

  return (
    <div className="corp-sub-content">
      {/* Toolbar */}
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
            <button
              key={t}
              type="button"
              className={`pill-filter${typeFilter === t ? ' active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {t === 'all' ? 'All' : t}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn corp-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          title="Fetch fresh data from ESI"
          aria-label="Refresh corp blueprint data from ESI"
        >
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {total} blueprints
          {lastRefresh
            ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}`
            : ''}
        </span>
      </div>

      {error && <div className="corp-error" role="alert">⚠ {error}</div>}
      {loading && <div className="corp-loading">Loading corp blueprints…</div>}

      {!loading && !error && sorted.length === 0 && (
        <div className="corp-empty">
          No blueprints found.
          {search ? ' Try clearing your search filter.' : ''}
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="corp-table-wrap">
          <table className="corp-table" aria-label="Corp blueprints">
            <thead>
              <tr>
                <th
                  className="corp-th corp-th-sortable"
                  onClick={() => handleSort('name')}
                  aria-sort={sortField === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Name <SortArrow field="name" />
                </th>
                <th className="corp-th corp-th-center">Type</th>
                <th
                  className="corp-th corp-th-center corp-th-sortable"
                  onClick={() => handleSort('me')}
                  title="Material Efficiency"
                  aria-sort={sortField === 'me' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  ME <SortArrow field="me" />
                </th>
                <th
                  className="corp-th corp-th-center corp-th-sortable"
                  onClick={() => handleSort('te')}
                  title="Time Efficiency"
                  aria-sort={sortField === 'te' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  TE <SortArrow field="te" />
                </th>
                <th
                  className="corp-th corp-th-center corp-th-sortable"
                  onClick={() => handleSort('runs')}
                  title="Runs remaining (BPC only)"
                  aria-sort={sortField === 'runs' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Runs <SortArrow field="runs" />
                </th>
                <th className="corp-th">Location</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(bp => (
                <tr key={bp.item_id} className="corp-row">
                  <td className="corp-td corp-td-name">{bp.name}</td>
                  <td className="corp-td corp-td-center">
                    <span className={`corp-bp-badge corp-bp-badge-${bp.bp_type.toLowerCase()}`}>
                      {bp.bp_type}
                    </span>
                  </td>
                  <td className="corp-td corp-td-center">{bp.me}</td>
                  <td className="corp-td corp-td-center">{bp.te}</td>
                  <td className="corp-td corp-td-center">
                    {bp.runs === -1 ? '∞' : bp.runs}
                  </td>
                  <td className="corp-td corp-td-location" title={bp.location_flag ?? ''}>
                    {bp.location_flag ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── Sub-tab: Assets ──────────────────────────────────────────────────────────

interface CorpAssetsProps { token: string | null }

const CorpAssetsView: FC<CorpAssetsProps> = ({ token }) => {
  const [assets,          setAssets]          = useState<CorpAsset[]>([]);
  const [loading,         setLoading]         = useState(false);
  const [error,           setError]           = useState<string | null>(null);
  const [search,          setSearch]          = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [total,           setTotal]           = useState(0);
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
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: '500',
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      });
      const data = await apiGet<{
        assets: CorpAsset[];
        meta: { total: number; last_refresh_at: string | null };
      }>(`/api/corp/assets?${params}`, token);
      setAssets(data.assets);
      setTotal(data.meta.total);
      setLastRefresh(data.meta.last_refresh_at);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, debouncedSearch]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    if (!token) return;
    setError(null); // clear any stale error before refresh
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="corp-sub-content">
      <div className="corp-toolbar">
        <input
          type="search"
          className="corp-search"
          placeholder="Search assets…"
          value={search}
          onChange={e => handleSearchChange(e.target.value)}
          aria-label="Search corp assets"
        />
        <button
          type="button"
          className="btn corp-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          title="Fetch fresh data from ESI"
          aria-label="Refresh corp asset data from ESI"
        >
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {total} asset types
          {lastRefresh
            ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}`
            : ''}
        </span>
      </div>

      {error && <div className="corp-error" role="alert">⚠ {error}</div>}
      {loading && <div className="corp-loading">Loading corp assets…</div>}

      {!loading && !error && assets.length === 0 && (
        <div className="corp-empty">
          No assets found.{search ? ' Try clearing your search filter.' : ''}
        </div>
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
                <tr key={a.type_id} className="corp-row">
                  <td className="corp-td corp-td-name">{a.name}</td>
                  <td className="corp-td corp-td-right">
                    {a.total_quantity.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ── Sub-tab: Jobs ────────────────────────────────────────────────────────────

interface CorpJobsProps { token: string | null }

const CorpJobsView: FC<CorpJobsProps> = ({ token }) => {
  const [jobs,        setJobs]        = useState<CorpJob[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
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
    if (!token) return;
    setError(null); // clear any stale error before refresh
    try {
      await apiPost('/api/corp/refresh', {}, token);
      setTimeout(load, 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const timeRemaining = (endDate: string | null): string => {
    if (!endDate) return '—';
    const diff = new Date(endDate).getTime() - Date.now();
    if (diff <= 0) return 'Complete';
    return formatBuildTime(Math.floor(diff / 1000));
  };

  return (
    <div className="corp-sub-content">
      <div className="corp-toolbar">
        <button
          type="button"
          className="btn corp-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          title="Fetch fresh data from ESI"
          aria-label="Refresh corp job data from ESI"
        >
          ⟳ Refresh
        </button>
        <span className="corp-meta-text">
          {jobs.length} active jobs
          {lastRefresh
            ? ` · Updated ${new Date(lastRefresh).toLocaleTimeString()}`
            : ''}
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
                <th className="corp-th corp-th-right">Time Left</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(job => {
                const done     = job.status === 'delivered' || timeRemaining(job.end_date) === 'Complete';
                const activity = ACTIVITY_LABELS[job.activity_id ?? -1] ?? `Activity ${job.activity_id}`;
                return (
                  <tr key={job.job_id} className={`corp-row${done ? ' corp-row-done' : ''}`}>
                    <td className="corp-td corp-td-name">{job.product_name}</td>
                    <td className="corp-td">{activity}</td>
                    <td className="corp-td corp-td-center">{job.runs ?? '—'}</td>
                    <td className="corp-td">{job.installer_name}</td>
                    <td className="corp-td">
                      <span className={`corp-job-status corp-job-status-${(job.status || 'unknown').toLowerCase()}`}>
                        {job.status ?? '—'}
                      </span>
                    </td>
                    <td className="corp-td corp-td-right">
                      {timeRemaining(job.end_date)}
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

const CorpTab: FC<CorpTabProps> = ({ token, corpStatus, accessStatus, corpDataLoading }) => {
  const [activeSubTab, setActiveSubTab] = useState<CorpSubTab>('blueprints');

  // Still fetching corp status, or re-checking access after a character switch —
  // show a spinner so we don't flash "Not Configured" or a stale access decision.
  if (corpDataLoading && (corpStatus === null || accessStatus === null)) {
    return (
      <div className="corp-not-configured">
        <span className="corp-nc-icon" aria-hidden="true">⏳</span>
        <h3 className="corp-nc-title">Checking corp access…</h3>
      </div>
    );
  }

  // Corp not configured
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

  // Corp configured, but character is not a Director
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

  // Access granted — render sub-tabs
  return (
    <div className="corp-content">
      {/* Sub-tab nav */}
      <div className="corp-sub-tabs" role="tablist" aria-label="Corp data sections">
        {(['blueprints', 'assets', 'jobs'] as CorpSubTab[]).map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeSubTab === tab}
            className={`corp-sub-tab${activeSubTab === tab ? ' active' : ''}`}
            onClick={() => setActiveSubTab(tab)}
          >
            {tab === 'blueprints' && '📋 '}
            {tab === 'assets'     && '📦 '}
            {tab === 'jobs'       && '⚙ '}
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
        <div className="corp-sub-tab-spacer" />
        <span className="corp-corp-name-badge">{corpStatus.corp_name}</span>
      </div>

      {/* Sub-tab panels */}
      {activeSubTab === 'blueprints' && <CorpBlueprintsView token={token} />}
      {activeSubTab === 'assets'     && <CorpAssetsView     token={token} />}
      {activeSubTab === 'jobs'       && <CorpJobsView       token={token} />}
    </div>
  );
};

export default CorpTab;
