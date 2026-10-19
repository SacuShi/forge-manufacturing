/**
 * useTickerPins — orchestrates all ticker pin state:
 *   • loads/saves config per-character from the server
 *   • polls /api/ticker-prices every 60 s for hub-specific pins
 *   • derives character-state slots (wallet, jobs) from app state
 *   • computes TickerSlotData (colour, direction, animation) for each pin
 *   • broadcasts the full payload via BroadcastChannel so the pop-out stays in sync
 */

import {
  useState, useEffect, useRef, useCallback, useContext, useMemo,
  createContext,
} from 'react';
import { apiGet, apiPost } from '../api/client';
import type {
  TickerPin, TickerPinType, TickerGroup, NewPinConfig,
  TickerSlotData, TickerBroadcastPayload,
  TickerColorClass, TickerAnimClass,
  ActiveJob,
} from '../types';

// ── helpers ───────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function compactISK(v: number | null): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${(v / 1e6).toFixed(0)}M`;
  if (abs >= 1e3)  return `${(v / 1e3).toFixed(0)}K`;
  return v.toFixed(0);
}

function compactISKPerHr(v: number | null): string {
  if (v === null) return '—';
  return compactISK(v) + '/hr';
}

/** margin values from the server are already percentages (e.g. 69.2 = 69.2%), not 0–1 fractions */
function fmtPct(v: number | null, decimals = 1): string {
  if (v === null) return '—';
  return `${v.toFixed(decimals)}%`;
}

function countdown(endDateStr: string | null, now: number): string {
  if (!endDateStr) return '';
  const diff = new Date(endDateStr).getTime() - now;
  if (diff <= 0) return 'completing';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0)   return `${h}h ${m}m`;
  return `${m}m`;
}

function msRemaining(endDateStr: string | null, now: number): number {
  if (!endDateStr) return Infinity;
  return new Date(endDateStr).getTime() - now;
}

function changePct(current: number | null, baseline: number | undefined): number | null {
  if (current === null || !baseline || baseline === 0) return null;
  return (current - baseline) / Math.abs(baseline);
}

function colorFromChange(pct: number | null): TickerColorClass {
  if (pct === null) return 'neutral';
  if (pct > 0.005) return 'green';
  if (pct < -0.005) return 'red';
  return 'neutral';
}

/** margin is already a percentage (e.g. 30 = 30%), not a 0–1 fraction */
function marginColor(margin: number | null): TickerColorClass {
  if (margin === null) return 'neutral';
  if (margin >= 30) return 'green';
  if (margin >= 15) return 'amber';
  return 'red';
}

function autoLabel(config: NewPinConfig): string {
  const hub = config.hubName ? ` @ ${config.hubName}` : '';
  switch (config.type) {
    case 'price_sell':      return `${config.itemName ?? 'Item'} sell${hub}`;
    case 'price_buy':       return `${config.itemName ?? 'Item'} buy${hub}`;
    case 'price_spread':    return `${config.itemName ?? 'Item'} spread${hub}`;
    case 'mfg_profit':      return `${config.itemName ?? 'Item'} profit (Gross)${hub}`;
    case 'mfg_margin':      return `${config.itemName ?? 'Item'} margin (Gross)${hub}`;
    case 'mfg_isk_hour':    return `${config.itemName ?? 'Item'} ISK/hr (Gross)${hub}`;
    case 'mfg_top_hub':     return `Top mfg (Gross)${hub}`;
    case 'trade_spread':    return `${config.itemName ?? 'Item'} trade${hub}`;
    case 'trade_top_hub':   return `Top trade${hub}`;
    case 'wallet':          return 'Wallet';
    case 'jobs_count':      return 'Jobs';
    case 'jobs_next':       return 'Next job';
    case 'jobs_free_slots': return 'Free slots';
    case 'pi_extractor':    return `${config.itemName ?? 'ECU'} expiry`;
    case 'pi_colony_isk':   return `${config.itemName ?? 'Colony'} ISK/day`;
    default:                return 'Pin';
  }
}

// ── server response type ──────────────────────────────────────────────────────

interface PriceResult {
  pinId: string;
  sell?: number | null;
  buy?: number | null;
  spreadPct?: number | null;
  profit?: number | null;
  margin?: number | null;
  iskPerHour?: number | null;
  itemName?: string | null;
  topTypeId?: number | null;
  error?: string;
}

// ── group colour palette ──────────────────────────────────────────────────────

const GROUP_COLORS = ['#00ff88', '#00eeff', '#ffbb00', '#c084fc', '#ff6644', '#ff2255'];
const DEFAULT_GROUP: TickerGroup = { id: 'default', name: 'Default', color: '#00ff88' };

// ── group operations bundle (used as a prop type in TickerBar/TickerSetup) ────

export interface GroupOps {
  groups:         TickerGroup[];
  activeGroupId:  string;
  setActiveGroup: (id: string) => void;
  addGroup:       () => void;
  removeGroup:    (id: string) => void;
  renameGroup:    (id: string, name: string) => void;
  movePin:        (pinId: string, targetGroupId: string) => void;
}

// ── context ───────────────────────────────────────────────────────────────────

export interface TickerContextValue {
  addPin:   (config: NewPinConfig) => void;
  removePin:(id: string) => void;
  isPinned: (type: TickerPinType, typeId?: number, regionId?: number) => boolean;
  pins:     TickerPin[]; // active group's pins (displayPins)
}

export const TickerContext = createContext<TickerContextValue>({
  addPin:    () => {},
  removePin: () => {},
  isPinned:  () => false,
  pins:      [],
});

export function useTickerContext(): TickerContextValue {
  return useContext(TickerContext);
}

// ── app-state input ───────────────────────────────────────────────────────────

export interface UseTickerPinsInput {
  token:        string | null;
  characterId:  number | null;
  walletISK:    number;
  activeJobs:   ActiveJob[];
  freeSlots:    number;
  itemNames:    Map<number, string>;
}

export interface UseTickerPinsOutput {
  pins:            TickerPin[];    // ALL pins (all groups)
  displayPins:     TickerPin[];    // active group's pins only (sorted)
  slots:           Record<string, TickerSlotData>;
  broadcastPayload: TickerBroadcastPayload;
  groupOps:        GroupOps;
  dualRow:         boolean;
  toggleDualRow:   () => void;
  addPin:          (config: NewPinConfig) => void;
  removePin:       (id: string) => void;
  reorderPins:     (ordered: TickerPin[]) => void;
  isPinned:        (type: TickerPinType, typeId?: number, regionId?: number) => boolean;
  setupOpen:       boolean;
  openSetup:       () => void;
  closeSetup:      () => void;
}

// ── main hook ─────────────────────────────────────────────────────────────────

export function useTickerPins(input: UseTickerPinsInput): UseTickerPinsOutput {
  const { token, characterId, walletISK, activeJobs, freeSlots, itemNames } = input;

  const [pins,          setPins]         = useState<TickerPin[]>([]);
  const [groups,        setGroups]       = useState<TickerGroup[]>([DEFAULT_GROUP]);
  const [activeGroupId, setActiveGroupId] = useState<string>('default');
  const [dualRow,       setDualRow]      = useState(false);
  const [slots,         setSlots]        = useState<Record<string, TickerSlotData>>({});
  const [now,           setNow]          = useState(Date.now);
  const [setupOpen,     setSetupOpen]    = useState(false);

  const flashKeysRef     = useRef<Record<string, number>>({});
  const prevValuesRef    = useRef<Record<string, number | null>>({});
  const channelRef       = useRef<BroadcastChannel | null>(null);
  const skipNextSaveRef  = useRef(false);
  // Stable ref so addPin/reorderPins don't need activeGroupId in dep array
  const activeGroupIdRef = useRef(activeGroupId);
  useEffect(() => { activeGroupIdRef.current = activeGroupId; }, [activeGroupId]);

  // Active group's pins, sorted — the ticker renders these in single-row mode
  const displayPins = useMemo(() =>
    pins
      .filter(p => p.groupId === activeGroupId)
      .sort((a, b) => a.order - b.order),
    [pins, activeGroupId]
  );

  // In dual-row mode the bar renders both group 0 and group 1, so slots must be
  // populated for both groups' pins — not just the active group.
  const pinsToSlot = useMemo(() => {
    if (!dualRow || groups.length < 2) return displayPins;
    const bothIds = new Set(groups.slice(0, 2).map(g => g.id));
    return pins
      .filter(p => bothIds.has(p.groupId))
      .sort((a, b) => a.order - b.order);
  }, [pins, groups, dualRow, displayPins]);

  // Live clock for countdown accuracy (30s)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // BroadcastChannel — send updates to pop-out
  useEffect(() => {
    const ch = new BroadcastChannel('forge-ticker');
    channelRef.current = ch;
    return () => { ch.close(); channelRef.current = null; };
  }, []);

  // ── Load config from server at login ────────────────────────────────────────
  // Deps include token so the load always races the auto-save when a new session starts,
  // ensuring skipNextSaveRef is set before the auto-save can fire with empty state.
  const loadedForRef = useRef<string>(''); // tracks "characterId:token" to avoid duplicate loads
  useEffect(() => {
    if (!token || !characterId) {
      // Clear dedup key on logout so the next login always fetches fresh config —
      // even if the same character logs back in within the token's TTL.
      loadedForRef.current = '';
      return;
    }
    const key = `${characterId}:${token}`;
    if (loadedForRef.current === key) return; // already loaded for this exact session
    loadedForRef.current = key;
    skipNextSaveRef.current = true; // suppress the auto-save that fires when token dep changes
    apiGet<{ pins: TickerPin[]; groups: TickerGroup[]; activeGroupId: string; dualRow?: boolean }>(
      '/api/ticker-config', token
    ).then(data => {
      skipNextSaveRef.current = true; // suppress the save that fires after setState
      const loaded = (data.pins ?? []).map(p => ({ ...p, groupId: p.groupId || 'default' }));
      setPins(loaded);
      setGroups(data.groups?.length ? data.groups : [DEFAULT_GROUP]);
      setActiveGroupId(data.activeGroupId || 'default');
      setDualRow(data.dualRow === true);
    }).catch(() => {});
  }, [token, characterId]);

  // ── Auto-save (debounced 1s) whenever config changes ────────────────────────
  useEffect(() => {
    if (!token || !characterId) return; // never save during auth transitions
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
    const t = setTimeout(() => {
      apiPost('/api/ticker-config', { pins, groups, activeGroupId, dualRow }, token).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  // characterId is deliberately not a dependency: a character switch must not re-save the previous
  // character's config under the new one (the load effect above handles the switch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, groups, activeGroupId, dualRow, token]);

  // ── Poll hub-specific pins (active group + second group in dual-row mode) ─────
  useEffect(() => {
    if (!token) return;
    const hubPins = pinsToSlot.filter(p =>
      ['price_sell','price_buy','price_spread','mfg_profit','mfg_margin',
       'mfg_isk_hour','mfg_top_hub','trade_spread','trade_top_hub'].includes(p.type)
    );
    if (hubPins.length === 0) return;

    const poll = async () => {
      const items = hubPins.map(p => ({ pinId: p.id, pinType: p.type, regionId: p.regionId, typeId: p.typeId }));
      try {
        const data = await apiPost<{ results: PriceResult[] }>('/api/ticker-prices', { items }, token);
        const byId = new Map(data.results.map(r => [r.pinId, r]));
        setSlots(prev => {
          const next = { ...prev };
          for (const pin of hubPins) {
            const r = byId.get(pin.id);
            if (!r || r.error) { next[pin.id] = { ...buildLoadingSlot(pin), loading: false, primaryText: '—' }; continue; }
            next[pin.id] = buildHubSlot(pin, r, now, flashKeysRef.current, prevValuesRef.current, itemNames);
          }
          return next;
        });
      } catch { /* non-fatal */ }
    };

    void poll(); // handles its own errors
    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinsToSlot, token, now]);

  // ── Derive character-state slots (active group + second group in dual-row mode)
  useEffect(() => {
    const charPins = pinsToSlot.filter(p =>
      ['wallet','jobs_count','jobs_next','jobs_free_slots','pi_extractor','pi_colony_isk'].includes(p.type)
    );
    if (charPins.length === 0) return;
    setSlots(prev => {
      const next = { ...prev };
      for (const pin of charPins) {
        next[pin.id] = buildCharSlot(pin, { walletISK, activeJobs, freeSlots }, now, flashKeysRef.current, prevValuesRef.current);
      }
      return next;
    });
  }, [pinsToSlot, walletISK, activeJobs, freeSlots, now]);

  // ── Broadcast active-group payload to pop-out ────────────────────────────────
  useEffect(() => {
    const payload: TickerBroadcastPayload = { pins: displayPins, slots };
    channelRef.current?.postMessage({ type: 'data', payload });
  }, [displayPins, slots]);

  // ── Pin management ───────────────────────────────────────────────────────────

  const addPin = useCallback((config: NewPinConfig) => {
    const gid = config.groupId ?? activeGroupIdRef.current;
    setPins(prev => {
      const groupPins = prev.filter(p => p.groupId === gid);
      const newPin: TickerPin = {
        id:            uuid(),
        type:          config.type,
        label:         config.label ?? autoLabel(config),
        groupId:       gid,
        regionId:      config.regionId,
        hubName:       config.hubName,
        typeId:        config.typeId,
        itemName:      config.itemName,
        expiryTime:    config.expiryTime,
        snapshotValue: config.snapshotValue,
        addedAt:       Date.now(),
        order:         groupPins.length,
      };
      return [...prev, newPin];
    });
  }, []);

  const removePin = useCallback((id: string) => {
    setPins(prev => prev.filter(p => p.id !== id));
    setSlots(prev => { const n = { ...prev }; delete n[id]; return n; });
  }, []);

  // Reorders the ACTIVE group's pins — called by TickerSetup with displayPins
  const reorderPins = useCallback((ordered: TickerPin[]) => {
    const gid = activeGroupIdRef.current;
    setPins(prev => {
      const others    = prev.filter(p => p.groupId !== gid);
      const reordered = ordered.map((p, i) => ({ ...p, order: i }));
      return [...others, ...reordered];
    });
  }, []);

  const isPinned = useCallback((type: TickerPinType, typeId?: number, regionId?: number): boolean => {
    return displayPins.some(p =>
      p.type === type &&
      (typeId   === undefined || p.typeId   === typeId) &&
      (regionId === undefined || p.regionId === regionId)
    );
  }, [displayPins]);

  // ── Group management ─────────────────────────────────────────────────────────

  const addGroup = useCallback(() => {
    setGroups(prev => {
      const color    = GROUP_COLORS[prev.length % GROUP_COLORS.length];
      const newGroup = { id: uuid(), name: 'New Layout', color };
      setActiveGroupId(newGroup.id);
      return [...prev, newGroup];
    });
  }, []);

  const removeGroup = useCallback((id: string) => {
    setGroups(prev => {
      if (prev.length <= 1) return prev;
      const remaining  = prev.filter(g => g.id !== id);
      const fallbackId = remaining[0]?.id ?? 'default';
      setActiveGroupId(ag => ag === id ? fallbackId : ag);
      setPins(pp => pp.map(p => p.groupId === id ? { ...p, groupId: fallbackId } : p));
      return remaining;
    });
  }, []);

  const renameGroup = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setGroups(prev => prev.map(g => g.id === id ? { ...g, name: trimmed } : g));
  }, []);

  const setActiveGroup = useCallback((id: string) => {
    setActiveGroupId(id);
  }, []);

  const movePin = useCallback((pinId: string, targetGroupId: string) => {
    setPins(prev => prev.map(p => p.id === pinId ? { ...p, groupId: targetGroupId } : p));
  }, []);

  const groupOps: GroupOps = {
    groups, activeGroupId,
    setActiveGroup, addGroup, removeGroup, renameGroup, movePin,
  };

  const toggleDualRow = useCallback(() => setDualRow(r => !r), []);

  const broadcastPayload: TickerBroadcastPayload = { pins: displayPins, slots };

  return {
    pins, displayPins, slots, broadcastPayload, groupOps,
    dualRow, toggleDualRow,
    addPin, removePin, reorderPins, isPinned,
    setupOpen, openSetup: () => setSetupOpen(true), closeSetup: () => setSetupOpen(false),
  };
}

// ── slot builders ─────────────────────────────────────────────────────────────

function buildLoadingSlot(pin: TickerPin): TickerSlotData {
  return {
    pinId: pin.id, primaryText: '…', loading: true,
    direction: null, changePct: null, colorClass: 'neutral', animClass: 'none', flashKey: 0,
  };
}

function flashKey(pinId: string, value: number | null, ref: Record<string, number>, prevRef: Record<string, number | null>): number {
  const prev = prevRef[pinId] ?? null;
  const k = ref[pinId] ?? 0;
  if (value !== null && prev !== null && Math.abs(value - prev) / Math.max(Math.abs(prev), 1) > 0.005) {
    ref[pinId] = k + 1;
  }
  prevRef[pinId] = value;
  return ref[pinId] ?? 0;
}

function buildHubSlot(
  pin: TickerPin,
  r: PriceResult,
  _now: number,
  flashKeys: Record<string, number>,
  prevValues: Record<string, number | null>,
  itemNames: Map<number, string>,
): TickerSlotData {
  const hub = pin.hubName ?? '';
  switch (pin.type) {

    case 'price_sell': {
      const v = r.sell ?? null;
      const cp = changePct(v, pin.baseline);
      const cc = colorFromChange(cp);
      return {
        pinId: pin.id,
        primaryText: compactISK(v),
        secondaryText: `sell @ ${hub}`,
        direction: cp !== null ? (cp > 0.005 ? 'up' : cp < -0.005 ? 'down' : 'stable') : null,
        changePct: cp,
        colorClass: cc,
        animClass: cc !== 'neutral' ? 'glow-once' : 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'price_buy': {
      const v = r.buy ?? null;
      const cp = changePct(v, pin.baseline);
      const cc = colorFromChange(cp);
      return {
        pinId: pin.id,
        primaryText: compactISK(v),
        secondaryText: `buy @ ${hub}`,
        direction: cp !== null ? (cp > 0.005 ? 'up' : cp < -0.005 ? 'down' : 'stable') : null,
        changePct: cp,
        colorClass: cc,
        animClass: cc !== 'neutral' ? 'glow-once' : 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'price_spread': {
      const spread = (r.sell && r.buy && r.sell > 0)
        ? ((r.sell - r.buy) / r.sell) * 100
        : null;
      const cp = changePct(spread, pin.baseline);
      const cc = spread !== null ? (spread >= 10 ? 'green' : spread >= 3 ? 'amber' : 'neutral') : 'neutral';
      return {
        pinId: pin.id,
        primaryText: spread !== null ? `${spread.toFixed(1)}%` : '—',
        secondaryText: `spread @ ${hub}`,
        direction: cp !== null ? (cp > 0 ? 'up' : 'down') : null,
        changePct: cp,
        colorClass: cc,
        animClass: 'none',
        flashKey: flashKey(pin.id, spread, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'mfg_profit': {
      const v = r.profit ?? null;
      const cp = changePct(v, pin.baseline);
      const cc = colorFromChange(cp);
      return {
        pinId: pin.id,
        primaryText: compactISK(v),
        secondaryText: `${pin.itemName ?? ''} (Gross) @ ${hub}`,
        direction: cp !== null ? (cp > 0.005 ? 'up' : cp < -0.005 ? 'down' : 'stable') : null,
        changePct: cp,
        colorClass: cc,
        animClass: cc !== 'neutral' ? 'glow-once' : 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'mfg_margin': {
      const v = r.margin ?? null;
      const cc = marginColor(v);
      const cp = changePct(v, pin.baseline);
      return {
        pinId: pin.id,
        primaryText: fmtPct(v),
        secondaryText: `${pin.itemName ?? ''} (Gross) @ ${hub}`,
        direction: cp !== null ? (cp > 0 ? 'up' : 'down') : null,
        changePct: cp,
        colorClass: cc,
        animClass: 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'mfg_isk_hour': {
      const v = r.iskPerHour ?? null;
      const cp = changePct(v, pin.baseline);
      const cc = colorFromChange(cp);
      return {
        pinId: pin.id,
        primaryText: compactISKPerHr(v),
        secondaryText: `${pin.itemName ?? ''} (Gross) @ ${hub}`,
        direction: cp !== null ? (cp > 0.005 ? 'up' : cp < -0.005 ? 'down' : 'stable') : null,
        changePct: cp,
        colorClass: cc,
        animClass: cc !== 'neutral' ? 'glow-once' : 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'mfg_top_hub': {
      const v = r.profit ?? null;
      const name = r.itemName ?? (r.topTypeId ? itemNames.get(r.topTypeId) ?? `#${r.topTypeId}` : '—');
      const cc = marginColor(r.margin ?? null);
      return {
        pinId: pin.id,
        primaryText: name,
        secondaryText: `${compactISK(v)} · ${fmtPct(r.margin ?? null)} (Gross) @ ${hub}`,
        direction: null,
        changePct: null,
        colorClass: cc,
        animClass: 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'trade_spread': {
      const v = r.spreadPct ?? null;
      const cc = v !== null ? (v >= 20 ? 'green' : v >= 8 ? 'amber' : 'neutral') : 'neutral';
      const cp = changePct(v, pin.baseline);
      return {
        pinId: pin.id,
        primaryText: v !== null ? `${v.toFixed(1)}%` : '—',
        secondaryText: `${pin.itemName ?? ''} trade @ ${hub}`,
        direction: cp !== null ? (cp > 0 ? 'up' : 'down') : null,
        changePct: cp,
        colorClass: cc,
        animClass: 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'trade_top_hub': {
      const v = r.spreadPct ?? null;
      const name = r.topTypeId ? itemNames.get(r.topTypeId) ?? `#${r.topTypeId}` : '—';
      const cc = v !== null ? (v >= 20 ? 'green' : v >= 8 ? 'amber' : 'neutral') : 'neutral';
      return {
        pinId: pin.id,
        primaryText: name,
        secondaryText: `${v !== null ? v.toFixed(1) + '%' : '—'} trade @ ${hub}`,
        direction: null,
        changePct: null,
        colorClass: cc,
        animClass: 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    default:
      return buildLoadingSlot(pin);
  }
}

interface CharState { walletISK: number; activeJobs: ActiveJob[]; freeSlots: number; }

function buildCharSlot(
  pin: TickerPin,
  state: CharState,
  now: number,
  flashKeys: Record<string, number>,
  prevValues: Record<string, number | null>,
): TickerSlotData {
  switch (pin.type) {

    case 'wallet': {
      const v = state.walletISK;
      const cp = changePct(v, pin.baseline);
      const cc = colorFromChange(cp);
      return {
        pinId: pin.id,
        primaryText: compactISK(v) + ' ISK',
        direction: cp !== null ? (cp > 0.005 ? 'up' : cp < -0.005 ? 'down' : 'stable') : null,
        changePct: cp,
        colorClass: cc,
        animClass: cc !== 'neutral' ? 'glow-once' : 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'jobs_count': {
      const active = state.activeJobs.filter(j => !j.done).length;
      return {
        pinId: pin.id,
        primaryText: `${active} active`,
        direction: null, changePct: null,
        colorClass: 'neutral', animClass: 'none',
        flashKey: flashKey(pin.id, active, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'jobs_next': {
      const pending = state.activeJobs
        .filter(j => !j.done && !!j.endDate)
        .sort((a, b) => new Date(a.endDate!).getTime() - new Date(b.endDate!).getTime());
      const next = pending[0] ?? null;
      const msLeft = next ? msRemaining(next.endDate ?? null, now) : Infinity;
      const colorClass: TickerColorClass =
        msLeft < 5 * 60_000   ? 'red'   :
        msLeft < 30 * 60_000  ? 'amber' : 'neutral';
      const animClass: TickerAnimClass =
        msLeft < 5 * 60_000   ? 'flash-fast' :
        msLeft < 30 * 60_000  ? 'pulse-slow' : 'none';
      return {
        pinId: pin.id,
        primaryText: next?.name ?? '—',
        secondaryText: next ? countdown(next.endDate ?? null, now) : undefined,
        direction: null, changePct: null,
        colorClass, animClass,
        flashKey: 0, loading: false,
      };
    }

    case 'jobs_free_slots': {
      const v = state.freeSlots;
      const cc: TickerColorClass = v > 0 ? 'green' : 'amber';
      return {
        pinId: pin.id,
        primaryText: `${v} free`,
        direction: null, changePct: null,
        colorClass: cc, animClass: 'none',
        flashKey: flashKey(pin.id, v, flashKeys, prevValues),
        loading: false,
      };
    }

    case 'pi_extractor': {
      const msLeft = pin.expiryTime ? msRemaining(pin.expiryTime, now) : Infinity;
      const expired = msLeft <= 0;
      const colorClass: TickerColorClass =
        expired               ? 'red'   :
        msLeft < 3_600_000    ? 'red'   :
        msLeft < 12_600_000   ? 'amber' : 'green'; // <1h red, <3.5h amber, ok green
      const animClass: TickerAnimClass =
        msLeft < 3_600_000 && !expired ? 'pulse-slow' :
        expired                        ? 'flash-fast' : 'none';
      return {
        pinId: pin.id,
        primaryText: expired ? '⚠ EXPIRED' : countdown(pin.expiryTime ?? null, now),
        secondaryText: pin.itemName ?? undefined,
        direction: null, changePct: null,
        colorClass, animClass,
        flashKey: 0, loading: false,
      };
    }

    case 'pi_colony_isk': {
      const v = pin.snapshotValue ?? null;
      const cc: TickerColorClass = v !== null && v > 0 ? 'green' : 'neutral';
      return {
        pinId: pin.id,
        primaryText: compactISK(v) + '/day',
        secondaryText: pin.itemName ?? undefined,
        direction: null, changePct: null,
        colorClass: cc, animClass: 'none',
        flashKey: 0, loading: false,
      };
    }

    default:
      return buildLoadingSlot(pin);
  }
}

// ── Dummy setter export so TickerContext can be provided without the full hook ──
