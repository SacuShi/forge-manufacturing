// FORGE — PI Planner tab
// Given a region and a target PI commodity (or item built from PI, e.g. Fuel Blocks),
// recommends which system and which planet should extract/manufacture each step of
// the chain. Topology only — extractor yield, richness, and cycle output aren't
// modeled; those depend on skills and in-game scans, done by the user.

import { useEffect, useRef, useState, type FC } from 'react';
import { apiGet, apiPost } from '../api/client';
import { usePocoTaxRate } from '../hooks/usePocoTaxRate';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Region { region_id: number; name: string; }
interface TargetOption { type_id: number; name: string; pi_tier: number | null; }

interface ExtractAssignment {
  kind:          'extract';
  extractTypeId: number;
  extractName:   string;
  p1TypeId:      number | null;
  p1Name:        string | null;
}
// Co-located planet: extracts all P0s for a P2, produces P1s on-site, runs P2 AIF on-site.
// Saves 2 colony slots vs the regular 3-planet approach.
interface ColocateAssignment {
  kind: 'colocate';
  p0s:  { typeId: number; name: string }[];
  p1s:  { typeId: number; name: string }[];
  p2:   { typeId: number; name: string };
}
interface FactoryProduct { typeId: number; name: string; tier: number | null; }
interface FactoryAssignment {
  kind:        'factory';
  factoryTier: number;
  products:    FactoryProduct[];
}
type PlanAssignment = ExtractAssignment | ColocateAssignment | FactoryAssignment;

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
  requiredRaw:     { typeId: number; name: string }[];
  requiredP1:      { typeId: number; name: string; tier: number; note: string }[];
  requiredFactory: { typeId: number; name: string; tier: number | null }[];
  candidates:      PlanCandidate[];
  spansMultipleSystems: boolean;
  clusteredBy:     string | null;
  reason:          string | null;
  note:            string;
}

// P4 (High-Tech Production Plant) hard-restricted to Barren/Temperate by CCP.
const P4_TYPES = new Set(['Barren', 'Temperate']);

// Factory planet suitability (smaller radius → cheaper links → more factories).
// Source: EVE University "Identifying valuable planets" wiki.
const FACTORY_PLANET_RANK: Record<string, number> = {
  Barren: 0, Lava: 1, Plasma: 2, Storm: 2, Ice: 3, Oceanic: 3, Temperate: 4, Gas: 9,
};
const isGoodFactoryPlanet = (type: string) => (FACTORY_PLANET_RANK[type] ?? 5) <= 3;

function factoryTypeWarning(p: PlanPlanet): string | null {
  if (p.assignment.kind === 'factory' && p.assignment.factoryTier === 4 && !P4_TYPES.has(p.planetTypeName))
    return 'P4 requires Barren or Temperate — this planet type is not valid in-game';
  if (p.assignment.kind === 'colocate' && !P4_TYPES.has(p.planetTypeName))
    return null; // P2 co-location uses AIF — no planet restriction
  return null;
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

  const [mode, setMode] = useState<'efficient' | 'balanced' | 'volume'>('efficient');
  const hasRun = useRef(false);

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
    hasRun.current = true;
    setLoading(true); setError(null); setPlan(null);
    apiPost<PlanResponse>('/api/pi-planner/plan', {
      regionId, targetTypeIds: selectedTargets.map(t => t.type_id), colonySlots, mode,
    })
      .then(setPlan)
      .catch(e => setError(e.message || 'Failed to compute plan'))
      .finally(() => setLoading(false));
  };

  // Re-run automatically when the mode pill changes, but only after the first manual run.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (hasRun.current) runPlan(); }, [mode]);

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

      <div className="pi-planner-mode">
        <span className="pi-section-label">Planning mode</span>
        <div className="pi-planner-mode-pills">
          {(['efficient', 'balanced', 'volume'] as const).map(m => (
            <button
              key={m}
              className={`pill-filter${mode === m ? ' active' : ''}`}
              onClick={() => setMode(m)}
            >
              {m === 'efficient' ? 'Efficient' : m === 'balanced' ? 'Balanced' : 'Volume'}
            </button>
          ))}
        </div>
        <span className="pi-planner-mode-hint">
          {mode === 'efficient' && 'Fewest colony slots — co-locates P2s where planet types allow, shares factory planets by tier.'}
          {mode === 'balanced'  && 'Co-locates P2s where possible, but each remaining factory product gets its own dedicated planet.'}
          {mode === 'volume'    && 'Every product on its own dedicated planet — no co-location, no sharing. Maximum throughput and ISK/hr.'}
        </span>
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
              {(plan.requiredRaw ?? []).map(r => (
                <span key={r.typeId} className="pi-planner-chain-item pi-chain-p0">
                  <span className="pi-tier-badge pi-tier-p0">P0</span>{r.name}
                </span>
              ))}
              {(plan.requiredP1 ?? []).map(r => (
                <span key={r.typeId} className="pi-planner-chain-item pi-chain-p1" title="Produced on-site at the extraction planet">
                  <span className="pi-tier-badge">P1</span>{r.name}
                  <em className="pi-chain-onsite"> on-site</em>
                </span>
              ))}
              {(plan.requiredFactory ?? []).map(r => (
                <span key={r.typeId} className="pi-planner-chain-item">
                  <span className="pi-tier-badge">P{r.tier ?? '?'}</span>{r.name}
                </span>
              ))}
            </div>
          </div>

          {(plan.candidates ?? []).length === 0 ? (
            <div className="pi-state-msg pi-empty-msg">
              {plan.reason || 'No system in this region can supply this chain.'}
            </div>
          ) : (
            (plan.candidates ?? []).map((cand, i) => (
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

                  {/* Co-located planets — extract both P0s + produce P1s + produce P2, all on one planet */}
                  {cand.planets.filter(p => p.assignment.kind === 'colocate').length > 0 && (
                    <div className="pi-planner-planet-group">
                      <div className="pi-planner-group-label pi-planner-group-colocate">
                        Co-located planets
                        <span className="pi-planner-group-hint">
                          both P0 inputs available on one planet type · extracts P0s, makes P1s on-site, runs P2 AIF on-site · saves a dedicated factory planet · P2 output still needs to be launched to the P3 factory planet
                        </span>
                      </div>
                      {cand.planets.filter(p => p.assignment.kind === 'colocate').map(p => {
                        const a = p.assignment as ColocateAssignment;
                        return (
                          <div key={p.planetId} className="pi-planner-planet-row pi-planner-row-colocate">
                            <span className="pi-planner-planet-name">
                              {systemName(cand, p.systemId)} {p.planetIndex ?? ''}
                            </span>
                            <span className={`pi-type-badge${isGoodFactoryPlanet(p.planetTypeName) ? ' pi-type-badge-factory-ok' : ''}`}>
                              {p.planetTypeName}
                            </span>
                            <div className="pi-planner-colocate-steps">
                              <div className="pi-planner-colocate-row">
                                <span className="pi-tier-badge pi-tier-p0">P0</span>
                                <span>Extract: {a.p0s.map(x => x.name).join(' + ')}</span>
                              </div>
                              {a.p1s.length > 0 && (
                                <div className="pi-planner-colocate-row">
                                  <span className="pi-tier-badge">P1</span>
                                  <span>Produce: {a.p1s.map(x => x.name).join(' + ')} <em>(on-site)</em></span>
                                </div>
                              )}
                              <div className="pi-planner-colocate-row">
                                <span className="pi-tier-badge">P2</span>
                                <span>Produce: {a.p2.name} <em>(on-site, AIF)</em></span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Extraction planets — extractors + Basic Industrial Facility → P0 + P1 on-site */}
                  {cand.planets.filter(p => p.assignment.kind === 'extract').length > 0 && (
                    <div className="pi-planner-planet-group">
                      <div className="pi-planner-group-label pi-planner-group-extract">
                        Extraction planets
                        <span className="pi-planner-group-hint">
                          extractors harvest P0 · Basic Industrial Facility produces P1 on-site · no haulage for P1
                        </span>
                      </div>
                      {cand.planets.filter(p => p.assignment.kind === 'extract').map(p => {
                        const a = p.assignment as ExtractAssignment;
                        return (
                          <div key={p.planetId} className="pi-planner-planet-row pi-planner-row-extract">
                            <span className="pi-planner-planet-name">
                              {systemName(cand, p.systemId)} {p.planetIndex ?? ''}
                            </span>
                            <span className="pi-type-badge">{p.planetTypeName}</span>
                            <span className="pi-planner-planet-arrow">→</span>
                            <span className="pi-tier-badge pi-tier-p0">P0</span>
                            <span>Extract {a.extractName}</span>
                            {a.p1Name && (
                              <>
                                <span className="pi-planner-planet-arrow pi-planner-onsite-arrow">+</span>
                                <span className="pi-tier-badge">P1</span>
                                <span className="pi-planner-onsite-label">Produce {a.p1Name} <em>(on-site)</em></span>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Factory planets — dedicated to P2 (non-co-locatable), P3, P4 */}
                  {cand.planets.filter(p => p.assignment.kind === 'factory').length > 0 && (
                    <div className="pi-planner-planet-group">
                      <div className="pi-planner-group-label pi-planner-group-factory">
                        Factory planets
                        <span className="pi-planner-group-hint">
                          no extractors · receives materials via launchpad · runs multiple schematics simultaneously · Barren preferred (smallest); P4 requires Barren or Temperate
                        </span>
                      </div>
                      {cand.planets.filter(p => p.assignment.kind === 'factory').map(p => {
                        const a = p.assignment as FactoryAssignment;
                        const warning = factoryTypeWarning(p);
                        const goodFactory = isGoodFactoryPlanet(p.planetTypeName);
                        return (
                          <div key={p.planetId} className={`pi-planner-planet-row pi-planner-row-factory${warning ? ' pi-planner-row-warning' : ''}`}>
                            <span className="pi-planner-planet-name">
                              {systemName(cand, p.systemId)} {p.planetIndex ?? ''}
                            </span>
                            <span className={`pi-type-badge${goodFactory ? ' pi-type-badge-factory-ok' : ''}`}>
                              {p.planetTypeName}
                            </span>
                            {!goodFactory && (
                              <span className="pi-planner-factory-soft-warn" title="Larger planet type — links consume more CPU/Power, leaving less headroom for factories. Barren or Lava preferred.">⚠</span>
                            )}
                            <span className="pi-planner-planet-arrow">→</span>
                            <span className="pi-tier-badge">P{a.factoryTier} Factory</span>
                            <div className="pi-planner-factory-products">
                              {a.products.map(prod => (
                                <span key={prod.typeId} className="pi-planner-factory-product">
                                  <span className="pi-tier-badge">P{prod.tier}</span>{prod.name}
                                </span>
                              ))}
                            </div>
                            {warning && <span className="pi-planner-row-warning-msg">{warning}</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
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
