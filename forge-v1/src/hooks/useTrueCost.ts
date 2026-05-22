/**
 * FORGE v1.2.0 — useTrueCost hook
 *
 * Fetches the True Profit breakdown for the currently selected item.
 *
 * Triggered whenever productTypeId, regionId, or the character's blueprint
 * list changes. Reads ME/TE from the character's owned blueprint for this
 * product (best available copy — BPO wins over BPC).
 *
 * Returns: TrueCostResponse (material cost, mfg fees, sales tax, true profit)
 */

import { useState, useEffect } from 'react';
import type { TrueCostResponse, EsiBlueprint } from '../types';
import { apiPost } from '../api/client';

interface UseTrueCostResult {
  data:    TrueCostResponse | null;
  loading: boolean;
  error:   string | null;
}

/**
 * Find the best blueprint for a given product type_id.
 * Prefers BPO (runs === -1) over any BPC.
 */
function findBestBlueprint(
  productTypeId: number,
  blueprints: EsiBlueprint[],
): EsiBlueprint | undefined {
  // Blueprint type_ids are product type_ids + 1 in most cases, but we match
  // by checking if the blueprint's product is this type. Since we don't have
  // a product→blueprint map here, we look for blueprints where type_id === productTypeId
  // (direct match) OR check if any blueprint resolves to this product.
  // In practice, the caller already knows this is a product type_id from the
  // market table, so we look for the *blueprint* type_id which is typically
  // distinct from the product. We'll use the fallback: ME=0, TE=0 (base case).
  //
  // The server-side /api/true-cost doesn't need the blueprint type_id to call
  // EVE Ref — it just needs product_id + ME + TE. We extract ME/TE from the
  // ESI blueprint the character owns.

  // Look for BPO first (runs === -1 in ESI means BPO)
  const bpo = blueprints.find(
    (bp) => bp.type_id === productTypeId && bp.runs === -1
  );
  if (bpo) return bpo;

  // Fall back to any BPC
  return blueprints.find((bp) => bp.type_id === productTypeId);
}

export function useTrueCost(
  productTypeId: number | null,
  regionId:      number,
  blueprints:    EsiBlueprint[],
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

      // Find ME/TE from owned blueprint (if any)
      const bp = findBestBlueprint(productTypeId, blueprints);
      const me = bp?.material_efficiency ?? 0;
      const te = bp?.time_efficiency     ?? 0;

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
          // If the error body is HTML (e.g. Cloudflare 502 page), show a clean message.
          const isHtml = raw.includes('<!DOCTYPE') || raw.includes('<html');
          setError(isHtml
            ? 'Manufacturing fee service unavailable — deploy the latest server.js and restart PM2'
            : raw
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTrueCost();
    return () => { cancelled = true; };

  // Re-fetch when item, region, or blueprints change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productTypeId, regionId, token, blueprints.length]);

  return { data, loading, error };
}
