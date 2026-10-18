import type { FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { type TrueCostResponse } from '../types';

interface HaulBoxRowProps {
  trueCostData: TrueCostResponse | null;
  trueCostLoading: boolean;
}

const HaulBoxRow: FC<HaulBoxRowProps> = ({ trueCostData, trueCostLoading }) => {
  return (
    <>
{trueCostData && !trueCostLoading && (() => {
              const h = trueCostData.haul_cost;
              // Show box if any method is non-default or rates > 0
              const leg1Active = h.leg1_method !== 'user_defined' || h.leg1_rate > 0 || h.leg1_configured === true;
              const leg2Active = h.leg2_method !== 'user_defined' || h.leg2_rate > 0 || h.leg2_configured === true;
              if (!leg1Active && !leg2Active) return null;

              const methodLabel = (m: string, ship: string | null, label: string | null) => {
                if (m === 'red_frog')   return 'Red Frog';
                if (m === 'black_frog') return 'Black Frog';
                if (m === 'pushx')      return 'PushX';
                if (m === 'self_haul')  return ship ? `Self — ${ship}` : 'Self-Haul';
                return label || 'User-Defined';
              };

              const jumpStr = (j: number) => j > 0 ? ` · ${j} jump${j !== 1 ? 's' : ''}` : '';

              return (
                <div className="cost-breakdown-row" style={{ marginTop: 4 }}>
                  <div className="cost-box haulage" style={{ flex: '0 0 calc(50% - 4px)' }}>
                    <span className="cost-box-label">Haulage</span>
                    <span className="cost-box-value">
                      {h.total > 0 ? formatISK(h.total) : '—'}
                    </span>
                    <div className="cost-tooltip">
                      {/* Leg 1 */}
                      {leg1Active && h.leg1_jumps > 0 ? (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Materials in{jumpStr(h.leg1_jumps)}</span>
                            <span>{h.leg1_cost > 0 ? formatISK(h.leg1_cost) : '—'}</span>
                          </div>
                          <div className="cost-tooltip-sub">
                            {methodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)}
                            {h.leg1_volume_m3 > 0 && ` · ${Math.round(h.leg1_volume_m3).toLocaleString()} m³`}
                            {h.leg1_isk_per_m3_effective > 0 && ` · ${Math.round(h.leg1_isk_per_m3_effective).toLocaleString()} ISK/m³`}
                            {h.leg1_contracts > 1 && ` · ${h.leg1_contracts} contracts`}
                          </div>
                        </>
                      ) : (
                        <div className="cost-tooltip-row">
                          <span>Materials in</span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>
                            {leg1Active && h.leg1_jumps === 0 ? 'Same location' : 'Not configured'}
                          </span>
                        </div>
                      )}
                      {/* Jita import leg — materials the buy hub can't supply */}
                      {(h.import_leg_cost ?? 0) > 0 && (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Jita import{jumpStr(h.import_leg_jumps ?? 0)}</span>
                            <span>{formatISK(h.import_leg_cost ?? 0)}</span>
                          </div>
                          <div className="cost-tooltip-sub">
                            Materials the buy hub can&apos;t supply · {Math.round(h.import_leg_volume_m3 ?? 0).toLocaleString()} m³ · Leg 1 settings
                          </div>
                        </>
                      )}
                      {h.import_leg_route_known === false && (
                        <div className="cost-tooltip-row">
                          <span>Jita import</span>
                          <span style={{ color: 'var(--color-warning)' }}>route unknown — not included</span>
                        </div>
                      )}
                      {/* Leg 2 */}
                      {leg2Active && h.leg2_jumps > 0 ? (
                        <>
                          <div className="cost-tooltip-row">
                            <span>Goods out{jumpStr(h.leg2_jumps)}</span>
                            <span>{h.leg2_cost > 0 ? formatISK(h.leg2_cost) : '—'}</span>
                          </div>
                          <div className="cost-tooltip-sub">
                            {methodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)}
                            {h.leg2_volume_m3 > 0 && ` · ${Math.round(h.leg2_volume_m3).toLocaleString()} m³`}
                            {h.leg2_isk_per_m3_effective > 0 && ` · ${Math.round(h.leg2_isk_per_m3_effective).toLocaleString()} ISK/m³`}
                            {h.leg2_contracts > 1 && ` · ${h.leg2_contracts} contracts`}
                          </div>
                        </>
                      ) : (
                        <div className="cost-tooltip-row">
                          <span>Goods out</span>
                          <span style={{ color: 'var(--color-text-tertiary)' }}>
                            {leg2Active && h.leg2_jumps === 0 ? 'Same location' : 'Not configured'}
                          </span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total Haul</span>
                        <span style={{ color: 'var(--color-warning)' }}>
                          {h.total > 0 ? formatISK(h.total) : '— awaiting volume data'}
                        </span>
                      </div>
                      {h.total === 0 && (
                        <div className="cost-tooltip-setup" style={{ color: 'var(--color-warning)', opacity: 0.8 }}>
                          ⟳ Run node sde-import.js on the server to calculate volumes.
                        </div>
                      )}
                      {h.provider_rates_as_of && (
                        <div className="cost-tooltip-setup">
                          Provider rates as of {h.provider_rates_as_of} — verify at provider website.
                        </div>
                      )}
                      <div className="cost-tooltip-setup">
                        Haul cost deducted from True Profit. Adjust in ⚙ Mfg Setup → Haulage.
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
    </>
  );
};

export default HaulBoxRow;
