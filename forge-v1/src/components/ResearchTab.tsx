/**
 * FORGE v1.11.0 — ME Research ROI tab
 *
 * Ranks the player's owned BPOs by the ISK saved per build when researched from
 * their current ME up to a target ME (default 10). Answers "which blueprint
 * should I research next?" — the highest-leverage research-prioritisation insight
 * for a capital / structure manufacturer.
 *
 * ISK saving is exact (material qty delta × market price). Research time is an
 * estimate that requires the SDE research_time import; until then the time column
 * shows "—" and ranking is purely by ISK.
 *
 * Security: no dangerouslySetInnerHTML; icon URLs use numeric typeId only.
 */

import { useState, useEffect, useMemo, useCallback, type FC } from 'react';
import type { EsiBlueprint, ResearchRoiItem, ResearchRoiResponse } from '../types';
import { apiPost } from '../api/client';
import { formatISK } from '../utils/format';

const ICON_BASE = 'https://images.evetech.net/types';

type SortKey = 'saving' | 'pct' | 'time' | 'projected';

interface ResearchTabProps {
  blueprints:   EsiBlueprint[];
  /** Selected market hub region id — drives material prices. */
  regionId:     number;
  /** Open an item in the right sidebar. */
  onSelectItem: (typeId: number, name: string) => void;
}

/** Day/hour-aware duration formatter (research times run to days). */
function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const ResearchTab: FC<ResearchTabProps> = ({ blueprints, regionId, onSelectItem }) => {
  const [data, setData]       = useState<ResearchRoiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('saving');
  const [buildsPerMonth, setBuildsPerMonth] = useState('10');

  // Owned BPOs only (runs === -1) — payload the endpoint needs.
  const ownedBpos = useMemo(
    () => blueprints
      .filter(b => b.runs === -1)
      .map(b => ({ type_id: b.type_id, material_efficiency: b.material_efficiency, runs: b.runs })),
    [blueprints]
  );

  useEffect(() => {
    if (ownedBpos.length === 0) { setData({ items: [], research_time_available: false }); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiPost<ResearchRoiResponse>('/api/me-research-roi', {
      blueprints: ownedBpos, regionId, targetME: 10,
    })
      .then(res => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setError('Failed to compute research ROI.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ownedBpos, regionId]);

  const builds = Math.max(0, parseInt(buildsPerMonth, 10) || 0);

  const sorted = useMemo<ResearchRoiItem[]>(() => {
    if (!data) return [];
    const arr = [...data.items];
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'pct':       return b.pctSaving - a.pctSaving;
        case 'time':      return (a.researchTimeSec ?? Infinity) - (b.researchTimeSec ?? Infinity);
        case 'projected': return (b.savingPerRun * b.productQuantity) - (a.savingPerRun * a.productQuantity);
        default:          return b.savingPerRun - a.savingPerRun;
      }
    });
    return arr;
  }, [data, sortKey]);

  const totalMonthlySaving = useMemo(
    () => sorted.reduce((s, it) => s + it.savingPerRun * builds, 0),
    [sorted, builds]
  );

  const Header: FC<{ k: SortKey; label: string; title?: string }> = useCallback(
    ({ k, label, title }) => (
      <th
        role="button"
        title={title}
        onClick={() => setSortKey(k)}
        style={{ cursor: 'pointer', whiteSpace: 'nowrap', color: sortKey === k ? 'var(--color-accent-primary)' : undefined }}
      >
        {label}{sortKey === k ? ' ▾' : ''}
      </th>
    ),
    [sortKey]
  );

  return (
    <div className="main-panel">
      {/* Intro + controls */}
      <div style={{ marginBottom: 10 }}>
        <h1 className="content-title" style={{ margin: 0 }}>ME Research ROI</h1>
        <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)', margin: '4px 0 0', maxWidth: 640 }}>
          Owned BPOs below ME10, ranked by ISK saved per build once researched to ME10.
          Material savings are exact at current {`${regionId === 10000002 ? 'Jita' : 'hub'}`} prices.
          {data && !data.research_time_available && (
            <> Research-time estimates need the SDE import — run it to populate the Time column.</>
          )}
        </p>
      </div>

      <div className="filter-row" style={{ gap: 12, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          Builds / month per BP:
          <input
            type="number" min={0} step={1} value={buildsPerMonth}
            onChange={(e) => setBuildsPerMonth(e.target.value)}
            className="filter-input" style={{ width: 64, textAlign: 'center' }}
          />
        </label>
        {sorted.length > 0 && builds > 0 && (
          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
            Projected total monthly saving if all researched:{' '}
            <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>{formatISK(totalMonthlySaving)} ISK</span>
          </span>
        )}
      </div>

      {loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          <span className="spin" style={{ display: 'inline-block', marginRight: 8 }}>◈</span>Computing research ROI…
        </div>
      )}
      {error && !loading && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-danger)', fontSize: 13 }}>{error}</div>
      )}

      {!loading && !error && data && sorted.length === 0 && (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 12 }}>
          {ownedBpos.length === 0
            ? 'No owned BPOs found. Only Blueprint Originals can be researched.'
            : 'All your BPOs are already at ME10 — nothing left to research. 🎉'}
        </div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 240px)' }}>
          <table className="roi-table">
            <thead>
              <tr>
                <th>Blueprint</th>
                <th title="Current ME → target ME">ME</th>
                <Header k="saving"    label="Saving / build" title="ISK saved per build at ME10" />
                <Header k="pct"       label="%"               title="Saving as % of material cost" />
                <Header k="projected" label="× batch"         title="Saving × product quantity per run" />
                <Header k="time"      label="Research time"   title="Estimated time to research current ME → ME10 (needs SDE import)" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((it) => (
                <tr
                  key={it.blueprintTypeId}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectItem(it.productId, it.productName)}
                  onKeyDown={(e) => e.key === 'Enter' && onSelectItem(it.productId, it.productName)}
                >
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <img
                        src={`${ICON_BASE}/${it.productId}/icon?size=32`}
                        alt="" width={24} height={24} crossOrigin="anonymous"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                        style={{ flexShrink: 0, borderRadius: 2 }}
                      />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.productName}
                      </span>
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--color-text-tertiary)' }}>
                    {it.currentME} → {it.targetME}
                  </td>
                  <td style={{ color: 'var(--color-success)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {formatISK(it.savingPerRun)}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{it.pctSaving.toFixed(1)}%</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--color-text-secondary)' }}>
                    {it.productQuantity > 1 ? formatISK(it.savingPerRun * it.productQuantity) : '—'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--color-text-tertiary)' }}>
                    {formatDuration(it.researchTimeSec)}
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

export default ResearchTab;
