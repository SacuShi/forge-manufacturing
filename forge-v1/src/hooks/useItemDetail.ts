/**
 * FORGE v1.0 — useItemDetail hook
 *
 * Calls POST /api/item-details when the selected typeId changes.
 * Returns the full ItemDetailApiResponse (price history, build analysis,
 * current market prices) from the server.
 *
 * v1.3.0: Accepts a separate materialRegionId so material unit costs in the
 * build analysis reflect the player's chosen sourcing hub rather than always
 * using the sell hub.
 *
 * Automatically cancels in-flight requests when typeId changes.
 * Clears detail and error when typeId becomes null.
 *
 * State model: the effect only talks to the server. Each answer is stored together with the exact inputs it
 * answers (`settled`); `detail`, `loading` and `error` are DERIVED from it during render, so changing the item
 * (or the pilot's holdings) drops the old figures on the same render rather than one render later.
 */

import { useState, useEffect } from 'react';
import type { EsiAsset, EsiBlueprint, ItemDetailApiResponse } from '../types';
import { apiFetch } from '../api/client';

export interface UseItemDetailReturn {
  detail: ItemDetailApiResponse | null;
  loading: boolean;
  error: string | null;
}

/** An answer plus the inputs it was fetched for (assets/blueprints are compared by reference, like effect deps). */
interface Settled {
  typeId:           number;
  regionId:         number;
  materialRegionId: number;
  assets:           EsiAsset[];
  blueprints:       EsiBlueprint[];
  detail:           ItemDetailApiResponse | null;
  error:            string | null;
}

// A hub whose price cache is still loading answers pricesWarm:false (it never quotes Jita data under the hub's
// name). Ask again quietly a few times so the figures appear without a click.
const PRICES_RETRY_MS = 6000;
const PRICES_MAX_RETRIES = 6;

export function useItemDetail(
  typeId:           number | null,
  assets:           EsiAsset[],
  blueprints:       EsiBlueprint[],
  token:            string | null,
  regionId         = 10000002,   // sell hub — drives "Current Market" price display
  materialRegionId = regionId,   // source hub — drives material unit costs in build analysis
): UseItemDetailReturn {
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (typeId === null) return;
    const inputs = { typeId, regionId, materialRegionId, assets, blueprints };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;

    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;

    const load = () => {
      apiFetch('/api/item-details', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          typeId,
          assets,
          ownedBlueprints: blueprints,
          regionId,
          materialRegionId,
        }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
          return res.json() as Promise<ItemDetailApiResponse>;
        })
        .then((data) => {
          if (cancelled) return;
          setSettled({ ...inputs, detail: data, error: null });
          if (data.pricesWarm === false && tries < PRICES_MAX_RETRIES) {
            tries += 1;
            timer = setTimeout(load, PRICES_RETRY_MS);
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setSettled({ ...inputs, detail: null, error: e instanceof Error ? e.message : String(e) });
        });
    };
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // assets and blueprints are included so the panel refreshes if the user's
  // holdings change while the same item is selected (e.g. after an alt loads).
  // They are stable memoised references in App.tsx and only change when data changes.
  // `token` is deliberately not a dependency: switching character must not refetch the same item.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, regionId, materialRegionId, assets, blueprints]);

  const current = settled !== null && settled.typeId === typeId && settled.regionId === regionId
    && settled.materialRegionId === materialRegionId && settled.assets === assets && settled.blueprints === blueprints
    ? settled : null;
  return {
    detail:  current?.detail ?? null,
    loading: typeId !== null && current === null,
    error:   current?.error ?? null,
  };
}
