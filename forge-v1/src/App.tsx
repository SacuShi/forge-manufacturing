/**
 * FORGE v1.5 — Application Root
 *
 * WHAT THIS FILE DOES
 * ───────────────────
 * This is the top of the React component tree. Everything the user sees lives inside
 * the `AppShell` component defined here. It:
 *
 *   1. Owns authentication state via `useAuth` — detects whether the user is logged in,
 *      handles the EVE SSO redirect callback, and stores the bearer token.
 *
 *   2. Aggregates data from the primary character plus any alt characters the user adds,
 *      producing combined lists (allBlueprints, combinedAssets, bestSkillsArray) that
 *      the rest of the app treats as a single merged view.
 *
 *   3. Owns the selected item — when the user clicks on a row in any tab, `selectedTypeId`
 *      and `selectedName` are set here, and the RightSidebar (info panel) opens.
 *
 *   4. Owns the market data lifecycle — loads the first page on login, paginates on
 *      "load more", and re-fetches when the user changes sell/source hub.
 *
 *   5. Manages the AI chat panel — sends messages, saves history to the server, and
 *      auto-opens the panel on first login so the user gets a welcome summary.
 *
 * LAYOUT (left → right)
 * ─────────────────────
 *   LeftSidebar | [resize handle] | MainContent | [resize handle] | RightSidebar
 *
 *   RightSidebar is 0-width when no item is selected (detailOpen = false).
 *   ChatPanel slides in from the right, overlapping the content area.
 *   TickerBar is pinned to the bottom of the viewport.
 *
 * EVE CONCEPTS FOR READERS WHO DON'T PLAY EVE
 * ─────────────────────────────────────────────
 *   ISK           — EVE's in-game currency (analogous to gold in other games)
 *   Blueprint     — a recipe that lets you manufacture an item. BPO (original,
 *                   unlimited) vs BPC (copy, limited runs).
 *   ESI           — EVE's official REST API (like a real-time game data feed)
 *   Market hub    — a star system with a busy player-run market (like a stock exchange)
 *   Jita          — the most active trade hub in the game (~70% of all EVE trade)
 *   ME/TE         — Material/Time Efficiency: blueprint research levels that reduce
 *                   build costs and build time respectively
 */

import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import type {
  ChatMessage,
  MarketItem,
  ItemDetail,
  TopProfitableResponse,
  AiChatResponse,
  Market,
  IndustrySettings,
  EsiBlueprint,
  EsiAsset,
  QueueCharacter,
  ActiveJob,
  PiCharacter,
  InterHubArbRow,
  InterHubHaulResult,
} from './types';
import { MARKETS } from './components/MarketSelector';
import { useAuth, REMEMBER_PROMPT_SHOWN_KEY } from './hooks/useAuth';
import { useItemDetail } from './hooks/useItemDetail';
import { useItemNames }  from './hooks/useItemNames';
import { useTrueCost }   from './hooks/useTrueCost';
import { apiGet, apiPost } from './api/client';
import { formatBuildTime }  from './utils/format';
import { QUICK_PROMPTS }    from './data/mockData';

import Header                from './components/Header';
import LeftSidebar           from './components/LeftSidebar';
import MainContent           from './components/MainContent';
import RightSidebar          from './components/RightSidebar';
import ChatPanel             from './components/ChatPanel';
import LoginScreen           from './components/LoginScreen';
import LoadingScreen         from './components/LoadingScreen';
import IndustrySettingsModal      from './components/IndustrySettings';
import CharacterManagementModal  from './components/CharacterManagementModal';
import HelpTab                   from './components/HelpTab';
import TradingStandalone     from './components/TradingStandalone';
import TickerBar             from './components/TickerBar';
import TickerIntro, { shouldShowTickerIntro } from './components/TickerIntro';
import { useTickerPins, TickerContext } from './hooks/useTickerPins';
import { useCorpData }            from './hooks/useCorpData';
import { usePushNotifications }  from './hooks/usePushNotifications';

/**
 * Maps raw precomputed results to MarketItem display rows.
 *
 * v1.19.0 — SINGLE BASELINE: profit/margin/ISK-hr are the RAW precomputed
 * estimate straight from the server (gross spread, unresearched BP, before
 * your fees/haul) — identical to what the AI quotes (get_precomputed) and
 * what's stored in the DB. No client-side fee/ME recalculation happens here
 * any more; the per-character, all-in net figure is "True Profit" in the
 * RightSidebar info panel, a deliberately separate, clearly-labelled number
 * computed server-side by /api/true-cost. (An earlier version of this
 * function re-derived a hybrid client-side estimate — removed because it
 * matched neither the raw estimate nor True Profit, which is exactly what
 * made figures disagree across the page. See git history if reintroducing
 * client-side fee math is ever considered.)
 */
function mapToMarketItems(
  results: TopProfitableResponse['results'],
  esiBlueprints: EsiBlueprint[],
  canBuildNowMap: Map<number, boolean>,
  rankOffset = 0
): MarketItem[] {
  // Map blueprint type_id → owned status (BPO wins over BPC)
  const bpMap = new Map<number, 'BPO' | 'BPC'>();
  esiBlueprints.forEach((bp) => {
    const isBpo = bp.runs === -1;
    if (isBpo || !bpMap.has(bp.type_id)) {
      bpMap.set(bp.type_id, isBpo ? 'BPO' : 'BPC');
    }
  });

  return results.map((item, index) => {
    const owned = bpMap.get(item.blueprint_id) ?? '—';

    // v1.19.0 — SINGLE BASELINE: the table shows the RAW precomputed estimate
    // (gross spread, unresearched BP, before your fees/haul). This is identical to
    // what the AI quotes (get_precomputed) and what's stored in the DB. The
    // per-character, all-in net is "True Profit" in the info panel — a deliberately
    // separate, clearly-labelled figure. We no longer re-derive a hybrid here (the
    // old fee math matched neither the estimate nor True Profit, which is exactly
    // what made figures disagree across the page).
    const profitPerRun = item.profit;
    const margin       = item.profit_margin;
    const iskPerHour   = item.isk_per_hour;

    return {
      rank:             rankOffset + index + 1,
      typeId:           item.product_id,
      name:             item.product_name,
      category:         '',
      profitPerRun,
      margin,
      iskPerHour,
      buildTime:        formatBuildTime(item.build_time ?? 0),
      buildTimeMinutes: Math.round((item.build_time ?? 0) / 60),
      owned,
      // v1.33.1 — "can build" now means owned blueprint AND owned materials/ISK cover it
      // (not just blueprint ownership). Unknown (map not yet loaded) = not buildable yet.
      canBuild:         owned !== '—' && (canBuildNowMap.get(item.blueprint_id) ?? false),
      priceSource:      item.price_source ?? null,
      avg30dPrice:      item.avg_30d_price ?? null,
      avgDailyVolume:   item.avg_daily_volume ?? null,
      volumeSource:     item.volume_source ?? null,
      liquidityRisk:    item.liquidity_risk ?? null,
      haulCostPerUnit:  item.haul_cost_per_unit ?? 0,
      haulIskPerM3:     item.haul_isk_per_m3    ?? 0,
      haulVolumeM3:     item.haul_volume_m3      ?? 0,
    } as MarketItem;
  });
}

function toItemDetail(
  item: TopProfitableResponse['results'][number],
  owned: MarketItem['owned']
): ItemDetail {
  return {
    typeId:       item.product_id,
    name:         item.product_name,
    category:     '',
    owned,
    profitPerRun: item.profit,
    margin:       item.profit_margin,
    iskPerHour:   item.isk_per_hour,
    buildTime:    formatBuildTime(item.build_time ?? 0),
    sellPrice:    item.sell_price,
    matCost:      item.material_cost,
    materials:    [],
  };
}

const AppShell: FC = () => {
  const auth = useAuth();
  const { names: itemNames, loading: itemNamesLoading, resolveUnknown } = useItemNames();

  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('forge-theme') ?? 'dark'
  );
  const [font, setFont] = useState<string>(
    () => localStorage.getItem('forge-font') ?? 'forge'
  );
  const [activeTab, setActiveTab] = useState('market');
  const [chatOpen, setChatOpen] = useState(false);
  const [chatAutoOpened, setChatAutoOpened] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState('');
  const [thinking, setThinking] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  // Navigation stack — allows ← Back through chain drill-downs
  const [panelHistory, setPanelHistory] = useState<Array<{ typeId: number; name: string }>>([]);

  const [sessionExpired,    setSessionExpired]    = useState(false);
  const [showTickerIntro,   setShowTickerIntro]   = useState(shouldShowTickerIntro);
  const [chatMessages,      setChatMessages]      = useState<ChatMessage[]>([]);
  const [rawResults,        setRawResults]        = useState<TopProfitableResponse['results']>([]);
  const [marketLoading,     setMarketLoading]     = useState(false);
  const [marketLoadingMore, setMarketLoadingMore] = useState(false);
  const [marketSearchQuery, setMarketSearchQuery] = useState('');
  const [marketSearchResults, setMarketSearchResults] = useState<TopProfitableResponse['results'] | null>(null);
  const [marketSearching,   setMarketSearching]   = useState(false);
  const marketSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref: debounce timer for the combined session re-POST (prevents burst during initial load)
  const sessionRePostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref-based guard prevents duplicate concurrent "load more" fetches.
  // React state updates are async so the closed-over state value can be stale
  // when two click events fire before the first re-render; a ref is set synchronously.
  const loadingMoreRef = useRef(false);

  // v1.16.0 — user-resizable panels (left + right). Persisted across sessions.
  // The right panel stays collapsed (width 0) until an item is selected (detailOpen).
  const PANEL_WIDTHS_KEY = 'forge_panel_widths';
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) || '{}').left ?? 240; } catch { return 240; }
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    try { return JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) || '{}').right ?? 460; } catch { return 460; }
  });
  const appBodyRef = useRef<HTMLDivElement>(null);
  const panelDragRef = useRef<null | { which: 'left' | 'right'; startX: number; startW: number }>(null);

  const [marketHasMore,     setMarketHasMore]     = useState(true);
  const [marketError,       setMarketError]       = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<Market>(() => {
    const saved = localStorage.getItem('forge-sell-market');
    if (saved) {
      const found = MARKETS.find((m) => m.id === parseInt(saved, 10));
      if (found) return found;
    }
    return MARKETS[0]; // default: Jita
  });
  // v1.3.0 — Source hub: where materials are purchased. Persisted across sessions.
  const [selectedSourceMarket, setSelectedSourceMarket] = useState<Market>(() => {
    const saved = localStorage.getItem('forge-source-market');
    if (saved) {
      const found = MARKETS.find((m) => m.id === parseInt(saved, 10));
      if (found) return found;
    }
    return MARKETS[0]; // default: Jita
  });

  // v1.2.0 — Industry settings + settings modal
  const [industrySettings, setIndustrySettings] = useState<IndustrySettings | null>(null);
  const [settingsOpen,     setSettingsOpen]     = useState(false);
  // Which part of Mfg Setup to scroll to when it opens (e.g. the haulage notice links straight to it)
  const [settingsFocus,    setSettingsFocus]    = useState<'haulage' | null>(null);
  // Bumped on every settings save (system/structure/rigs/tax) so useTrueCost's
  // effect re-fires — /api/true-cost reads rig_ids etc. fresh from the DB per
  // request, but none of useTrueCost's other params change on a rig pick alone,
  // so without this the True Profit panel would keep showing stale numbers
  // (computed under the OLD rig selection) until something unrelated happened
  // to trigger a refetch (switching items, changing runs, ...).
  const [settingsVersion,  setSettingsVersion]  = useState(0);

  // v1.5 — Multi-character: view isolation + fee character selection
  // viewCharacterId: null = combined view; a characterId = isolated single-char view
  // feeCharacterId:  null = use primary character's token for fee/true-cost calls
  const [viewCharacterId,  setViewCharacterId]  = useState<number | null>(null);
  // "+ Add Character" triggers a full EVE SSO page redirect, which unmounts the
  // whole app — plain useState would always come back closed, forcing the user
  // to reopen Manage Characters before adding each alt (reported as "the box
  // closes after every add" with 20+ characters). Persist across that round
  // trip in sessionStorage instead; the modal now only closes when the user
  // explicitly clicks away/×.
  const [charModalOpen,    setCharModalOpen]    = useState(
    () => sessionStorage.getItem('forge_char_modal_open') === 'true'
  );
  useEffect(() => {
    sessionStorage.setItem('forge_char_modal_open', charModalOpen ? 'true' : 'false');
  }, [charModalOpen]);

  // "Remember my characters" — auto-restore, no confirmation click required.
  // Originally this gated behind a "Welcome back, pick which to reload" popup,
  // but with a large roster that's still a manual step every single login —
  // reported directly ("I don't want to be adding 20 characters each
  // session"). The user already consented at the toggle: every remembered
  // alt was only ever captured because they personally logged into it via
  // EVE SSO while that toggle was on, so silently reloading it on the next
  // main login isn't a new consent boundary, just skipping a click nobody
  // wanted. Characters flagged needsReauth are skipped (they'd fail anyway)
  // and stay visible/loadable individually from Manage Characters.
  // REMEMBER_PROMPT_SHOWN_KEY (cleared on logout, see useAuth.ts) guards this
  // to fire once per login rather than on every re-render.
  useEffect(() => {
    if (auth.status !== 'authed') return;
    if (!auth.rememberEnabled) return;
    if (auth.rememberedCharacters.length === 0) return;
    if (sessionStorage.getItem(REMEMBER_PROMPT_SHOWN_KEY) === 'true') return;
    sessionStorage.setItem(REMEMBER_PROMPT_SHOWN_KEY, 'true');
    const idsToRestore = auth.rememberedCharacters
      .filter((c) => !c.needsReauth)
      .map((c) => c.characterId);
    if (idsToRestore.length > 0) auth.restoreRememberedCharacters(idsToRestore);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.rememberEnabled, auth.rememberedCharacters]);

  const [feeCharacterId,  setFeeCharacterId]  = useState<number | null>(null);
  const [buildRuns,       setBuildRuns]       = useState(1);
  // v1.17.1 — implant set the user chose to apply to True Profit ISK/hr (default none)
  const [selectedImplants, setSelectedImplants] = useState<number[]>([]);
  // v1.35.0 — invention decryptor + manual probability bonus
  const [inventionDecryptorType, setInventionDecryptorType] = useState<string | null>(null);
  const [inventionProbBonus,     setInventionProbBonus]     = useState(0);

  // Inter-Hub Arb — the full row of the last item clicked from the inter-hub tab.
  // Non-null → RightSidebar renders the trade view instead of the manufacturing view.
  const [interHubContext,          setInterHubContext]          = useState<InterHubArbRow | null>(null);
  const [interHubHaulData,         setInterHubHaulData]         = useState<InterHubHaulResult | null>(null);
  const [interHubHaulLoading,      setInterHubHaulLoading]      = useState(false);
  const [interHubHaulConfigOpen,   setInterHubHaulConfigOpen]   = useState(false);
  const [interHubHaulRefreshKey,   setInterHubHaulRefreshKey]   = useState(0);

  // ── v1.5 Aggregation ──────────────────────────────────────────────────────
  // Derive combined/isolated datasets from primary + alts based on viewCharacterId.

  const activeAltCharacters = useMemo(() =>
    viewCharacterId === null
      ? auth.altCharacters
      : auth.altCharacters.filter((a) => a.characterId === viewCharacterId),
    [viewCharacterId, auth.altCharacters]
  );

  const primaryInScope = viewCharacterId === null || viewCharacterId === auth.character?.characterId;

  // All blueprints across in-scope characters (used for ownership badges + market filtering)
  const allBlueprints = useMemo<EsiBlueprint[]>(() => [
    ...(primaryInScope ? auth.blueprints : []),
    ...activeAltCharacters.flatMap((a) => a.blueprints),
  ], [primaryInScope, auth.blueprints, activeAltCharacters]);

  // Fetch blueprint metadata (metaLevel + productTypeId) eagerly at login so icons
  // are ready before the user opens the My Blueprints tab.
  const [bpMetadataApp, setBpMetadataApp] = useState<Record<number, { metaLevel: number; productTypeId: number | null }>>({});
  useEffect(() => {
    if (allBlueprints.length === 0) return;
    const typeIds = [...new Set(allBlueprints.map(b => b.type_id))];
    fetch('/api/blueprint-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blueprintTypeIds: typeIds }),
    })
      .then(res => res.json())
      .then(data => setBpMetadataApp(data))
      .catch(() => {});
  }, [allBlueprints]);

  // Raw assets from all in-scope characters, preserving per-item location_id.
  // Used by the Assets tab to show per-location grouping.
  const allRawAssets = useMemo<EsiAsset[]>(() => {
    const result: EsiAsset[] = [];
    if (primaryInScope) result.push(...auth.assets);
    activeAltCharacters.forEach((a) => result.push(...a.assets));
    return result;
  }, [primaryInScope, auth.assets, activeAltCharacters]);

  // Combined assets summed by type_id — used by useItemDetail for have/needed
  const combinedAssets = useMemo<EsiAsset[]>(() => {
    const map = new Map<number, number>();
    const add = (assets: EsiAsset[]) =>
      assets.forEach((a) => map.set(a.type_id, (map.get(a.type_id) ?? 0) + a.quantity));
    if (primaryInScope) add(auth.assets);
    activeAltCharacters.forEach((a) => add(a.assets));
    // Convert back to EsiAsset[] (server/hooks expect an array)
    return Array.from(map.entries()).map(([type_id, quantity]) => ({
      type_id, quantity,
      item_id: type_id, location_id: 0, location_flag: 'Hangar', is_singleton: false,
    }));
  }, [primaryInScope, auth.assets, activeAltCharacters]);

  // Best skill level per skill_id across in-scope characters (for market filtering)
  const bestSkillsArray = useMemo(() => {
    const map = new Map<number, number>();
    const add = (skills: Array<{ skill_id: number; active_skill_level: number }>) =>
      skills.forEach((s) => map.set(s.skill_id, Math.max(map.get(s.skill_id) ?? 0, s.active_skill_level)));
    if (primaryInScope) add(auth.skills);
    activeAltCharacters.forEach((a) => add(a.skills));
    return Array.from(map.entries()).map(([skill_id, active_skill_level]) => ({ skill_id, active_skill_level }));
  }, [primaryInScope, auth.skills, activeAltCharacters]);

  // All active jobs across in-scope characters
  const allActiveJobs = useMemo(() => [
    ...(primaryInScope ? (auth.character?.activeJobs ?? []) : []),
    ...activeAltCharacters.flatMap((a) => a.activeJobs),
  ], [primaryInScope, auth.character, activeAltCharacters]);

  // Total wallet across in-scope characters
  const totalWalletISK = useMemo(() =>
    (primaryInScope ? (auth.character?.walletISK ?? 0) : 0) +
    activeAltCharacters.reduce((s, a) => s + a.walletISK, 0),
    [primaryInScope, auth.character, activeAltCharacters]
  );

  /**
   * Stable version key for the combined session data.
   * Covers skill level VALUES (not just count) so the re-POST fires when a skill
   * trains up mid-session, even if the total number of skills stays the same.
   * Using a string key avoids including large arrays in the effect dependency.
   */
  const combinedDataVersion = useMemo(() => {
    const skillHash = bestSkillsArray.reduce((acc, s) => acc + s.active_skill_level, 0)
      // the main's OWN levels are posted too (fees use them), so a change there must re-post as well
      + 1000 * auth.skills.reduce((acc, s) => acc + s.active_skill_level, 0);
    // Include sorted alt IDs so adding/removing a zero-asset alt (same counts) still
    // triggers a re-POST to keep the server session in sync.
    const altIds    = activeAltCharacters.map((a) => a.characterId).sort().join(',');
    return `${allBlueprints.length}:${combinedAssets.length}:${bestSkillsArray.length}:${skillHash}:${altIds}`;
  }, [allBlueprints, combinedAssets, bestSkillsArray, activeAltCharacters, auth.skills]);

  // v1.33.1 — "Can Build Now" map for Market Opportunities' Can Build pill: owned
  // materials + wallet ISK cover each owned blueprint's shortfall. Reuses
  // /api/blueprint-profits (same computation as the My Blueprints tab); only the
  // canBuildNow field is used here, priced at the MATERIALS hub (not the sell hub).
  // v1.33.2 — silently retries once after 15s if the server flags the price cache
  // as cold (_meta.canBuildDataWarm === false), same pattern as useTrueCost.
  const [canBuildNowMap, setCanBuildNowMap] = useState<Map<number, boolean>>(new Map());
  useEffect(() => {
    if (allBlueprints.length === 0) { setCanBuildNowMap(new Map()); return; }
    const typeIds = [...new Set(allBlueprints.map((b) => b.type_id))];
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const load = (silent = false) => {
      fetch('/api/blueprint-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blueprintTypeIds: typeIds,
          regionId: selectedSourceMarket.id,
          assets: combinedAssets,
          walletISK: totalWalletISK,
        }),
      })
        .then((res) => res.json())
        .then((data: Record<string, unknown>) => {
          if (cancelled) return;
          const map = new Map<number, boolean>();
          Object.entries(data).forEach(([bpId, v]) => {
            if (bpId === '_meta') return;
            map.set(Number(bpId), !!(v as { canBuildNow?: boolean } | undefined)?.canBuildNow);
          });
          setCanBuildNowMap(map);
          const meta = data._meta as { canBuildDataWarm?: boolean } | undefined;
          if (!silent && meta && meta.canBuildDataWarm === false) {
            retryTimer = setTimeout(() => load(true), 15_000);
          }
        })
        .catch(() => { if (!cancelled) setCanBuildNowMap(new Map()); });
    };
    load();

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [allBlueprints, selectedSourceMarket.id, combinedAssets, totalWalletISK]);

  // Resolve names for any asset/blueprint type_ids missing from the DB-sourced name map.
  // Runs once after both the character data and the name map have fully loaded.
  useEffect(() => {
    if (auth.status !== 'authed' || itemNamesLoading) return;
    const unknown = new Set<number>();
    combinedAssets.forEach(a => { if (!itemNames.has(a.type_id)) unknown.add(a.type_id); });
    allBlueprints.forEach(bp => { if (!itemNames.has(bp.type_id)) unknown.add(bp.type_id); });
    if (unknown.size > 0) resolveUnknown([...unknown]);
  // resolveUnknown changes identity when names changes, so omit it to avoid infinite loop;
  // the auth.status + itemNamesLoading gate ensures this only runs once per login.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, itemNamesLoading, combinedAssets, allBlueprints]);

  // ── PI: all characters with their tokens (always all, not filtered by isolation) ──
  // PI is best viewed combined — each colony card shows who owns it.
  const piCharacters = useMemo<PiCharacter[]>(() => {
    const all: PiCharacter[] = [];
    if (auth.character && auth.token) {
      all.push({ characterId: auth.character.characterId, name: auth.character.name, token: auth.token });
    }
    auth.altCharacters.filter(a => !a.loading && !a.error).forEach(alt => {
      all.push({ characterId: alt.characterId, name: alt.name, token: alt.token });
    });
    // When "All" is selected (null), show every character's colonies combined.
    // When a specific character is selected, show only that character's colonies.
    if (viewCharacterId !== null) return all.filter(c => c.characterId === viewCharacterId);
    return all;
  }, [auth.character, auth.token, auth.altCharacters, viewCharacterId]);

  // ── Queue Planner: per-character slot summary ────────────────────────────
  // Manufacturing and Reaction jobs use two INDEPENDENT slot pools in EVE —
  // Mass Production/Advanced Mass Production (skills 3387/24625) govern
  // manufacturing slots; Mass Reactions/Advanced Mass Reactions (skills
  // 45748/45749) govern reaction slots. A reaction job can never occupy a
  // manufacturing slot or vice versa. (Verified 17 Sept 2026 — this used to
  // be a single combined pool sized only by the manufacturing skills, with
  // both job types counted against it, which under- or over-stated free
  // slots for anyone running reactions.)
  const queueCharacters = useMemo<QueueCharacter[]>(() => {
    const getSlots = (skills: Array<{ skill_id: number; active_skill_level: number }>, l1: number, l2: number) => {
      const sm: Record<number, number> = {};
      skills.forEach(s => { sm[s.skill_id] = s.active_skill_level; });
      return 1 + (sm[l1] || 0) + (sm[l2] || 0);
    };
    const chars: QueueCharacter[] = [];
    const toSkillMap = (skills: Array<{ skill_id: number; active_skill_level: number }>) => {
      const m: Record<number, number> = {};
      skills.forEach(s => { m[s.skill_id] = s.active_skill_level; });
      return m;
    };
    const buildChar = (
      characterId: number, name: string, token: string,
      skills: Array<{ skill_id: number; active_skill_level: number }>,
      activeJobs: ActiveJob[],
    ): QueueCharacter => {
      const mfgTotalSlots      = getSlots(skills, 3387, 24625);   // 1 + Mass Prod + Adv Mass Prod
      const reactionTotalSlots = getSlots(skills, 45748, 45749);  // 1 + Mass Reactions + Adv Mass Reactions
      const mfgBusy      = activeJobs.filter(j => j.activityId === 1).length;
      const reactionBusy = activeJobs.filter(j => j.activityId === 9).length;
      const mfgFreeSlots      = Math.max(0, mfgTotalSlots - mfgBusy);
      const reactionFreeSlots = Math.max(0, reactionTotalSlots - reactionBusy);
      return {
        characterId, name, token,
        totalSlots: mfgTotalSlots + reactionTotalSlots,
        freeSlots:  mfgFreeSlots + reactionFreeSlots,
        mfgTotalSlots, mfgFreeSlots, reactionTotalSlots, reactionFreeSlots,
        activeJobs,
        skills: toSkillMap(skills),
      };
    };
    if (auth.character) {
      chars.push(buildChar(
        auth.character.characterId, auth.character.name, auth.token ?? '',
        auth.skills, auth.character.activeJobs ?? [],
      ));
    }
    auth.altCharacters.filter(a => !a.loading && !a.error).forEach(alt => {
      chars.push(buildChar(alt.characterId, alt.name, alt.token, alt.skills, alt.activeJobs ?? []));
    });
    // When "All" is selected (null), plan across every character's slots combined.
    // When a specific character is selected, plan only for that character's slots
    // (still uses the primary's session for blueprint/asset data).
    if (viewCharacterId !== null) return chars.filter(c => c.characterId === viewCharacterId);
    return chars;
  }, [auth.character, auth.token, auth.skills, auth.altCharacters, viewCharacterId]);

  // Blueprint → owner name map (item_id → character name) — for attribution badges
  const blueprintOwnerMap = useMemo(() => {
    const map = new Map<number, string>();
    if (auth.altCharacters.length === 0) return map; // no alts → no badges needed
    auth.blueprints.forEach((bp) => map.set(bp.item_id, auth.character?.name ?? 'Primary'));
    auth.altCharacters.forEach((a) => a.blueprints.forEach((bp) => map.set(bp.item_id, a.name)));
    return map;
  }, [auth.blueprints, auth.character, auth.altCharacters]);

  // Token to use for fee-rate and true-cost calls (primary or selected alt)
  const feeToken = useMemo(() => {
    if (!feeCharacterId) return auth.token;
    return auth.altCharacters.find((a) => a.characterId === feeCharacterId)?.token ?? auth.token;
  }, [feeCharacterId, auth.token, auth.altCharacters]);

  // Name of the character whose fees are being used (for the selector label)
  const feeCharacterName = useMemo(() => {
    if (!feeCharacterId) return auth.character?.name ?? 'Primary';
    return auth.altCharacters.find((a) => a.characterId === feeCharacterId)?.name ?? 'Primary';
  }, [feeCharacterId, auth.character, auth.altCharacters]);

  // v1.13.2 — Corp access is checked against the CURRENTLY-SELECTED character's
  // token (the view chip in the sidebar), so a Director alt is recognised and a
  // non-Director selection is denied. "All" view (null) falls back to the primary.
  const corpToken = useMemo(() => {
    if (viewCharacterId == null || viewCharacterId === auth.character?.characterId) return auth.token;
    return auth.altCharacters.find((a) => a.characterId === viewCharacterId)?.token ?? auth.token;
  }, [viewCharacterId, auth.token, auth.character, auth.altCharacters]);

  // v1.4.0 — Corp feature: director-role access (no PIN). Re-checks when the
  // selected character (corpToken) changes.
  const {
    corpStatus,
    accessStatus: corpAccessStatus,
    loading:      corpDataLoading,
  } = useCorpData(
    corpToken,
    activeTab === 'corp' && auth.status === 'authed',
  );

  const { state: pushState, enable: pushEnable, disable: pushDisable, syncJobs } = usePushNotifications(
    auth.status === 'authed' ? auth.token : null
  );

  useEffect(() => {
    if (pushState !== 'granted') return;
    const jobs = allActiveJobs
      .filter(j => !j.done && j.endDate)
      .map(j => ({ key: `${j.typeId}:${j.endDate}`, productName: j.name, endDate: j.endDate! }));
    if (jobs.length) syncJobs(jobs);
  }, [allActiveJobs, pushState, syncJobs]);

  // Derive marketItems from rawResults (paginated list) or marketSearchResults (search).
  // When feeRates are loaded, profit/margin/ISK-hr are recalculated with the same
  // formula as True Profit so both panels show consistent figures.
  // Uses allBlueprints so owned status reflects all in-scope characters.
  const marketItems = useMemo<MarketItem[]>(() => {
    const source = marketSearchResults ?? rawResults;
    if (!source.length) return [];
    return mapToMarketItems(source, allBlueprints, canBuildNowMap);
  }, [rawResults, marketSearchResults, allBlueprints, canBuildNowMap]);

  // Clear inter-hub context whenever the user navigates away from the arb tab.
  useEffect(() => {
    if (activeTab !== 'interhub') {
      setInterHubContext(null);
      setInterHubHaulData(null);
    }
  }, [activeTab]);

  // Fetch haul cost per unit whenever an inter-hub item is selected.
  useEffect(() => {
    if (!interHubContext || !auth.token) { setInterHubHaulData(null); return; }
    let cancelled = false;
    setInterHubHaulLoading(true);
    const { product_id, buy_region_id, sell_region_id, buy_at } = interHubContext;
    fetch(
      `/api/inter-hub-haul?typeId=${product_id}&buyHub=${buy_region_id}&sellHub=${sell_region_id}&collateral=${buy_at}`,
      { headers: { Authorization: `Bearer ${auth.token}` } }
    )
      .then(r => r.json())
      .then((data: InterHubHaulResult) => { if (!cancelled) setInterHubHaulData(data); })
      .catch(() => { if (!cancelled) setInterHubHaulData(null); })
      .finally(() => { if (!cancelled) setInterHubHaulLoading(false); });
    return () => { cancelled = true; };
  }, [interHubContext, auth.token, interHubHaulRefreshKey]);

  // Server-side name search — called when user types in the market search box.
  const handleMarketSearch = useCallback((query: string) => {
    setMarketSearchQuery(query);
    if (marketSearchTimerRef.current) clearTimeout(marketSearchTimerRef.current);

    if (query.trim().length < 2) {
      setMarketSearchResults(null); // revert to paginated list
      setMarketSearching(false);
      return;
    }

    setMarketSearching(true);
    marketSearchTimerRef.current = setTimeout(async () => {
      if (!auth.token) return;
      try {
        const encoded = encodeURIComponent(query.trim());
        const data = await apiGet<{ results: TopProfitableResponse['results'] }>(
          `/api/search-profitable?q=${encoded}&regionId=${selectedMarket.id}`,
          auth.token
        );
        setMarketSearchResults(data.results);
      } catch {
        setMarketSearchResults([]); // show "no results" on error
      } finally {
        setMarketSearching(false);
      }
    }, 300);
  }, [auth.token, selectedMarket.id]);

  const {
    detail: apiDetail,
    loading: detailLoading,
    error: detailError,
  } = useItemDetail(
    selectedTypeId, combinedAssets, allBlueprints, auth.token,
    selectedMarket.id,        // sell hub — drives "Current Market" price box
    selectedSourceMarket.id,  // source hub — drives material unit costs in build analysis
  );

  // v1.2.0 — Resolve the character's best blueprint ME/TE for the selected product.
  //
  // ESI blueprint type_ids differ from product type_ids, so we match by name:
  //   itemNames.get(bp.type_id) === productName + " Blueprint"
  // BPO (quantity === -1) is preferred over any BPC when both exist.
  // v1.5: search allBlueprints so alts' blueprints are included in ME/TE resolution
  const { selectedBlueprintME, selectedBlueprintTE, selectedBp } = useMemo(() => {
    if (!selectedTypeId || !itemNames.size || !allBlueprints.length) {
      return { selectedBlueprintME: 0, selectedBlueprintTE: 0, selectedBp: null };
    }
    const productName = itemNames.get(selectedTypeId);
    if (!productName) return { selectedBlueprintME: 0, selectedBlueprintTE: 0, selectedBp: null };
    const bpNameTarget = (productName + ' Blueprint').toLowerCase();

    let best: EsiBlueprint | null = null;
    for (const bp of allBlueprints) {
      const bpName = itemNames.get(bp.type_id);
      if (!bpName || bpName.toLowerCase() !== bpNameTarget) continue;
      // Prefer BPO (quantity === -1); among BPCs pick any
      if (!best || bp.quantity === -1) best = bp;
    }
    return {
      selectedBlueprintME: best?.material_efficiency ?? 0,
      selectedBlueprintTE: best?.time_efficiency     ?? 0,
      selectedBp: best,
    };
  }, [selectedTypeId, allBlueprints, itemNames]);

  // v1.2.0 — True Profit calculation via /api/true-cost (local ESI calc, no external API)
  // v1.5: feeToken switches to whichever character the user selects for fee calculations
  const {
    data:    trueCostData,
    loading: trueCostLoading,
    error:   trueCostError,
  } = useTrueCost(
    selectedTypeId,
    selectedMarket.id,        // sell hub
    selectedSourceMarket.id,  // source hub — determines material purchase prices
    selectedBlueprintME,
    selectedBlueprintTE,
    feeToken,
    buildRuns,
    selectedImplants,
    inventionDecryptorType,
    inventionProbBonus,
    settingsVersion,
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('forge-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
    localStorage.setItem('forge-font', font);
  }, [font]);

  // Listen for 401 events fired by apiGet/apiPost — show expiry message on login screen
  useEffect(() => {
    const handleExpiry = () => setSessionExpired(true);
    window.addEventListener('forge:session-expired', handleExpiry);
    return () => window.removeEventListener('forge:session-expired', handleExpiry);
  }, []);

  // Reset expiry flag once the user successfully logs in again
  useEffect(() => {
    if (auth.status === 'authed') {
      setSessionExpired(false);
      localStorage.setItem('forge_ever_authed', '1');
    }
  }, [auth.status]);

  // v1.2.0 — Load saved industry settings on login
  useEffect(() => {
    if (auth.status !== 'authed' || !auth.token) return;
    apiGet<IndustrySettings>('/api/industry-settings', auth.token)
      .then(setIndustrySettings)
      .catch(() => { /* non-fatal — settings remain null */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  // v1.5 — Re-POST combined session to server whenever the in-scope character set changes.
  // This keeps /api/top-profitable-by-skills skill-filtering and have/needed checks
  // up-to-date with the current combined (or isolated) character data — no server changes needed.
  //
  // Debounced by 1.5 s: during initial login every alt that finishes loading changes
  // combinedDataVersion, which without debouncing fires one POST per alt in rapid
  // succession and exhausts the server rate limit before the market call gets through.
  // The debounce collapses the entire burst into a single POST once loading settles.
  useEffect(() => {
    if (auth.status !== 'authed' || !auth.token) return;

    if (sessionRePostTimerRef.current) clearTimeout(sessionRePostTimerRef.current);
    sessionRePostTimerRef.current = setTimeout(() => {
      apiPost('/api/session-data', {
        assets:    combinedAssets,
        blueprints: allBlueprints,
        prices:    {},
        wallet:    auth.character?.walletISK ?? 0,
        jobs:      allActiveJobs,
        skills:    bestSkillsArray,          // best level of each skill across all loaded characters (build filters)
        own_skills: auth.skills,             // THIS character's own levels — fees and build time use these
        standings: auth.hasStandingsScope ? auth.primaryStandings : null,
      }, auth.token ?? undefined).catch(() => { /* non-fatal */ });
    }, 1500);

    return () => {
      if (sessionRePostTimerRef.current) clearTimeout(sessionRePostTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.token, combinedDataVersion]);

  // Relay token to localStorage so the standalone trading window can read it.
  useEffect(() => {
    if (auth.status === 'authed' && auth.token) {
      localStorage.setItem('forge_trading_token', auth.token);
    } else if (auth.status === 'idle') {
      localStorage.removeItem('forge_trading_token');
    }
  }, [auth.status, auth.token]);

  useEffect(() => {
    if (auth.status !== 'authed') return;

    setMarketLoading(true);
    // Use skills-filtered endpoint; pass both hubs so the table reflects the user's
    // persisted source/sell combination from the first load.
    apiGet<TopProfitableResponse>(
      `/api/top-profitable-by-skills?limit=50&regionId=${selectedMarket.id}&sourceRegionId=${selectedSourceMarket.id}`,
      auth.token ?? ''
    )
      .then((data) => {
        setRawResults(data.results);
        setMarketHasMore(data.meta.hasMore ?? data.results.length >= 50);

        const lastComputed = data.meta.lastComputed
          ? new Date(data.meta.lastComputed).toLocaleTimeString()
          : 'recently';

        // Only set welcome message if no history loaded yet
        setChatMessages((prev) => prev.length === 0 ? [{
          role:    'assistant',
          content: `${auth.character?.name}, your data is ready.\n\n` +
                   `Wallet: **${((auth.character?.walletISK ?? 0) / 1e9).toFixed(2)}B ISK** · ` +
                   `${auth.character?.activeJobCount ?? 0} active jobs · ` +
                   `${data.results.length} profitable opportunities loaded ` +
                   `(updated ${lastComputed}).\n\n` +
                   `Ask me what's most profitable to build right now, or ask about any specific item or blueprint.`,
        }] : prev);
      })
      .catch((e: Error) => setMarketError(e.message))
      .finally(() => {
        setMarketLoading(false);
        // Auto-open the chat panel after every login once data is ready
        setChatOpen(true);
        setChatAutoOpened(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  useEffect(() => {
    if (auth.status !== 'authed' || !auth.token || !auth.character || historyLoaded) return;

    const cid = auth.character.characterId;
    apiGet<Array<{ role: string; content: string }>>(
      `/api/chat-history/${cid}`,
      auth.token
    )
      .then((hist) => {
        if (hist.length > 1) {
          const limit   = 20;
          const limited = hist.length > limit ? hist.slice(-limit) : hist;
          const note    = hist.length > limit
            ? ` (Loaded last ${limit} of ${hist.length} messages)`
            : '';
          setChatMessages([
            {
              role:    'assistant',
              content: `Welcome back! Your previous conversation has been restored.${note}`,
            },
            ...limited.map((m) => ({
              role:    m.role as 'user' | 'assistant',
              content: m.content,
            })),
          ]);
          setHistoryLoaded(true);
        }
      })
      .catch(() => { /* history unavailable — not a fatal error */ });
  }, [auth.status, auth.character, auth.token, historyLoaded]);

  // ── Ticker ────────────────────────────────────────────────────────────────
  const totalFreeSlots = useMemo(() =>
    queueCharacters.reduce((sum, c) => sum + c.freeSlots, 0),
  [queueCharacters]);

  const ticker = useTickerPins({
    token:       auth.token,
    characterId: auth.character?.characterId ?? null,
    walletISK:   totalWalletISK,
    activeJobs:  allActiveJobs,
    freeSlots:   totalFreeSlots,
    itemNames,
  });

  const selectedDetail: ItemDetail | null = (() => {
    if (!selectedTypeId) return null;
    const raw = rawResults.find((r) => r.product_id === selectedTypeId);
    if (!raw) return null;
    const mi = marketItems.find((m) => m.typeId === selectedTypeId);
    return toItemDetail(raw, mi?.owned ?? '—');
  })();

  // v1.20 — liquidity signal for the selected item, fed to the True Profit panel.
  // Prefer the mapped MarketItem (covers drill-down items not in rawResults).
  const selectedItem = selectedTypeId
    ? marketItems.find((m) => m.typeId === selectedTypeId) ?? null
    : null;
  const selectedVolume       = selectedItem?.avgDailyVolume ?? null;
  const selectedLiquidityRisk = selectedItem?.liquidityRisk ?? null;
  const selectedVolumeSource  = selectedItem?.volumeSource ?? null;

  const handleLoadMoreMarket = useCallback(async () => {
    // Use a ref guard (not state) so the check is synchronous — prevents two rapid
    // clicks from both passing the guard before the first setState re-render fires.
    if (loadingMoreRef.current || !marketHasMore || !auth.token) return;
    loadingMoreRef.current = true;
    setMarketLoadingMore(true);
    try {
      const nextOffset = rawResults.length;
      const data = await apiGet<TopProfitableResponse>(
        `/api/top-profitable-by-skills?limit=50&offset=${nextOffset}&regionId=${selectedMarket.id}&sourceRegionId=${selectedSourceMarket.id}`,
        auth.token
      );
      setRawResults((prev) => [...prev, ...data.results]);
      setMarketHasMore(data.meta.hasMore ?? data.results.length >= 50);
    } catch (e) {
      console.error('Load more market items failed:', e);
    } finally {
      loadingMoreRef.current = false;
      setMarketLoadingMore(false);
    }
  }, [marketHasMore, auth.token, rawResults.length, selectedMarket.id, selectedSourceMarket.id]);

  const handleToggleChat = () => {
    setChatOpen((p) => !p);
    setChatAutoOpened(false);
  };

  const handleItemSelect = useCallback((typeId: number) => {
    setSelectedTypeId((prev) => {
      if (prev === typeId) {
        setDetailOpen(false);
        setSelectedName('');
        return null;
      }
      setDetailOpen(true);
      return typeId;
    });
  }, []);

  const handleSelectItem = useCallback((typeId: number, name: string) => {
    // Push the currently displayed item onto the back-stack before navigating
    setSelectedTypeId((prev) => {
      if (prev !== null) {
        setSelectedName((prevName) => {
          setPanelHistory((h) => [...h, { typeId: prev, name: prevName }]);
          return name;
        });
      } else {
        setSelectedName(name);
      }
      return typeId;
    });
    setDetailOpen(true);
  }, []);

  const handleSelectArbItem = useCallback((typeId: number, name: string, row: InterHubArbRow) => {
    setInterHubContext(row);
    handleSelectItem(typeId, name);
  }, [handleSelectItem]);

  const handlePanelBack = useCallback(() => {
    setPanelHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setSelectedTypeId(prev.typeId);
      setSelectedName(prev.name);
      return h.slice(0, -1);
    });
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedTypeId(null);
    setSelectedName('');
    setDetailOpen(false);
    setPanelHistory([]);   // clear back-stack on explicit close
  }, []);

  // ── Panel resize (v1.16.0) ────────────────────────────────────────────────
  // Delta-from-drag-start (robust — independent of element offsets/overflow) +
  // pointer capture so the drag survives the cursor leaving the thin handle.
  const startPanelDrag = useCallback((which: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    panelDragRef.current = {
      which,
      startX: e.clientX,
      startW: which === 'left' ? leftWidth : rightWidth,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = panelDragRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      if (d.which === 'left') {
        // Drag right → wider.
        setLeftWidth(Math.min(Math.max(d.startW + delta, 180), 460));
      } else {
        // Right panel is right-docked: drag left → wider, drag right → narrower.
        setRightWidth(Math.min(Math.max(d.startW - delta, 300), 760));
      }
    };
    const onUp = () => {
      if (!panelDragRef.current) return;
      panelDragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  // Persist panel widths
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify({ left: leftWidth, right: rightWidth }));
    } catch { /* ignore */ }
  }, [leftWidth, rightWidth]);

  /**
   * Loads market data for the given sell/source hub pair and updates all
   * related state. Handles both sell-hub changes and source-hub changes in
   * one place, reverting only the market that changed on fetch failure.
   *
   * When the sell hub changes, stale name-search results are also cleared
   * (they were scoped to the old hub's region). Source-hub changes leave
   * search state intact — search is by item name, not region-specific.
   */
  const loadMarket = useCallback(async (sellMarket: Market, sourceMarket: Market) => {
    const sellChanged = sellMarket.id !== selectedMarket.id;

    setSelectedMarket(sellMarket);
    localStorage.setItem('forge-sell-market', String(sellMarket.id));
    setSelectedSourceMarket(sourceMarket);
    localStorage.setItem('forge-source-market', String(sourceMarket.id));

    setRawResults([]);
    setMarketHasMore(true);
    setMarketError(null);
    // Clear search only when the sell hub changes: search results are hub-scoped.
    if (sellChanged) {
      setMarketSearchResults(null);
      setMarketSearchQuery('');
    }
    setMarketLoading(true);

    try {
      const data = await apiGet<TopProfitableResponse>(
        `/api/top-profitable-by-skills?limit=50&regionId=${sellMarket.id}&sourceRegionId=${sourceMarket.id}`,
        auth.token ?? ''
      );
      setRawResults(data.results);
      setMarketHasMore(data.meta.hasMore ?? data.results.length >= 50);
    } catch (e) {
      console.error('Failed to load market:', e);
      setMarketError((e as Error).message);
      // Revert whichever hub changed so the selector doesn't show a hub whose prices failed.
      if (sellChanged) {
        setSelectedMarket(MARKETS[0]);
        localStorage.setItem('forge-sell-market', String(MARKETS[0].id));
      } else {
        setSelectedSourceMarket(MARKETS[0]);
        localStorage.setItem('forge-source-market', String(MARKETS[0].id));
      }
    } finally {
      setMarketLoading(false);
    }
  }, [auth.token, selectedMarket.id]);

  const handleSendMessage = useCallback(async (text: string) => {
    const now    = Date.now();
    const userMsg: ChatMessage = {
      id:        `user-${now}`,
      role:      'user',
      content:   text,
      timestamp: new Date(now),
    };

    setChatMessages((prev) => [...prev, userMsg]);
    setChatOpen(true);
    setThinking(true);

    if (auth.character && auth.token) {
      apiPost('/api/save-message', {
        characterId:    auth.character.characterId,
        role:           'user',
        content:        text,
        conversationId: 'default',
      }, auth.token).catch(() => {});
    }

    try {
      const history = [...chatMessages.slice(-10), userMsg].map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const response = await fetch('/api/ai-chat', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${auth.token ?? ''}`,
          // v1.23 — corp access in the AI follows the selected view character (the
          // sidebar chip), mirroring the Corp tab. corpToken is a Director alt's token
          // when one is selected, else the primary's. Lets the AI see corp blueprints
          // whenever the Corp tab can.
          'X-Viewer-Token': corpToken ?? '',
        },
        body: JSON.stringify({
          messages: history,
          // Pass the currently viewed item so the AI knows what the user is looking at
          // and whether they own a blueprint for it — used by the server to extend builtContext.
          ...(selectedTypeId && selectedName ? {
            viewedItem: {
              typeId: selectedTypeId,
              name:   selectedName,
              bpOwned: !!selectedBp,
              bpType:  selectedBp ? (selectedBp.quantity === -1 ? 'BPO' : 'BPC') : null,
              bpME:    selectedBp?.material_efficiency ?? null,
              bpTE:    selectedBp?.time_efficiency     ?? null,
            },
          } : {}),
        }),
      });

      const data = await response.json() as AiChatResponse;

      if (!response.ok || data.error) {
        const msg = data.code === 'SESSION_EXPIRED'
          ? 'Session expired — please refresh the page to reconnect your character.'
          : (data.error ?? `Server error ${response.status}`);
        throw new Error(msg);
      }

      const assistantText =
        data.content?.find((b) => b.type === 'text')?.text ??
        'No response received.';

      const assistantMsg: ChatMessage = {
        id:        `assist-${Date.now()}`,
        role:      'assistant',
        content:   assistantText,
        timestamp: new Date(),
      };

      setChatMessages((prev) => [...prev, assistantMsg]);

      if (auth.character && auth.token) {
        apiPost('/api/save-message', {
          characterId:    auth.character.characterId,
          role:           'assistant',
          content:        assistantText,
          conversationId: 'default',
        }, auth.token).catch(() => {});
      }

    } catch (e) {
      const errMsg: ChatMessage = {
        id:        `err-${Date.now()}`,
        role:      'assistant',
        content:   `Sorry, I couldn't process that: ${(e as Error).message}`,
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, errMsg]);
    }

    setThinking(false);
  }, [auth.token, auth.character, chatMessages, corpToken, selectedTypeId, selectedName, selectedBp]);

  const handleClearHistory = useCallback(async () => {
    if (!auth.character || !auth.token) return;
    try {
      const res = await fetch(`/api/chat-history/${auth.character.characterId}`, {
        method:  'DELETE',
        headers: { 'Authorization': `Bearer ${auth.token}` },
      });
      if (res.ok) {
        setChatMessages([]);
        setHistoryLoaded(false);
      }
    } catch {
      // ignore
    }
  }, [auth.character, auth.token]);

  if (auth.status === 'idle' || auth.status === 'error') {
    const everAuthed = !!localStorage.getItem('forge_ever_authed');

    // Returning users who explicitly logged out or expired: go straight to login screen
    if (everAuthed) {
      return (
        <div className="app" data-theme={theme} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <LoginScreen onLogin={auth.login} error={auth.error} sessionExpired={sessionExpired} />
        </div>
      );
    }

    // First-time visitors: show the Guide as the landing page with a login CTA
    return (
      <div className="app" data-theme={theme} style={{ flexDirection: 'column', overflowY: 'auto' }}>
        <div style={{
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border)',
          padding: '16px 28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-accent)', letterSpacing: 2, textTransform: 'uppercase' }}>
              FORGE
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
              EVE Online Manufacturing Intelligence
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
            {auth.error && (
              <div style={{ fontSize: 11, color: 'var(--color-warn)', textAlign: 'right' }}>
                {auth.error}
              </div>
            )}
            <button
              type="button"
              className="login-btn"
              onClick={auth.login}
              style={{ fontSize: 13, padding: '8px 20px', whiteSpace: 'nowrap' }}
            >
              Link EVE Character →
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <HelpTab />
        </div>
      </div>
    );
  }

  if (auth.status === 'exchanging' || auth.status === 'loading') {
    return (
      <div className="app" data-theme={theme} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoadingScreen step={auth.loadStep} log={auth.dataLog} />
      </div>
    );
  }

  const character = auth.character!;

  const tickerCtx = {
    addPin:    ticker.addPin,
    removePin: ticker.removePin,
    isPinned:  ticker.isPinned,
    pins:      ticker.displayPins, // active group's pins — what ⊕ buttons check
  };

  return (
    <TickerContext.Provider value={tickerCtx}>
    <div className="app" data-theme={theme}>
      <Header
        character={character}
        chatOpen={chatOpen}
        theme={theme}
        font={font}
        selectedMarket={selectedMarket}
        selectedSourceMarket={selectedSourceMarket}
        regionLoading={marketLoading}
        mfgSystemName={industrySettings?.system_name ?? null}
        onToggleChat={handleToggleChat}
        onMenuToggle={() => setDrawerOpen((o) => !o)}
        onThemeChange={setTheme}
        onFontChange={setFont}
        onLogout={auth.logout}
        onMarketChange={market => loadMarket(market, selectedSourceMarket)}
        onSourceMarketChange={market => loadMarket(selectedMarket, market)}
        onOpenSettings={() => { setSettingsFocus(null); setSettingsOpen(true); }}
        canDockKeestar={auth.canDockKeestar}
      />

      {/* Re-auth banner: shown if standings scope not yet granted */}
      {!auth.hasStandingsScope && (
        <div className="reauth-banner" role="alert">
          FORGE needs one additional permission for accurate broker fees.
          Please{' '}
          <button type="button" onClick={auth.logout}>
            log out and back in
          </button>
          {' '}to grant it. (Broker fee will use skill levels only until then.)
        </div>
      )}

      <div
        className="app-body"
        ref={appBodyRef}
        style={{
          '--left-panel-w':  `${leftWidth}px`,
          '--right-panel-w': detailOpen ? `${rightWidth}px` : '0px',
          // v1.33.1 — matches TickerBar's own dual-row condition (dualRow AND 2+ groups)
          // so content never renders behind the taller dual-row ticker bar.
          paddingBottom: (ticker.dualRow && ticker.groupOps.groups.length >= 2) ? '68px' : '38px',
        } as React.CSSProperties}
        onClick={(e) => {
          if (!chatAutoOpened) return;
          if (!(e.target as HTMLElement).closest('.chat-panel')) {
            setChatOpen(false);
            setChatAutoOpened(false);
          }
        }}
      >
        {/* Mobile drawer backdrop */}
        {drawerOpen && (
          <div
            className="sidebar-overlay"
            onClick={() => setDrawerOpen(false)}
            style={{ display: 'block' }}
          />
        )}

        <LeftSidebar
          character={character}
          blueprints={allBlueprints}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setDrawerOpen(false);
          }}
          drawerOpen={drawerOpen}
          onQuickPrompt={handleSendMessage}
          altCharacters={auth.altCharacters}
          onRemoveCharacter={auth.removeCharacter}
          onManageCharacters={() => setCharModalOpen(true)}
          viewCharacterId={viewCharacterId}
          onViewChange={setViewCharacterId}
          totalWalletISK={totalWalletISK}
          pushState={pushState}
          onPushEnable={pushEnable}
          onPushDisable={pushDisable}
        />

        {charModalOpen && (
          <CharacterManagementModal
            character={character}
            altCharacters={auth.altCharacters}
            addingAlt={auth.addingAlt}
            onAddCharacter={auth.addCharacter}
            onRemoveCharacter={(id) => {
              auth.removeCharacter(id);
              if (viewCharacterId === id) setViewCharacterId(null);
            }}
            onMakePrimary={auth.makePrimary}
            onClose={() => setCharModalOpen(false)}
            rememberEnabled={auth.rememberEnabled}
            rememberConfigured={auth.rememberConfigured}
            rememberedCharacters={auth.rememberedCharacters}
            onSetRemember={auth.setRemember}
            onForgetRemembered={auth.forgetRememberedCharacter}
            onRestoreRemembered={auth.restoreRememberedCharacters}
          />
        )}

        {/* Drag handle: resize left sidebar (desktop only) */}
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation panel"
          title="Drag to resize"
          onPointerDown={startPanelDrag('left')}
        />

        <MainContent
          activeTab={activeTab}
          onTabChange={setActiveTab}
          marketItems={marketItems}
          marketLoading={marketLoading}
          marketError={marketError}
          marketSearchQuery={marketSearchQuery}
          marketSearching={marketSearching}
          onMarketSearch={handleMarketSearch}
          blueprints={allBlueprints}
          assets={combinedAssets}
          rawAssets={allRawAssets}
          activeJobs={allActiveJobs}
          itemNames={itemNames}
          walletISK={totalWalletISK}
          selectedTypeId={selectedTypeId}
          onSelectItem={handleSelectItem}
          onSelectArbItem={handleSelectArbItem}
          regionId={selectedMarket.id}
          materialRegionId={selectedSourceMarket.id}
          onOpenSettings={(section) => { setSettingsFocus(section ?? null); setSettingsOpen(true); }}
          importHaulConfigured={!!industrySettings?.haul_enabled && ((industrySettings.leg1_method ?? 'user_defined') !== 'user_defined'
            || (industrySettings.leg1_haul_rate ?? 0) > 0 || (industrySettings.leg1_isk_per_jump ?? 0) > 0 || (industrySettings.leg1_flat_total ?? 0) > 0)}
          onMarketSelect={handleItemSelect}
          onLoadMoreMarket={handleLoadMoreMarket}
          marketLoadingMore={marketLoadingMore}
          marketHasMore={marketHasMore}
          haulConfigured={!!(industrySettings?.haul_enabled)}
          token={corpToken}
          primaryToken={auth.token}
          lpPoints={auth.character?.lpPoints ?? []}
          piCharacters={piCharacters}
          queueCharacters={queueCharacters}
          corpStatus={corpStatus}
          accessStatus={corpAccessStatus}
          corpDataLoading={corpDataLoading}
          blueprintOwnerMap={blueprintOwnerMap}
          haulConfigOpen={interHubHaulConfigOpen}
          onHaulConfigOpen={() => setInterHubHaulConfigOpen(true)}
          onHaulConfigClose={() => setInterHubHaulConfigOpen(false)}
          interHubToken={auth.token ?? undefined}
          interHubCharacters={[
            ...(auth.character ? [{
              characterId: auth.character.characterId,
              name:        auth.character.name,
              skills:      auth.skills,
            }] : []),
            ...auth.altCharacters.filter(a => !a.loading && !a.error).map(a => ({
              characterId: a.characterId,
              name:        a.name,
              skills:      a.skills,
            })),
          ]}
          onInterHubHaulSaved={() => setInterHubHaulRefreshKey(k => k + 1)}
          canDockKeestar={auth.canDockKeestar}
          bpMetadataProp={bpMetadataApp}
        />

        {/* Drag handle: resize the info panel — only when it's open (desktop only) */}
        {detailOpen && (
          <div
            className="resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize information panel"
            title="Drag to resize"
            onPointerDown={startPanelDrag('right')}
          />
        )}

        {/* Tablet overlay (dims background when detail panel is open) */}
        <div
          className={`sidebar-overlay${detailOpen ? ' detail-open' : ''}`}
          onClick={handleCloseDetail}
        />

        <RightSidebar
          selectedTypeId={selectedTypeId}
          selectedName={selectedName}
          fallbackDetail={selectedDetail}
          apiDetail={apiDetail}
          detailLoading={detailLoading}
          detailError={detailError}
          detailOpen={detailOpen}
          blueprints={allBlueprints}
          itemNames={itemNames}
          selectedMarket={selectedMarket}
          trueCostData={trueCostData}
          trueCostLoading={trueCostLoading}
          trueCostError={trueCostError}
          onClose={handleCloseDetail}
          onOpenSettings={(section) => { setSettingsFocus(section ?? null); setSettingsOpen(true); }}
          onSelectItem={handleSelectItem}
          onBack={handlePanelBack}
          canGoBack={panelHistory.length > 0}
          altCharacters={auth.altCharacters}
          primaryCharacterName={auth.character?.name ?? ''}
          feeCharacterId={feeCharacterId}
          feeCharacterName={feeCharacterName}
          onFeeCharacterChange={setFeeCharacterId}
          buildRuns={buildRuns}
          onBuildRunsChange={setBuildRuns}
          selectedVolume={selectedVolume}
          selectedLiquidityRisk={selectedLiquidityRisk}
          selectedVolumeSource={selectedVolumeSource}
          activeImplants={auth.implants}
          jumpClones={auth.jumpClones}
          selectedImplants={selectedImplants}
          onImplantsChange={setSelectedImplants}
          materialRegionId={selectedSourceMarket.id}
          materialMarketName={selectedSourceMarket.name}
          walletISK={totalWalletISK}
          inventionDecryptorType={inventionDecryptorType}
          onInventionDecryptorChange={setInventionDecryptorType}
          inventionProbBonus={inventionProbBonus}
          onInventionProbBonusChange={setInventionProbBonus}
          interHubContext={interHubContext}
          interHubHaulData={interHubHaulData}
          interHubHaulLoading={interHubHaulLoading}
          onConfigureInterHubHaul={() => setInterHubHaulConfigOpen(true)}
        />

        <ChatPanel
          open={chatOpen}
          messages={chatMessages}
          thinking={thinking}
          quickPrompts={QUICK_PROMPTS}
          onSend={handleSendMessage}
          onItemSelect={handleItemSelect}
          onClearHistory={handleClearHistory}
        />
      </div>

      <TickerBar
        mode="main"
        displayPins={ticker.displayPins}
        allPins={ticker.pins}
        slots={ticker.slots}
        payload={ticker.broadcastPayload}
        groupOps={ticker.groupOps}
        dualRow={ticker.dualRow}
        onRemovePin={ticker.removePin}
        onReorder={ticker.reorderPins}
        onToggleDualRow={ticker.toggleDualRow}
      />

      {/* v1.2.0 — Manufacturing Setup modal */}
      <IndustrySettingsModal
        open={settingsOpen}
        focusSection={settingsFocus}
        token={auth.token}
        initial={industrySettings}
        sourceMarket={selectedSourceMarket}
        sellMarket={selectedMarket}
        onClose={() => { setSettingsOpen(false); setSettingsFocus(null); }}
        onSaved={(settings) => {
          setIndustrySettings(settings);
          setSettingsVersion((v) => v + 1);
          setSettingsOpen(false);
          setSettingsFocus(null);
        }}
        characters={[
          ...(auth.character ? [{
            characterId: auth.character.characterId,
            name:        auth.character.name,
            skills:      auth.skills,
          }] : []),
          ...auth.altCharacters.filter(a => !a.loading && !a.error).map(a => ({
            characterId: a.characterId,
            name:        a.name,
            skills:      a.skills,
          })),
        ]}
      />

    </div>

    {showTickerIntro && <TickerIntro onClose={() => setShowTickerIntro(false)} />}

    </TickerContext.Provider>
  );
};

// Standalone/popout checks must live outside AppShell to avoid
// calling hooks conditionally (Rules of Hooks).
const App: FC = () => {
  const params = new URLSearchParams(window.location.search);
  const isStandalone = params.get('standalone') === '1' && window.location.pathname === '/trading';
  const isTicker     = params.get('ticker') === '1';
  if (isStandalone) return <TradingStandalone />;
  if (isTicker)     return <TickerBar mode="popout" />;
  return <AppShell />;
};

export default App;
