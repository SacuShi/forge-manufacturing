/**
 * The "Reactions" part of ⚙ Mfg Setup: the refinery (Athanor / Tatara), its system, its tax and up to 3 reactor rigs.
 * Reactions run in refineries, not engineering complexes, so this is a separate, optional setup. Leave it empty and
 * FORGE counts only the Reactions skill (as before). Rig names, values and sizes come from CCP's data via
 * /api/industry-rigs — nothing is hand-typed here.
 */
import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import type { IndustryRigsResponse, SystemSearchResult } from '../types';
import { apiGet } from '../api/client';
import type { ReactionSetupState } from '../utils/reactionSetup';

const MAX_RIGS = 3;
const fmtNum = (n: number) => String(Math.round(n * 100) / 100);

interface Props {
  token:    string | null;
  value:    ReactionSetupState;
  onChange: (next: ReactionSetupState) => void;
  rigStats: IndustryRigsResponse | null;
}

const ReactionSetupSection: FC<Props> = ({ token, value, onChange, rigStats }) => {
  const [open, setOpen] = useState(value.structureId !== null);
  const [query, setQuery] = useState(value.systemName ?? '');
  const [suggestions, setSuggestions] = useState<SystemSearchResult[]>([]);
  const [showList, setShowList] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-seed the text box when a different saved system is loaded (the modal is reopened).
  const seededName = useRef(value.systemName);
  useEffect(() => {
    if (seededName.current !== value.systemName) { seededName.current = value.systemName; setQuery(value.systemName ?? ''); }
  }, [value.systemName]);

  const refineries = Object.entries(rigStats?.structures ?? {})
    .filter(([, s]) => s.refinery)
    .map(([id, s]) => ({ id: Number(id), name: s.name, size: s.rigSize ?? null, timeMult: s.timeMult }));
  const chosen = refineries.find((r) => r.id === value.structureId) ?? null;
  const rigsForSize = Object.entries(rigStats?.rigs ?? {})
    .filter(([, r]) => r.reaction && chosen && r.size === chosen.size)
    .map(([id, r]) => ({ id: Number(id), ...r }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const secClass = typeof value.systemSecurity !== 'number' ? null
    : value.systemSecurity >= 0.45 ? 'hi' : value.systemSecurity > 0 ? 'low' : 'null';
  const rigText = (r: { matPct: number; timePct: number; sec: { hi: number; low: number; null: number } }) => {
    const mult = secClass ? r.sec[secClass] : r.sec.low;   // unknown system: the lowsec value (the smallest)
    const parts: string[] = [];
    if (r.matPct)  parts.push(`ME ${fmtNum(r.matPct)}%${mult !== 1 ? ` → ${fmtNum(r.matPct * mult)}% here` : ''}`);
    if (r.timePct) parts.push(`TE ${fmtNum(r.timePct)}%${mult !== 1 ? ` → ${fmtNum(r.timePct * mult)}% here` : ''}`);
    return parts.join(' · ');
  };

  const search = useCallback((text: string) => {
    setQuery(text);
    onChange({ ...value, systemId: null, systemName: null, systemSecurity: null });
    setShowList(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        setSuggestions(await apiGet<SystemSearchResult[]>(`/api/system-search?q=${encodeURIComponent(text.trim())}`, token ?? ''));
      } catch { setSuggestions([]); }
    }, 300);
  }, [onChange, value, token]);

  const pickSystem = (s: SystemSearchResult) => {
    setQuery(s.system_name);
    setSuggestions([]);
    setShowList(false);
    onChange({ ...value, systemId: s.system_id, systemName: s.system_name, systemSecurity: s.security ?? null });
  };

  const pickRefinery = (id: number | null) => {
    const size = refineries.find((r) => r.id === id)?.size;
    // Only rigs of the refinery's own size fit (Athanor M, Tatara L); anything else is dropped when it changes.
    const allowed = new Set(Object.entries(rigStats?.rigs ?? {}).filter(([, r]) => r.reaction && r.size === size).map(([rid]) => Number(rid)));
    onChange({ ...value, structureId: id, rigs: id === null ? [] : value.rigs.filter((r) => allowed.has(r)) });
  };

  const toggleRig = (id: number) => {
    const has = value.rigs.includes(id);
    if (!has && value.rigs.length >= MAX_RIGS) return;
    onChange({ ...value, rigs: has ? value.rigs.filter((r) => r !== id) : [...value.rigs, id] });
  };

  return (
    <div className="settings-section" id="settings-reactions">
      <div className="settings-label">
        <button
          type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: 'none', border: 'none',
                   padding: 0, font: 'inherit', color: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit' }}
        >
          <span style={{ fontSize: '0.8em' }}>{open ? '▼' : '▶'}</span>
          Reactions{' '}
          <span className="settings-label-sub">
            {value.structureId === null ? '(optional — set up your Athanor or Tatara)' : `— ${chosen?.name ?? 'refinery'}`}
          </span>
        </button>
      </div>
      {open && (
        <>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            Reactions run in a refinery, not an engineering complex. Leave this empty and FORGE counts only your Reactions skill.
          </div>

          <div className="structure-grid">
            {[{ id: null as number | null, name: 'None', note: 'Reactions skill only' },
              ...refineries.map((r) => ({
                id: r.id as number | null, name: r.name,
                note: r.timeMult < 1 ? `${fmtNum((1 - r.timeMult) * 100)}% faster reactions` : 'No reaction bonus',
              }))].map((st) => (
              <label key={String(st.id)} className={`structure-option${value.structureId === st.id ? ' selected' : ''}`}>
                <input type="radio" name="reaction_structure" checked={value.structureId === st.id} onChange={() => pickRefinery(st.id)} />
                <span className="structure-label">{st.name}</span>
                <span className="structure-note">{st.note}</span>
              </label>
            ))}
          </div>

          {value.structureId !== null && (
            <>
              <div className="settings-label" style={{ marginTop: 10 }}>Refinery system</div>
              <div className="system-search-wrap">
                <input
                  className="settings-input"
                  value={query}
                  placeholder="Type a system name…"
                  onChange={(e) => search(e.target.value)}
                  onFocus={() => setShowList(true)}
                  onBlur={() => setTimeout(() => setShowList(false), 150)}
                  aria-label="Reaction system name"
                  autoComplete="off"
                />
                {showList && suggestions.length > 0 && (
                  <ul className="system-suggestions" role="listbox" aria-label="Matching systems">
                    {suggestions.map((s) => (
                      <li key={s.system_id} className="system-suggestion-item" role="option" aria-selected={false}
                          onMouseDown={() => pickSystem(s)}>
                        {s.system_name}<span className="system-suggestion-id"> #{s.system_id}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {value.systemId
                ? <div className="settings-resolved">✓ {value.systemName} <span className="settings-id">(ID {value.systemId})</span></div>
                : <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>No system picked — FORGE uses your manufacturing system.</div>}
              {secClass === 'hi' && (
                <div className="settings-warn">Refineries can&apos;t be anchored in highsec and reactor rigs give nothing there — check the system.</div>
              )}

              <div className="settings-label" style={{ marginTop: 10 }}>
                Reactor rigs <span className="settings-label-sub">({value.rigs.length}/{MAX_RIGS} selected)</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                A rig only helps the reactions it is built for (composite, hybrid or biochemical).
                {secClass ? ` Values are scaled for this ${secClass === 'low' ? 'lowsec' : 'nullsec / wormhole'} system.` : ''}
              </div>
              <div className="rig-list">
                {rigsForSize.map((rig) => {
                  const checked = value.rigs.includes(rig.id);
                  const maxed = !checked && value.rigs.length >= MAX_RIGS;
                  return (
                    <label key={rig.id} className={`rig-item${maxed ? ' rig-item-disabled' : ''}`}>
                      <input type="checkbox" checked={checked} disabled={maxed} onChange={() => toggleRig(rig.id)} />
                      <span>{rig.name}<span style={{ opacity: 0.65 }}> — {rigText(rig)}</span></span>
                    </label>
                  );
                })}
              </div>

              <div className="settings-label" style={{ marginTop: 10 }}>
                Refinery tax <span className="settings-label-sub">(set by the structure owner; CCP caps it at 10%)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number" className="settings-input settings-input-short" min={0} max={10} step={0.1}
                  value={value.tax}
                  onChange={(e) => onChange({ ...value, tax: Math.min(10, Math.max(0, parseFloat(e.target.value) || 0)) })}
                  aria-label="Refinery tax percentage"
                />
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>%</span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default ReactionSetupSection;
