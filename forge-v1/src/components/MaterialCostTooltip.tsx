import type { FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { type TrueCostResponse } from '../types';

interface MaterialCostTooltipProps {
  blueprintME: number;
  trueCostData: TrueCostResponse;
}

const MaterialCostTooltip: FC<MaterialCostTooltipProps> = ({ blueprintME, trueCostData }) => {
  return (
    <>
{(() => {
                      const isT2    = trueCostData.manufacturing_setup?.is_t2 ?? false;
                      const bpMe    = trueCostData.manufacturing_setup?.blueprint_me   ?? blueprintME;
                      const t2Base  = trueCostData.manufacturing_setup?.t2_base_me     ?? null;
                      const decrMe  = trueCostData.manufacturing_setup?.decryptor_me_bonus ?? null;
                      const strMe   = trueCostData.manufacturing_setup?.structure_me_bonus ?? 0;
                      const rigMe   = trueCostData.manufacturing_setup?.rig_me_bonus   ?? 0;
                      const effME   = trueCostData.manufacturing_setup?.effective_me   ?? bpMe;
                      const effFac  = Math.max(0, 1 - effME / 100);
                      const rawCost = effME > 0
                        ? trueCostData.total_material_cost / effFac
                        : trueCostData.total_material_cost;
                      const saving  = rawCost - trueCostData.total_material_cost;
                      const meColor = (n: number) => n >= 0 ? 'var(--color-success)' : 'var(--color-warning)';
                      return (
                        <>
                          {isT2 ? (
                            <>
                              <div className="cost-tooltip-row">
                                <span>T2 BPC base ME</span>
                                <span style={{ color: meColor(t2Base ?? 0) }}>{t2Base}%</span>
                              </div>
                              {decrMe !== null && decrMe !== 0 && (
                                <div className="cost-tooltip-row">
                                  <span>Decryptor ME</span>
                                  <span style={{ color: meColor(decrMe) }}>{decrMe > 0 ? '+' : ''}{decrMe}%</span>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="cost-tooltip-row">
                              <span>Blueprint ME</span>
                              <span style={{ color: meColor(bpMe) }}>{bpMe}%</span>
                            </div>
                          )}
                          {strMe > 0 && (
                            <div className="cost-tooltip-row">
                              <span>Structure ME</span>
                              <span style={{ color: 'var(--color-success)' }}>+{strMe}%</span>
                            </div>
                          )}
                          {(trueCostData.manufacturing_setup?.rigs ?? []).map((r) => (
                            <div key={r.id} className="cost-tooltip-row" style={r.applies ? undefined : { opacity: 0.55 }}>
                              <span>
                                {r.name.replace(/^Standup /, '')}
                                {r.applies
                                  ? ` (${r.base_me_pct}%${r.security_mult !== 1 ? ` × ${r.security_mult}` : ''})`
                                  : (trueCostData.manufacturing_setup?.product_family_known === false
                                      ? ' — coverage unknown for this item type'
                                      : ' — not for this item type')}
                              </span>
                              <span style={{ color: r.applies ? 'var(--color-success)' : undefined }}>
                                {r.applies ? `+${r.eff_me_pct.toFixed(2)}%` : '—'}
                              </span>
                            </div>
                          ))}
                          {rigMe === 0 && (trueCostData.manufacturing_setup?.rigs?.length ?? 0) > 0
                            && trueCostData.manufacturing_setup?.product_family_known === false && (
                            <div className="cost-tooltip-row" style={{ opacity: 0.7 }}>
                              <span>Rig coverage for this item type isn&apos;t mapped — no rig bonus applied</span>
                              <span>—</span>
                            </div>
                          )}
                          {(isT2 || strMe > 0 || rigMe > 0) && (
                            <div className="cost-tooltip-row" style={{
                              borderTop: '0.5px solid rgba(79,195,247,0.15)',
                              marginTop: 3, paddingTop: 3,
                            }}>
                              <span>Effective ME</span>
                              <span style={{ color: meColor(effME), fontWeight: 600 }}>
                                {effME.toFixed(1)}%
                              </span>
                            </div>
                          )}
                          {effME > 0 && (
                            <>
                              <div className="cost-tooltip-row">
                                <span>Base cost (ME 0)</span>
                                <span>{formatISK(rawCost)}</span>
                              </div>
                              <div className="cost-tooltip-row">
                                <span>ME saving ({effME.toFixed(1)}%)</span>
                                <span style={{ color: 'var(--color-success)' }}>
                                  −{formatISK(saving)}
                                </span>
                              </div>
                              <div className="cost-tooltip-divider" />
                            </>
                          )}
                          <div className="cost-tooltip-row total">
                            <span>Adjusted cost</span>
                            <span>{formatISK(trueCostData.total_material_cost)}</span>
                          </div>
                        </>
                      );
                    })()}
    </>
  );
};

export default MaterialCostTooltip;
