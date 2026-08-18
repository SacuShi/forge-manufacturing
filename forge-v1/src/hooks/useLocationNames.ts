import { useEffect, useRef, useState } from 'react';

// Well-known structures from HUB_CONFIG — resolved without an ESI call.
const KNOWN_STRUCTURES: Record<number, string> = {
  1049588174021: 'C-J6MT Keepstar',
};

// Only confirmed names are stored — failed lookups are never cached so they
// will be retried on the next hook mount (e.g. when the auth token arrives).
const _cache = new Map<number, string>(
  Object.entries(KNOWN_STRUCTURES).map(([id, name]) => [Number(id), name]),
);

// EVE ESI public entity ID ranges accepted by /universe/names/.
// Item-instance IDs (ships, containers) that happen to fall in the 32-bit
// range would cause a 400 for the entire batch, so we filter to known ranges.
const isPublicEntityId = (id: number): boolean =>
  (id >= 10_000_000 && id < 14_000_000) ||  // regions
  (id >= 20_000_000 && id < 22_000_000) ||  // constellations
  (id >= 30_000_000 && id < 34_000_000) ||  // solar systems
  (id >= 60_000_000 && id < 70_000_000);    // NPC stations

const ESI = 'https://esi.evetech.net/latest';

export function useLocationNames(locationIds: number[], token?: string | null): Map<number, string> {
  const [names, setNames] = useState<Map<number, string>>(() => new Map(_cache));
  const inFlight = useRef(new Set<number>());

  const idsKey = [...locationIds].sort((a, b) => a - b).join(',');

  useEffect(() => {
    const uncached = locationIds.filter(
      (id) => id > 0 && !_cache.has(id) && !inFlight.current.has(id),
    );

    // Always reflect whatever is already cached synchronously.
    setNames(new Map(_cache));
    if (uncached.length === 0) return;

    uncached.forEach((id) => inFlight.current.add(id));

    const npcIds       = uncached.filter((id) => id < 1_000_000_000 && isPublicEntityId(id));
    const structureIds = uncached.filter((id) => id >= 1_000_000_000);

    const promises: Promise<void>[] = [];

    // ── Phase 1: NPC stations and solar systems via /universe/names/ ───────
    // Called directly from the browser — ESI is CORS-enabled.
    if (npcIds.length > 0) {
      promises.push(
        fetch(`${ESI}/universe/names/?datasource=tranquility`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(npcIds),
        })
          .then((r) => (r.ok ? r.json() : []))
          .then((entries: Array<{ id: number; name: string; category: string }>) => {
            for (const { id, name, category } of entries) {
              if (category === 'solar_system') {
                _cache.set(id, `${name} · System`);
              } else if (category === 'station') {
                // "Jita IV - Moon 4 - Caldari Navy Assembly Plant"
                // → "Jita IV · Caldari Navy Assembly Plant"
                const parts = name.split(' - ');
                _cache.set(
                  id,
                  parts.length >= 3
                    ? `${parts[0]} · ${parts[parts.length - 1]}`
                    : name,
                );
              } else {
                _cache.set(id, name);
              }
            }
          })
          .catch(() => { /* retry next mount */ }),
      );
    }

    // ── Phase 2: player structures via /universe/structures/{id}/ ──────────
    // Requires esi-universe.read_structures.v1 scope + docking access.
    // If the token isn't available yet the IDs will be retried when it is
    // (the effect re-runs whenever `token` changes).
    if (structureIds.length > 0 && token) {
      promises.push(
        Promise.allSettled(
          structureIds.map((id) =>
            fetch(`${ESI}/universe/structures/${id}/?datasource=tranquility`, {
              headers: { Authorization: `Bearer ${token}` },
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((data: { name: string } | null) => {
                if (data?.name) {
                  // "SYSTEM-NAME - Player Given Name" → "SYSTEM-NAME · Player Given Name"
                  const parts = data.name.split(' - ');
                  _cache.set(
                    id,
                    parts.length >= 2
                      ? `${parts[0]} · ${parts.slice(1).join(' - ')}`
                      : data.name,
                  );
                }
              })
              .catch(() => { /* 403 = no scope / no access; skip silently */ }),
          ),
        ).then(() => { /* settled */ }),
      );
    } else if (structureIds.length > 0 && !token) {
      // Token not yet available — remove from inFlight so they'll be picked
      // up again when the token arrives and the effect re-runs.
      structureIds.forEach((id) => inFlight.current.delete(id));
    }

    Promise.all(promises).then(() => {
      // Clean up inFlight for everything we tried (structures without token
      // were already cleaned up above).
      uncached
        .filter((id) => !structureIds.includes(id) || !!token)
        .forEach((id) => inFlight.current.delete(id));
      setNames(new Map(_cache));
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, token]);

  return names;
}
