/**
 * FORGE v1.2.0 — useTrueCost hook
 *
 * Fetches the True Profit breakdown for the currently selected item.
 *
 * v1.3.0: Accepts separate sellRegionId (where goods are sold) and
 * materialRegionId (where materials are purchased) so the True Profit panel
 * reflects the user's actual sourcing and selling hubs independently.
 *
 * ME and TE are resolved by the caller (App.tsx) via name-based blueprint
 * matching (product type_id → blueprint name → ESI blueprint entry).
 *
 * When the server returns prices_warm=false (cache cold after restart),
 * a silent 15-second retry is scheduled so values auto-upgrade to live prices.
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
  productTypeId:       number | null,
  sellRegionId:        number,        // hub where finished goods are sold
  materialRegionId:    number,        // hub where raw materials are purchased
  me:                  number,        // material efficiency from the character's best blueprint (0 if unknown)
  te:                  number,        // time efficiency — passed through to server for future use
  token:               string | null,
  runs:                number = 1,    // number of manufacturing runs
  implants:            number[] = [], // v1.17.1 — selected implant set (default none)
  decryptorType:       string | null = null, // v1.35.0 — invention decryptor
  inventionProbBonus:  number = 0,    // v1.35.0 — flat probability bonus % (manual override)
  // Bumped by the caller whenever Manufacturing Setup (system/structure/rigs/
  // tax) is saved. The server reads rig_ids etc. fresh from the DB on every
  // call, so this isn't sent to the server — it exists purely to force this
  // effect to re-fire, since a rig-only change touches none of the params
  // above and would otherwise leave the panel showing stale numbers.
  settingsVersion:     number = 0,
): UseTrueCostResult {
  const [data,    setData]    = useState<TrueCostResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const retryTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevItemRef    = useRef<number | null>(null);

  useEffect(() => {
    if (!productTypeId || !token) {
      setData(null);
      setError(null);
      prevItemRef.current = productTypeId;
      return;
    }

    // Switching to a DIFFERENT item must drop the previous item's data
    // immediately, not just on a successful fetch — otherwise the panel (and
    // everything downstream that reads effective_me/material quantities from
    // it: the shortfall total, the stock-check request, the multibuy export)
    // keeps showing the OLD item's numbers, now mislabeled as the new item's,
    // until the new /api/true-cost call resolves (which can take up to 60s on
    // a cold ESI cache). A settingsVersion-only refetch for the SAME item
    // deliberately does NOT clear — keeping the last-known numbers visible
    // while it refreshes is the better UX there.
    if (prevItemRef.current !== productTypeId) {
      setData(null);
      setError(null);
    }
    prevItemRef.current = productTypeId;

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
          product_id:           productTypeId,
          me,
          te,
          runs:                 Math.max(1, runs),
          regionId:             sellRegionId,
          materialRegionId:     materialRegionId,
          implants,
          decryptor_type:       decryptorType || 'none',
          invention_prob_bonus: inventionProbBonus,
        }, token);

        if (!cancelled) {
          setData(result);
          // If the server returned estimated (cached DB) prices, schedule a
          // silent retry so we upgrade to live prices once the warm finishes.
          // also while Jita's prices (needed to price imports) are still loading
          if (!result.prices_warm || result.material_sourcing?.jita_unavailable) {
            retryTimerRef.current = setTimeout(() => {
              if (!cancelled) fetchTrueCost(true /* silent */);
            }, WARM_RETRY_MS);
          }
        }
      } catch (e) {
        if (!cancelled && !silent) {
          const raw = (e as Error).message;
          // If the error body is HTML (Cloudflare 502 / gateway timeout), show a clean message.
          const isHtml = raw.includes('<!DOCTYPE') || raw.includes('<html');
          // 404 "No blueprint found" → item is a drop / LP store reward, not manufacturable.
          const noBlueprint = raw.includes('404') && raw.includes('No blueprint found');
          setError(isHtml
            ? 'Server gateway timeout — wait a moment and try again.'
            : noBlueprint
              ? 'Not manufacturable — this item comes from the LP store, drops, or contracts only.'
              : raw
          );
          if (noBlueprint) setData(null);
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

  // Re-fetch when item, hub, blueprint ME/TE, runs count, invention settings, or
  // Manufacturing Setup (system/structure/rigs/tax, via settingsVersion) change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productTypeId, sellRegionId, materialRegionId, token, me, te, runs, implants.join(','), decryptorType, inventionProbBonus, settingsVersion]);

  return { data, loading, error };
}
