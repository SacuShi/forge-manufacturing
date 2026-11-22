import { describe, it, expect } from 'vitest';
import { HAUL_PROVIDERS, calcProviderFee } from '../haulProviders';

// The website and the server read the same rate table (server/lib/haul-providers.json).
describe('haul providers', () => {
  it('has the three courier services with volume AND collateral limits', () => {
    expect(Object.keys(HAUL_PROVIDERS).sort()).toEqual(['black_frog', 'pushx', 'red_frog']);
    for (const p of Object.values(HAUL_PROVIDERS)) {
      expect(p.max_volume_m3).toBeGreaterThan(0);
      expect(p.max_collateral).toBeGreaterThan(0);
    }
  });
  it('a load over the collateral limit is split into more contracts (same rule as the server)', () => {
    const rf = HAUL_PROVIDERS.red_frog;
    // 2.5B collateral over a 1B limit → 3 contracts, each at least the minimum fee
    expect(calcProviderFee('red_frog', 100, 2.5e9)).toBeCloseTo(3 * Math.max(rf.min_fee, rf.isk_per_m3 * 100 / 3 + rf.collateral_rate * 2.5e9 / 3), 6);
  });
});
