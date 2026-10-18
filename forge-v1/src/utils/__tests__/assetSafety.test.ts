import { describe, it, expect } from 'vitest';
import {
  findAssetSafetyItemIds, splitAssetSafety, isInAssetSafety, assetSafetyFees,
  ASSET_SAFETY_LOCATION_ID, ASSET_SAFETY_WRAP_TYPE_ID,
} from '../assetSafety';

const asset = (item_id: number, location_id: number, over: Partial<{ type_id: number; location_flag: string }> = {}) =>
  ({ item_id, type_id: 34, location_id, location_flag: 'Hangar', ...over });

describe('asset safety detection', () => {
  const wrap = asset(10, 60003760, { type_id: ASSET_SAFETY_WRAP_TYPE_ID });
  const inWrap = asset(11, 10); // directly inside the wrap
  const inCrate = asset(12, 11); // inside something inside the wrap
  const flagged = asset(13, 60003760, { location_flag: 'AssetSafety' });
  const atLocation = asset(14, ASSET_SAFETY_LOCATION_ID);
  const normal = asset(15, 60003760);
  const all = [wrap, inWrap, inCrate, flagged, atLocation, normal];

  it('finds the wrap, everything nested in it, and flagged items', () => {
    expect([...findAssetSafetyItemIds(all)].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });

  it('splits usable from locked without losing or duplicating anything', () => {
    const { usable, safety } = splitAssetSafety(all);
    expect(usable).toEqual([normal]);
    expect(safety).toHaveLength(5);
    expect(usable.length + safety.length).toBe(all.length);
  });

  it('returns the same array when nothing is locked', () => {
    const plain = [normal];
    expect(splitAssetSafety(plain).usable).toBe(plain);
  });

  it('survives a parent cycle', () => {
    expect(() => findAssetSafetyItemIds([asset(1, 2), asset(2, 1)])).not.toThrow();
  });

  it('classifies entries by the computed ids, location or flag', () => {
    const ids = findAssetSafetyItemIds(all);
    expect(isInAssetSafety({ item_id: 99, location_id: 10, location_flag: 'Hangar' }, ids)).toBe(true);
    expect(isInAssetSafety({ item_id: 99, location_id: 5, location_flag: 'Hangar' }, ids)).toBe(false);
  });
});

describe('asset safety release cost', () => {
  it('charges 15% to another system and 0.5% within the same system', () => {
    expect(assetSafetyFees(1_000_000)).toEqual({ otherSystem: 150_000, sameSystem: 5_000 });
  });
  it('ignores bad totals', () => {
    expect(assetSafetyFees(NaN)).toEqual({ otherSystem: 0, sameSystem: 0 });
    expect(assetSafetyFees(-5)).toEqual({ otherSystem: 0, sameSystem: 0 });
  });
});
