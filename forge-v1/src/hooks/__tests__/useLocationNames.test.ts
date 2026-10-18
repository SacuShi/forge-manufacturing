// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

// The hook keeps a module-level cache, so each test loads a fresh copy of it.
const load = async () => (await import('../useLocationNames')).useLocationNames;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

describe('useLocationNames', () => {
  it('knows the Keepstar without asking ESI', async () => {
    const useLocationNames = await load();
    const { result } = renderHook(() => useLocationNames([1049588174021]));
    expect(result.current.get(1049588174021)).toBe('C-J6MT Keepstar');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves stations and systems in one batch and tidies the names', async () => {
    fetchMock.mockResolvedValue(json([
      { id: 60003760, name: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', category: 'station' },
      { id: 30000142, name: 'Jita', category: 'solar_system' },
    ]));
    const useLocationNames = await load();
    const { result } = renderHook(() => useLocationNames([60003760, 30000142]));
    await waitFor(() => expect(result.current.get(60003760)).toBe('Jita IV · Caldari Navy Assembly Plant'));
    expect(result.current.get(30000142)).toBe('Jita · System');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual([60003760, 30000142]);
  });

  it('does not ask again for names it already has', async () => {
    fetchMock.mockResolvedValue(json([{ id: 60003760, name: 'Jita IV - Moon 4 - Plant', category: 'station' }]));
    const useLocationNames = await load();
    const first = renderHook(() => useLocationNames([60003760]));
    await waitFor(() => expect(first.result.current.has(60003760)).toBe(true));
    const second = renderHook(() => useLocationNames([60003760]));
    expect(second.result.current.get(60003760)).toBe('Jita IV · Plant');   // immediately, from the shared cache
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits for a token before asking about player structures, then resolves them', async () => {
    fetchMock.mockResolvedValue(json({ name: 'ABC-123 - Our Fortizar' }));
    const useLocationNames = await load();
    const { result, rerender } = renderHook((p: { token: string | null }) => useLocationNames([1049500000001], p.token), { initialProps: { token: null as string | null } });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.has(1049500000001)).toBe(false);
    rerender({ token: 'tok' });
    await waitFor(() => expect(result.current.get(1049500000001)).toBe('ABC-123 · Our Fortizar'));
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('retries a failed lookup the next time it is asked', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    const useLocationNames = await load();
    const first = renderHook(() => useLocationNames([60003760]));
    await new Promise((r) => setTimeout(r, 20));
    expect(first.result.current.has(60003760)).toBe(false);
    fetchMock.mockResolvedValueOnce(json([{ id: 60003760, name: 'Jita IV - Moon 4 - Plant', category: 'station' }]));
    const second = renderHook(() => useLocationNames([60003760]));
    await waitFor(() => expect(second.result.current.get(60003760)).toBe('Jita IV · Plant'));
  });

  it('ignores ids that are not public entities, so one bad id cannot fail the batch', async () => {
    fetchMock.mockResolvedValue(json([]));
    const useLocationNames = await load();
    renderHook(() => useLocationNames([60003760, 1234567890123, 0, -5, 40000000]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const npcCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/universe/names/'));
    expect(JSON.parse(npcCall![1].body)).toEqual([60003760]);
  });
});
