/**
 * FORGE v1.0 — useItemNames hook
 *
 * Loads the full EVE item name database from /api/item-names.
 * Caches the result in localStorage (key: forge_item_names).
 * Cache is considered stale if it has fewer than MIN_ENTRIES entries.
 *
 * Returns a Map<typeId, name> for O(1) lookups.
 */

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY  = 'forge_item_names_v2';   // v2 — includes unpublished types
const MIN_ENTRIES  = 10_000;

interface ItemNamesApiResponse {
  items?: Record<string, string>;
}

export interface UseItemNamesReturn {
  names:          Map<number, string>;
  loading:        boolean;
  resolveUnknown: (typeIds: number[]) => Promise<void>;
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

    void load(); // handles its own errors
    return () => { cancelled = true; };
  }, []);

  // Resolve any type_ids that are missing from the current name map via the
  // server's ESI fallback endpoint. Merges results into state and localStorage.
  const resolveUnknown = useCallback(async (typeIds: number[]) => {
    const missing = typeIds.filter(id => !names.has(id));
    if (missing.length === 0) return;

    try {
      const res = await fetch('/api/resolve-type-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typeIds: missing }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { names: Record<string, string> };
      if (!data.names || Object.keys(data.names).length === 0) return;

      setNames(prev => {
        const next = new Map(prev);
        for (const [k, v] of Object.entries(data.names)) {
          next.set(parseInt(k, 10), v);
        }
        // Persist resolved names into the localStorage cache
        try {
          const cached = localStorage.getItem(STORAGE_KEY);
          const obj = cached ? JSON.parse(cached) as Record<string, string> : {};
          Object.assign(obj, data.names);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch { /* localStorage unavailable or full: the in-memory map still works */ }
        return next;
      });
    } catch (e) {
      console.warn('useItemNames: resolveUnknown failed:', e);
    }
  }, [names]);

  return { names, loading, resolveUnknown };
}
