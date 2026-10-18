// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiPost = vi.fn();
vi.mock('../../api/client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));

import { useTradingBook, type ScanFilters } from '../useTradingBook';
import type { TradingScanResponse } from '../../types';

const scan = (over: Record<string, unknown> = {}) => ({ results: [], sessionCached: true, meta: { expiresInSec: 300 }, ...over }) as unknown as TradingScanResponse;
const filters = (over: Partial<ScanFilters> = {}) => ({ hub: 'jita', minMarginPct: 5, minVolume: 10, capital: 1e9, maxSellOrders: 20, ...over }) as ScanFilters;

type P = { token: string | null; filters: ScanFilters };
const render = (initial: P) => renderHook((p: P) => useTradingBook(p.token, p.filters), { initialProps: initial });

beforeEach(() => { vi.useFakeTimers(); apiPost.mockReset(); localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('useTradingBook', () => {
  it('does not scan without a token', async () => {
    render({ token: null, filters: filters() });
    await flush();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('scans on login with the current filters and reports the result', async () => {
    apiPost.mockResolvedValue(scan());
    const { result } = render({ token: 'tok', filters: filters() });
    expect(result.current.scanning).toBe(true);
    await flush();
    expect(result.current.scanning).toBe(false);
    expect(result.current.scanData).toEqual(scan());
    expect(result.current.lastRefreshed).toBeInstanceOf(Date);
    expect(apiPost).toHaveBeenCalledWith('/api/trading/scan', { hub: 'jita', minMarginPct: 5, minVolume: 10, capital: 1e9, maxSellOrders: 20 }, 'tok');
  });

  it('schedules the next refresh for when the server cache expires (+10 s)', async () => {
    apiPost.mockResolvedValue(scan({ meta: { expiresInSec: 120 } }));
    const { result } = render({ token: 'tok', filters: filters() });
    await flush();
    expect(result.current.nextRefreshIn).toBe(130);
    await act(async () => { await vi.advanceTimersByTimeAsync(129_000); });
    expect(apiPost).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('polls quickly while the server is still warming its book', async () => {
    apiPost.mockResolvedValue(scan({ meta: { warming: true } }));
    render({ token: 'tok', filters: filters() });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiPost.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('uses the filters as they are NOW when a scheduled scan fires', async () => {
    apiPost.mockResolvedValue(scan({ meta: { expiresInSec: 60 } }));
    const { rerender } = render({ token: 'tok', filters: filters() });
    await flush();
    rerender({ token: 'tok', filters: filters({ minMarginPct: 9 }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(apiPost.mock.calls.at(-1)![1].minMarginPct).toBe(9);
  });

  it('shows the error and backs off for two minutes', async () => {
    apiPost.mockRejectedValueOnce(new Error('ESI down'));
    const { result } = render({ token: 'tok', filters: filters() });
    await flush();
    expect(result.current.scanError).toBe('ESI down');
    expect(result.current.nextRefreshIn).toBe(120);
    apiPost.mockResolvedValue(scan());
    await act(async () => { await vi.advanceTimersByTimeAsync(120_500); });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(result.current.scanError).toBeNull();
  });

  it('stops its timers when it unmounts', async () => {
    apiPost.mockResolvedValue(scan({ meta: { expiresInSec: 30 } }));
    const { unmount } = render({ token: 'tok', filters: filters() });
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('keeps a watchlist in local storage', async () => {
    apiPost.mockResolvedValue(scan());
    const { result } = render({ token: null, filters: filters() });
    act(() => result.current.addToWatchlist({ typeId: 34, name: 'Tritanium' }));
    act(() => result.current.addToWatchlist({ typeId: 34, name: 'Tritanium' }));   // no duplicates
    expect(result.current.isWatched(34)).toBe(true);
    expect(JSON.parse(localStorage.getItem([...Object.keys(localStorage)][0])!)).toEqual([{ typeId: 34, name: 'Tritanium' }]);
    act(() => result.current.removeFromWatchlist(34));
    expect(result.current.isWatched(34)).toBe(false);
  });
});
