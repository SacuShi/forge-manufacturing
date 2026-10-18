/**
 * Asset Safety detection.
 *
 * Asset Safety is not a station. When an Upwell structure is destroyed (or Asset Safety is triggered by hand)
 * its contents are bundled into an "Asset Safety Wrap" container that exists in no physical location until it
 * is delivered (CCP support article "Asset Safety"; ESI docs "Asset location_id quick reference": an asset in
 * Asset Safety has location_id == 2004). After the automatic 20-day move — or a manual one — the wrap shows
 * up as a container in an NPC station hangar, and the items stay locked inside it until they are released
 * (15% of their value if the station is in another system, 0.5% in the same system).
 *
 * Either way the items cannot be used for manufacturing, so everything that is (a) in a wrap, (b) located at
 * 2004, or (c) flagged `AssetSafety` is treated as "in Asset Safety" and kept out of every calculation.
 */

import type { EsiAsset } from '../types';

/** ESI location_id of items in Asset Safety (not yet delivered anywhere). */
export const ASSET_SAFETY_LOCATION_ID = 2004;
/** type_id of the "Asset Safety Wrap" container. */
export const ASSET_SAFETY_WRAP_TYPE_ID = 60;
/** ESI location_flag of items inside Asset Safety. */
export const ASSET_SAFETY_FLAG = 'AssetSafety';

/** Official release fees (CCP support: Asset Safety). */
export const ASSET_SAFETY_FEE_OTHER_SYSTEM = 0.15;
export const ASSET_SAFETY_FEE_SAME_SYSTEM  = 0.005;

type AssetLike = Pick<EsiAsset, 'item_id' | 'type_id' | 'location_id' | 'location_flag'>;

/**
 * item_ids of every asset that is in Asset Safety (including the wrap containers themselves and anything
 * nested inside them: ships, their fittings, containers…). Works on one character's list or on several
 * characters' lists concatenated (item_ids are globally unique).
 */
export function findAssetSafetyItemIds(assets: readonly AssetLike[]): Set<number> {
  const byId = new Map<number, AssetLike>();
  for (const a of assets) byId.set(a.item_id, a);

  const verdict = new Map<number, boolean>();

  const isSafety = (start: AssetLike): boolean => {
    // Walk up the parent chain (an item inside a ship/container has location_id = that item's item_id).
    const path: number[] = [];
    let cur: AssetLike | undefined = start;
    let result = false;
    const seen = new Set<number>();
    while (cur) {
      if (verdict.has(cur.item_id)) { result = verdict.get(cur.item_id)!; break; }
      if (seen.has(cur.item_id)) break;                         // cycle guard (never in real data)
      seen.add(cur.item_id);
      path.push(cur.item_id);
      if (cur.location_flag === ASSET_SAFETY_FLAG
          || cur.type_id === ASSET_SAFETY_WRAP_TYPE_ID
          || cur.location_id === ASSET_SAFETY_LOCATION_ID) { result = true; break; }
      cur = byId.get(cur.location_id);                          // undefined once we reach a station/structure/system
    }
    for (const id of path) verdict.set(id, result);
    return result;
  };

  const out = new Set<number>();
  for (const a of assets) if (isSafety(a)) out.add(a.item_id);
  return out;
}

/** Splits a list into what can be used and what is locked in Asset Safety. */
export function splitAssetSafety<T extends AssetLike>(assets: readonly T[]): { usable: T[]; safety: T[]; safetyIds: Set<number> } {
  const safetyIds = findAssetSafetyItemIds(assets);
  if (safetyIds.size === 0) return { usable: assets as T[], safety: [], safetyIds };
  const usable: T[] = [], safety: T[] = [];
  for (const a of assets) (safetyIds.has(a.item_id) ? safety : usable).push(a);
  return { usable, safety, safetyIds };
}

/**
 * Whether a blueprint (or any ESI entry with an item_id + location) is in Asset Safety. A blueprint that is
 * itself in the asset list is judged by the same parent walk; otherwise by its own location fields or by its
 * parent being a safety item.
 */
export function isInAssetSafety(
  entry: { item_id: number; location_id: number; location_flag: string },
  safetyIds: ReadonlySet<number>,
): boolean {
  return safetyIds.has(entry.item_id)
    || safetyIds.has(entry.location_id)
    || entry.location_id === ASSET_SAFETY_LOCATION_ID
    || entry.location_flag === ASSET_SAFETY_FLAG;
}

/**
 * Fee to release Asset Safety contents, from a total value: 15% (station in another system — what the
 * automatic move does) or 0.5% (a station in the same system as the original structure).
 */
export function assetSafetyFees(totalValue: number): { otherSystem: number; sameSystem: number } {
  const v = Number.isFinite(totalValue) && totalValue > 0 ? totalValue : 0;
  return { otherSystem: v * ASSET_SAFETY_FEE_OTHER_SYSTEM, sameSystem: v * ASSET_SAFETY_FEE_SAME_SYSTEM };
}
