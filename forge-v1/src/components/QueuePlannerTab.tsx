/**
 * FORGE — Production Queue Planner tab
 *
 * Plans across ALL logged-in characters' slots simultaneously.
 * Each recommendation is assigned to a specific character based on their
 * available slots.  Uses the primary character's session for blueprint/asset
 * data (which already holds the combined set) and always authenticates as
 * the primary to avoid "no session data" errors when an alt is isolated.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import { apiPost }       from '../api/client';
import { formatISK }     from '../utils/format';
import type { QueueCharacter } from '../types';
import ForgeWait        from './ForgeWait';
import TickerPinButton  from './TickerPinButton';

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueRecommendation {
  blueprintId:           number;
  productId:             number;
  productName:           string;
  productUnits:          number;
  activityId:            number;
  runs:                  number;
  buildTimeSec:          number;
  buildTimePerRunSec:    number;
  materialCost:          number;
  jobCost:               number;
  estimatedProfit:       number;
  iskPerHour:            number;
  liquidityRisk:         string | null;
  avgDailyVolume:        number;
  ownedBpME:             number;
  effectiveME:           number;
  assignedCharacterId?:  number;
  assignedCharacterName?: string;
}

interface AggregateMaterial {
  typeId:      number;
  name:        string;
  needed:      number;
  have:        number;
  shortage:    number;
  jitaSell:    number;
  shortageISK: number;
}

interface QueuePlanResult {
  recommendations:    QueueRecommendation[];
  aggregateMaterials: AggregateMaterial[];
  summaryProfit:      number;
  summaryIskPerDay:   number;
  totalMatSpend:      number;
  totalJobCost:       number;
  totalShortageISK:   number;
  walletBalance:      number;
  effectiveBudget:    number;
  horizonHours:       number;
  regionId:           number;
  message?:           string;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface QueuePlannerTabProps {
  queueCharacters: QueueCharacter[];
  /** Always the primary character's token — server session data lives under the primary */
  primaryToken: string | null;
  regionId: number;
  onSelectItem: (typeId: number, name: string) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(sec: number): string {
  if (sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const LIQ_DOT: Record<string, string> = {
  healthy:       'var(--color-success)',
  low_volume:    'var(--color-warning)',
  contract_only: 'var(--color-contract)',
  suspect:       'var(--color-danger)',
};

import { itemIconUrl } from '../utils/icons';

const HORIZON_OPTIONS = [
  { value: 24,  label: '24 hours' },
  { value: 72,  label: '3 days'   },
  { value: 168, label: '7 days'   },
];

// Stable initials for a character name badge (first char of each word, max 2)
function initials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

// ── Component ─────────────────────────────────────────────────────────────────

const QueuePlannerTab: FC<QueuePlannerTabProps> = ({ queueCharacters, primaryToken, regionId, onSelectItem }) => {
  const [result,        setResult]        = useState<QueuePlanResult | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [copied,        setCopied]        = useState(false);
  const sessionRetryRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRetryCount = useRef(0);
  // Stable ref to latest runPlan — prevents stale-closure in the retry setTimeout
  const runPlanRef = useRef<() => void>(() => {});

  const [horizonHours,   setHorizonHours]   = useState(72);
  const [budgetCapInput, setBudgetCapInput] = useState('');
  const [includeCorpBps, setIncludeCorpBps] = useState(false);
  const [activityFilter, setActivityFilter] = useState<'all' | 'manufacturing' | 'reactions'>('all');

  // primaryToken is passed from App.tsx (always auth.token — the primary's token).
  // queueCharacters may be filtered to a single alt, so we cannot derive it from [0].token.

  const runPlan = useCallback(() => {
    if (!primaryToken) return;
    setLoading(true);
    setError(null);

    const rawBudget = parseFloat(budgetCapInput.replace(/[^0-9.]/g, ''));
    const budgetCap = isNaN(rawBudget) || rawBudget <= 0 ? null : rawBudget;

    // Send per-character slot counts AND skills so backend can do per-character skill checks.
    // Manufacturing and reaction slots are independent pools (see App.tsx's
    // queueCharacters comment) — send both so the backend allocates against
    // whichever pool(s) activityFilter actually needs.
    const characters = queueCharacters.map(c => ({
      characterId:        c.characterId,
      name:               c.name,
      totalSlots:         c.totalSlots,
      freeSlots:          c.freeSlots,
      mfgFreeSlots:       c.mfgFreeSlots,
      reactionFreeSlots:  c.reactionFreeSlots,
      skills:             c.skills,
    }));

    apiPost<QueuePlanResult & { code?: string }>('/api/queue-planner', {
      regionId,
      horizonHours,
      budgetCap,
      includeCorpBps,
      activityFilter,
      characters,
    }, primaryToken)
      .then(d => {
        sessionRetryCount.current = 0;
        setResult(d as QueuePlanResult);
        setLoading(false);
      })
      .catch(e => {
        const msg = e.message || 'Failed to generate plan';
        if (msg.includes('SESSION_MISSING') || msg.includes('No session data')) {
          if (sessionRetryCount.current < 3) {
            // Session cache cold after server restart — retry up to 3 times
            sessionRetryCount.current += 1;
            setError('Session loading…');
            sessionRetryRef.current = setTimeout(() => {
              setError(null);
              runPlanRef.current();
            }, 4000);
          } else {
            sessionRetryCount.current = 0;
            setError('Session timed out — server may still be warming up. Refresh to retry.');
            setLoading(false);
          }
        } else {
          sessionRetryCount.current = 0;
          setError(msg);
          setLoading(false);
        }
      });
  }, [primaryToken, queueCharacters, regionId, horizonHours, budgetCapInput, includeCorpBps, activityFilter]);

  // Keep runPlanRef pointing at the latest closure so the retry setTimeout never calls a stale version
  useEffect(() => { runPlanRef.current = runPlan; }, [runPlan]);

  useEffect(() => { if (primaryToken) runPlan(); }, [primaryToken, regionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up any pending retry on unmount
  useEffect(() => () => { if (sessionRetryRef.current) clearTimeout(sessionRetryRef.current); }, []);

  // ── Multibuy copy ─────────────────────────────────────────────────────────
  const handleCopyAll = useCallback(() => {
    if (!result?.aggregateMaterials.length) return;
    const text = result.aggregateMaterials.map(m => `${m.name} ${m.shortage}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [result]);

  // ── Per-character slot sections built from frontend state + backend recs ──
  const perCharSections = useMemo(() => {
    return queueCharacters.map(char => {
      const mfgJobs = char.activeJobs.filter(j => j.activityId === 1 || j.activityId === 9);
      const charRecs = (result?.recommendations ?? []).filter(
        r => r.assignedCharacterId === char.characterId
      );

      const slots: Array<
        | { kind: 'active';  job: typeof mfgJobs[number] }
        | { kind: 'planned'; rec: QueueRecommendation }
        | { kind: 'empty' }
      > = [];

      mfgJobs.forEach(job => slots.push({ kind: 'active', job }));
      charRecs.forEach(rec => slots.push({ kind: 'planned', rec }));
      while (slots.length < char.totalSlots) slots.push({ kind: 'empty' });

      return { char, slots };
    });
  }, [queueCharacters, result]);

  // Totals derived from queueCharacters (authoritative — not from backend response)
  const totalSlots  = queueCharacters.reduce((s, c) => s + c.totalSlots,  0);
  const activeSlots = queueCharacters.reduce((s, c) => s + (c.totalSlots - c.freeSlots), 0);
  const freeSlots   = queueCharacters.reduce((s, c) => s + c.freeSlots,   0);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!primaryToken) {
    return <div className="qp-state-msg">Log in to use the Queue Planner.</div>;
  }

  return (
    <div className="qp-tab">

      {/* ── Config row ── */}
      <div className="qp-config-row">
        <label className="qp-config-label">
          Horizon
          <select className="qp-select" value={horizonHours} onChange={e => setHorizonHours(Number(e.target.value))}>
            {HORIZON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        <label className="qp-config-label">
          Budget cap
          <input
            className="qp-input"
            type="text"
            placeholder="Full wallet"
            value={budgetCapInput}
            onChange={e => setBudgetCapInput(e.target.value)}
          />
        </label>

        <label className="qp-config-label">
          Activity
          <select className="qp-select" value={activityFilter} onChange={e => setActivityFilter(e.target.value as typeof activityFilter)}>
            <option value="all">Mfg + Reactions</option>
            <option value="manufacturing">Manufacturing only</option>
            <option value="reactions">Reactions only</option>
          </select>
        </label>

        <label className="qp-config-label qp-toggle-label">
          <input type="checkbox" checked={includeCorpBps} onChange={e => setIncludeCorpBps(e.target.checked)} />
          Include corp BPs
        </label>

        <button className="qp-run-btn" onClick={runPlan} disabled={loading}>
          {loading ? 'Planning…' : '⟳ Plan queue'}
        </button>
      </div>

      {error && <div className="qp-error">{error}</div>}
      {loading && !result && <ForgeWait message="Generating optimal queue…" detail="Running the planning engine across your blueprints and available slots — please wait." quip="I have simulated 11,000 production strategies and eliminated the ones that would have disappointed you. You are welcome." />}

      {result && (
        <>
          {/* ── Summary bar ── */}
          <div className="qp-summary-bar">
            <div className="qp-summary-cell">
              <div className="qp-s-label">
                Slots{queueCharacters.length > 1 ? ` (${queueCharacters.length} chars)` : ''}
              </div>
              <div className="qp-s-val">
                <span className="qp-s-used">{activeSlots}</span>
                <span className="qp-s-sep"> / </span>
                <span>{totalSlots}</span>
              </div>
              <div className="qp-s-sub">
                {freeSlots} free
                <TickerPinButton
                  options={[{ type: 'jobs_free_slots', label: 'Free slots' }]}
                  baseConfig={{}}
                />
              </div>
            </div>
            <div className="qp-summary-cell">
              <div className="qp-s-label">Material spend</div>
              <div className="qp-s-val qp-s-amber">{formatISK(result.totalMatSpend)}</div>
              <div className="qp-s-sub">of {formatISK(result.effectiveBudget)} budget</div>
            </div>
            <div className="qp-summary-cell">
              <div className="qp-s-label">Job cost</div>
              <div className="qp-s-val qp-s-amber">{formatISK(result.totalJobCost)}</div>
              <div className="qp-s-sub">SCI + 4% SCC + facility tax</div>
            </div>
            <div className="qp-summary-cell">
              <div className="qp-s-label">Est. profit</div>
              <div className="qp-s-val qp-s-green">+{formatISK(result.summaryProfit)}</div>
              <div className="qp-s-sub">over {result.horizonHours >= 24 ? `${result.horizonHours / 24}d` : `${result.horizonHours}h`} · net of job cost, not haul</div>
            </div>
            <div className="qp-summary-cell">
              <div className="qp-s-label">Est. ISK/day</div>
              <div className="qp-s-val qp-s-green">{formatISK(result.summaryIskPerDay)}</div>
              <div className="qp-s-sub">across all planned slots</div>
            </div>
            <div className="qp-summary-cell">
              <div className="qp-s-label">To buy</div>
              <div className="qp-s-val qp-s-amber">{formatISK(result.totalShortageISK)}</div>
              <div className="qp-s-sub">{result.aggregateMaterials.length} materials short</div>
            </div>
          </div>

          {result.message && <div className="qp-notice">{result.message}</div>}

          {/* ── Per-character slot sections ── */}
          {perCharSections.map(({ char, slots }) => (
            <div key={char.characterId} className="qp-char-section">
              <div className="qp-char-header">
                <span className="qp-char-avatar">{initials(char.name)}</span>
                <span className="qp-char-name">{char.name}</span>
                <span className="qp-char-slots">
                  {char.totalSlots - char.freeSlots} active · {char.freeSlots} free · {char.totalSlots} total
                </span>
              </div>
              <div className="qp-slot-grid">
                {slots.map((slot, i) => {
                  if (slot.kind === 'active') {
                    return (
                      <div key={i} className="qp-slot qp-slot-active">
                        <div className="qp-slot-label">SLOT {i + 1} — active</div>
                        <div className="qp-slot-item">
                          {slot.job.typeId ? (
                            <img className="qp-slot-icon" src={itemIconUrl(slot.job.typeId, 22)}
                              alt="" width={16} height={16}
                              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          ) : null}
                          {slot.job.quantity > 1 ? `×${slot.job.quantity} ` : ''}{slot.job.name}
                        </div>
                        <div className="qp-slot-time qp-time-amber">{slot.job.remaining}</div>
                      </div>
                    );
                  }
                  if (slot.kind === 'planned') {
                    const rec = slot.rec;
                    return (
                      <div key={i} className="qp-slot qp-slot-planned">
                        <div className="qp-slot-label">SLOT {i + 1} — planned</div>
                        <div className="qp-slot-item">
                          <img className="qp-slot-icon" src={itemIconUrl(rec.productId, 22)}
                            alt="" width={16} height={16}
                            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                          {rec.productName} ×{rec.runs}
                        </div>
                        <div className="qp-slot-time qp-time-cyan">{fmtDuration(rec.buildTimePerRunSec)}/run</div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} className="qp-slot qp-slot-empty">
                      <div className="qp-slot-label">SLOT {i + 1}</div>
                      <div className="qp-slot-item qp-empty-text">—</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* ── Recommendations table ── */}
          {result.recommendations.length > 0 ? (
            <>
              <div className="qp-section-title">Recommended queue — ranked by ISK/hr</div>
              <div className="qp-rec-table-wrap">
              <div className="qp-rec-table">
                <div className="qp-rec-head">
                  <span className="qp-col-rank">#</span>
                  <span className="qp-col-name">Product</span>
                  <span className="qp-col-char">Character</span>
                  <span className="qp-col-runs">Runs</span>
                  <span className="qp-col-time">Build time</span>
                  <span className="qp-col-mat">Mat cost</span>
                  <span className="qp-col-profit">Est. profit</span>
                  <span className="qp-col-iskhr">ISK/hr</span>
                  <span className="qp-col-liq">Liq.</span>
                </div>
                {result.recommendations.map((rec, i) => {
                  const liqColor = LIQ_DOT[rec.liquidityRisk || ''] || '#4a5568';
                  const liqLabel = rec.avgDailyVolume > 0
                    ? `${rec.avgDailyVolume >= 1000
                        ? `${(rec.avgDailyVolume / 1000).toFixed(1)}K`
                        : Math.round(rec.avgDailyVolume)}/d`
                    : '—';
                  return (
                    <div key={rec.blueprintId} className="qp-rec-row">
                      <span className="qp-col-rank qp-rank-num">{i + 1}</span>
                      <span className="qp-col-name">
                        <img className="qp-rec-icon" src={itemIconUrl(rec.productId)}
                          alt="" width={18} height={18}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        <button className="qp-item-link" onClick={() => onSelectItem(rec.productId, rec.productName)}>
                          {rec.productName}
                        </button>
                        {rec.activityId === 9 && <span className="qp-tag qp-tag-rxn">⚗</span>}
                        {rec.effectiveME > 0 && <span className="qp-tag qp-tag-me">ME{rec.effectiveME}</span>}
                      </span>
                      <span className="qp-col-char">
                        {rec.assignedCharacterName
                          ? <span className="qp-char-chip">{initials(rec.assignedCharacterName)}</span>
                          : '—'}
                      </span>
                      <span className="qp-col-runs"><span className="qp-runs-badge">×{rec.runs}</span></span>
                      <span className="qp-col-time qp-time-dim">{fmtDuration(rec.buildTimePerRunSec)}/run</span>
                      <span className="qp-col-mat qp-mat-val">{formatISK(rec.materialCost)}</span>
                      <span className="qp-col-profit qp-profit-val">+{formatISK(rec.estimatedProfit)}</span>
                      <span className="qp-col-iskhr qp-iskhr-val">{formatISK(rec.iskPerHour)}</span>
                      <span className="qp-col-liq">
                        <span className="qp-liq-dot" style={{ background: liqColor }} title={rec.liquidityRisk ?? 'healthy'} />
                        <span className="qp-liq-label">{liqLabel}</span>
                      </span>
                      <span className="qp-col-pin">
                        <TickerPinButton
                          options={[
                            { type: 'mfg_profit',   label: `${rec.productName} profit (Net, ex-haul)` },
                            { type: 'mfg_isk_hour', label: `${rec.productName} ISK/hr (Net, ex-haul)` },
                            { type: 'mfg_margin',   label: `${rec.productName} margin (Net, ex-haul)` },
                          ]}
                          baseConfig={{ typeId: rec.productId, itemName: rec.productName, regionId }}
                        />
                      </span>
                    </div>
                  );
                })}
              </div>
              </div>
            </>
          ) : (
            !loading && (
              <div className="qp-notice">
                No profitable buildable items found for the current settings.
                Try switching market hub or expanding the activity filter.
              </div>
            )
          )}

          {/* ── Aggregate shopping list ── */}
          {result.aggregateMaterials.length > 0 && (
            <>
              <div className="qp-section-title">
                Aggregate material shortfall
                <span className="qp-section-sub">
                  {result.aggregateMaterials.length} materials · {formatISK(result.totalShortageISK)} total
                </span>
              </div>
              <div className="qp-mat-grid">
                {result.aggregateMaterials.map(m => (
                  <div key={m.typeId} className="qp-mat-row">
                    <span className="qp-mat-name">{m.name}</span>
                    <span className="qp-mat-have">{m.have > 0 ? `have ${m.have.toLocaleString()}` : '—'}</span>
                    <span className="qp-mat-short">need {m.shortage.toLocaleString()}</span>
                    <span className="qp-mat-cost">{m.shortageISK > 0 ? formatISK(m.shortageISK) : '—'}</span>
                  </div>
                ))}
              </div>
              <div className="qp-multibuy-row">
                <button className="qp-multibuy-btn" onClick={handleCopyAll}>
                  {copied ? '✓ Copied!' : '📋 Copy ALL shortfall as Multibuy'}
                </button>
                <span className="qp-multibuy-note">Paste in EVE → right-click market → Buy Items</span>
              </div>
            </>
          )}

          <p className="qp-footnote">
            ISK/hr = estimated profit ÷ effective build time (ME/TE/skills/structure applied) ·
            profit is net of materials, job cost (SCI + SCC + facility tax), and your sales fees —
            but does NOT include haul cost, unlike the per-item True Profit panel · Jita sell prices ·
            runs capped at {result.horizonHours}h horizon and market liquidity ·
            character assignments are suggestive — start on whichever character meets the skill requirements
          </p>
        </>
      )}
    </div>
  );
};

export default QueuePlannerTab;
