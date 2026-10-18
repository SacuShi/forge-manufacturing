/**
 * FORGE — MainContent
 *
 * The central pane of the app. Renders one of 13 tabs depending on which nav item
 * the user has selected in the LeftSidebar:
 *
 *   market      — Market Opportunities: ranked list of items to manufacture for profit
 *   blueprints  — My Blueprints: the user's owned BPOs/BPCs with per-blueprint profit metrics
 *   research    — Research ROI: blueprints worth researching to higher ME/TE levels
 *   assets      — My Assets: everything in the character's hangars
 *   jobs        — Active Jobs: manufacturing/research jobs currently running
 *   queue       — Queue Planner: builds a job queue across all characters' spare slots
 *   pi          — PI Colonies: Planetary Industry colonies across all characters
 *   piplanner   — PI Planner: recommends which planet in a region to use for a PI chain
 *   corp        — Corp: corporation-level blueprints and assets (Director access required)
 *   trading     — Station Trading: live buy/sell order management
 *   interhub    — Inter-Hub Arb: items priced differently at different trade hubs
 *   lpstore     — LP Store: converts Loyalty Points earned from NPC corps into ISK
 *   help        — Guide
 *
 * All data comes from App.tsx as props — this component owns display state only
 * (sort order, search text, filter selections). It never fetches auth-gated data
 * directly; the only fetches here are for blueprint metadata (icons + meta level)
 * and blueprint profitability (ISK/hr, margin), which are not user-sensitive.
 *
 * GLOSSARY (for readers who don't play EVE)
 * ──────────────────────────────────────────
 *   BPO / BPC   — Blueprint Original / Blueprint Copy. Originals last forever;
 *                 copies have a fixed number of uses (runs). BPOs are far more
 *                 valuable and usually take months to earn or hundreds of billions
 *                 of ISK to buy.
 *   PI          — Planetary Industry. Characters can place extractors and factories
 *                 on planets to harvest raw materials and process them into
 *                 manufactured goods (P0 → P1 → P2 → P3 → P4).
 *   LP          — Loyalty Points. Earned by running NPC missions. Spent in the LP
 *                 store to buy exclusive items (faction ships, implants, etc.).
 *   ISK/hr      — ISK per hour: the key profitability metric. Accounts for both
 *                 margin and how quickly a job completes.
 */

import { useState, useMemo, useEffect, type FC } from 'react';
import { findAssetSafetyItemIds, ASSET_SAFETY_LOCATION_ID, ASSET_SAFETY_WRAP_TYPE_ID } from '../utils/assetSafety';
import type {
  MarketItem,
  SortField,
  SortDirection,
  EsiBlueprint,
  EsiAsset,
  ActiveJob,
  CorpStatus,
  CorpAccessStatus,
  QueueCharacter,
  PiCharacter,
  InterHubArbRow,
  BlueprintProfit,
} from '../types';
import CorpTab      from './CorpTab';
import ResearchTab  from './ResearchTab';
import PiTab           from './PiTab';
import PiPlannerTab    from './PiPlannerTab';
import QueuePlannerTab from './QueuePlannerTab';
import TradingTab      from './TradingTab';
import InterHubTab     from './InterHubTab';
import LPStoreTab      from './LPStoreTab';
import {
  IconMarket, IconBlueprint, IconResearch, IconAssets, IconJobs,
  IconQueue, IconPI, IconPIPlanner, IconCorp, IconTrading, IconInterhub, IconLPStore, IconHelp,
  IconAppraise,
} from './NavIcons';
import HelpTab from './HelpTab';
import AppraisalTab from './AppraisalTab';
import { useLocationNames } from '../hooks/useLocationNames';
import JobsTabView from './JobsTabView';
import AssetsTabView from './AssetsTabView';
import BlueprintsTabView from './BlueprintsTabView';
import MarketTabView from './MarketTabView';

type BpSortField = 'name' | 'iskPerHour' | 'margin' | 'profit' | 'level';

// ── Types ────────────────────────────────────────────────────────────────────

interface MainContentProps {
  activeTab: string;
  onTabChange: (tab: string) => void;

  // Market tab
  marketItems: MarketItem[];
  marketLoading: boolean;
  marketError: string | null;
  selectedTypeId: number | null;
  /** Called when a market table row is clicked — only passes typeId */
  onMarketSelect: (typeId: number) => void;
  onLoadMoreMarket?: () => void;
  marketLoadingMore?: boolean;
  marketHasMore?: boolean;
  /** v1.7 — show Haul/unit column when true (haulage configured in industry settings) */
  haulConfigured?: boolean;
  /** Controlled search query — parent handles the server-side search */
  marketSearchQuery: string;
  marketSearching: boolean;
  onMarketSearch: (query: string) => void;

  // Blueprints/Assets/Jobs tabs
  blueprints: EsiBlueprint[];
  assets: EsiAsset[];
  /** Raw per-item assets (with real location_ids) — used by the Assets tab */
  rawAssets?: EsiAsset[];
  /** Blueprints locked in Asset Safety (left out of the list above) */
  safetyBlueprintCount?: number;
  activeJobs: ActiveJob[];
  itemNames: Map<number, string>;
  /** v1.33.0 — combined wallet ISK across in-scope characters, for the "✓ Can Build Now" pill */
  walletISK: number;

  /** Called when any item is selected (typeId + name) — opens RightSidebar */
  onSelectItem: (typeId: number, name: string) => void;
  /** Called when an item is selected from the inter-hub tab — carries the full arb row */
  onSelectArbItem?: (typeId: number, name: string, row: InterHubArbRow) => void;

  /** v1.35.0 — inter-hub haul config panel props */
  haulConfigOpen?:        boolean;
  onHaulConfigOpen?:      () => void;
  onHaulConfigClose?:     () => void;
  interHubToken?:         string;
  interHubCharacters?:    Array<{ characterId: number; name: string; skills: Array<{ skill_id: number; active_skill_level: number }> }>;
  onInterHubHaulSaved?:   () => void;

  /** v1.11 — selected market hub region id (drives Research ROI material prices) */
  regionId: number;
  /** "Buy In" hub — Queue Planner prices materials (per-recommendation cost + shortfall) here, not at regionId (the "Sell At" hub) */
  materialRegionId: number;
  /** Opens Mfg Setup (optionally scrolled to a section) — the planner's haulage notice links to it */
  onOpenSettings?: (section?: 'haulage') => void;
  /** Haulage is on AND Leg 1 has a rate/method, i.e. Jita imports can be costed (not the same as the Haul column flag) */
  importHaulConfigured?: boolean;

  // v1.4.0 — Corp tab props
  token:            string | null;
  /** All logged-in characters for the PI tab, pre-filtered by the selected character view */
  piCharacters?: PiCharacter[];
  /** Per-character slot summaries for Queue Planner, pre-filtered by the selected character view */
  queueCharacters?: QueueCharacter[];
  /** Always the primary character's auth token — used by Queue Planner regardless of which character is selected */
  primaryToken?: string | null;
  /** LP point balances loaded at login time — passed to LP Store tab */
  lpPoints?: import('../types').LPPoint[];
  corpStatus:       CorpStatus | null;
  accessStatus:     CorpAccessStatus | null;
  corpDataLoading?: boolean;
  /** v1.5 — item_id → character name; populated when alts are loaded; empty = no badges */
  blueprintOwnerMap?: Map<number, string>;
  /** Whether the primary character has docking rights at C-J6MT Keepstar. Defaults true (fail-open). */
  canDockKeestar?: boolean;
  /** Blueprint typeId → { metaLevel, productTypeId } — fetched at login time in App.tsx */
  bpMetadataProp?: Record<number, { metaLevel: number; productTypeId: number | null }>;
}

// Stable empty map used as the default for blueprintOwnerMap.
// Using `new Map()` inline as a default parameter creates a new reference on every
// render, which would invalidate any memo or effect that lists it as a dependency.
const EMPTY_BP_OWNER_MAP = new Map<number, string>();

// ── Constants ────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'help',       Icon: IconHelp,      label: 'Guide' },
  { key: 'market',     Icon: IconMarket,    label: 'Market Opportunities' },
  { key: 'blueprints', Icon: IconBlueprint, label: 'Your Blueprints' },
  { key: 'research',   Icon: IconResearch,  label: 'Research ROI' },
  { key: 'assets',     Icon: IconAssets,    label: 'Assets' },
  { key: 'appraise',   Icon: IconAppraise,  label: 'Appraise' },
  { key: 'jobs',       Icon: IconJobs,      label: 'Jobs' },
  { key: 'queue',      Icon: IconQueue,     label: 'Queue Planner' },
  { key: 'pi',         Icon: IconPI,        label: 'PI Colonies' },
  { key: 'piplanner',  Icon: IconPIPlanner, label: 'PI Planner' },
  { key: 'corp',       Icon: IconCorp,      label: 'Corp' },
  { key: 'trading',    Icon: IconTrading,   label: 'Station Trading' },
  { key: 'interhub',   Icon: IconInterhub,  label: 'Inter-Hub Arb' },
  { key: 'lpstore',    Icon: IconLPStore,   label: 'LP Store' },
];

// ── Component ────────────────────────────────────────────────────────────────

const MainContent: FC<MainContentProps> = ({
  activeTab,
  onTabChange,
  marketItems,
  marketLoading,
  marketError,
  selectedTypeId,
  onMarketSelect,
  onLoadMoreMarket,
  marketLoadingMore,
  marketHasMore,
  haulConfigured = false,
  blueprints,
  assets,
  rawAssets = [],
  safetyBlueprintCount = 0,
  activeJobs,
  itemNames,
  walletISK,
  onSelectItem,
  onSelectArbItem,
  regionId,
  materialRegionId,
  onOpenSettings,
  importHaulConfigured,
  haulConfigOpen       = false,
  onHaulConfigOpen,
  onHaulConfigClose    = () => {},
  interHubToken        = '',
  interHubCharacters   = [],
  onInterHubHaulSaved,
  marketSearchQuery,
  marketSearching,
  onMarketSearch,
  token,
  corpStatus,
  accessStatus,
  corpDataLoading,
  blueprintOwnerMap = EMPTY_BP_OWNER_MAP,
  piCharacters      = [],
  queueCharacters   = [],
  primaryToken      = null,
  lpPoints          = [],
  canDockKeestar    = true,
  bpMetadataProp    = {},
}) => {
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [filterOwned, setFilterOwned] = useState<string>('all');
  const [bpSearch, setBpSearch] = useState('');
  const [bpFilter, setBpFilter] = useState<'all' | 'bpo' | 'bpc'>('all');
  // App.tsx fetches blueprint metadata at login and passes it down as bpMetadataProp.
  // Do NOT maintain a local fallback fetch — that caused a duplicate /api/blueprint-metadata
  // POST every time MainContent mounted, racing the App.tsx request.
  const bpMetadata = bpMetadataProp;
  // v1.15.0 — My Blueprints profitability + sorting (mirrors Market Opportunities)
  const [bpProfits, setBpProfits] = useState<Record<number, BlueprintProfit>>({});
  const [bpSort,    setBpSort]    = useState<BpSortField>('iskPerHour');
  const [bpSortDir, setBpSortDir] = useState<'asc' | 'desc'>('desc');
  // v1.33.0 — "Can Build Now" filter: owned materials + wallet ISK cover the shortfall
  const [bpBuildableOnly, setBpBuildableOnly] = useState(false);
  const [assetSearch,      setAssetSearch]      = useState('');
  // Items locked in Asset Safety are hidden by default (they can't be used); the pill shows them.
  const [hideAssetSafety,  setHideAssetSafety]  = useState(true);
  const [assetSort,        setAssetSort]        = useState<'qty' | 'name' | 'location'>('location');
  const [assetSortDir,     setAssetSortDir]     = useState<1 | -1>(1);
  // Tracks which location sections the user has opened. Empty = all collapsed (default).
  const [expandedLocs,     setExpandedLocs]     = useState<Set<number>>(new Set());
  // Multi-select export (Ctrl+click / Shift+click rows, then appraise)
  const [assetExportSet,   setAssetExportSet]   = useState<Set<string>>(new Set());
  const [lastExportIdx,    setLastExportIdx]     = useState<number | null>(null);
  // Items sent to the Appraise tab
  const [appraisalItems,   setAppraisalItems]   = useState<Array<{ typeId: number; name: string; qty: number }>>([]);

  const getBpName = (typeId: number) =>
    itemNames.get(typeId) ?? `Blueprint #${typeId}`;

  // Fallback name-based lookup for LP BPCs not in the blueprints DB table.
  // Used only when bpMetadata doesn't supply a productTypeId.
  const nameToTypeId = useMemo(() => {
    const m = new Map<string, number>();
    itemNames.forEach((name, id) => m.set(name.toLowerCase(), id));
    return m;
  }, [itemNames]);

  const getProductTypeIdByName = (bpTypeId: number): number | null => {
    const bpName = itemNames.get(bpTypeId);
    if (!bpName) return null;
    const productName = bpName.replace(/ Blueprint$/i, '').toLowerCase();
    return nameToTypeId.get(productName) ?? null;
  };

  const activityLabel = (id: number | undefined): string => {
    switch (id) {
      case 1:  return 'Mfg';
      case 3:  return 'TE Research';
      case 4:  return 'ME Research';
      case 5:  return 'Copying';
      case 8:  return 'Invention';
      case 9:  return 'Reaction';
      case 11: return 'Rev.Eng';
      default: return '';
    }
  };


  // v1.15.0 — fetch per-blueprint profitability for the selected hub (same source
  // as Market Opportunities). Refetches when the blueprint set or hub changes.
  // v1.33.2 — if the server's canBuildDataWarm meta flag is false (price cache was
  // cold), silently retry once after 15s so the "Can Build Now" pill self-heals
  // once the background warm finishes, same pattern as useTrueCost's prices_warm.
  useEffect(() => {
    if (!blueprints || blueprints.length === 0) { setBpProfits({}); return; }
    const typeIds = [...new Set(blueprints.map(b => b.type_id))];
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const load = (silent = false) => {
      fetch('/api/blueprint-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprintTypeIds: typeIds, regionId, assets, walletISK }),
      })
        .then(res => res.json())
        .then((data: Record<string, unknown> & { _meta?: { canBuildDataWarm?: boolean } }) => {
          if (cancelled) return;
          const { _meta, ...profits } = data || {};
          setBpProfits(profits as Record<number, BlueprintProfit>);
          if (!silent && _meta && _meta.canBuildDataWarm === false) {
            retryTimer = setTimeout(() => load(true), 15_000);
          }
        })
        .catch(err => console.error('Failed to load blueprint profits:', err));
    };
    load();

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [blueprints, regionId, assets, walletISK]);

  const handleBpSort = (field: BpSortField) => {
    if (field === bpSort) {
      setBpSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setBpSort(field);
      setBpSortDir(field === 'name' ? 'asc' : 'desc');
    }
  };

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'rank' ? 'asc' : 'desc');
    }
  };

  const displayItems = useMemo<MarketItem[]>(() => {
    let list = [...marketItems];

    // Ownership pill filter (still applied on top of search results)
    if (filterOwned === 'can-build') {
      list = list.filter((i) => i.canBuild);
    } else if (filterOwned === 'BPO' || filterOwned === 'BPC') {
      list = list.filter((i) => i.owned === filterOwned);
    }

    list.sort((a, b) => {
      // Coerce null/undefined (e.g. un-enriched avgDailyVolume) to -Infinity so
      // those rows always sink to the bottom regardless of sort direction.
      const aRaw = a[sortField as keyof MarketItem] as number | null | undefined;
      const bRaw = b[sortField as keyof MarketItem] as number | null | undefined;
      const aVal = aRaw == null ? -Infinity : aRaw;
      const bVal = bRaw == null ? -Infinity : bRaw;
      return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return list;
  }, [marketItems, filterOwned, sortField, sortDirection]);

  // BPO = runs===-1, BPC = runs>=0
  const groupedBps = useMemo(() => {
    const q = bpSearch.trim().toLowerCase();

    // Step 1 — type filter (all / bpo / bpc)
    const filtered = blueprints.filter((b) => {
      const isBpo = b.runs === -1;
      if (bpFilter === 'bpo') return isBpo;
      if (bpFilter === 'bpc') return !isBpo;
      return true;
    });

    // Step 2 — group by type_id
    const groups = new Map<number, typeof blueprints>();
    filtered.forEach((b) => {
      const arr = groups.get(b.type_id);
      if (arr) arr.push(b);
      else groups.set(b.type_id, [b]);
    });

    // Step 3 — name search + "Can Build Now" filter (owned materials + wallet ISK)
    const entries = Array.from(groups.entries()).filter(([typeId]) => {
      if (q && !getBpName(typeId).toLowerCase().includes(q)) return false;
      if (bpBuildableOnly && !bpProfits[typeId]?.canBuildNow) return false;
      return true;
    });

    // Step 4 — sort. Name = alphabetical; metric sorts use /api/blueprint-profits
    // values, with blueprints lacking market data pushed to the end.
    const dir = bpSortDir === 'asc' ? 1 : -1;
    const metric = (typeId: number): number | null => {
      const p = bpProfits[typeId];
      if (!p) return null;
      return bpSort === 'margin' ? p.margin
           : bpSort === 'profit' ? p.profit
           : p.iskPerHour;
    };
    entries.sort(([a], [b]) => {
      if (bpSort === 'name') return dir * getBpName(a).localeCompare(getBpName(b));
      if (bpSort === 'level') {
        const la = bpMetadata[a]?.metaLevel ?? 0;
        const lb = bpMetadata[b]?.metaLevel ?? 0;
        return la !== lb
          ? (la - lb) * dir
          : getBpName(a).localeCompare(getBpName(b));
      }
      const va = metric(a), vb = metric(b);
      if (va == null && vb == null) return getBpName(a).localeCompare(getBpName(b));
      if (va == null) return 1;   // no-data always last
      if (vb == null) return -1;
      return va === vb ? getBpName(a).localeCompare(getBpName(b)) : (va - vb) * dir;
    });
    return entries;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprints, bpSearch, bpFilter, bpBuildableOnly, itemNames, bpProfits, bpMetadata, bpSort, bpSortDir]);

  // Items in Asset Safety wraps (kept out of every calculation; shown only when the pill is off).
  const safetyIds = useMemo(() => findAssetSafetyItemIds(rawAssets), [rawAssets]);

  const assetGroups = useMemo(() => {
    // Map each item_id → its direct location_id so we can walk the parent chain.
    // Items inside ships/containers have location_id = the ship/container's item_id.
    // We walk up until we reach an ID that is NOT another asset's item_id —
    // that will be the actual station or structure.
    const itemToLocation = new Map<number, number>();
    rawAssets.forEach((a) => itemToLocation.set(a.item_id, a.location_id));

    function resolveStation(locationId: number): number {
      const visited = new Set<number>();
      let cur = locationId;
      while (itemToLocation.has(cur) && !visited.has(cur)) {
        visited.add(cur);
        cur = itemToLocation.get(cur)!;
      }
      return cur;
    }

    const g = new Map<string, { name: string; qty: number; typeId: number; locationId: number }>();
    rawAssets.forEach((a) => {
      const name       = itemNames.get(a.type_id) ?? `Item #${a.type_id}`;
      // The wrap container itself is just the box: only what is inside it is listed.
      if (a.type_id === ASSET_SAFETY_WRAP_TYPE_ID) return;
      const inSafety   = safetyIds.has(a.item_id);
      if (inSafety && hideAssetSafety) return;                  // the pill: view assets WITHOUT Asset Safety
      let locationId   = resolveStation(a.location_id);
      // Skip items whose resolved location is 0 (no real location data)
      if (!locationId) return;
      // Asset Safety items are grouped apart from the same station's usable items (negative id = "locked in a wrap
      // at |id|"; -2004 = not yet delivered anywhere), so they can never be mistaken for, or merged with, usable stock.
      if (inSafety) locationId = -locationId;
      const key  = `${a.type_id}:${locationId}`;
      const prev = g.get(key);
      if (prev) {
        prev.qty += a.quantity;
      } else {
        g.set(key, { name, qty: a.quantity, typeId: a.type_id, locationId });
      }
    });
    return Array.from(g.values())
      .filter(({ name }) =>
        !assetSearch || name.toLowerCase().includes(assetSearch.toLowerCase())
      );
  }, [rawAssets, itemNames, assetSearch, safetyIds, hideAssetSafety]);

  const assetLocationIds = useMemo(
    () => [...new Set(assetGroups.map((g) => Math.abs(g.locationId)).filter((id) => id !== ASSET_SAFETY_LOCATION_ID))],
    [assetGroups],
  );
  const locationNames = useLocationNames(assetLocationIds, primaryToken);

  // Header text for a location group; Asset Safety groups say what they are.
  const locationLabelFor = (id: number): string | undefined => {
    if (id >= 0) return locationNames.get(id);
    const base = -id;
    if (base === ASSET_SAFETY_LOCATION_ID) return 'Asset Safety — not yet delivered to a station';
    const place = locationNames.get(base);
    return place ? `${place} · Asset Safety wrap (locked)` : undefined;
  };

  const safetyWrapCount = useMemo(() => rawAssets.filter((a) => a.type_id === ASSET_SAFETY_WRAP_TYPE_ID).length, [rawAssets]);

  // What is locked in Asset Safety (independent of the pill and the search box): drives the fee panel.
  const safetyHoldings = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of rawAssets) {
      if (a.type_id === ASSET_SAFETY_WRAP_TYPE_ID || !safetyIds.has(a.item_id)) continue;
      m.set(a.type_id, (m.get(a.type_id) ?? 0) + a.quantity);
    }
    return [...m.entries()].map(([typeId, qty]) => ({ typeId, qty }));
  }, [rawAssets, safetyIds]);

  // Blueprints and formulas aren't sold on the market (they trade by contract), so they can't be valued at a Jita price.
  const isBlueprintName = (typeId: number) => /(blueprint|formula)$/i.test(itemNames.get(typeId) ?? '');
  const safetyValuable  = useMemo(() => safetyHoldings.filter((h) => !isBlueprintName(h.typeId)), [safetyHoldings, itemNames]); // eslint-disable-line react-hooks/exhaustive-deps
  const safetyUnvaluedTypes = safetyHoldings.length - safetyValuable.length;

  // BPO/BPC lookup — built from the full blueprints list (quantity === -1 → BPO).
  // Used by the Assets tab to pick the correct CCP icon variant per item.
  const bpoTypeIds = useMemo(
    () => new Set(blueprints.filter((b) => b.quantity === -1).map((b) => b.type_id)),
    [blueprints],
  );
  const bpcTypeIds = useMemo(
    () => new Set(blueprints.filter((b) => b.quantity !== -1).map((b) => b.type_id)),
    [blueprints],
  );

  // Group the flat assetGroups list into per-location buckets for the collapsed view
  type AssetGroup = (typeof assetGroups)[number];
  const locationGroups = useMemo(() => {
    const map = new Map<number, { locationId: number; items: AssetGroup[] }>();
    for (const item of assetGroups) {
      const bucket = map.get(item.locationId);
      if (bucket) bucket.items.push(item);
      else map.set(item.locationId, { locationId: item.locationId, items: [item] });
    }
    return Array.from(map.values());
  }, [assetGroups]);

  // Fast key→{name,qty,typeId} lookup used by the appraise function
  const assetItemMap = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; typeId: number }>();
    for (const item of assetGroups) {
      map.set(`${item.typeId}:${item.locationId}`, { name: item.name, qty: item.qty, typeId: item.typeId });
    }
    return map;
  }, [assetGroups]);

  // Flat list of visible item keys in render order — used for Shift+click range selection.
  // Mirrors the sort logic in the render loop exactly.
  const visibleItemKeys = useMemo(() => {
    const keys: string[] = [];
    const sorted = [...locationGroups].sort((a, b) => {
      if (assetSort === 'qty') {
        const qa = a.items.reduce((s, it) => s + it.qty, 0);
        const qb = b.items.reduce((s, it) => s + it.qty, 0);
        return (qa - qb) * assetSortDir;
      }
      const la = locationLabelFor(a.locationId) ?? '';
      const lb = locationLabelFor(b.locationId) ?? '';
      return la.localeCompare(lb) * (assetSort === 'name' ? 1 : assetSortDir);
    });
    for (const { locationId, items } of sorted) {
      if (!expandedLocs.has(locationId)) continue;
      const sortedItems = assetSort === 'name'
        ? [...items].sort((a, b) => a.name.localeCompare(b.name) * assetSortDir)
        : [...items].sort((a, b) => b.qty - a.qty);
      for (const item of sortedItems) {
        keys.push(`${item.typeId}:${locationId}`);
      }
    }
    return keys;
  }, [locationGroups, expandedLocs, assetSort, assetSortDir, locationNames]);

  const sendToAppraise = () => {
    const agg = new Map<number, { name: string; qty: number }>();
    for (const key of assetExportSet) {
      const item = assetItemMap.get(key);
      if (!item) continue;
      const prev = agg.get(item.typeId);
      if (prev) prev.qty += item.qty;
      else agg.set(item.typeId, { name: item.name, qty: item.qty });
    }
    setAppraisalItems([...agg.entries()].map(([typeId, { name, qty }]) => ({ typeId, name, qty })));
    onTabChange('appraise');
  };

  return (
    <main className="main-content" aria-label="Manufacturing data">

      <div className="main-tabs" role="tablist" aria-label="Content area tabs">
        {TABS.map(({ key, Icon, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            className={`main-tab${activeTab === key ? ' active' : ''}`}
            aria-selected={activeTab === key}
            onClick={() => onTabChange(key)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Icon />
            {label}
          </button>
        ))}
      </div>

      <MarketTabView activeTab={activeTab} displayItems={displayItems} filterOwned={filterOwned} handleSort={handleSort} haulConfigured={haulConfigured} marketError={marketError} marketHasMore={marketHasMore} marketItems={marketItems} marketLoading={marketLoading} marketLoadingMore={marketLoadingMore} marketSearching={marketSearching} marketSearchQuery={marketSearchQuery} onLoadMoreMarket={onLoadMoreMarket} onMarketSearch={onMarketSearch} onMarketSelect={onMarketSelect} regionId={regionId} selectedTypeId={selectedTypeId} setFilterOwned={setFilterOwned} sortDirection={sortDirection} sortField={sortField} />

      <BlueprintsTabView activeTab={activeTab} blueprintOwnerMap={blueprintOwnerMap} blueprints={blueprints} bpBuildableOnly={bpBuildableOnly} bpFilter={bpFilter} bpMetadata={bpMetadata} bpProfits={bpProfits} bpSearch={bpSearch} bpSort={bpSort} bpSortDir={bpSortDir} getBpName={getBpName} getProductTypeIdByName={getProductTypeIdByName} groupedBps={groupedBps} handleBpSort={handleBpSort} onSelectItem={onSelectItem} safetyBlueprintCount={safetyBlueprintCount} selectedTypeId={selectedTypeId} setBpBuildableOnly={setBpBuildableOnly} setBpFilter={setBpFilter} setBpSearch={setBpSearch} />

      <AssetsTabView activeTab={activeTab} assetExportSet={assetExportSet} assetSearch={assetSearch} assetSort={assetSort} assetSortDir={assetSortDir} bpcTypeIds={bpcTypeIds} bpoTypeIds={bpoTypeIds} expandedLocs={expandedLocs} hideAssetSafety={hideAssetSafety} lastExportIdx={lastExportIdx} locationGroups={locationGroups} locationLabelFor={locationLabelFor} onSelectItem={onSelectItem} rawAssets={rawAssets} safetyHoldings={safetyHoldings} safetyUnvaluedTypes={safetyUnvaluedTypes} safetyValuable={safetyValuable} safetyWrapCount={safetyWrapCount} sendToAppraise={sendToAppraise} setAssetExportSet={setAssetExportSet} setAssetSearch={setAssetSearch} setAssetSort={setAssetSort} setAssetSortDir={setAssetSortDir} setExpandedLocs={setExpandedLocs} setHideAssetSafety={setHideAssetSafety} setLastExportIdx={setLastExportIdx} visibleItemKeys={visibleItemKeys} />

      {/* Item Appraisal */}
      {activeTab === 'appraise' && (
        <div className="main-panel">
          <AppraisalTab seedItems={appraisalItems} canDockKeestar={canDockKeestar} />
        </div>
      )}

      <JobsTabView activeJobs={activeJobs} activeTab={activeTab} activityLabel={activityLabel} onSelectItem={onSelectItem} selectedTypeId={selectedTypeId} />

      {/* v1.11.0 — ME Research ROI tab */}
      {activeTab === 'research' && (
        <ResearchTab
          blueprints={blueprints}
          regionId={regionId}
          onSelectItem={onSelectItem}
          selectedTypeId={selectedTypeId}
        />
      )}

      {/* Queue Planner tab */}
      {activeTab === 'queue' && (
        <QueuePlannerTab
          queueCharacters={queueCharacters}
          primaryToken={primaryToken}
          regionId={regionId}
          materialRegionId={materialRegionId}
          onSelectItem={onSelectItem}
          onOpenSettings={onOpenSettings}
          haulConfigured={importHaulConfigured}
        />
      )}

      {/* v1.25.0 — PI Colonies tab */}
      {activeTab === 'pi' && (
        <PiTab piCharacters={piCharacters} />
      )}

      {/* PI Planner — recommends system/planet layout for a target PI chain */}
      {activeTab === 'piplanner' && (
        <PiPlannerTab />
      )}

      {/* v1.4.0 — Corp tab */}
      {activeTab === 'corp' && (
        <CorpTab
          token={token}
          corpStatus={corpStatus}
          accessStatus={accessStatus}
          corpDataLoading={corpDataLoading}
          regionId={regionId}
          onSelectItem={onSelectItem}
        />
      )}

      {/* v1.27.0 — Station Trading tab */}
      {activeTab === 'trading' && (
        <TradingTab token={token} canDockKeestar={canDockKeestar} />
      )}

      {/* Inter-Hub Arbitrage tab */}
      {activeTab === 'interhub' && (
        <InterHubTab
          onSelectArbItem={onSelectArbItem ?? ((typeId, name) => onSelectItem(typeId, name))}
          selectedTypeId={selectedTypeId}
          haulConfigOpen={haulConfigOpen}
          onHaulConfigOpen={onHaulConfigOpen}
          onHaulConfigClose={onHaulConfigClose}
          token={interHubToken}
          characters={interHubCharacters}
          onHaulSaved={onInterHubHaulSaved}
          canDockKeestar={canDockKeestar}
        />
      )}

      {/* LP Store Calculator */}
      {activeTab === 'lpstore' && (
        <LPStoreTab
          onSelectItem={onSelectItem}
          selectedTypeId={selectedTypeId}
          lpPoints={lpPoints}
          sellRegionId={regionId}
          token={primaryToken}
        />
      )}

      {/* Pilot's Guide */}
      {activeTab === 'help' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <HelpTab />
        </div>
      )}

    </main>
  );
};

export default MainContent;
