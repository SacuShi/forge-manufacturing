// FORGE v1.0 — App root. Auth states: idle/exchanging/loading → authed | error

import { useState, useEffect, useCallback, useMemo, useRef, type FC } from 'react';
import type {
  ChatMessage,
  MarketItem,
  ItemDetail,
  TopProfitableResponse,
  AiChatResponse,
  Market,
  IndustrySettings,
  FeeRates,
  EsiBlueprint,
  EsiAsset,
} from './types';
import { MARKETS } from './components/MarketSelector';
import { useAuth }       from './hooks/useAuth';
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
import IndustrySettingsModal from './components/IndustrySettings';
import { useCorpData }       from './hooks/useCorpData';

/**
 * Maps raw precomputed results to MarketItem display rows.
 *
 * When feeRates is provided (post-login), profit/margin/ISK-hr are
 * recalculated with the same formula as /api/true-cost so both the
 * Market Opportunities table and the True Profit panel show consistent
 * figures:
 *
 *   me         = best owned blueprint ME level (0 if unowned)
 *   meFactor   = max(0, 1 − me/100)
 *   adjMatCost = material_cost × meFactor        (ME reduces material spend)
 *   jobCost    = adjMatCost × (sci + 0.02 + facilityTax)
 *   fees       = sell_price × (brokerFeeRate + transactionTaxRate)
 *   profit     = sell_price − adjMatCost − jobCost − fees
 */
function mapToMarketItems(
  results: TopProfitableResponse['results'],
  esiBlueprints: EsiBlueprint[],
  feeRates: FeeRates | null = null,
  rankOffset = 0
): MarketItem[] {
  // Map blueprint type_id → owned status + best ME level
  const bpMap  = new Map<number, 'BPO' | 'BPC'>();
  const bpMeMap = new Map<number, number>();

  esiBlueprints.forEach((bp) => {
    const isBpo = bp.runs === -1;
    // BPO wins if any copy is an original (don't downgrade BPO → BPC)
    if (isBpo || !bpMap.has(bp.type_id)) {
      bpMap.set(bp.type_id, isBpo ? 'BPO' : 'BPC');
    }
    // Track highest ME among owned copies (BPO usually has best ME)
    const me = bp.material_efficiency ?? 0;
    if (!bpMeMap.has(bp.type_id) || me > (bpMeMap.get(bp.type_id) ?? 0)) {
      bpMeMap.set(bp.type_id, me);
    }
  });

  return results.map((item, index) => {
    const owned = bpMap.get(item.blueprint_id) ?? '—';

    let profitPerRun = item.profit;
    let margin       = item.profit_margin;
    let iskPerHour   = item.isk_per_hour;

    // Apply fee-adjusted math when rates are available and sell price is known
    if (feeRates && item.sell_price > 0) {
      const me        = bpMeMap.get(item.blueprint_id) ?? 0;
      const meFactor  = Math.max(0, 1 - me / 100);

      // ME-adjusted material cost (precomputed baseline is ME=0)
      const adjMatCost = item.material_cost * meFactor;

      // Manufacturing job cost: EIV proxy = adjMatCost; see /api/true-cost for exact formula
      const jobCost = adjMatCost * (feeRates.sci + feeRates.scc_rate + feeRates.facility_tax);

      // Sales fees: broker fee + transaction tax on full sell revenue
      const fees = item.sell_price * (feeRates.broker_fee_rate + feeRates.transaction_tax_rate);

      profitPerRun = item.sell_price - adjMatCost - jobCost - fees;
      margin       = (profitPerRun / item.sell_price) * 100;
      const buildHrs = (item.build_time ?? 0) / 3600;
      iskPerHour   = buildHrs > 0 ? profitPerRun / buildHrs : 0;
    }

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
      canBuild:         owned !== '—',
      priceSource:      item.price_source ?? null,
      avg30dPrice:      item.avg_30d_price ?? null,
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

const App: FC = () => {
  const auth = useAuth();
  const { names: itemNames, loading: itemNamesLoading, resolveUnknown } = useItemNames();

  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem('forge-theme') ?? 'dark'
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
  const [marketHasMore,     setMarketHasMore]     = useState(true);
  const [marketError,       setMarketError]       = useState<string | null>(null);
  const [selectedMarket,    setSelectedMarket]    = useState<Market>(MARKETS[0]);
  // v1.3.0 — Source hub: where materials are purchased. Persisted across sessions.
  const [selectedSourceMarket, setSelectedSourceMarket] = useState<Market>(() => {
    const saved = localStorage.getItem('forge-source-market');
    if (saved) {
      const found = MARKETS.find((m) => m.id === parseInt(saved, 10));
      if (found) return found;
    }
    return MARKETS[0]; // default: Jita
  });

  // v1.5.1 — Character fee rates (broker, tax, SCI, facility tax) for profit alignment
  const [feeRates, setFeeRates] = useState<FeeRates | null>(null);

  // v1.2.0 — Industry settings + settings modal
  const [industrySettings, setIndustrySettings] = useState<IndustrySettings | null>(null);
  const [settingsOpen,     setSettingsOpen]     = useState(false);

  // v1.5 — Multi-character: view isolation + fee character selection
  // viewCharacterId: null = combined view; a characterId = isolated single-char view
  // feeCharacterId:  null = use primary character's token for fee/true-cost calls
  const [viewCharacterId, setViewCharacterId] = useState<number | null>(null);
  const [feeCharacterId,  setFeeCharacterId]  = useState<number | null>(null);
  const [buildRuns,       setBuildRuns]       = useState(1);

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
    const skillHash = bestSkillsArray.reduce((acc, s) => acc + s.active_skill_level, 0);
    // Include sorted alt IDs so adding/removing a zero-asset alt (same counts) still
    // triggers a re-POST to keep the server session in sync.
    const altIds    = activeAltCharacters.map((a) => a.characterId).sort().join(',');
    return `${allBlueprints.length}:${combinedAssets.length}:${bestSkillsArray.length}:${skillHash}:${altIds}`;
  }, [allBlueprints, combinedAssets, bestSkillsArray, activeAltCharacters]);

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

  // Derive marketItems from rawResults (paginated list) or marketSearchResults (search).
  // When feeRates are loaded, profit/margin/ISK-hr are recalculated with the same
  // formula as True Profit so both panels show consistent figures.
  // Uses allBlueprints so owned status reflects all in-scope characters.
  const marketItems = useMemo<MarketItem[]>(() => {
    const source = marketSearchResults ?? rawResults;
    if (!source.length) return [];
    return mapToMarketItems(source, allBlueprints, feeRates);
  }, [rawResults, marketSearchResults, allBlueprints, feeRates]);

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
  const { selectedBlueprintME, selectedBlueprintTE } = useMemo(() => {
    if (!selectedTypeId || !itemNames.size || !allBlueprints.length) {
      return { selectedBlueprintME: 0, selectedBlueprintTE: 0 };
    }
    const productName = itemNames.get(selectedTypeId);
    if (!productName) return { selectedBlueprintME: 0, selectedBlueprintTE: 0 };
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
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('forge-theme', theme);
  }, [theme]);

  // Listen for 401 events fired by apiGet/apiPost — show expiry message on login screen
  useEffect(() => {
    const handleExpiry = () => setSessionExpired(true);
    window.addEventListener('forge:session-expired', handleExpiry);
    return () => window.removeEventListener('forge:session-expired', handleExpiry);
  }, []);

  // Reset expiry flag once the user successfully logs in again
  useEffect(() => {
    if (auth.status === 'authed') setSessionExpired(false);
  }, [auth.status]);

  // v1.2.0 — Load saved industry settings on login
  useEffect(() => {
    if (auth.status !== 'authed' || !auth.token) return;
    apiGet<IndustrySettings>('/api/industry-settings', auth.token)
      .then(setIndustrySettings)
      .catch(() => { /* non-fatal — settings remain null */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status]);

  // v1.5 — Load fee rates on login, hub change, or fee-character change.
  // feeToken resolves to primary or a selected alt's token.
  useEffect(() => {
    if (auth.status !== 'authed' || !feeToken) return;
    apiGet<FeeRates>(
      `/api/character-fee-rates?sellRegionId=${selectedMarket.id}`,
      feeToken
    )
      .then(setFeeRates)
      .catch(() => { /* non-fatal — falls back to precomputed figures */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, selectedMarket.id, feeToken]);

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
        skills:    bestSkillsArray,
        standings: auth.hasStandingsScope ? auth.primaryStandings : null,
      }, auth.token ?? undefined).catch(() => { /* non-fatal */ });
    }, 1500);

    return () => {
      if (sessionRePostTimerRef.current) clearTimeout(sessionRePostTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.token, combinedDataVersion]);

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

  const selectedDetail: ItemDetail | null = (() => {
    if (!selectedTypeId) return null;
    const raw = rawResults.find((r) => r.product_id === selectedTypeId);
    if (!raw) return null;
    const mi = marketItems.find((m) => m.typeId === selectedTypeId);
    return toItemDetail(raw, mi?.owned ?? '—');
  })();

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

  const handleMarketChange = useCallback(async (market: Market) => {
    setSelectedMarket(market);
    setRawResults([]);
    setMarketSearchResults(null);
    setMarketSearchQuery('');
    setMarketHasMore(true);
    setMarketError(null);
    setMarketLoading(true);
    try {
      const data = await apiGet<TopProfitableResponse>(
        `/api/top-profitable-by-skills?limit=50&regionId=${market.id}&sourceRegionId=${selectedSourceMarket.id}`,
        auth.token ?? ''
      );
      setRawResults(data.results);
      setMarketHasMore(data.meta.hasMore ?? data.results.length >= 50);
    } catch (e) {
      console.error('Failed to load market for region:', e);
      setMarketError((e as Error).message);
      setSelectedMarket(MARKETS[0]);
    } finally {
      setMarketLoading(false);
    }
  }, [auth.token, selectedSourceMarket.id]);

  // v1.3.0 — Source hub change: persist selection, then reload the market table
  // so profit/margin/ISK-per-hour all reflect the new material purchase costs.
  const handleSourceMarketChange = useCallback(async (market: Market) => {
    setSelectedSourceMarket(market);
    localStorage.setItem('forge-source-market', String(market.id));
    setRawResults([]);
    setMarketHasMore(true);
    setMarketError(null);
    setMarketLoading(true);
    try {
      const data = await apiGet<TopProfitableResponse>(
        `/api/top-profitable-by-skills?limit=50&regionId=${selectedMarket.id}&sourceRegionId=${market.id}`,
        auth.token ?? ''
      );
      setRawResults(data.results);
      setMarketHasMore(data.meta.hasMore ?? data.results.length >= 50);
    } catch (e) {
      console.error('Failed to load market with new source region:', e);
      setMarketError((e as Error).message);
      // Revert source on error so the selector doesn't show a hub whose prices failed
      setSelectedSourceMarket(MARKETS[0]);
      localStorage.setItem('forge-source-market', String(MARKETS[0].id));
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
        },
        body: JSON.stringify({ messages: history }),
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
  }, [auth.token, auth.character, chatMessages]);

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
    return (
      <div className="app" data-theme={theme} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LoginScreen onLogin={auth.login} error={auth.error} sessionExpired={sessionExpired} />
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

  return (
    <div className="app" data-theme={theme}>
      <Header
        character={character}
        chatOpen={chatOpen}
        theme={theme}
        selectedMarket={selectedMarket}
        selectedSourceMarket={selectedSourceMarket}
        regionLoading={marketLoading}
        mfgSystemName={industrySettings?.system_name ?? null}
        onToggleChat={handleToggleChat}
        onMenuToggle={() => setDrawerOpen((o) => !o)}
        onThemeToggle={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onLogout={auth.logout}
        onMarketChange={handleMarketChange}
        onSourceMarketChange={handleSourceMarketChange}
        onOpenSettings={() => setSettingsOpen(true)}
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
          addingAlt={auth.addingAlt}
          onAddCharacter={auth.addCharacter}
          onRemoveCharacter={auth.removeCharacter}
          viewCharacterId={viewCharacterId}
          onViewChange={setViewCharacterId}
          totalWalletISK={totalWalletISK}
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
          activeJobs={allActiveJobs}
          itemNames={itemNames}
          selectedTypeId={selectedTypeId}
          onSelectItem={handleSelectItem}
          regionId={selectedMarket.id}
          onMarketSelect={handleItemSelect}
          onLoadMoreMarket={handleLoadMoreMarket}
          marketLoadingMore={marketLoadingMore}
          marketHasMore={marketHasMore}
          haulConfigured={!!(industrySettings?.haul_enabled)}
          token={corpToken}
          corpStatus={corpStatus}
          accessStatus={corpAccessStatus}
          corpDataLoading={corpDataLoading}
          blueprintOwnerMap={blueprintOwnerMap}
        />

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
          onOpenSettings={() => setSettingsOpen(true)}
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

      {/* v1.2.0 — Manufacturing Setup modal */}
      <IndustrySettingsModal
        open={settingsOpen}
        token={auth.token}
        initial={industrySettings}
        sourceMarket={selectedSourceMarket}
        sellMarket={selectedMarket}
        onClose={() => setSettingsOpen(false)}
        onSaved={(settings) => {
          setIndustrySettings(settings);
          setSettingsOpen(false);
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
  );
};

export default App;
