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

import { useState, useEffect, useRef } from 'react';
import type { TrueCostResponse } from '../types';
import { apiPost } from '../api/client';

interface UseTrueCostResult {
  data:    TrueCostResponse | null;
  loading: boolean;
  error:   string | null;
}

// How long to wait before retrying when the server returned estimated (non-live) prices.
// Server kicks off a background price warm on the first cold request; 15s is enough time.
const WARM_RETRY_MS = 15_000;

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
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!productTypeId || !token) {
      setData(null);
      setError(null);
      return;
    }

    let cancelled = false;

    // Clear any pending warm-retry from a previous item
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const fetchTrueCost = async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }

      try {
        const result = await apiPost<TrueCostResponse>('/api/true-cost', {
          product_id: productTypeId,
          me,
          te,
          runs:     1,
          regionId,
        }, token);

        if (!cancelled) {
          setData(result);
          // If the server returned estimated (cached DB) prices, schedule a
          // silent retry so we upgrade to live prices once the warm finishes.
          if (!result.prices_warm) {
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) fetchTrueCost(true /* silent */);
            }, WARM_RETRY_MS);
          }
        }
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
        if (!cancelled && !silent) setLoading(false);
      }
    };

    fetchTrueCost();
    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

  // Re-fetch when item, region, or blueprint ME/TE changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productTypeId, regionId, token, me, te]);

  return { data, loading, error };
}
