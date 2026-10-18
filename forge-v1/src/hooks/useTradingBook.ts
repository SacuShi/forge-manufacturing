/**
 * useTradingBook — polls /api/trading/scan and manages the watchlist.
 * Refresh is aligned to jitaBookMeta.expiresInSec so we don't poll faster
 * than ESI actually updates (~5 min cycles).
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { apiPost } from '../api/client';
import type { TradingScanResponse, TradingScanItem, TradingWatchlistEntry } from '../types';

const WATCHLIST_KEY    = 'forge_watchlist';
const MIN_REFRESH_MS   = 60_000;   // never faster than 1 min (normal operation)
const MAX_REFRESH_MS   = 360_000;  // never slower than 6 min
const WARMING_POLL_MS  = 4_000;    // poll every 4s while book is warming

export interface ScanFilters {
  hub:           string;
  minMarginPct:  number;
  minVolume:     number;
  capital:       number | null;
  maxSellOrders: number | null;
}

export interface UseTradingBookResult {
  scanData:        TradingScanResponse | null;
  scanning:        boolean;
  scanError:       string | null;
  lastRefreshed:   Date | null;
  nextRefreshIn:   number;           // seconds
  runScan:         () => void;
  watchlist:       TradingWatchlistEntry[];
  addToWatchlist:  (item: Pick<TradingScanItem, 'typeId' | 'name'>) => void;
  removeFromWatchlist: (typeId: number) => void;
  isWatched:       (typeId: number) => boolean;
}

function loadWatchlist(): TradingWatchlistEntry[] {
  try {
    return JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveWatchlist(list: TradingWatchlistEntry[]): void {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

export function useTradingBook(
  token: string | null,
  filters: ScanFilters,
  autoRun = true,
): UseTradingBookResult {
  const [scanData,      setScanData]      = useState<TradingScanResponse | null>(null);
  const [scanning,      setScanning]      = useState(false);
  const [scanError,     setScanError]     = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [nextRefreshIn, setNextRefreshIn] = useState(0);
  const [watchlist,     setWatchlist]     = useState<TradingWatchlistEntry[]>(loadWatchlist);

  const timerRef          = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionPollCount  = useRef(0);  // limits fast-polls when sessionCached is persistently false
  const filtersRef        = useRef(filters);
  const runScanRef        = useRef<() => void>(() => {});   // the latest runScan, for the timers that re-run it
  // Keep the latest filters readable by scheduled scans (written after render, not during it).
  useEffect(() => { filtersRef.current = filters; });

  const clearTimers = useCallback(() => {
    if (timerRef.current)     { clearTimeout(timerRef.current);   timerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
  }, []);

  const startCountdown = useCallback((seconds: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    let remaining = seconds;
    setNextRefreshIn(remaining);
    countdownRef.current = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      setNextRefreshIn(remaining);
    }, 1000);
  }, []);

  const runScan = useCallback(() => {
    if (!token) return;
    clearTimers();
    setScanning(true);
    setScanError(null);

    const f = filtersRef.current;
    apiPost<TradingScanResponse>('/api/trading/scan', {
      hub:           f.hub,
      minMarginPct:  f.minMarginPct,
      minVolume:     f.minVolume,
      capital:       f.capital,
      maxSellOrders: f.maxSellOrders,
    }, token)
      .then(data => {
        setScanData(data);
        setLastRefreshed(new Date());
        setScanning(false);

        const needsFastPoll = data.meta?.warming ||
          (data.sessionCached === false && sessionPollCount.current < 10);
        if (needsFastPoll) {
          // Book still fetching OR session not yet cached — poll fast (max 10 retries for session)
          if (data.sessionCached === false) sessionPollCount.current += 1;
          startCountdown(Math.round(WARMING_POLL_MS / 1000));
          timerRef.current = setTimeout(() => runScanRef.current(), WARMING_POLL_MS);
        } else {
          if (data.sessionCached !== false) sessionPollCount.current = 0; // reset on success
          // Book is ready — align next refresh to when ESI cache expires
          const expiresIn = data.meta?.expiresInSec ?? 300;
          const delay = Math.min(Math.max(expiresIn * 1000 + 10_000, MIN_REFRESH_MS), MAX_REFRESH_MS);
          startCountdown(Math.round(delay / 1000));
          timerRef.current = setTimeout(() => runScanRef.current(), delay);
        }
      })
      .catch(err => {
        setScanError(err.message || 'Scan failed');
        setScanning(false);
        // Back off 2 min on error
        startCountdown(120);
        timerRef.current = setTimeout(() => runScanRef.current(), 120_000);
      });
  }, [token, clearTimers, startCountdown]);
  useEffect(() => { runScanRef.current = runScan; }, [runScan]);

  // Auto-run when token is available
  useEffect(() => {
    if (autoRun && token) runScan();
    return clearTimers;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Watchlist helpers
  const addToWatchlist = useCallback((item: Pick<TradingScanItem, 'typeId' | 'name'>) => {
    setWatchlist(prev => {
      if (prev.some(w => w.typeId === item.typeId)) return prev;
      const next = [...prev, { typeId: item.typeId, name: item.name }];
      saveWatchlist(next);
      return next;
    });
  }, []);

  const removeFromWatchlist = useCallback((typeId: number) => {
    setWatchlist(prev => {
      const next = prev.filter(w => w.typeId !== typeId);
      saveWatchlist(next);
      return next;
    });
  }, []);

  const isWatched = useCallback((typeId: number) =>
    watchlist.some(w => w.typeId === typeId), [watchlist]);

  return {
    scanData, scanning, scanError, lastRefreshed, nextRefreshIn, runScan,
    watchlist, addToWatchlist, removeFromWatchlist, isWatched,
  };
}
