import { describe, it, expect } from 'vitest';
import { findAssetSafetyItemIds, splitAssetSafety, isInAssetSafety, assetSafetyFees } from '../assetSafety';

// Hand-built asset tree exercising wraps that were never delivered, wraps delivered to a station, and odd nesting.
const STATION = 60003760;
const asset = (item_id: number, type_id: number, location_id: number, location_flag = 'Hangar') =>
  ({ item_id, type_id, quantity: 1, location_id, location_flag, is_singleton: false });

const assets = [
  // a normal station hangar: a ship with a fitted module, and loose minerals
  asset(1, 587, STATION),                       // Rifter in the hangar
  asset(2, 2046, 1, 'LoSlot0'),                 // module fitted to the Rifter
  asset(3, 34, STATION),                        // Tritanium
  // an asset-safety wrap that has NOT been delivered anywhere (location 2004)
  asset(10, 60, 2004, 'AssetSafety'),           // the wrap
  asset(11, 587, 10, 'AssetSafety'),            // a ship inside it
  asset(12, 2046, 11, 'LoSlot0'),               // its fitted module
  asset(13, 35, 10, 'AssetSafety'),             // loose Pyerite inside
  // a wrap that HAS been delivered to the station hangar; contents still locked inside
  asset(20, 60, STATION),
  asset(21, 36, 20, 'AssetSafety'),
  asset(22, 11399, 21),                         // (odd nesting) still inside the wrap's contents
  // a stray item flagged AssetSafety whose parent isn't in the list
  asset(30, 37, 999999, 'AssetSafety'),
];

describe('asset safety on a realistic asset tree', () => {
  it('treats items in an undelivered wrap (location 2004) and everything nested in them as safety', () => {
    const ids = findAssetSafetyItemIds(assets);
    for (const id of [10, 11, 12, 13]) expect(ids.has(id), `item ${id}`).toBe(true);
  });

  it('keeps the contents of a wrap delivered to a station locked (the wrap and its contents are safety)', () => {
    const ids = findAssetSafetyItemIds(assets);
    for (const id of [20, 21, 22]) expect(ids.has(id), `item ${id}`).toBe(true);
  });

  it('does not treat ordinary hangar items, ships and their fittings as safety', () => {
    const ids = findAssetSafetyItemIds(assets);
    for (const id of [1, 2, 3]) expect(ids.has(id), `item ${id}`).toBe(false);
  });

  it('treats an item flagged AssetSafety as safety even when its parent is unknown', () => {
    expect(findAssetSafetyItemIds(assets).has(30)).toBe(true);
  });

  it('partitions without losing or duplicating anything', () => {
    const { usable, safety, safetyIds } = splitAssetSafety(assets);
    expect(usable.length + safety.length).toBe(assets.length);
    expect(usable.map((a) => a.item_id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(safetyIds.size).toBe(safety.length);
  });

  it('returns the original array untouched when nothing is locked', () => {
    const plain = assets.slice(0, 3);
    const result = splitAssetSafety(plain);
    expect(result.usable).toBe(plain);
    expect(result.safety).toHaveLength(0);
  });

  it('cannot hang on a parent cycle', () => {
    const cycle = [asset(1, 587, 2), asset(2, 587, 1), asset(3, 34, STATION)];
    expect(findAssetSafetyItemIds(cycle).size).toBe(0);
  });

  it('judges blueprints by the asset tree, their own location, or their parent', () => {
    const ids = findAssetSafetyItemIds(assets);
    const bp = (item_id: number, location_id: number, location_flag = 'Hangar') => ({ item_id, location_id, location_flag });
    expect(isInAssetSafety(bp(11, 10), ids)).toBe(true);                       // in the asset list, inside a wrap
    expect(isInAssetSafety(bp(500, 2004, 'AssetSafety'), ids)).toBe(true);     // not in the list, but located at 2004
    expect(isInAssetSafety(bp(501, 10), ids)).toBe(true);                      // parent is the wrap
    expect(isInAssetSafety(bp(502, STATION), ids)).toBe(false);                // ordinary station hangar
  });

  it('charges 15% to another system and 0.5% within the same system, and ignores bad totals', () => {
    expect(assetSafetyFees(1_000_000_000)).toEqual({ otherSystem: 150_000_000, sameSystem: 5_000_000 });
    expect(assetSafetyFees(NaN)).toEqual({ otherSystem: 0, sameSystem: 0 });
    expect(assetSafetyFees(-5)).toEqual({ otherSystem: 0, sameSystem: 0 });
  });
});
