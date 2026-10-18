// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('../../api/client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { useItemDetail } from '../useItemDetail';
import type { EsiAsset, EsiBlueprint, ItemDetailApiResponse } from '../../types';

const detail = (n: number, over: Partial<ItemDetailApiResponse> = {}) => ({ typeId: n, pricesWarm: true, ...over }) as unknown as ItemDetailApiResponse;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const NO_ASSETS: EsiAsset[] = [];
const NO_BPS: EsiBlueprint[] = [];

const render = (typeId: number | null = 1, assets = NO_ASSETS, blueprints = NO_BPS) => renderHook(
  (p: { typeId: number | null; assets: EsiAsset[]; blueprints: EsiBlueprint[] }) =>
    useItemDetail(p.typeId, p.assets, p.blueprints, 'tok', 10000002, 10000043),
  { initialProps: { typeId, assets, blueprints } },
);

beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useItemDetail', () => {
  it('stays idle with nothing selected', () => {
    const { result } = render(null);
    expect(result.current).toEqual({ detail: null, loading: false, error: null });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('loads the item and sends what the server needs', async () => {
    apiFetch.mockResolvedValue(ok(detail(1)));
    const { result } = render(1);
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.detail).toEqual(detail(1)));
    expect(result.current.loading).toBe(false);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/item-details');
    expect(JSON.parse(init.body)).toMatchObject({ typeId: 1, regionId: 10000002, materialRegionId: 10000043 });
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('drops the previous item immediately when another is selected', async () => {
    apiFetch.mockResolvedValueOnce(ok(detail(1)));
    const { result, rerender } = render(1);
    await waitFor(() => expect(result.current.detail).toEqual(detail(1)));
    const next = deferred<ReturnType<typeof ok>>();
    apiFetch.mockReturnValueOnce(next.promise);
    rerender({ typeId: 2, assets: NO_ASSETS, blueprints: NO_BPS });
    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { next.resolve(ok(detail(2))); });
    expect(result.current.detail).toEqual(detail(2));
    expect(result.current.loading).toBe(false);
  });

  it('refreshes when the pilot\'s holdings change under the same item', async () => {
    apiFetch.mockResolvedValueOnce(ok(detail(1)));
    const { result, rerender } = render(1);
    await waitFor(() => expect(result.current.detail).toEqual(detail(1)));
    apiFetch.mockResolvedValueOnce(ok(detail(1, { pricesWarm: true, currentPrice: { sell: 5 } } as never)));
    rerender({ typeId: 1, assets: [{ type_id: 34, quantity: 5 } as EsiAsset], blueprints: NO_BPS });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('ignores a slow answer for an item that is no longer selected', async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    apiFetch.mockReturnValueOnce(slow.promise);
    const { result, rerender } = render(1);
    apiFetch.mockResolvedValueOnce(ok(detail(2)));
    rerender({ typeId: 2, assets: NO_ASSETS, blueprints: NO_BPS });
    await waitFor(() => expect(result.current.detail).toEqual(detail(2)));
    await act(async () => { slow.resolve(ok(detail(99))); });
    expect(result.current.detail).toEqual(detail(2));
  });

  it('asks again every 6 seconds while the hub\'s prices are still loading, at most 6 times', async () => {
    vi.useFakeTimers();
    apiFetch.mockResolvedValue(ok(detail(1, { pricesWarm: false })));
    const { result } = render(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.loading).toBe(false);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000 * 10); });
    expect(apiFetch).toHaveBeenCalledTimes(7);   // the first call plus 6 retries
    expect(result.current.loading).toBe(false);
  });

  it('shows the server\'s error message, or the HTTP status', async () => {
    apiFetch.mockResolvedValueOnce(fail(500, { error: 'database is locked' }));
    const a = render(1);
    await waitFor(() => expect(a.result.current.error).toBe('database is locked'));
    expect(a.result.current.loading).toBe(false);

    apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new Error('not json'); } });
    const b = render(1);
    await waitFor(() => expect(b.result.current.error).toBe('HTTP 503'));
  });

  it('clears when the selection is removed', async () => {
    apiFetch.mockResolvedValueOnce(ok(detail(1)));
    const { result, rerender } = render(1);
    await waitFor(() => expect(result.current.detail).toEqual(detail(1)));
    rerender({ typeId: null, assets: NO_ASSETS, blueprints: NO_BPS });
    expect(result.current).toEqual({ detail: null, loading: false, error: null });
  });
});
