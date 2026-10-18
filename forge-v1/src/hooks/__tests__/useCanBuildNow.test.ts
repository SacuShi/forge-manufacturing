// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCanBuildNow } from '../useCanBuildNow';
import type { EsiAsset, EsiBlueprint, Market } from '../../types';

const bp = (type_id: number) => ({ type_id } as EsiBlueprint);
const market = { id: 10000002, name: 'Jita' } as Market;
const ASSETS: EsiAsset[] = [];
const reply = (body: unknown) => ({ json: async () => body });

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const render = (blueprints: EsiBlueprint[]) => renderHook(
  (p: { blueprints: EsiBlueprint[] }) => useCanBuildNow({ allBlueprints: p.blueprints, combinedAssets: ASSETS, selectedSourceMarket: market, totalWalletISK: 5e8 }),
  { initialProps: { blueprints } },
);

describe('useCanBuildNow', () => {
  it('does nothing without blueprints', () => {
    const { result } = render([]);
    expect(result.current.canBuildNowMap.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the server once per distinct blueprint and maps the answer', async () => {
    fetchMock.mockResolvedValue(reply({ 11: { canBuildNow: true }, 12: { canBuildNow: false }, _meta: { canBuildDataWarm: true } }));
    const { result } = render([bp(11), bp(12), bp(11)]);
    await waitFor(() => expect(result.current.canBuildNowMap.get(11)).toBe(true));
    expect(result.current.canBuildNowMap.get(12)).toBe(false);
    expect(result.current.canBuildNowMap.has(13)).toBe(false);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ blueprintTypeIds: [11, 12], regionId: 10000002, walletISK: 5e8 });
  });

  it('retries once, quietly, after 15 seconds when the server says its prices are cold', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply({ _meta: { canBuildDataWarm: false } }));
    const { result } = render([bp(11)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(reply({ 11: { canBuildNow: true }, _meta: { canBuildDataWarm: false } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.canBuildNowMap.get(11)).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);          // only one retry
  });

  it('falls back to an empty map when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const { result } = render([bp(11)]);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.canBuildNowMap.size).toBe(0);
  });

  it('empties the map when the pilot has no blueprints any more', async () => {
    fetchMock.mockResolvedValue(reply({ 11: { canBuildNow: true } }));
    const { result, rerender } = render([bp(11)]);
    await waitFor(() => expect(result.current.canBuildNowMap.get(11)).toBe(true));
    rerender({ blueprints: [] });
    expect(result.current.canBuildNowMap.size).toBe(0);
  });

  it('ignores an answer that arrives after the blueprints changed', async () => {
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const { result, rerender } = render([bp(11)]);
    fetchMock.mockResolvedValueOnce(reply({ 22: { canBuildNow: true } }));
    rerender({ blueprints: [bp(22)] });
    await waitFor(() => expect(result.current.canBuildNowMap.get(22)).toBe(true));
    await act(async () => { release(reply({ 11: { canBuildNow: true } })); });
    expect(result.current.canBuildNowMap.has(11)).toBe(false);
  });
});
