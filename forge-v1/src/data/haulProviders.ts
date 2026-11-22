// ── Haul provider rate tables ─────────────────────────────────────────────────
// The ONE copy is server/lib/haul-providers.json (the server's lib/haul.js reads the same file), so the
// website's estimates and the server's haul costs can never use different rates.
import providers from '../../../server/lib/haul-providers.json';

export interface HaulProvider {
  name:            string;
  max_volume_m3:   number;
  max_collateral:  number;
  min_fee:         number;
  isk_per_m3:      number;
  collateral_rate: number;
  rates_as_of:     string;
  note:            string;
}

export const HAUL_PROVIDERS: Record<string, HaulProvider> = providers;

/** Same rule as the server's calcProviderFee: a load over the volume OR collateral limit is split into contracts. */
export function calcProviderFee(provider: string, volumeM3: number, collateral: number): number {
  const p = HAUL_PROVIDERS[provider];
  if (!p || volumeM3 <= 0) return 0;
  const contracts  = Math.max(1, Math.ceil(volumeM3 / p.max_volume_m3),
                              p.max_collateral > 0 ? Math.ceil(collateral / p.max_collateral) : 1);
  const volPerCon  = volumeM3    / contracts;
  const colPerCon  = collateral  / contracts;
  const feePerCon  = Math.max(p.min_fee, p.isk_per_m3 * volPerCon + p.collateral_rate * colPerCon);
  return feePerCon * contracts;
}

export function fmtISK(n: number): string {
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

export interface CharacterSkillData {
  characterId: number;
  name:        string;
  skills:      Array<{ skill_id: number; active_skill_level: number }>;
}
