// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiGet = vi.fn();
vi.mock('../../api/client', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }));

import { useCorpData } from '../useCorpData';
import type { CorpAccessStatus, CorpStatus } from '../../types';

const status = (n: number) => ({ configured: true, corp_name: 'Corp ' + n }) as unknown as CorpStatus;
const access = (n: number) => ({ hasAccess: n > 0, method: 'admin' }) as unknown as CorpAccessStatus;

function deferred<T>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
/** Routes the two corp endpoints to the given answers. */
const answer = (s: unknown, a: unknown) => apiGet.mockImplementation((url: string) =>
  (url.includes('access-status') ? a : s) instanceof Promise ? (url.includes('access-status') ? a : s) : Promise.resolve(url.includes('access-status') ? a : s));

type P = { token: string | null; isActive: boolean };
const render = (initial: P) => renderHook((p: P) => useCorpData(p.token, p.isActive), { initialProps: initial });

beforeEach(() => { apiGet.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

describe('useCorpData', () => {
  it('does nothing until the Corp tab is active and a character is logged in', () => {
    const a = render({ token: 'a', isActive: false });
    const b = render({ token: null, isActive: true });
    expect(a.result.current).toEqual({ corpStatus: null, accessStatus: null, loading: false });
    expect(b.result.current).toEqual({ corpStatus: null, accessStatus: null, loading: false });
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('loads both answers when the tab opens', async () => {
    answer(status(1), access(1));
    const { result } = render({ token: 'a', isActive: true });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.corpStatus).toEqual(status(1));
    expect(result.current.accessStatus).toEqual(access(1));
    expect(apiGet).toHaveBeenCalledWith('/api/corp/status', 'a');
    expect(apiGet).toHaveBeenCalledWith('/api/corp/access-status', 'a');
  });

  it('shows what loaded even when the other check fails', async () => {
    apiGet.mockImplementation((url: string) => (url.includes('access-status') ? Promise.reject(new Error('403')) : Promise.resolve(status(1))));
    const { result } = render({ token: 'a', isActive: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.corpStatus).toEqual(status(1));
    expect(result.current.accessStatus).toBeNull();
  });

  it('never shows the previous character\'s access while the new one is being checked', async () => {
    answer(status(1), access(1));
    const { result, rerender } = render({ token: 'a', isActive: true });
    await waitFor(() => expect(result.current.accessStatus).toEqual(access(1)));
    const slowAccess = deferred<CorpAccessStatus>();
    apiGet.mockImplementation((url: string) => (url.includes('access-status') ? slowAccess.promise : Promise.resolve(status(2))));
    rerender({ token: 'b', isActive: true });
    expect(result.current.accessStatus).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => { slowAccess.resolve(access(0)); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.accessStatus).toEqual(access(0));
    expect(result.current.corpStatus).toEqual(status(2));
  });

  it('ignores answers for a character that is no longer selected', async () => {
    const slow = deferred<CorpAccessStatus>();
    apiGet.mockImplementation((url: string) => (url.includes('access-status') ? slow.promise : Promise.resolve(status(1))));
    const { result, rerender } = render({ token: 'a', isActive: true });
    answer(status(2), access(2));
    rerender({ token: 'b', isActive: true });
    await waitFor(() => expect(result.current.accessStatus).toEqual(access(2)));
    await act(async () => { slow.resolve(access(0)); });
    expect(result.current.accessStatus).toEqual(access(2));
  });
});
