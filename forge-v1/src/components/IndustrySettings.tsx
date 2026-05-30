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

import { useState, useEffect, useCallback, useRef, useMemo, type FC } from 'react';
import type { IndustrySettings, HaulMethod, Market, SystemSearchResult } from '../types';
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

// Hub system IDs — used to auto-zero haul legs when mfg system matches a hub
const HUB_SYSTEM_IDS: Record<number, number> = {
  10000002: 30000142, // Jita
  10000043: 30002187, // Amarr
  10000032: 30002659, // Dodixie
  10000042: 30002053, // Hek
  10000030: 30002510, // Rens
  10000041: 30045331, // Syndicate (Poitot)
};

// ── Haul provider rate tables (mirrored from server.js HAUL_PROVIDERS) ────────
interface HaulProvider {
  name:            string;
  max_volume_m3:   number;
  min_fee:         number;
  isk_per_m3:      number;
  collateral_rate: number;
  rates_as_of:     string;
  note:            string;
}

const HAUL_PROVIDERS: Record<string, HaulProvider> = {
  red_frog:   { name: 'Red Frog',   max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 400,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec only'          },
  black_frog: { name: 'Black Frog', max_volume_m3: 860_000, min_fee: 1_500_000, isk_per_m3: 1_200, collateral_rate: 0.01,  rates_as_of: 'Jun 2025', note: 'Lowsec / Null / WH'    },
  pushx:      { name: 'PushX',      max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 380,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec + some lowsec' },
};

function calcProviderFee(provider: string, volumeM3: number, collateral: number): number {
  const p = HAUL_PROVIDERS[provider];
  if (!p || volumeM3 <= 0) return 0;
  const contracts  = Math.ceil(volumeM3 / p.max_volume_m3);
  const volPerCon  = volumeM3    / contracts;
  const colPerCon  = collateral  / contracts;
  const feePerCon  = Math.max(p.min_fee, p.isk_per_m3 * volPerCon + p.collateral_rate * colPerCon);
  return feePerCon * contracts;
}

function fmtISK(n: number): string {
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

// ── Freight ship table ─────────────────────────────────────────────────────────
// cargoAtLevel[n] = cargo capacity (m³) when the required skill is at level n (1–5).
interface FreightShip {
  id:          string;
  name:        string;
  skillId:     number;
  skillName:   string;
  minLevel:    number;
  cargoAtLevel: [number, number, number, number, number, number]; // [unused, L1, L2, L3, L4, L5]
}

const FREIGHT_SHIPS: FreightShip[] = [
  // T1 Industrials
  { id: 'bestower',   name: 'Bestower',        skillId: 3388,  skillName: 'Amarr Industrial',    minLevel: 1, cargoAtLevel: [0, 4200,  4700,  5300,  6000,  6800]  },
  { id: 'sigil',      name: 'Sigil',            skillId: 3388,  skillName: 'Amarr Industrial',    minLevel: 1, cargoAtLevel: [0, 3500,  3900,  4400,  5000,  5600]  },
  { id: 'badger',     name: 'Badger',           skillId: 3387,  skillName: 'Caldari Industrial',  minLevel: 1, cargoAtLevel: [0, 4700,  5200,  5900,  6700,  7600]  },
  { id: 'iteron_v',   name: 'Iteron Mark V',    skillId: 3389,  skillName: 'Gallente Industrial', minLevel: 5, cargoAtLevel: [0, 0,     0,     0,     0,     62500] },
  { id: 'hoarder',    name: 'Hoarder',          skillId: 3390,  skillName: 'Minmatar Industrial', minLevel: 1, cargoAtLevel: [0, 4900,  5500,  6200,  7000,  7900]  },
  // Freighters
  { id: 'providence', name: 'Providence',       skillId: 20522, skillName: 'Amarr Freighter',    minLevel: 1, cargoAtLevel: [0, 490000, 614000, 737000, 816000, 895000] },
  { id: 'charon',     name: 'Charon',           skillId: 20524, skillName: 'Caldari Freighter',  minLevel: 1, cargoAtLevel: [0, 485000, 600000, 720000, 845000, 900000] },
  { id: 'obelisk',    name: 'Obelisk',          skillId: 20525, skillName: 'Gallente Freighter', minLevel: 1, cargoAtLevel: [0, 530000, 650000, 775000, 895000, 995000] },
  { id: 'fenrir',     name: 'Fenrir',           skillId: 20526, skillName: 'Minmatar Freighter', minLevel: 1, cargoAtLevel: [0, 452000, 555000, 665000, 735000, 800000] },
];

interface CharacterSkillData {
  characterId: number;
  name:        string;
  skills:      Array<{ skill_id: number; active_skill_level: number }>;
}

interface IndustrySettingsProps {
  open:         boolean;
  token:        string | null;
  initial:      IndustrySettings | null;
  sourceMarket: Market;
  sellMarket:   Market;
  onClose:      () => void;
  onSaved:      (settings: IndustrySettings) => void;
  /** v1.7 — primary + alt characters with skill data for self-haul ship selection */
  characters?:  CharacterSkillData[];
}

// ── Component ─────────────────────────────────────────────────────────────────

const IndustrySettingsModal: FC<IndustrySettingsProps> = ({
  open, token, initial, sourceMarket, sellMarket, onClose, onSaved,
  characters = [],
}) => {
  // ── Form state ─────────────────────────────────────────────────────────────
  const [systemQuery,    setSystemQuery]    = useState('');
  const [systemId,       setSystemId]       = useState<number | null>(null);
  const [systemName,     setSystemName]     = useState<string | null>(null);
  const [structureId,    setStructureId]    = useState<number | null>(null);
  const [selectedRigs,   setSelectedRigs]   = useState<number[]>([]);
  const [facilityTax,    setFacilityTax]    = useState(0);
  const [expandedCats,   setExpandedCats]   = useState<Set<string>>(new Set());

  // ── Haulage state (Phase 1 + Phase 2) ─────────────────────────────────────
  const [haulEnabled,      setHaulEnabled]      = useState(false);
  // Per-leg method
  const [leg1Method, setLeg1Method] = useState<HaulMethod>('user_defined');
  const [leg2Method, setLeg2Method] = useState<HaulMethod>('user_defined');
  // user_defined inputs
  const [leg1Rate,         setLeg1Rate]         = useState(0);
  const [leg2Rate,         setLeg2Rate]         = useState(0);
  const [leg1IskPerJump,   setLeg1IskPerJump]   = useState(0);
  const [leg2IskPerJump,   setLeg2IskPerJump]   = useState(0);
  const [leg1FlatTotal,    setLeg1FlatTotal]     = useState(0);
  const [leg2FlatTotal,    setLeg2FlatTotal]     = useState(0);
  const [leg1ServiceLabel, setLeg1ServiceLabel] = useState('');
  const [leg2ServiceLabel, setLeg2ServiceLabel] = useState('');
  // contract hauler collateral
  const [leg1Collateral,   setLeg1Collateral]   = useState(0);
  const [leg2Collateral,   setLeg2Collateral]   = useState(0);
  // self-haul
  const [leg1SelfCharId,   setLeg1SelfCharId]   = useState<number | null>(null);
  const [leg1SelfShip,     setLeg1SelfShip]     = useState('');
  const [leg1SelfFuel,     setLeg1SelfFuel]     = useState(0);
  const [leg2SelfCharId,   setLeg2SelfCharId]   = useState<number | null>(null);
  const [leg2SelfShip,     setLeg2SelfShip]     = useState('');
  const [leg2SelfFuel,     setLeg2SelfFuel]     = useState(0);

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
      setHaulEnabled(initial.haul_enabled ?? false);
      setLeg1Method((initial.leg1_method ?? 'user_defined') as HaulMethod);
      setLeg2Method((initial.leg2_method ?? 'user_defined') as HaulMethod);
      setLeg1Rate(initial.leg1_haul_rate     ?? 0);
      setLeg2Rate(initial.leg2_haul_rate     ?? 0);
      setLeg1IskPerJump(initial.leg1_isk_per_jump  ?? 0);
      setLeg2IskPerJump(initial.leg2_isk_per_jump  ?? 0);
      setLeg1FlatTotal(initial.leg1_flat_total     ?? 0);
      setLeg2FlatTotal(initial.leg2_flat_total     ?? 0);
      setLeg1ServiceLabel(initial.leg1_service_label ?? '');
      setLeg2ServiceLabel(initial.leg2_service_label ?? '');
      setLeg1Collateral(initial.leg1_collateral  ?? 0);
      setLeg2Collateral(initial.leg2_collateral  ?? 0);
      setLeg1SelfCharId(initial.leg1_self_char_id ?? null);
      setLeg1SelfShip(initial.leg1_self_ship   ?? '');
      setLeg1SelfFuel(initial.leg1_self_fuel   ?? 0);
      setLeg2SelfCharId(initial.leg2_self_char_id ?? null);
      setLeg2SelfShip(initial.leg2_self_ship   ?? '');
      setLeg2SelfFuel(initial.leg2_self_fuel   ?? 0);
    } else {
      setSystemId(null);
      setSystemName(null);
      setSystemQuery('');
      setStructureId(null);
      setSelectedRigs([]);
      setFacilityTax(0);
      setHaulEnabled(false);
      setLeg1Method('user_defined'); setLeg2Method('user_defined');
      setLeg1Rate(0);         setLeg2Rate(0);
      setLeg1IskPerJump(0);   setLeg2IskPerJump(0);
      setLeg1FlatTotal(0);    setLeg2FlatTotal(0);
      setLeg1ServiceLabel(''); setLeg2ServiceLabel('');
      setLeg1Collateral(0);   setLeg2Collateral(0);
      setLeg1SelfCharId(null); setLeg2SelfCharId(null);
      setLeg1SelfShip('');    setLeg2SelfShip('');
      setLeg1SelfFuel(0);     setLeg2SelfFuel(0);
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

  // ── Self-haul helpers ─────────────────────────────────────────────────────
  // Which ships can each character fly? Filter FREIGHT_SHIPS by skill level.
  const charShipOptions = useMemo(() => {
    return characters.map((c) => {
      const skillMap = new Map(c.skills.map(s => [s.skill_id, s.active_skill_level]));
      const flyable = FREIGHT_SHIPS.filter((ship) => {
        const level = skillMap.get(ship.skillId) ?? 0;
        return level >= ship.minLevel;
      }).map((ship) => {
        const level    = skillMap.get(ship.skillId) ?? 0;
        const cargo    = ship.cargoAtLevel[Math.min(level, 5) as 0|1|2|3|4|5];
        return { ...ship, level, cargo };
      });
      return { characterId: c.characterId, name: c.name, ships: flyable };
    });
  }, [characters]);

  function getSelfHaulCargo(charId: number | null, shipId: string): number {
    if (!charId || !shipId) return 0;
    const char = charShipOptions.find(c => c.characterId === charId);
    const ship = char?.ships.find(s => s.id === shipId);
    return ship?.cargo ?? 0;
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const isNpc    = structureId === null;
  const canSave  = !!systemId;

  // Auto-zero: if mfg system matches the source or sell hub's main station
  const leg1AutoZero = !!(systemId && HUB_SYSTEM_IDS[sourceMarket.id] === systemId);
  const leg2AutoZero = !!(systemId && HUB_SYSTEM_IDS[sellMarket.id]   === systemId);

  const handleSave = useCallback(async () => {
    if (!canSave || !token) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        system_id:         systemId,
        system_name:       systemName,
        structure_type_id: structureId,
        rig_ids:           isNpc ? [] : selectedRigs,
        facility_tax:      isNpc ? 0 : facilityTax,
        haul_enabled:      haulEnabled,
        // Phase 1 compat
        leg1_haul_rate:    leg1AutoZero ? 0 : leg1Rate,
        leg2_haul_rate:    leg2AutoZero ? 0 : leg2Rate,
        // Phase 2
        leg1_method:          leg1AutoZero ? 'user_defined' : leg1Method,
        leg2_method:          leg2AutoZero ? 'user_defined' : leg2Method,
        leg1_collateral:      leg1Collateral,
        leg2_collateral:      leg2Collateral,
        leg1_isk_per_jump:    leg1IskPerJump,
        leg2_isk_per_jump:    leg2IskPerJump,
        leg1_flat_total:      leg1FlatTotal,
        leg2_flat_total:      leg2FlatTotal,
        leg1_service_label:   leg1ServiceLabel || null,
        leg2_service_label:   leg2ServiceLabel || null,
        leg1_self_char_id:    leg1SelfCharId,
        leg1_self_ship:       leg1SelfShip || null,
        leg1_self_fuel:       leg1SelfFuel,
        leg2_self_char_id:    leg2SelfCharId,
        leg2_self_ship:       leg2SelfShip || null,
        leg2_self_fuel:       leg2SelfFuel,
      };
      await apiPost('/api/industry-settings', body, token);
      const newSettings: IndustrySettings = {
        system_id:         systemId,
        system_name:       systemName,
        structure_type_id: structureId,
        rig_ids:           JSON.stringify(isNpc ? [] : selectedRigs),
        facility_tax:      isNpc ? 0 : facilityTax,
        haul_enabled:      haulEnabled,
        leg1_haul_rate:    leg1AutoZero ? 0 : leg1Rate,
        leg2_haul_rate:    leg2AutoZero ? 0 : leg2Rate,
        leg1_method:       leg1AutoZero ? 'user_defined' : leg1Method,
        leg2_method:       leg2AutoZero ? 'user_defined' : leg2Method,
        leg1_collateral:   leg1Collateral,    leg2_collateral:   leg2Collateral,
        leg1_isk_per_jump: leg1IskPerJump,    leg2_isk_per_jump: leg2IskPerJump,
        leg1_flat_total:   leg1FlatTotal,     leg2_flat_total:   leg2FlatTotal,
        leg1_service_label: leg1ServiceLabel || null,
        leg2_service_label: leg2ServiceLabel || null,
        leg1_self_char_id: leg1SelfCharId,    leg2_self_char_id: leg2SelfCharId,
        leg1_self_ship:    leg1SelfShip || null, leg2_self_ship: leg2SelfShip || null,
        leg1_self_fuel:    leg1SelfFuel,      leg2_self_fuel:    leg2SelfFuel,
      };
      onSaved(newSettings);
      setSaved(true);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [canSave, token, systemId, systemName, structureId, isNpc, selectedRigs,
      facilityTax, haulEnabled, leg1AutoZero, leg2AutoZero,
      leg1Method, leg2Method, leg1Rate, leg2Rate,
      leg1Collateral, leg2Collateral, leg1IskPerJump, leg2IskPerJump,
      leg1FlatTotal, leg2FlatTotal, leg1ServiceLabel, leg2ServiceLabel,
      leg1SelfCharId, leg1SelfShip, leg1SelfFuel,
      leg2SelfCharId, leg2SelfShip, leg2SelfFuel, onSaved]);

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

          {/* ── Haulage ───────────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="settings-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={haulEnabled} onChange={(e) => setHaulEnabled(e.target.checked)} />
                Haulage Costs
              </label>
              <span className="settings-label-sub">— included in True Profit when enabled</span>
            </div>

            {haulEnabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                {(['leg1', 'leg2'] as const).map((leg) => {
                  const isLeg1     = leg === 'leg1';
                  const autoZero   = isLeg1 ? leg1AutoZero   : leg2AutoZero;
                  const method     = isLeg1 ? leg1Method     : leg2Method;
                  const setMethod  = isLeg1 ? setLeg1Method  : setLeg2Method;
                  const rate       = isLeg1 ? leg1Rate       : leg2Rate;
                  const setRate    = isLeg1 ? setLeg1Rate    : setLeg2Rate;
                  const perJump    = isLeg1 ? leg1IskPerJump : leg2IskPerJump;
                  const setPerJump = isLeg1 ? setLeg1IskPerJump : setLeg2IskPerJump;
                  const flatTotal  = isLeg1 ? leg1FlatTotal  : leg2FlatTotal;
                  const setFlat    = isLeg1 ? setLeg1FlatTotal : setLeg2FlatTotal;
                  const serviceLabel = isLeg1 ? leg1ServiceLabel : leg2ServiceLabel;
                  const setLabel   = isLeg1 ? setLeg1ServiceLabel : setLeg2ServiceLabel;
                  const collateral = isLeg1 ? leg1Collateral : leg2Collateral;
                  const setCol     = isLeg1 ? setLeg1Collateral : setLeg2Collateral;
                  const selfCharId = isLeg1 ? leg1SelfCharId : leg2SelfCharId;
                  const setSelfChar = isLeg1 ? setLeg1SelfCharId : setLeg2SelfCharId;
                  const selfShip   = isLeg1 ? leg1SelfShip   : leg2SelfShip;
                  const setSelfShip = isLeg1 ? setLeg1SelfShip : setLeg2SelfShip;
                  const selfFuel   = isLeg1 ? leg1SelfFuel   : leg2SelfFuel;
                  const setSelfFuel = isLeg1 ? setLeg1SelfFuel : setLeg2SelfFuel;

                  const routeLabel = isLeg1
                    ? `${sourceMarket.name} → ${systemName ?? '(set system above)'}`
                    : `${systemName ?? '(set system above)'} → ${sellMarket.name}`;

                  // Self-haul — available ships for selected character
                  const selfCharOptions = charShipOptions;
                  const selectedChar    = selfCharOptions.find(c => c.characterId === selfCharId);
                  const flyableShips    = selectedChar?.ships ?? [];
                  const selfCargo       = getSelfHaulCargo(selfCharId, selfShip);
                  // Red Frog equivalent for break-even (leg 1 only used when volumes known)
                  const rfEquiv = selfCargo > 0 ? calcProviderFee('red_frog', selfCargo, 0) : 0;
                  const breakEvenIskHr = rfEquiv > 0 && selfCargo > 0 ? rfEquiv / (9 / 60) : 0; // rough 9-jump estimate

                  // Provider preview
                  const providerPreview = (m: HaulMethod) => {
                    const p = HAUL_PROVIDERS[m];
                    if (!p) return null;
                    return `~${fmtISK(p.isk_per_m3)} ISK/m³ base · ${(p.collateral_rate * 100).toFixed(1)}% collateral · min ${fmtISK(p.min_fee)} ISK · ${p.note}`;
                  };

                  return (
                    <div key={leg} className="haul-leg">
                      <div className="haul-leg-label">
                        <span className="haul-leg-title">{isLeg1 ? 'Materials in' : 'Goods out'}</span>
                        <span className="haul-leg-route">{routeLabel}</span>
                      </div>

                      {autoZero ? (
                        <div className="haul-leg-autozero">Same location — no haul needed · 0 ISK/m³</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {/* Method selector */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 48 }}>Method</span>
                            <select
                              className="settings-input"
                              style={{ maxWidth: 200 }}
                              value={method}
                              onChange={(e) => setMethod(e.target.value as HaulMethod)}
                            >
                              <option value="user_defined">User-Defined</option>
                              <option value="red_frog">Red Frog</option>
                              <option value="black_frog">Black Frog</option>
                              <option value="pushx">PushX</option>
                              <option value="self_haul">Self-Haul</option>
                            </select>
                          </div>

                          {/* ── User-Defined inputs ─────────────────────────── */}
                          {method === 'user_defined' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="number" className="settings-input settings-input-short" value={rate} min={0} step={100} placeholder="0"
                                  onChange={(e) => setRate(Math.max(0, parseFloat(e.target.value) || 0))} />
                                <span className="haul-leg-unit">ISK/m³</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="number" className="settings-input settings-input-short" value={perJump || ''} min={0} step={100000} placeholder="0"
                                  onChange={(e) => setPerJump(Math.max(0, parseFloat(e.target.value) || 0))} />
                                <span className="haul-leg-unit">ISK/jump</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="number" className="settings-input settings-input-short" value={flatTotal || ''} min={0} step={1000000} placeholder="0"
                                  onChange={(e) => setFlat(Math.max(0, parseFloat(e.target.value) || 0))} />
                                <span className="haul-leg-unit">ISK flat</span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="text" className="settings-input" style={{ maxWidth: 160 }} value={serviceLabel} placeholder="Label (e.g. Alliance JF)"
                                  onChange={(e) => setLabel(e.target.value.slice(0, 40))} />
                              </div>
                              {(rate > 0 || perJump > 0 || flatTotal > 0) && (
                                <div className="haul-leg-note">
                                  Using highest of filled fields (most conservative).
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── Contract hauler inputs (Red/Black Frog, PushX) ── */}
                          {(method === 'red_frog' || method === 'black_frog' || method === 'pushx') && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                              <div className="haul-leg-note" style={{ marginBottom: 4 }}>
                                {providerPreview(method)}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Collateral</span>
                                <input type="number" className="settings-input settings-input-short" value={collateral || ''} min={0} step={10000000} placeholder="0"
                                  onChange={(e) => setCol(Math.max(0, parseFloat(e.target.value) || 0))} />
                                <span className="haul-leg-unit">ISK</span>
                              </div>
                              {collateral > 0 && (
                                <div className="haul-leg-note">
                                  Collateral declared: {fmtISK(collateral)} ISK — affects quoted fee but not deducted from profit.
                                  Rates as of {HAUL_PROVIDERS[method].rates_as_of} — verify at provider website.
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── Self-Haul inputs ────────────────────────────── */}
                          {method === 'self_haul' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingLeft: 56 }}>
                              {characters.length === 0 ? (
                                <div className="haul-leg-note">Log in to see available ships.</div>
                              ) : (
                                <>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Character</span>
                                    <select className="settings-input" style={{ maxWidth: 180 }} value={selfCharId ?? ''} onChange={(e) => { setSelfChar(e.target.value ? Number(e.target.value) : null); setSelfShip(''); }}>
                                      <option value="">— select —</option>
                                      {characters.map(c => <option key={c.characterId} value={c.characterId}>{c.name}</option>)}
                                    </select>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Ship</span>
                                    <select className="settings-input" style={{ maxWidth: 200 }} value={selfShip} onChange={(e) => setSelfShip(e.target.value)} disabled={!selfCharId}>
                                      <option value="">— select —</option>
                                      {flyableShips.map(s => (
                                        <option key={s.id} value={s.id}>
                                          {s.name} L{s.level} — {s.cargo.toLocaleString()} m³
                                        </option>
                                      ))}
                                      {selfCharId && flyableShips.length === 0 && <option disabled>No freight ships available</option>}
                                    </select>
                                  </div>
                                  {selfCargo > 0 && (
                                    <div className="haul-leg-note" style={{ color: 'var(--color-success)' }}>
                                      ✓ {selfCargo.toLocaleString()} m³ cargo — 0 ISK/m³ (your time only)
                                    </div>
                                  )}
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', minWidth: 72 }}>Fuel cost</span>
                                    <input type="number" className="settings-input settings-input-short" value={selfFuel || ''} min={0} step={1000000} placeholder="0"
                                      onChange={(e) => setSelfFuel(Math.max(0, parseFloat(e.target.value) || 0))} />
                                    <span className="haul-leg-unit">ISK</span>
                                  </div>
                                  {selfCargo > 0 && rfEquiv > 0 && (
                                    <div className="haul-leg-note">
                                      Red Frog equivalent ≈ {fmtISK(rfEquiv)} ISK · Break-even: your time worth &lt; {fmtISK(breakEvenIskHr)} ISK/hr → self-haul wins
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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
