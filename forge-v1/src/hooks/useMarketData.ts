import type { AuthState } from './useAuth';
import { useState, useRef, useCallback } from 'react';
import { type TopProfitableResponse, type Market } from '../types';
import { MARKETS } from '../data/markets';
import { apiGet } from '../api/client';

interface UseMarketDataParams {
  auth: AuthState & { login: () => void; logout: () => void; addCharacter: () => void; removeCharacter: (characterId: number) => void; setRemember: (enabled: boolean) => Promise<void>; restoreRememberedCharacters: (characterIds: number[]) => Promise<{ characterId: number; name: string; error?: string | undefined; }[]>; forgetRememberedCharacter: (characterId: number) => Promise<void>; forgetAllRemembered: () => Promise<void>; };
}

export function useMarketData({ auth }: UseMarketDataParams) {
  const [rawResults,        setRawResults]        = useState<TopProfitableResponse['results']>([]);

  const [marketLoading,     setMarketLoading]     = useState(false);

  const [marketLoadingMore, setMarketLoadingMore] = useState(false);

  const [marketSearchQuery, setMarketSearchQuery] = useState('');

  const [marketSearchResults, setMarketSearchResults] = useState<TopProfitableResponse['results'] | null>(null);

  const [marketSearching,   setMarketSearching]   = useState(false);

  const marketSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ref-based guard prevents duplicate concurrent "load more" fetches.
  // React state updates are async so the closed-over state value can be stale
  // when two click events fire before the first re-render; a ref is set synchronously.
  const loadingMoreRef = useRef(false);

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

  return { handleLoadMoreMarket, handleMarketSearch, loadMarket, marketError, marketHasMore, marketLoading, marketLoadingMore, marketSearchQuery, marketSearchResults, marketSearching, rawResults, selectedMarket, selectedSourceMarket, setMarketError, setMarketHasMore, setMarketLoading, setRawResults };
}
