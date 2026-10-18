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
 *
 * State model: the effect only talks to the server. What it learns is stored with the item and request it
 * answers (`settled`); `data`, `loading` and `error` are DERIVED from that during render. That is what makes
 * switching items drop the old item's numbers on the very same render, instead of one render later.
 */

import { useState, useEffect } from 'react';
import type { TrueCostResponse } from '../types';
import { apiPost } from '../api/client';

interface UseTrueCostResult {
  data:    TrueCostResponse | null;
  loading: boolean;
  error:   string | null;
}

/** The latest answer: which item it is for, which exact request it answers, and what came back. */
interface Settled {
  item:  number;
  key:   string;
  data:  TrueCostResponse | null;
  error: string | null;
}

// How long to wait before retrying when the server returned estimated (non-live) prices.
// Server kicks off a background price warm on the first cold request; 15s is enough time.
const WARM_RETRY_MS = 15_000;

/** Turns a failed request into the text the panel shows. */
function describeError(raw: string): { message: string; notManufacturable: boolean } {
  // If the error body is HTML (Cloudflare 502 / gateway timeout), show a clean message.
  const isHtml = raw.includes('<!DOCTYPE') || raw.includes('<html');
  // 404 "No blueprint found" → item is a drop / LP store reward, not manufacturable.
  const notManufacturable = raw.includes('404') && raw.includes('No blueprint found');
  const message = isHtml
    ? 'Server gateway timeout — wait a moment and try again.'
    : notManufacturable
      ? 'Not manufacturable — this item comes from the LP store, drops, or contracts only.'
      : raw;
  return { message, notManufacturable };
}

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
  const [settled, setSettled] = useState<Settled | null>(null);

  const active      = productTypeId !== null && !!token;
  const implantsKey = implants.join(',');
  const requestRuns = Math.max(1, runs);
  // Identifies one exact request. Anything that should trigger a refetch is in here.
  const requestKey = [
    productTypeId, sellRegionId, materialRegionId, token, me, te, requestRuns, implantsKey,
    decryptorType, inventionProbBonus, settingsVersion,
  ].join('|');

  useEffect(() => {
    if (productTypeId === null || !token) return;
    const item = productTypeId;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchTrueCost = async (silent: boolean) => {
      try {
        const result = await apiPost<TrueCostResponse>('/api/true-cost', {
          product_id:           item,
          me,
          te,
          runs:                 requestRuns,
          regionId:             sellRegionId,
          materialRegionId:     materialRegionId,
          implants:             implantsKey ? implantsKey.split(',').map(Number) : [],
          decryptor_type:       decryptorType || 'none',
          invention_prob_bonus: inventionProbBonus,
        }, token);
        if (cancelled) return;
        setSettled({ item, key: requestKey, data: result, error: null });
        // If the server returned estimated (cached DB) prices, schedule a silent retry so we upgrade to
        // live prices once the warm finishes — also while Jita's prices (needed to price imports) are loading.
        if (!result.prices_warm || result.material_sourcing?.jita_unavailable) {
          retryTimer = setTimeout(() => fetchTrueCost(true), WARM_RETRY_MS);
        }
      } catch (e) {
        if (cancelled || silent) return;
        const { message, notManufacturable } = describeError((e as Error).message);
        // Keep the last numbers for this item visible next to the error, except when it can't be built at all.
        setSettled((prev) => ({
          item, key: requestKey, error: message,
          data: !notManufacturable && prev && prev.item === item ? prev.data : null,
        }));
      }
    };

    fetchTrueCost(false);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [productTypeId, sellRegionId, materialRegionId, token, me, te, requestRuns, implantsKey,
    decryptorType, inventionProbBonus, settingsVersion, requestKey]);

  // Numbers belong to the item they were fetched for; another item's must never show under this one. A refetch
  // of the SAME item after a setup change keeps the last numbers visible while it loads.
  const current = active && settled?.item === productTypeId ? settled : null;
  const loading = active && settled?.key !== requestKey;
  return {
    data:  current?.data ?? null,
    loading,
    error: loading ? null : current?.error ?? null,
  };
}
