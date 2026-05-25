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
 */

import { useState, useEffect } from 'react';
import type { EsiAsset, EsiBlueprint, ItemDetailApiResponse } from '../types';
import { apiFetch } from '../api/client';

export interface UseItemDetailReturn {
  detail: ItemDetailApiResponse | null;
  loading: boolean;
  error: string | null;
}

export function useItemDetail(
  typeId:           number | null,
  assets:           EsiAsset[],
  blueprints:       EsiBlueprint[],
  token:            string | null,
  regionId         = 10000002,   // sell hub — drives "Current Market" price display
  materialRegionId = regionId,   // source hub — drives material unit costs in build analysis
): UseItemDetailReturn {
  const [detail,  setDetail]  = useState<ItemDetailApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (typeId === null) {
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setError(null);

    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    if (token) (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;

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
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  // assets and blueprints are included so the panel refreshes if the user's
  // holdings change while the same item is selected (e.g. after an alt loads).
  // They are stable memoised references in App.tsx and only change when data changes.
  }, [typeId, regionId, materialRegionId, assets, blueprints]);

  return { detail, loading, error };
}
