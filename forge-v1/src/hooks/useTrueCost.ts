/**
 * FORGE v1.2.0 — useTrueCost hook
 *
 * Fetches the True Profit breakdown for the currently selected item.
 *
 * Triggered whenever productTypeId, regionId, me, or te changes.
 * ME and TE are resolved by the caller (App.tsx) using the itemNames map
 * to match product type_id → blueprint type_id → ESI blueprint entry.
 *
 * Returns: TrueCostResponse (material cost, mfg fees, sales tax, true profit)
 */

import { useState, useEffect } from 'react';
import type { TrueCostResponse } from '../types';
import { apiPost } from '../api/client';

interface UseTrueCostResult {
  data:    TrueCostResponse | null;
  loading: boolean;
  error:   string | null;
}

export function useTrueCost(
  productTypeId: number | null,
  regionId:      number,
  me:            number,       // material efficiency from the character's best blueprint (0 if unknown)
  te:            number,       // time efficiency — passed through to server for future use
  token:         string | null,
): UseTrueCostResult {
  const [data,    setData]    = useState<TrueCostResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!productTypeId || !token) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;

    const fetchTrueCost = async () => {
      setLoading(true);
      setError(null);

      try {
        const result = await apiPost<TrueCostResponse>('/api/true-cost', {
          product_id: productTypeId,
          me,
          te,
          runs:     1,
          regionId,
        }, token);

        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) {
          const raw = (e as Error).message;
          // If the error body is HTML (Cloudflare 502 / gateway timeout), show a clean message.
          const isHtml = raw.includes('<!DOCTYPE') || raw.includes('<html');
          setError(isHtml
            ? 'Server gateway timeout — wait a moment and try again.'
            : raw
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTrueCost();
    return () => { cancelled = true; };

  // Re-fetch when item, region, or blueprint ME/TE changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productTypeId, regionId, token, me, te]);

  return { data, loading, error };
}
