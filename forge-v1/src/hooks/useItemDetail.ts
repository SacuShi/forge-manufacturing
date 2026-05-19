/**
 * FORGE v1.0 — useItemDetail hook
 *
 * Calls POST /api/item-details when the selected typeId changes.
 * Returns the full ItemDetailApiResponse (price history, build analysis,
 * current market prices) from the server.
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
  typeId: number | null,
  assets: EsiAsset[],
  blueprints: EsiBlueprint[],
  token: string | null,
  regionId = 10000002,
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId, regionId]);

  return { detail, loading, error };
}
