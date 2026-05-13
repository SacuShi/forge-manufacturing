/**
 * FORGE v1.0 — useItemNames hook
 *
 * Loads the full EVE item name database from /api/item-names.
 * Caches the result in localStorage (key: forge_item_names).
 * Cache is considered stale if it has fewer than MIN_ENTRIES entries.
 *
 * Returns a Map<typeId, name> for O(1) lookups.
 */

import { useState, useEffect } from 'react';

const STORAGE_KEY  = 'forge_item_names_v2';   // v2 — includes unpublished types
const MIN_ENTRIES  = 10_000;

interface ItemNamesApiResponse {
  items?: Record<string, string>;
}

export interface UseItemNamesReturn {
  names: Map<number, string>;
  loading: boolean;
}

export function useItemNames(): UseItemNamesReturn {
  const [names,   setNames]   = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // ── Check localStorage first ──────────────────────────────────────────
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Record<string, string>;
          const count  = Object.keys(parsed).length;
          if (count >= MIN_ENTRIES) {
            if (!cancelled) {
              setNames(new Map(Object.entries(parsed).map(([k, v]) => [parseInt(k, 10), v])));
              setLoading(false);
            }
            return;
          }
          // Too few entries — stale cache, discard
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }

      // ── Fetch from server ─────────────────────────────────────────────────
      try {
        const res = await fetch('/api/item-names');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ItemNamesApiResponse;

        if (data.items && Object.keys(data.items).length > 0) {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data.items));
          } catch {
            // localStorage may be full — ignore, names are still in state
          }
          if (!cancelled) {
            setNames(new Map(Object.entries(data.items).map(([k, v]) => [parseInt(k, 10), v])));
          }
        }
      } catch (e) {
        console.warn('useItemNames: failed to load from server:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, []);

  return { names, loading };
}
