// ── Haul provider rate tables (mirrored from server.js HAUL_PROVIDERS) ────────
// Single client copy: IndustrySettings and InterHubHaulConfig both import from here.
export interface HaulProvider {
  name:            string;
  max_volume_m3:   number;
  min_fee:         number;
  isk_per_m3:      number;
  collateral_rate: number;
  rates_as_of:     string;
  note:            string;
}

export const HAUL_PROVIDERS: Record<string, HaulProvider> = {
  red_frog:   { name: 'Red Frog',   max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 400,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec only'          },
  black_frog: { name: 'Black Frog', max_volume_m3: 860_000, min_fee: 1_500_000, isk_per_m3: 1_200, collateral_rate: 0.01,  rates_as_of: 'Jun 2025', note: 'Lowsec / Null / WH'    },
  pushx:      { name: 'PushX',      max_volume_m3: 860_000, min_fee: 1_000_000, isk_per_m3: 380,   collateral_rate: 0.005, rates_as_of: 'Jun 2025', note: 'Highsec + some lowsec' },
};

export function calcProviderFee(provider: string, volumeM3: number, collateral: number): number {
  const p = HAUL_PROVIDERS[provider];
  if (!p || volumeM3 <= 0) return 0;
  const contracts  = Math.ceil(volumeM3 / p.max_volume_m3);
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
