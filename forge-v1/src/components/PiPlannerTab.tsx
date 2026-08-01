// FORGE — PI Planner tab
// Given a region and a target PI commodity (or item built from PI, e.g. Fuel Blocks),
// recommends which system and which planet should extract/manufacture each step of
// the chain. Topology only — extractor yield, richness, and cycle output aren't
// modeled; those depend on skills and in-game scans, done by the user.

import { useEffect, useState, type FC } from 'react';
import { apiGet, apiPost } from '../api/client';
import { usePocoTaxRate } from '../hooks/usePocoTaxRate';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Region { region_id: number; name: string; }
interface TargetOption { type_id: number; name: string; pi_tier: number | null; }

interface PlanAssignment {
  typeId: number;
  name:   string;
  tier:   number | null;
  kind:   'extract' | 'produce';
}
interface PlanPlanet {
  planetId:       number;
  planetIndex:    number | null;
  planetTypeName: string;
  systemId:       number;
  assignment:     PlanAssignment;
}
interface PlanSystem { systemId: number; name: string; securityStatus: number | null; }
interface PlanCandidate { systems: PlanSystem[]; planets: PlanPlanet[]; }
interface PlanResponse {
  requiredRaw:      { typeId: number; name: string }[];
  requiredProducts: { typeId: number; name: string; tier: number | null }[];
  candidates:       PlanCandidate[];
  spansMultipleSystems: boolean;
  clusteredBy:      string | null;
  reason:           string | null;
  note:             string;
}

// ── Component ─────────────────────────────────────────────────────────────────

const PiPlannerTab: FC = () => {
  const [regions,  setRegions]  = useState<Region[]>([]);
  const [regionId, setRegionId] = useState<number | null>(null);

  const [query,          setQuery]          = useState('');
  const [searchResults,  setSearchResults]  = useState<TargetOption[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<TargetOption[]>([]);

  const [colonySlots, setColonySlots] = useState(36);
  const [pocoTaxRate] = usePocoTaxRate(); // shared with PiTab — informs which target is worth planning for

  const [plan,    setPlan]    = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Load region list once.
  useEffect(() => {
    apiGet<{ regions: Region[] }>('/api/pi-planner/regions')
      .then(d => {
        setRegions(d.regions);
        if (d.regions.length) setRegionId(prev => prev ?? d.regions[0].region_id);
      })
      .catch(() => {});
  }, []);

  // Debounced target search.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearchResults([]); return; }
    const id = setTimeout(() => {
      apiGet<{ targets: TargetOption[] }>(`/api/pi-planner/targets?q=${encodeURIComponent(q)}`)
        .then(d => setSearchResults(d.targets))
        .catch(() => setSearchResults([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query]);

  const toggleTarget = (t: TargetOption) => {
    setSelectedTargets(prev =>
      prev.some(x => x.type_id === t.type_id)
        ? prev.filter(x => x.type_id !== t.type_id)
        : [...prev, t]
    );
  };

  const runPlan = () => {
    if (!regionId || !selectedTargets.length) return;
    setLoading(true); setError(null); setPlan(null);
    apiPost<PlanResponse>('/api/pi-planner/plan', {
      regionId, targetTypeIds: selectedTargets.map(t => t.type_id), colonySlots,
    })
      .then(setPlan)
      .catch(e => setError(e.message || 'Failed to compute plan'))
      .finally(() => setLoading(false));
  };

  const systemName = (cand: PlanCandidate, systemId: number) =>
    cand.systems.find(s => s.systemId === systemId)?.name ?? `System ${systemId}`;

  return (
    <div className="pi-tab pi-planner-tab">
      <div className="pi-planner-intro">
        <p className="pi-planner-hint">
          Pick a region and what you want to end up with — Forge works out which system
          and which planet should extract or manufacture each step of the chain.
          Extractor yield and richness aren't modeled here — verify the actual planet
          in-game before committing a colony to it. <em>{Math.round(pocoTaxRate * 100)}% POCO tax</em> assumed
          where relevant (set your real rate on the PI Colonies tab).
        </p>
      </div>

      <div className="pi-planner-form">
        <label className="pi-planner-field">
          <span className="pi-section-label">Region</span>
          <select
            className="filter-select"
            value={regionId ?? ''}
            onChange={e => setRegionId(parseInt(e.target.value, 10))}
          >
            {regions.map(r => <option key={r.region_id} value={r.region_id}>{r.name}</option>)}
          </select>
        </label>

        <label className="pi-planner-field">
          <span className="pi-section-label">Colony slots available</span>
          <input
            className="filter-input"
            type="number" min={1} max={200}
            value={colonySlots}
            onChange={e => setColonySlots(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
        </label>
      </div>

      <div className="pi-planner-targets">
        <span className="pi-section-label">Target commodity or item</span>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <input
            className="filter-input"
            placeholder="Search P0–P4 or an item made from PI (e.g. Oxygen, Fuel Block)…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={{ width: 340, paddingRight: query ? 22 : undefined }}
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setSearchResults([]); }}
              aria-label="Clear search"
              style={{
                position: 'absolute', right: 5, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--color-text-tertiary)', fontSize: 13, lineHeight: 1, padding: 0,
              }}
            >×</button>
          )}
        </div>
        {searchResults.length > 0 && (
          <div className="pi-planner-search-results">
            {searchResults.map(t => (
              <label key={t.type_id} className="pi-planner-checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedTargets.some(x => x.type_id === t.type_id)}
                  onChange={() => toggleTarget(t)}
                />
                <span className="pi-tier-badge">{t.pi_tier != null ? `P${t.pi_tier}` : '—'}</span>
                {t.name}
              </label>
            ))}
          </div>
        )}
        {selectedTargets.length > 0 && (
          <div className="pi-planner-selected-pills">
            {selectedTargets.map(t => (
              <button key={t.type_id} className="pill-filter active" onClick={() => toggleTarget(t)}>
                {t.name} ✕
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        className="pi-planner-run-btn"
        disabled={!regionId || !selectedTargets.length || loading}
        onClick={runPlan}
      >
        {loading ? 'Computing…' : 'Find best system & planets'}
      </button>

      {error && <div className="pi-state-msg pi-error-msg">{error}</div>}

      {plan && (
        <div className="pi-planner-results">
          <div className="pi-planner-chain">
            <span className="pi-section-label">Full chain required</span>
            <div className="pi-planner-chain-items">
              {plan.requiredRaw.map(r => (
                <span key={r.typeId} className="pi-planner-chain-item">
                  <span className="pi-tier-badge">P0</span>{r.name}
                </span>
              ))}
              {plan.requiredProducts.map(r => (
                <span key={r.typeId} className="pi-planner-chain-item">
                  <span className="pi-tier-badge">P{r.tier}</span>{r.name}
                </span>
              ))}
            </div>
          </div>

          {plan.candidates.length === 0 ? (
            <div className="pi-state-msg pi-empty-msg">
              {plan.reason || 'No system in this region can supply this chain.'}
            </div>
          ) : (
            plan.candidates.map((cand, i) => (
              <div key={i} className="pi-planner-candidate">
                <div className="pi-planner-candidate-header">
                  <span>{cand.systems.map(s => s.name).join(' + ')}</span>
                  {plan.spansMultipleSystems && (
                    <span className="pi-planner-spans-note">
                      {plan.clusteredBy === 'constellation' ? 'same constellation' : 'spans the region'}
                    </span>
                  )}
                  <span className="pi-planner-planet-count">
                    {cand.planets.length} planet{cand.planets.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="pi-planner-planet-table">
                  {cand.planets.map(p => (
                    <div key={p.planetId} className="pi-planner-planet-row">
                      <span className="pi-planner-planet-name">
                        {systemName(cand, p.systemId)} {p.planetIndex ?? ''}
                      </span>
                      <span className="pi-type-badge">{p.planetTypeName}</span>
                      <span className="pi-planner-planet-arrow">→</span>
                      <span className="pi-tier-badge">{p.assignment.tier != null ? `P${p.assignment.tier}` : ''}</span>
                      <span>{p.assignment.kind === 'extract' ? 'Extract' : 'Manufacture'} {p.assignment.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}

          <p className="pi-footnote">{plan.note}</p>
        </div>
      )}
    </div>
  );
};

export default PiPlannerTab;
