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
import type {
  IndustrySettings, HaulMethod, Market, SystemSearchResult,
  IndustryRigsResponse, StructureFitSuggestion, JobCostCheck,
} from '../types';
import { apiGet, apiPost } from '../api/client';

import HaulMethodFields from './HaulMethodFields';
import { fmtISK, type CharacterSkillData } from '../data/haulProviders';
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
  { label: 'Sotiyo',       type_id: 35827, note: '1% ME · 30% TE'       },
];

interface RigEntry {
  type_id:  number;
  name:     string;
  category: string;
  size:     'M' | 'L' | 'XL';
}

// Every published Standup {M,L,XL}-Set manufacturing-efficiency rig, verified
// 17 Sept 2026 against live ESI (/universe/types/) + the Fuzzwork SDE export
// (market groups 2347/2348/2349 = "{Medium,Large,X-Large} Structure Engineering
// Rigs"). Excludes the sibling research/invention/blueprint-copy rigs that live
// in the same market groups — those aren't manufacturing-job rigs and belong to
// a separate research-rig picker (see invention_rig_ids elsewhere in this file).
//
// M-Set (Raitaru) splits each category into a Material-Efficiency-only rig and
// a Time-Efficiency-only rig. L-Set (Azbel) and XL-Set (Sotiyo) instead use one
// combined rig per category/tier that grants both bonuses at once — that's why
// M has ~2x as many rows per category as L/XL. Only fit rigs matching the
// structure's own size (a Raitaru cannot take L or XL rigs); the picker below
// filters accordingly.
//
// `name` is the FULL verbatim in-game item name (including the "Standup
// {M,L,XL}-Set" prefix) — deliberately not shortened, so a user cross-checking
// against their structure's fitting window or the market never has to guess
// whether a shown item is the same thing. Keep it that way on any future edit.
const MANUFACTURING_RIGS: RigEntry[] = [
  // ── M-Set (Raitaru) ──────────────────────────────────────
  { type_id: 43866, name: 'Standup M-Set Advanced Component Manufacturing Material Efficiency II', category: 'Advanced Component', size: 'M' },
  { type_id: 43867, name: 'Standup M-Set Advanced Component Manufacturing Material Efficiency I', category: 'Advanced Component', size: 'M' },
  { type_id: 43868, name: 'Standup M-Set Advanced Component Manufacturing Time Efficiency II', category: 'Advanced Component', size: 'M' },
  { type_id: 43869, name: 'Standup M-Set Advanced Component Manufacturing Time Efficiency I', category: 'Advanced Component', size: 'M' },
  { type_id: 45640, name: 'Standup M-Set Thukker Advanced Component Manufacturing Material Efficiency', category: 'Advanced Component', size: 'M' },
  { type_id: 43862, name: 'Standup M-Set Advanced Large Ship Manufacturing Material Efficiency I', category: 'Advanced Large Ship', size: 'M' },
  { type_id: 43863, name: 'Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II', category: 'Advanced Large Ship', size: 'M' },
  { type_id: 43864, name: 'Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II', category: 'Advanced Large Ship', size: 'M' },
  { type_id: 43865, name: 'Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I', category: 'Advanced Large Ship', size: 'M' },
  { type_id: 43858, name: 'Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency I', category: 'Advanced Medium Ship', size: 'M' },
  { type_id: 43859, name: 'Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency II', category: 'Advanced Medium Ship', size: 'M' },
  { type_id: 43860, name: 'Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency I', category: 'Advanced Medium Ship', size: 'M' },
  { type_id: 43861, name: 'Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency II', category: 'Advanced Medium Ship', size: 'M' },
  { type_id: 43854, name: 'Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II', category: 'Advanced Small Ship', size: 'M' },
  { type_id: 43855, name: 'Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I', category: 'Advanced Small Ship', size: 'M' },
  { type_id: 43856, name: 'Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I', category: 'Advanced Small Ship', size: 'M' },
  { type_id: 43857, name: 'Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II', category: 'Advanced Small Ship', size: 'M' },
  { type_id: 37150, name: 'Standup M-Set Ammunition Manufacturing Time Efficiency I', category: 'Ammunition', size: 'M' },
  { type_id: 37151, name: 'Standup M-Set Ammunition Manufacturing Time Efficiency II', category: 'Ammunition', size: 'M' },
  { type_id: 37158, name: 'Standup M-Set Ammunition Manufacturing Material Efficiency I', category: 'Ammunition', size: 'M' },
  { type_id: 37159, name: 'Standup M-Set Ammunition Manufacturing Material Efficiency II', category: 'Ammunition', size: 'M' },
  { type_id: 43870, name: 'Standup M-Set Basic Capital Component Manufacturing Material Efficiency I', category: 'Basic Capital Component', size: 'M' },
  { type_id: 43871, name: 'Standup M-Set Basic Capital Component Manufacturing Material Efficiency II', category: 'Basic Capital Component', size: 'M' },
  { type_id: 43872, name: 'Standup M-Set Basic Capital Component Manufacturing Time Efficiency I', category: 'Basic Capital Component', size: 'M' },
  { type_id: 43873, name: 'Standup M-Set Basic Capital Component Manufacturing Time Efficiency II', category: 'Basic Capital Component', size: 'M' },
  { type_id: 45544, name: 'Standup M-Set Thukker Basic Capital Component Manufacturing Material Efficiency', category: 'Basic Capital Component', size: 'M' },
  { type_id: 37152, name: 'Standup M-Set Basic Large Ship Manufacturing Material Efficiency II', category: 'Basic Large Ship', size: 'M' },
  { type_id: 43732, name: 'Standup M-Set Basic Large Ship Manufacturing Material Efficiency I', category: 'Basic Large Ship', size: 'M' },
  { type_id: 43733, name: 'Standup M-Set Basic Large Ship Manufacturing Time Efficiency I', category: 'Basic Large Ship', size: 'M' },
  { type_id: 43734, name: 'Standup M-Set Basic Large Ship Manufacturing Time Efficiency II', category: 'Basic Large Ship', size: 'M' },
  { type_id: 37146, name: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I', category: 'Basic Medium Ship', size: 'M' },
  { type_id: 37147, name: 'Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II', category: 'Basic Medium Ship', size: 'M' },
  { type_id: 37153, name: 'Standup M-Set Basic Medium Ship Manufacturing Time Efficiency II', category: 'Basic Medium Ship', size: 'M' },
  { type_id: 43919, name: 'Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I', category: 'Basic Medium Ship', size: 'M' },
  { type_id: 37154, name: 'Standup M-Set Basic Small Ship Manufacturing Material Efficiency I', category: 'Basic Small Ship', size: 'M' },
  { type_id: 37155, name: 'Standup M-Set Basic Small Ship Manufacturing Material Efficiency II', category: 'Basic Small Ship', size: 'M' },
  { type_id: 37162, name: 'Standup M-Set Basic Small Ship Manufacturing Time Efficiency I', category: 'Basic Small Ship', size: 'M' },
  { type_id: 37163, name: 'Standup M-Set Basic Small Ship Manufacturing Time Efficiency II', category: 'Basic Small Ship', size: 'M' },
  { type_id: 37148, name: 'Standup M-Set Drone and Fighter Manufacturing Time Efficiency I', category: 'Drone and Fighter', size: 'M' },
  { type_id: 37149, name: 'Standup M-Set Drone and Fighter Manufacturing Time Efficiency II', category: 'Drone and Fighter', size: 'M' },
  { type_id: 37156, name: 'Standup M-Set Drone and Fighter Manufacturing Material Efficiency I', category: 'Drone and Fighter', size: 'M' },
  { type_id: 37157, name: 'Standup M-Set Drone and Fighter Manufacturing Material Efficiency II', category: 'Drone and Fighter', size: 'M' },
  { type_id: 37160, name: 'Standup M-Set Equipment Manufacturing Time Efficiency I', category: 'Equipment', size: 'M' },
  { type_id: 37161, name: 'Standup M-Set Equipment Manufacturing Time Efficiency II', category: 'Equipment', size: 'M' },
  { type_id: 43920, name: 'Standup M-Set Equipment Manufacturing Material Efficiency I', category: 'Equipment', size: 'M' },
  { type_id: 43921, name: 'Standup M-Set Equipment Manufacturing Material Efficiency II', category: 'Equipment', size: 'M' },
  { type_id: 43874, name: 'Standup M-Set Structure Manufacturing Material Efficiency II', category: 'Structure', size: 'M' },
  { type_id: 43875, name: 'Standup M-Set Structure Manufacturing Material Efficiency I', category: 'Structure', size: 'M' },
  { type_id: 43876, name: 'Standup M-Set Structure Manufacturing Time Efficiency I', category: 'Structure', size: 'M' },
  { type_id: 43877, name: 'Standup M-Set Structure Manufacturing Time Efficiency II', category: 'Structure', size: 'M' },
  // ── L-Set (Azbel) ──────────────────────────────────────
  { type_id: 37174, name: 'Standup L-Set Advanced Component Manufacturing Efficiency I', category: 'Advanced Component', size: 'L' },
  { type_id: 37175, name: 'Standup L-Set Advanced Component Manufacturing Efficiency II', category: 'Advanced Component', size: 'L' },
  { type_id: 45641, name: 'Standup L-Set Thukker Advanced Component Manufacturing Efficiency', category: 'Advanced Component', size: 'L' },
  { type_id: 37168, name: 'Standup L-Set Advanced Large Ship Manufacturing Efficiency I', category: 'Advanced Large Ship', size: 'L' },
  { type_id: 37169, name: 'Standup L-Set Advanced Large Ship Manufacturing Efficiency II', category: 'Advanced Large Ship', size: 'L' },
  { type_id: 43709, name: 'Standup L-Set Advanced Medium Ship Manufacturing Efficiency I', category: 'Advanced Medium Ship', size: 'L' },
  { type_id: 43711, name: 'Standup L-Set Advanced Medium Ship Manufacturing Efficiency II', category: 'Advanced Medium Ship', size: 'L' },
  { type_id: 43707, name: 'Standup L-Set Advanced Small Ship Manufacturing Efficiency I', category: 'Advanced Small Ship', size: 'L' },
  { type_id: 43708, name: 'Standup L-Set Advanced Small Ship Manufacturing Efficiency II', category: 'Advanced Small Ship', size: 'L' },
  { type_id: 37164, name: 'Standup L-Set Ammunition Manufacturing Efficiency I', category: 'Ammunition', size: 'L' },
  { type_id: 37165, name: 'Standup L-Set Ammunition Manufacturing Efficiency II', category: 'Ammunition', size: 'L' },
  { type_id: 43718, name: 'Standup L-Set Basic Capital Component Manufacturing Efficiency I', category: 'Basic Capital Component', size: 'L' },
  { type_id: 43719, name: 'Standup L-Set Basic Capital Component Manufacturing Efficiency II', category: 'Basic Capital Component', size: 'L' },
  { type_id: 45546, name: 'Standup L-Set Thukker Basic Capital Component Manufacturing Efficiency', category: 'Basic Capital Component', size: 'L' },
  { type_id: 37166, name: 'Standup L-Set Basic Large Ship Manufacturing Efficiency I', category: 'Basic Large Ship', size: 'L' },
  { type_id: 37167, name: 'Standup L-Set Basic Large Ship Manufacturing Efficiency II', category: 'Basic Large Ship', size: 'L' },
  { type_id: 43716, name: 'Standup L-Set Basic Medium Ship Manufacturing Efficiency I', category: 'Basic Medium Ship', size: 'L' },
  { type_id: 43717, name: 'Standup L-Set Basic Medium Ship Manufacturing Efficiency II', category: 'Basic Medium Ship', size: 'L' },
  { type_id: 43714, name: 'Standup L-Set Basic Small Ship Manufacturing Efficiency I', category: 'Basic Small Ship', size: 'L' },
  { type_id: 43715, name: 'Standup L-Set Basic Small Ship Manufacturing Efficiency II', category: 'Basic Small Ship', size: 'L' },
  { type_id: 37172, name: 'Standup L-Set Capital Ship Manufacturing Efficiency II', category: 'Capital Ship', size: 'L' },
  { type_id: 37173, name: 'Standup L-Set Capital Ship Manufacturing Efficiency I', category: 'Capital Ship', size: 'L' },
  { type_id: 43712, name: 'Standup L-Set Drone and Fighter Manufacturing Efficiency I', category: 'Drone and Fighter', size: 'L' },
  { type_id: 43713, name: 'Standup L-Set Drone and Fighter Manufacturing Efficiency II', category: 'Drone and Fighter', size: 'L' },
  { type_id: 37170, name: 'Standup L-Set Equipment Manufacturing Efficiency I', category: 'Equipment', size: 'L' },
  { type_id: 37171, name: 'Standup L-Set Equipment Manufacturing Efficiency II', category: 'Equipment', size: 'L' },
  { type_id: 43720, name: 'Standup L-Set Structure Manufacturing Efficiency I', category: 'Structure', size: 'L' },
  { type_id: 43721, name: 'Standup L-Set Structure Manufacturing Efficiency II', category: 'Structure', size: 'L' },
  // ── XL-Set (Sotiyo) ──────────────────────────────────────
  { type_id: 37178, name: 'Standup XL-Set Equipment and Consumable Manufacturing Efficiency I', category: 'Equipment and Consumable', size: 'XL' },
  { type_id: 37179, name: 'Standup XL-Set Equipment and Consumable Manufacturing Efficiency II', category: 'Equipment and Consumable', size: 'XL' },
  { type_id: 37180, name: 'Standup XL-Set Ship Manufacturing Efficiency I', category: 'Ship', size: 'XL' },
  { type_id: 37181, name: 'Standup XL-Set Ship Manufacturing Efficiency II', category: 'Ship', size: 'XL' },
  { type_id: 43704, name: 'Standup XL-Set Structure and Component Manufacturing Efficiency I', category: 'Structure and Component', size: 'XL' },
  { type_id: 43705, name: 'Standup XL-Set Structure and Component Manufacturing Efficiency II', category: 'Structure and Component', size: 'XL' },
  { type_id: 45548, name: 'Standup XL-Set Thukker Structure and Component Manufacturing Efficiency', category: 'Structure and Component', size: 'XL' },
];

// Maps each selectable structure type_id (see STRUCTURE_TYPES) to the rig size
// it can mount — Raitaru→M, Azbel→L, Sotiyo→XL. NPC stations (null) take none.
const STRUCTURE_RIG_SIZE: Record<number, 'M' | 'L' | 'XL'> = {
  35825: 'M',  // Raitaru
  35826: 'L',  // Azbel
  35827: 'XL', // Sotiyo
};

const MAX_RIGS = 3;

/** hi ≥ 0.45 (shown as 0.5+), low 0 < sec < 0.45, null ≤ 0 (incl. wormholes). Same rule as the server. */
function securityClassOf(sec: number | null | undefined): 'hi' | 'low' | 'null' | null {
  if (typeof sec !== 'number' || !isFinite(sec)) return null;
  if (sec >= 0.45) return 'hi';
  if (sec > 0)     return 'low';
  return 'null';
}
const SEC_CLASS_LABEL = { hi: 'highsec', low: 'lowsec', null: 'nullsec / wormhole' } as const;

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

// ── Freight ship table ─────────────────────────────────────────────────────────
// cargoAtLevel[n] = cargo capacity (m³) when the required skill is at level n (1–5).
// Shared with InterHubHaulConfig.tsx — see data/freightShips.ts for the full
// verification notes (both skillId/skillName and cargoAtLevel are verified).

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
  /** Section to scroll to when the modal opens (the haulage notices in the item panel link here) */
  focusSection?: 'haulage' | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

const NO_SUGGESTIONS: StructureFitSuggestion[] = [];

const IndustrySettingsModal: FC<IndustrySettingsProps> = ({
  open, token, initial, sourceMarket, sellMarket, onClose, onSaved,
  characters = [], focusSection = null,
}) => {
  // Scroll straight to the haulage section when opened from a haulage notice.
  useEffect(() => {
    if (!open || focusSection !== 'haulage') return;
    const t = setTimeout(() => {
      document.getElementById('settings-haulage')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 120);
    return () => clearTimeout(t);
  }, [open, focusSection]);
  // ── Form state ─────────────────────────────────────────────────────────────
  const [systemQuery,    setSystemQuery]    = useState('');
  const [systemId,       setSystemId]       = useState<number | null>(null);
  const [systemName,     setSystemName]     = useState<string | null>(null);
  const [structureId,    setStructureId]    = useState<number | null>(null);
  const [selectedRigs,   setSelectedRigs]   = useState<number[]>([]);
  const [facilityTax,    setFacilityTax]    = useState(0);
  // Real game stats + context that make the setup honest: security of the chosen system (rig
  // bonuses scale by it), CCP's published rig values, rigs that were dropped, and what other
  // FORGE pilots report for the same structure.
  const [systemSecurity, setSystemSecurity] = useState<number | null>(null);
  const [droppedRigCount, setDroppedRigCount] = useState(0);
  const [sizeDroppedCount, setSizeDroppedCount] = useState(0);
  const [rigStats,       setRigStats]       = useState<IndustryRigsResponse | null>(null);
  const [fitResult, setFitResult] = useState<{ key: string; suggestions: StructureFitSuggestion[] } | null>(null);
  const [jobCheckResult, setJobCheckResult] = useState<{ initial: IndustrySettings | null; data: JobCostCheck | null } | null>(null);
  // Shown only while the modal is open and only for the saved setup it was computed for (derived, not cleared by an effect).
  const jobCheck = open && token && jobCheckResult?.initial === initial ? jobCheckResult.data : null;
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the form is (re)seeded from the saved settings each time the modal opens
    setSaved(false);
    setSaveError(null);
    if (initial) {
      setSystemId(initial.system_id);
      setSystemName(initial.system_name);
      setSystemQuery(initial.system_name ?? '');
      setStructureId(initial.structure_type_id);
      // Saved rigs that aren't in the picker's catalog (stale ids from an older picker) can't be
      // selected, so say so instead of dropping them silently.
      let savedRigs: number[] = [];
      try {
        const parsed: unknown = JSON.parse(initial.rig_ids || '[]');
        if (Array.isArray(parsed)) savedRigs = parsed.map(Number).filter(Number.isFinite);
      } catch { /* corrupt value → treat as no saved rigs */ }
      const catalogIds = new Set(MANUFACTURING_RIGS.map((r) => r.type_id));
      setSelectedRigs(savedRigs.filter((id) => catalogIds.has(id)));
      setDroppedRigCount(savedRigs.filter((id) => !catalogIds.has(id)).length);
      setSizeDroppedCount(0);
      setSystemSecurity(initial.system_security ?? null);
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
      setDroppedRigCount(0);
      setSizeDroppedCount(0);
      setSystemSecurity(null);
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

  // CCP's published rig values (static game data) — fetched once, shown next to each rig.
  useEffect(() => {
    if (!open || !token || rigStats) return;
    let cancelled = false;
    apiGet<IndustryRigsResponse>('/api/industry-rigs', token)
      .then((r) => { if (!cancelled) setRigStats(r); })
      .catch(() => { /* optional enhancement — picker works without it */ });
    return () => { cancelled = true; };
  }, [open, token, rigStats]);

  // FORGE's install-cost estimate vs what CCP actually charged for the character's running jobs.
  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    apiGet<JobCostCheck>('/api/job-cost-check', token)
      .then((r) => { if (!cancelled) setJobCheckResult({ initial, data: r }); })
      .catch(() => { if (!cancelled) setJobCheckResult({ initial, data: null }); });
    return () => { cancelled = true; };
  }, [open, token, initial]);

  // What other FORGE pilots report for this system + structure type (anonymous).
  // Suggestions are stored with the system + structure type they answer; those for a previous selection are
  // never shown (or applied) while the new request is in flight.
  const fitKey = open && token && systemId && structureId !== null ? `${systemId}|${structureId}` : null;
  const fitSuggestions = fitKey !== null && fitResult?.key === fitKey ? fitResult.suggestions : NO_SUGGESTIONS;
  useEffect(() => {
    if (fitKey === null || !token) return;
    let cancelled = false;
    apiGet<{ suggestions: StructureFitSuggestion[] }>(
      `/api/structure-fit-suggestions?system_id=${systemId}&structure_type_id=${structureId}`, token
    )
      .then((r) => { if (!cancelled) setFitResult({ key: fitKey, suggestions: r.suggestions ?? [] }); })
      .catch(() => { if (!cancelled) setFitResult({ key: fitKey, suggestions: [] }); });
    return () => { cancelled = true; };
  }, [fitKey, token, systemId, structureId]);

  // ── System autocomplete ────────────────────────────────────────────────────
  const handleSystemInput = useCallback((value: string) => {
    setSystemQuery(value);
    setSystemId(null);   // clear resolved system until user picks from list
    setSystemName(null);
    setSystemSecurity(null);
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
    setSystemSecurity(result.security ?? null);
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
  const canSave  = !!systemId;

  // Rigs available for the currently-selected structure size (a Raitaru can't
  // mount L/XL rigs, etc.) — grouped by category for the accordion below.
  const rigSize = structureId !== null ? STRUCTURE_RIG_SIZE[structureId] : null;
  const RIG_CATEGORIES = useMemo(() => {
    const rigs = rigSize ? MANUFACTURING_RIGS.filter((r) => r.size === rigSize) : [];
    return Array.from(new Set(rigs.map((r) => r.category))).map((cat) => ({
      category: cat,
      rigs: rigs.filter((r) => r.category === cat),
    }));
  }, [rigSize]);

  // Security class of the chosen system: engineering rig bonuses are multiplied by it
  // (CCP's per-rig values: highsec ×1, lowsec ×1.9, nullsec/wormhole ×2.1 for standard rigs).
  const secClass = securityClassOf(systemSecurity);
  const fmtNum = (n: number) => String(Math.round(n * 100) / 100);
  const rigStatText = (typeId: number): string | null => {
    const s = rigStats?.rigs?.[String(typeId)];
    if (!s) return null;
    const mult = secClass ? (s.sec?.[secClass] ?? null) : null;
    const scaled = (v: number) => (mult && mult !== 1 ? ` → ${fmtNum(v * mult)}% here` : '');
    const parts: string[] = [];
    const mat = s.matPct || s.thukkerMatPct || 0;   // Thukker rigs keep their material bonus in a separate game attribute
    if (mat)       parts.push(`ME ${fmtNum(mat)}%${scaled(mat)}`);
    if (s.timePct) parts.push(`TE ${fmtNum(s.timePct)}%${scaled(s.timePct)}`);
    return parts.join(' · ') || null;
  };

  // If the structure type changes (or is cleared), drop any selected rigs that
  // no longer fit the new size — prevents saving e.g. an XL rig against a
  // Raitaru after switching structures mid-edit.
  const validRigIds = new Set(
    (rigSize ? MANUFACTURING_RIGS.filter((r) => r.size === rigSize) : []).map((r) => r.type_id)
  );
  const keptRigs = selectedRigs.filter((id) => validRigIds.has(id));
  if (keptRigs.length !== selectedRigs.length) {
    // Adjusted while rendering (it converges on the next pass), so a rig that no longer fits is never shown selected.
    setSizeDroppedCount(selectedRigs.length - keptRigs.length);   // never drop rigs silently
    setSelectedRigs(keptRigs);
  }

  // Auto-zero: if mfg system matches the source or sell hub's main station
  const leg1AutoZero = !!(systemId && HUB_SYSTEM_IDS[sourceMarket.id] === systemId);
  // Leg 1 is only truly "no haul" when the buy hub is Jita AND sits at the build system. For any other
  // buy hub the Leg 1 rates still price the materials that hub can't supply, which are imported from Jita.
  const leg1SaveZero = leg1AutoZero && sourceMarket.id === 10000002;
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
        leg1_haul_rate:    leg1SaveZero ? 0 : leg1Rate,
        leg2_haul_rate:    leg2AutoZero ? 0 : leg2Rate,
        // Phase 2
        leg1_method:          leg1SaveZero ? 'user_defined' : leg1Method,
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
        // Carry the derived fields forward so reopening the modal in the same session still
        // scales rig values by the system's security (the save response only returns {ok:true}).
        system_security:   systemSecurity,
        security_class:    securityClassOf(systemSecurity),
        invalid_rig_ids:   [],
        haul_enabled:      haulEnabled,
        leg1_haul_rate:    leg1SaveZero ? 0 : leg1Rate,
        leg2_haul_rate:    leg2AutoZero ? 0 : leg2Rate,
        leg1_method:       leg1SaveZero ? 'user_defined' : leg1Method,
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
  }, [canSave, token, systemId, systemName, systemSecurity, structureId, isNpc, selectedRigs,
      facilityTax, haulEnabled, leg1AutoZero, leg1SaveZero, leg2AutoZero,
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
            {droppedRigCount > 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-warning, #e8a838)', marginBottom: 6 }}>
                ⚠ {droppedRigCount} previously saved rig{droppedRigCount > 1 ? 's were' : ' was'} not valid in the
                current game data and {droppedRigCount > 1 ? 'were' : 'was'} removed. Re-select your rigs
                below, then save.
              </div>
            )}
            {sizeDroppedCount > 0 && (
              <div style={{ fontSize: 12, color: 'var(--color-warning, #e8a838)', marginBottom: 6 }}>
                ⚠ {sizeDroppedCount} selected rig{sizeDroppedCount > 1 ? "s don't" : " doesn't"} fit this
                structure&apos;s size and {sizeDroppedCount > 1 ? 'were' : 'was'} removed (a Raitaru takes
                M-Set rigs, an Azbel L-Set, a Sotiyo XL-Set).
              </div>
            )}
            {!isNpc && !secClass && systemId && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                ℹ This system&apos;s security isn&apos;t known — rig values are shown for highsec; nullsec and
                lowsec bonuses are larger.
              </div>
            )}
            {!isNpc && secClass && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                {systemName ?? 'This system'} is {SEC_CLASS_LABEL[secClass]}
                {typeof systemSecurity === 'number' ? ` (security ${systemSecurity.toFixed(1)})` : ''} — rig
                bonuses are scaled for it, as shown next to each rig. A rig only affects the item types it is built for.
              </div>
            )}
            {!isNpc && fitSuggestions.length > 0 && (
              <div style={{ border: '1px solid var(--color-border-medium)', borderRadius: 6,
                            padding: '8px 10px', marginBottom: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  Other FORGE pilots report this for {systemName ?? 'this system'}:
                </div>
                {fitSuggestions.slice(0, 3).map((s, i) => (
                  <div key={`${s.rig_ids.join('-')}-${i}`}
                       style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ flex: 1 }}>
                      {s.same_structure ? <strong>Your structure: </strong> : null}
                      {s.rig_names.map((n) => n.replace(/^Standup /, '')).join(' · ')}
                      <span style={{ opacity: 0.7 }}>
                        {' '}— {s.reports} pilot{s.reports > 1 ? 's' : ''}, {s.facility_tax}% tax
                      </span>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={!rigSize}
                      onClick={() => {
                        const allowed = new Set(
                          MANUFACTURING_RIGS.filter((r) => r.size === rigSize).map((r) => r.type_id)
                        );
                        setSelectedRigs(s.rig_ids.filter((id) => allowed.has(id)).slice(0, MAX_RIGS));
                        setFacilityTax(s.facility_tax);
                      }}
                    >
                      Use these
                    </button>
                  </div>
                ))}
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  Reported by other users — check it matches your structure before saving.
                </div>
              </div>
            )}
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
                          <span>
                            {rig.name}
                            {rigStatText(rig.type_id) && (
                              <span style={{ opacity: 0.65 }}> — {rigStatText(rig.type_id)}</span>
                            )}
                          </span>
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
            {jobCheck?.summary && jobCheck.summary.diff_pct !== null && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <strong>Install-cost check (your saved setup):</strong> your {jobCheck.summary.compared} running manufacturing
                job{jobCheck.summary.compared > 1 ? 's were' : ' was'} charged {fmtISK(jobCheck.summary.actual_total)} ISK;
                FORGE estimates {fmtISK(jobCheck.summary.predicted_total)} ISK
                ({jobCheck.summary.diff_pct > 0 ? '+' : ''}{jobCheck.summary.diff_pct.toFixed(1)}%).
                {Math.abs(jobCheck.summary.diff_pct) > 10 &&
                  ' A gap this large usually means the system, structure type or facility tax above does not match where you installed them.'}
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  The estimate uses today&apos;s system cost index; jobs paid the index in force when they were installed,
                  so small differences are normal.
                </div>
              </div>
            )}
          </div>

          {/* ── Haulage ───────────────────────────────────────────────────── */}
          <div className="settings-section" id="settings-haulage">
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

                  return (
                    <div key={leg} className="haul-leg">
                      <div className="haul-leg-label">
                        <span className="haul-leg-title">{isLeg1 ? 'Materials in' : 'Goods out'}</span>
                        <span className="haul-leg-route">{routeLabel}</span>
                      </div>
                      {isLeg1 && sourceMarket.id !== 10000002 && (
                        <div className="settings-label-sub" style={{ fontSize: 10, margin: '2px 0 4px' }}>
                          These rates also price any materials {sourceMarket.name} doesn&apos;t stock — they&apos;re imported from Jita
                          to {systemName ?? 'your build system'} and costed with the same method and rate.
                        </div>
                      )}

                      {(isLeg1 ? leg1SaveZero : autoZero) ? (
                        <div className="haul-leg-autozero">Same location — no haul needed · 0 ISK/m³</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <HaulMethodFields
                            characters={characters}
                            value={{ method, rate, iskPerJump: perJump, flatTotal, serviceLabel, collateral, selfCharId, selfShip, selfFuel }}
                            onChange={(p) => {
                              if (p.method       !== undefined) setMethod(p.method);
                              if (p.rate         !== undefined) setRate(p.rate);
                              if (p.iskPerJump   !== undefined) setPerJump(p.iskPerJump);
                              if (p.flatTotal    !== undefined) setFlat(p.flatTotal);
                              if (p.serviceLabel !== undefined) setLabel(p.serviceLabel);
                              if (p.collateral   !== undefined) setCol(p.collateral);
                              if (p.selfCharId   !== undefined) setSelfChar(p.selfCharId);
                              if (p.selfShip     !== undefined) setSelfShip(p.selfShip);
                              if (p.selfFuel     !== undefined) setSelfFuel(p.selfFuel);
                            }}
                          />
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
