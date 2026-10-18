// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiPost = vi.fn();
vi.mock('../../api/client', () => ({ apiPost: (...a: unknown[]) => apiPost(...a) }));

import { useTrueCost } from '../useTrueCost';
import type { TrueCostResponse } from '../../types';

const result = (n: number, over: Partial<TrueCostResponse> = {}) =>
  ({ prices_warm: true, true_profit: n, ...over }) as unknown as TrueCostResponse;

/** A promise the test resolves or rejects by hand, to control response order. */
function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Args = Parameters<typeof useTrueCost>;
const base = (over: Partial<Record<'product' | 'runs' | 'version' | 'token', unknown>> = {}) => ({
  product: 100 as number | null, runs: 1, version: 0, token: 'tok' as string | null, ...over,
});
const render = (initial = base()) => renderHook(
  (p: ReturnType<typeof base>) => useTrueCost(p.product as Args[0], 10000002, 10000002, 5, 10, p.token as Args[5], p.runs as number, [], null, 0, p.version as number),
  { initialProps: initial },
);

beforeEach(() => { apiPost.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useTrueCost', () => {
  it('stays idle without a product or a token', () => {
    const a = render(base({ product: null }));
    expect(a.result.current).toEqual({ data: null, loading: false, error: null });
    const b = render(base({ token: null }));
    expect(b.result.current).toEqual({ data: null, loading: false, error: null });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('loads the true cost and sends the request the server expects', async () => {
    apiPost.mockResolvedValue(result(1));
    const { result: r } = render();
    expect(r.current.loading).toBe(true);
    await waitFor(() => expect(r.current.data).toEqual(result(1)));
    expect(r.current.loading).toBe(false);
    expect(apiPost).toHaveBeenCalledWith('/api/true-cost', expect.objectContaining({
      product_id: 100, me: 5, te: 10, runs: 1, regionId: 10000002, materialRegionId: 10000002, decryptor_type: 'none',
    }), 'tok');
  });

  it('never asks for fewer than one run', async () => {
    apiPost.mockResolvedValue(result(1));
    render(base({ runs: 0 }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(apiPost.mock.calls[0][1].runs).toBe(1);
  });

  it('drops the previous item\'s numbers the moment another item is selected', async () => {
    apiPost.mockResolvedValueOnce(result(1));
    const { result: r, rerender } = render();
    await waitFor(() => expect(r.current.data).toEqual(result(1)));
    const second = deferred<TrueCostResponse>();
    apiPost.mockReturnValueOnce(second.promise);
    rerender(base({ product: 200 }));
    expect(r.current.data).toBeNull();          // not the old item's figures mislabelled as the new item's
    expect(r.current.loading).toBe(true);
    await act(async () => { second.resolve(result(2)); });
    expect(r.current.data).toEqual(result(2));
    expect(r.current.loading).toBe(false);
  });

  it('keeps the last numbers visible while the SAME item refetches after a setup change', async () => {
    apiPost.mockResolvedValueOnce(result(1));
    const { result: r, rerender } = render();
    await waitFor(() => expect(r.current.data).toEqual(result(1)));
    const second = deferred<TrueCostResponse>();
    apiPost.mockReturnValueOnce(second.promise);
    rerender(base({ version: 1 }));
    expect(r.current.data).toEqual(result(1));
    expect(r.current.loading).toBe(true);
    await act(async () => { second.resolve(result(3)); });
    expect(r.current.data).toEqual(result(3));
    expect(r.current.loading).toBe(false);
  });

  it('ignores a slow answer for an item that is no longer selected', async () => {
    const slow = deferred<TrueCostResponse>();
    apiPost.mockReturnValueOnce(slow.promise);
    const { result: r, rerender } = render();
    apiPost.mockResolvedValueOnce(result(2));
    rerender(base({ product: 200 }));
    await waitFor(() => expect(r.current.data).toEqual(result(2)));
    await act(async () => { slow.resolve(result(99)); });
    expect(r.current.data).toEqual(result(2));
  });

  it('quietly upgrades estimated prices to live ones after 15 seconds', async () => {
    vi.useFakeTimers();
    apiPost.mockResolvedValueOnce(result(1, { prices_warm: false }));
    const { result: r } = render();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(r.current.data?.prices_warm).toBe(false);
    expect(r.current.loading).toBe(false);
    apiPost.mockResolvedValueOnce(result(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(r.current.data).toEqual(result(2));
    expect(r.current.loading).toBe(false);      // the retry is silent: no loading flash
  });

  it('reports errors, with friendlier text for gateway pages and non-manufacturable items', async () => {
    apiPost.mockRejectedValueOnce(new Error('boom'));
    const a = render();
    await waitFor(() => expect(a.result.current.error).toBe('boom'));
    expect(a.result.current.loading).toBe(false);

    apiPost.mockRejectedValueOnce(new Error('<html>502 Bad Gateway</html>'));
    const b = render();
    await waitFor(() => expect(b.result.current.error).toMatch(/gateway timeout/i));

    apiPost.mockRejectedValueOnce(new Error('HTTP 404: No blueprint found'));
    const c = render();
    await waitFor(() => expect(c.result.current.error).toMatch(/Not manufacturable/));
    expect(c.result.current.data).toBeNull();
  });

  it('clears everything when the selection is removed', async () => {
    apiPost.mockResolvedValueOnce(result(1));
    const { result: r, rerender } = render();
    await waitFor(() => expect(r.current.data).toEqual(result(1)));
    rerender(base({ product: null }));
    expect(r.current).toEqual({ data: null, loading: false, error: null });
  });
});
