import type { AuthState } from './useAuth';
import { useMemo, useState, useEffect } from 'react';
import { type EsiAsset, type EsiBlueprint } from '../types';
import { findAssetSafetyItemIds, isInAssetSafety } from '../utils/assetSafety';

interface UseCharacterAggregatesParams {
  auth: AuthState & { login: () => void; logout: () => void; addCharacter: () => void; removeCharacter: (characterId: number) => void; setRemember: (enabled: boolean) => Promise<void>; restoreRememberedCharacters: (characterIds: number[]) => Promise<{ characterId: number; name: string; error?: string | undefined; }[]>; forgetRememberedCharacter: (characterId: number) => Promise<void>; forgetAllRemembered: () => Promise<void>; };
  viewCharacterId: number | null;
}

export function useCharacterAggregates({ auth, viewCharacterId }: UseCharacterAggregatesParams) {
  // ── v1.5 Aggregation ──────────────────────────────────────────────────────
  // Derive combined/isolated datasets from primary + alts based on viewCharacterId.
  const activeAltCharacters = useMemo(() =>
    viewCharacterId === null
      ? auth.altCharacters
      : auth.altCharacters.filter((a) => a.characterId === viewCharacterId),
    [viewCharacterId, auth.altCharacters]
  );

  // Primary + loaded alts with their skills, for the haulage ship pickers (self-haul needs each pilot's skills).
  const haulCharacters = useMemo(() => [
    ...(auth.character ? [{ characterId: auth.character.characterId, name: auth.character.name, skills: auth.skills }] : []),
    ...auth.altCharacters.filter((a) => !a.loading && !a.error)
      .map((a) => ({ characterId: a.characterId, name: a.name, skills: a.skills })),
  ], [auth.character, auth.skills, auth.altCharacters]);

  const primaryInScope = viewCharacterId === null || viewCharacterId === auth.character?.characterId;

  // Raw assets from all in-scope characters, preserving per-item location_id.
  // Used by the Assets tab to show per-location grouping.
  const allRawAssets = useMemo<EsiAsset[]>(() => {
    const result: EsiAsset[] = [];
    if (primaryInScope) result.push(...auth.assets);
    activeAltCharacters.forEach((a) => result.push(...a.assets));
    return result;
  }, [primaryInScope, auth.assets, activeAltCharacters]);

  // Items locked in Asset Safety wraps can't be used for manufacturing: they are kept out of EVERY calculation
  // (have/needed, shortfalls, buildable-now, the Queue Planner, the server session) — see utils/assetSafety.ts.
  const safetyIds = useMemo(() => findAssetSafetyItemIds(allRawAssets), [allRawAssets]);

  // All USABLE blueprints across in-scope characters (used for ownership badges + market filtering).
  // Blueprints stuck in Asset Safety are left out; safetyBlueprintCount lets the Blueprints tab say so.
  const allBlueprintsRaw = useMemo<EsiBlueprint[]>(() => [
    ...(primaryInScope ? auth.blueprints : []),
    ...activeAltCharacters.flatMap((a) => a.blueprints),
  ], [primaryInScope, auth.blueprints, activeAltCharacters]);

  const allBlueprints = useMemo<EsiBlueprint[]>(
    () => safetyIds.size === 0 ? allBlueprintsRaw : allBlueprintsRaw.filter((b) => !isInAssetSafety(b, safetyIds)),
    [allBlueprintsRaw, safetyIds],
  );

  const safetyBlueprintCount = allBlueprintsRaw.length - allBlueprints.length;

  // Fetch blueprint metadata (metaLevel + productTypeId) eagerly at login so icons
  // are ready before the user opens the My Blueprints tab.
  const [bpMetadataApp, setBpMetadataApp] = useState<Record<number, { metaLevel: number; productTypeId: number | null }>>({});

  useEffect(() => {
    if (allBlueprints.length === 0) return;
    const typeIds = [...new Set(allBlueprints.map(b => b.type_id))];
    fetch('/api/blueprint-metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blueprintTypeIds: typeIds }),
    })
      .then(res => res.json())
      .then(data => setBpMetadataApp(data))
      .catch(() => {});
  }, [allBlueprints]);

  // Combined USABLE assets summed by type_id (Asset Safety contents excluded) — used by useItemDetail for have/needed
  const combinedAssets = useMemo<EsiAsset[]>(() => {
    const map = new Map<number, number>();
    const add = (assets: EsiAsset[]) =>
      assets.forEach((a) => {
        if (safetyIds.has(a.item_id)) return;       // locked in Asset Safety: not usable, not counted
        map.set(a.type_id, (map.get(a.type_id) ?? 0) + a.quantity);
      });
    if (primaryInScope) add(auth.assets);
    activeAltCharacters.forEach((a) => add(a.assets));
    // Convert back to EsiAsset[] (server/hooks expect an array)
    return Array.from(map.entries()).map(([type_id, quantity]) => ({
      type_id, quantity,
      item_id: type_id, location_id: 0, location_flag: 'Hangar', is_singleton: false,
    }));
  }, [primaryInScope, auth.assets, activeAltCharacters, safetyIds]);

  // Best skill level per skill_id across in-scope characters (for market filtering)
  const bestSkillsArray = useMemo(() => {
    const map = new Map<number, number>();
    const add = (skills: Array<{ skill_id: number; active_skill_level: number }>) =>
      skills.forEach((s) => map.set(s.skill_id, Math.max(map.get(s.skill_id) ?? 0, s.active_skill_level)));
    if (primaryInScope) add(auth.skills);
    activeAltCharacters.forEach((a) => add(a.skills));
    return Array.from(map.entries()).map(([skill_id, active_skill_level]) => ({ skill_id, active_skill_level }));
  }, [primaryInScope, auth.skills, activeAltCharacters]);

  // All active jobs across in-scope characters
  const allActiveJobs = useMemo(() => [
    ...(primaryInScope ? (auth.character?.activeJobs ?? []) : []),
    ...activeAltCharacters.flatMap((a) => a.activeJobs),
  ], [primaryInScope, auth.character, activeAltCharacters]);

  return { activeAltCharacters, allActiveJobs, allBlueprints, allBlueprintsRaw, allRawAssets, bestSkillsArray, bpMetadataApp, combinedAssets, haulCharacters, primaryInScope, safetyBlueprintCount };
}
