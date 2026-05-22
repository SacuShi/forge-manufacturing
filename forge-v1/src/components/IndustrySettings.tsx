/**
 * FORGE v1.2.0 — IndustrySettings modal
 *
 * Lets the user configure their manufacturing setup so True Profit can be
 * calculated accurately:
 *   - Manufacturing system (autocomplete → EVE solar system)
 *   - Structure type (NPC / Raitaru / Azbel / Sotiyo)
 *   - Rigs installed (max 3, accordion by category)
 *   - Facility tax rate (% override — 0 for NPC stations)
 *
 * Saves to POST /api/industry-settings. Changes take effect on the next
 * item opened in the RightSidebar True Profit panel.
 */

import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import type { IndustrySettings, SystemSearchResult } from '../types';
import { apiGet, apiPost } from '../api/client';

// ── Constants ─────────────────────────────────────────────────────────────────

interface StructureType {
  label:    string;
  type_id:  number | null;
  note:     string;
}

const STRUCTURE_TYPES: StructureType[] = [
  { label: 'NPC Station',  type_id: null,  note: 'No ME/TE bonus'       },
  { label: 'Raitaru',      type_id: 35825, note: '1% ME · 15% TE'       },
  { label: 'Azbel',        type_id: 35826, note: '1% ME · 20% TE'       },
  { label: 'Sotiyo',       type_id: 35827, note: '1% ME · 25% TE'       },
];

interface RigEntry {
  type_id:  number;
  name:     string;
  category: string;
}

const MANUFACTURING_RIGS: RigEntry[] = [
  { type_id: 37178, name: 'Capital Ship Mfg Efficiency I',      category: 'Capital Ships'     },
  { type_id: 37179, name: 'Capital Ship Mfg Efficiency II',     category: 'Capital Ships'     },
  { type_id: 37180, name: 'Large Ship Mfg Efficiency I',        category: 'Large Ships'       },
  { type_id: 37181, name: 'Large Ship Mfg Efficiency II',       category: 'Large Ships'       },
  { type_id: 37182, name: 'Medium Ship Mfg Efficiency I',       category: 'Medium Ships'      },
  { type_id: 37183, name: 'Medium Ship Mfg Efficiency II',      category: 'Medium Ships'      },
  { type_id: 37184, name: 'Small Ship Mfg Efficiency I',        category: 'Small Ships'       },
  { type_id: 37185, name: 'Small Ship Mfg Efficiency II',       category: 'Small Ships'       },
  { type_id: 37186, name: 'Ammunition Mfg Efficiency I',        category: 'Ammunition'        },
  { type_id: 37187, name: 'Ammunition Mfg Efficiency II',       category: 'Ammunition'        },
  { type_id: 37188, name: 'Equipment Mfg Efficiency I',         category: 'Equipment'         },
  { type_id: 37189, name: 'Equipment Mfg Efficiency II',        category: 'Equipment'         },
  { type_id: 37190, name: 'Drone Mfg Efficiency I',             category: 'Drones'            },
  { type_id: 37191, name: 'Drone Mfg Efficiency II',            category: 'Drones'            },
  { type_id: 37197, name: 'Adv. Component Mfg Efficiency I',    category: 'Adv. Components'   },
  { type_id: 37198, name: 'Adv. Component Mfg Efficiency II',   category: 'Adv. Components'   },
  { type_id: 37199, name: 'Structure Mfg Efficiency I',         category: 'Structures'        },
  { type_id: 37200, name: 'Structure Mfg Efficiency II',        category: 'Structures'        },
];

// Group rigs by category
const RIG_CATEGORIES = Array.from(
  new Set(MANUFACTURING_RIGS.map((r) => r.category))
).map((cat) => ({
  category: cat,
  rigs: MANUFACTURING_RIGS.filter((r) => r.category === cat),
}));

const MAX_RIGS = 3;

// ── Props ─────────────────────────────────────────────────────────────────────

interface IndustrySettingsProps {
  open:     boolean;
  token:    string | null;
  initial:  IndustrySettings | null;
  onClose:  () => void;
  onSaved:  (settings: IndustrySettings) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

const IndustrySettingsModal: FC<IndustrySettingsProps> = ({
  open, token, initial, onClose, onSaved,
}) => {
  // ── Form state ─────────────────────────────────────────────────────────────
  const [systemQuery,    setSystemQuery]    = useState('');
  const [systemId,       setSystemId]       = useState<number | null>(null);
  const [systemName,     setSystemName]     = useState<string | null>(null);
  const [structureId,    setStructureId]    = useState<number | null>(null);
  const [selectedRigs,   setSelectedRigs]   = useState<number[]>([]);
  const [facilityTax,    setFacilityTax]    = useState(0);
  const [expandedCats,   setExpandedCats]   = useState<Set<string>>(new Set());

  // ── Autocomplete state ─────────────────────────────────────────────────────
  const [suggestions,    setSuggestions]    = useState<SystemSearchResult[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Save state ─────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Populate form from saved settings when modal opens
  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setSaveError(null);
    if (initial) {
      setSystemId(initial.system_id);
      setSystemName(initial.system_name);
      setSystemQuery(initial.system_name ?? '');
      setStructureId(initial.structure_type_id);
      setSelectedRigs(JSON.parse(initial.rig_ids || '[]') as number[]);
      setFacilityTax(initial.facility_tax ?? 0);
    } else {
      setSystemId(null);
      setSystemName(null);
      setSystemQuery('');
      setStructureId(null);
      setSelectedRigs([]);
      setFacilityTax(0);
    }
  }, [open, initial]);

  // ── System autocomplete ────────────────────────────────────────────────────
  const handleSystemInput = useCallback((value: string) => {
    setSystemQuery(value);
    setSystemId(null);   // clear resolved system until user picks from list
    setSystemName(null);
    setShowSuggestions(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const results = await apiGet<SystemSearchResult[]>(
          `/api/system-search?q=${encodeURIComponent(value.trim())}`,
          token ?? ''
        );
        setSuggestions(results);
      } catch {
        setSuggestions([]);
      } finally {
        setSuggestLoading(false);
      }
    }, 300);
  }, [token]);

  const handlePickSystem = useCallback((result: SystemSearchResult) => {
    setSystemId(result.system_id);
    setSystemName(result.system_name);
    setSystemQuery(result.system_name);
    setSuggestions([]);
    setShowSuggestions(false);
  }, []);

  // ── Rig toggle ─────────────────────────────────────────────────────────────
  const handleRigToggle = useCallback((typeId: number) => {
    setSelectedRigs((prev) => {
      if (prev.includes(typeId)) return prev.filter((id) => id !== typeId);
      if (prev.length >= MAX_RIGS) return prev; // max 3
      return [...prev, typeId];
    });
  }, []);

  const toggleCategory = useCallback((cat: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────────
  const isNpc    = structureId === null;
  const canSave  = !!systemId;  // system must be resolved before saving

  const handleSave = useCallback(async () => {
    if (!canSave || !token) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiPost('/api/industry-settings', {
        system_id:         systemId,
        system_name:       systemName,
        structure_type_id: structureId,
        rig_ids:           isNpc ? [] : selectedRigs,
        facility_tax:      isNpc ? 0 : facilityTax,
      }, token);
      const newSettings: IndustrySettings = {
        system_id:         systemId,
        system_name:       systemName,
        structure_type_id: structureId,
        rig_ids:           JSON.stringify(isNpc ? [] : selectedRigs),
        facility_tax:      isNpc ? 0 : facilityTax,
      };
      onSaved(newSettings);
      setSaved(true);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [canSave, token, systemId, systemName, structureId, isNpc, selectedRigs, facilityTax, onSaved]);

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Manufacturing Setup">
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>

        {/* ── Header ────────────────────────────────────────────────────── */}
        <div className="modal-header">
          <span className="modal-title">⚙ Manufacturing Setup</span>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          <p className="modal-hint">
            Configure your manufacturing location and structure. Used to calculate accurate job fees (System Cost Index × EIV + SCC surcharge + facility tax).
          </p>

          {/* ── Manufacturing System ─────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-label">Manufacturing System</div>
            <div className="system-search-wrap" style={{ position: 'relative' }}>
              <input
                type="text"
                className="settings-input"
                placeholder="Type a system name (e.g. Jita)…"
                value={systemQuery}
                onChange={(e) => handleSystemInput(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                aria-label="Manufacturing system name"
                autoComplete="off"
              />
              {suggestLoading && (
                <span className="system-search-loading">…</span>
              )}
              {showSuggestions && suggestions.length > 0 && (
                <ul className="system-suggestions">
                  {suggestions.map((s) => (
                    <li
                      key={s.system_id}
                      className="system-suggestion-item"
                      onMouseDown={() => handlePickSystem(s)}
                    >
                      {s.system_name}
                      <span className="system-suggestion-id"> #{s.system_id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {systemId && (
              <div className="settings-resolved">
                ✓ {systemName} <span className="settings-id">(ID {systemId})</span>
              </div>
            )}
            {!systemId && systemQuery.length >= 2 && !suggestLoading && suggestions.length === 0 && (
              <div className="settings-warn">No systems found — try a different name</div>
            )}
          </div>

          {/* ── Structure Type ────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-label">Structure Type</div>
            <div className="structure-grid">
              {STRUCTURE_TYPES.map((st) => (
                <label
                  key={String(st.type_id)}
                  className={`structure-option${structureId === st.type_id ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="structure_type"
                    value={String(st.type_id)}
                    checked={structureId === st.type_id}
                    onChange={() => setStructureId(st.type_id)}
                  />
                  <span className="structure-label">{st.label}</span>
                  <span className="structure-note">{st.note}</span>
                </label>
              ))}
            </div>
          </div>

          {/* ── Rigs ─────────────────────────────────────────────────────── */}
          <div className={`settings-section${isNpc ? ' settings-disabled' : ''}`}>
            <div className="settings-label">
              Rigs Installed
              <span className="settings-label-sub">
                {isNpc ? '— N/A for NPC station' : `(${selectedRigs.length}/${MAX_RIGS} selected)`}
              </span>
            </div>
            {RIG_CATEGORIES.map(({ category, rigs }) => (
              <div key={category} className="rig-category">
                <button
                  type="button"
                  className="rig-category-btn"
                  onClick={() => toggleCategory(category)}
                  disabled={isNpc}
                >
                  <span className="rig-category-arrow">
                    {expandedCats.has(category) ? '▼' : '▶'}
                  </span>
                  {category}
                </button>
                {expandedCats.has(category) && (
                  <div className="rig-list">
                    {rigs.map((rig) => {
                      const isChecked   = selectedRigs.includes(rig.type_id);
                      const isMaxed     = !isChecked && selectedRigs.length >= MAX_RIGS;
                      return (
                        <label
                          key={rig.type_id}
                          className={`rig-item${isMaxed ? ' rig-item-disabled' : ''}`}
                        >
                          <input
                            type="checkbox"
                            disabled={isNpc || isMaxed}
                            checked={isChecked}
                            onChange={() => handleRigToggle(rig.type_id)}
                          />
                          <span>{rig.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* ── Facility Tax ─────────────────────────────────────────────── */}
          <div className={`settings-section${isNpc ? ' settings-disabled' : ''}`}>
            <div className="settings-label">
              Facility Tax
              <span className="settings-label-sub">
                {isNpc ? '— N/A for NPC station' : '(set by structure owner; typically 0–5%)'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                className="settings-input settings-input-short"
                value={facilityTax}
                min={0}
                max={100}
                step={0.1}
                disabled={isNpc}
                onChange={(e) => setFacilityTax(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                aria-label="Facility tax percentage"
              />
              <span style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>%</span>
            </div>
          </div>
        </div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <div className="modal-footer">
          {saveError && (
            <div className="settings-save-error">⚠ {saveError}</div>
          )}
          {saved && !saveError && (
            <div className="settings-save-ok">✓ Saved</div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSave || saving}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default IndustrySettingsModal;
