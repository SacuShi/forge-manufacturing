import { useState, useEffect } from 'react';
import type { EsiAsset, EsiBlueprint, Market } from '../types';

interface UseCanBuildNowParams {
  allBlueprints: EsiBlueprint[];
  combinedAssets: EsiAsset[];
  selectedSourceMarket: Market;
  totalWalletISK: number;
}

const EMPTY_MAP: Map<number, boolean> = new Map();

export function useCanBuildNow({ allBlueprints, combinedAssets, selectedSourceMarket, totalWalletISK }: UseCanBuildNowParams) {
  // v1.33.1 — "Can Build Now" map for Market Opportunities' Can Build pill: owned
  // materials + wallet ISK cover each owned blueprint's shortfall. Reuses
  // /api/blueprint-profits (same computation as the My Blueprints tab); only the
  // canBuildNow field is used here, priced at the MATERIALS hub (not the sell hub).
  // v1.33.2 — silently retries once after 15s if the server flags the price cache
  // as cold (_meta.canBuildDataWarm === false), same pattern as useTrueCost.
  const [loadedMap, setLoadedMap] = useState<Map<number, boolean>>(EMPTY_MAP);

  useEffect(() => {
    if (allBlueprints.length === 0) return;
    const typeIds = [...new Set(allBlueprints.map((b) => b.type_id))];
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const load = (silent = false) => {
      fetch('/api/blueprint-profits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blueprintTypeIds: typeIds,
          regionId: selectedSourceMarket.id,
          assets: combinedAssets,
          walletISK: totalWalletISK,
        }),
      })
        .then((res) => res.json())
        .then((data: Record<string, unknown>) => {
          if (cancelled) return;
          const map = new Map<number, boolean>();
          Object.entries(data).forEach(([bpId, v]) => {
            if (bpId === '_meta') return;
            map.set(Number(bpId), !!(v as { canBuildNow?: boolean } | undefined)?.canBuildNow);
          });
          setLoadedMap(map);
          const meta = data._meta as { canBuildDataWarm?: boolean } | undefined;
          if (!silent && meta && meta.canBuildDataWarm === false) {
            retryTimer = setTimeout(() => load(true), 15_000);
          }
        })
        .catch(() => { if (!cancelled) setLoadedMap(EMPTY_MAP); });
    };
    load();

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [allBlueprints, selectedSourceMarket.id, combinedAssets, totalWalletISK]);

  // No blueprints means nothing can be built: derived here, not stored, so it is correct on the same render.
  return { canBuildNowMap: allBlueprints.length === 0 ? EMPTY_MAP : loadedMap };
}
