import type { FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { type TrueCostResponse } from '../types';

interface TrueProfitBoxProps {
  trueCostData: TrueCostResponse;
}

const TrueProfitBox: FC<TrueProfitBoxProps> = ({ trueCostData }) => {
  return (
    <>
{(() => {
                  const h = trueCostData.haul_cost;
                  const leg1Active = h.leg1_method !== 'user_defined' || h.leg1_rate > 0 || h.leg1_configured === true;
                  const leg2Active = h.leg2_method !== 'user_defined' || h.leg2_rate > 0 || h.leg2_configured === true;
                  const haulConfigured = leg1Active || leg2Active;
                  // True when every active leg is self-haul (no contracted freight cost)
                  const allSelfHaul =
                    haulConfigured &&
                    (!leg1Active || h.leg1_method === 'self_haul') &&
                    (!leg2Active || h.leg2_method === 'self_haul');
                  // Provider haul is active if any leg uses a contracted/user-rate method
                  const hasProviderHaul =
                    (leg1Active && h.leg1_method !== 'self_haul') ||
                    (leg2Active && h.leg2_method !== 'self_haul');

                  const haulMethodLabel = (
                    method: string,
                    ship: string | null,
                    label: string | null,
                  ): string => {
                    if (method === 'red_frog')   return 'Red Frog';
                    if (method === 'black_frog') return 'Black Frog';
                    if (method === 'pushx')      return 'PushX';
                    if (method === 'self_haul')  return ship ? `Self-haul (${ship})` : 'Self-haul';
                    return label || 'User rate';
                  };

                  return (
                    <div className={`cost-box true-profit${trueCostData.true_profit >= 0 ? ' positive' : ' negative'}`}>
                      <span className="cost-box-label">True Profit (Net)</span>
                      <span className="cost-box-value">
                        {formatISK(trueCostData.true_profit)}
                      </span>
                      <span className="cost-box-margin">
                        {trueCostData.true_margin.toFixed(1)}%
                      </span>
                      {/* Tooltip — full formula so users can verify the math */}
                      <div className="cost-tooltip">

                        {/* ── Formula rows ─────────────────────────── */}
                        <div className="cost-tooltip-row">
                          <span>Sell Revenue</span>
                          <span>{formatISK(trueCostData.sell_price * trueCostData.runs)}</span>
                        </div>
                        <div className="cost-tooltip-row">
                          <span>− Materials</span>
                          <span style={{ color: 'var(--color-danger)' }}>
                            −{formatISK(trueCostData.total_material_cost)}
                          </span>
                        </div>
                        {trueCostData.setup_configured && (
                          <div className="cost-tooltip-row">
                            <span>− Mfg Fees</span>
                            <span style={{ color: 'var(--color-danger)' }}>
                              −{formatISK(trueCostData.mfg_fees.total)}
                            </span>
                          </div>
                        )}
                        <div className="cost-tooltip-row">
                          <span>− Sales Tax</span>
                          <span style={{ color: 'var(--color-danger)' }}>
                            −{formatISK(trueCostData.sales_tax.total)}
                          </span>
                        </div>

                        {/* Invention overhead */}
                        {trueCostData.invention_cost && (
                          <div className="cost-tooltip-row">
                            <span>− Invention</span>
                            <span style={{ color: 'var(--color-danger)' }}>
                              −{formatISK(trueCostData.invention_cost.total)}
                            </span>
                          </div>
                        )}

                        {/* ── Haulage — always present, detail varies by config ── */}
                        {haulConfigured ? (
                          <>
                            {/* Summary line */}
                            <div className="cost-tooltip-row">
                              <span>− Haulage</span>
                              <span style={{
                                color: h.total > 0
                                  ? 'var(--color-danger)'
                                  : 'var(--color-text-tertiary)',
                              }}>
                                {h.total > 0
                                  ? `−${formatISK(h.total)}`
                                  : allSelfHaul ? '— (self-haul)' : '— (loading)'}
                              </span>
                            </div>
                            {/* Leg 1 — Materials in */}
                            {leg1Active && (
                              <div className="cost-tooltip-sub">
                                {h.leg1_method === 'self_haul'
                                  ? `Materials in: ${haulMethodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)} — no freight cost`
                                  : `Materials in: ${haulMethodLabel(h.leg1_method, h.leg1_self_ship, h.leg1_service_label)}` +
                                    (h.leg1_cost > 0
                                      ? ` · ${formatISK(h.leg1_cost)}`
                                      : h.leg1_jumps > 0 ? ' · loading…' : ' · same location')
                                }
                              </div>
                            )}
                            {/* Jita import leg — materials the buy hub can't supply */}
                            {(h.import_leg_cost ?? 0) > 0 && (
                              <div className="cost-tooltip-sub">
                                {`Jita import: ${formatISK(h.import_leg_cost ?? 0)} · ${Math.round(h.import_leg_volume_m3 ?? 0).toLocaleString()} m³ · ${h.import_leg_jumps ?? 0} jumps`}
                              </div>
                            )}
                            {h.import_leg_route_known === false && (
                              <div className="cost-tooltip-sub">Jita import: route unknown — freight not included</div>
                            )}
                            {/* Leg 2 — Goods out */}
                            {leg2Active && (
                              <div className="cost-tooltip-sub">
                                {h.leg2_method === 'self_haul'
                                  ? `Goods out: ${haulMethodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)} — no freight cost`
                                  : `Goods out: ${haulMethodLabel(h.leg2_method, h.leg2_self_ship, h.leg2_service_label)}` +
                                    (h.leg2_cost > 0
                                      ? ` · ${formatISK(h.leg2_cost)}`
                                      : h.leg2_jumps > 0 ? ' · loading…' : ' · same location')
                                }
                              </div>
                            )}
                          </>
                        ) : (
                          /* Haulage not configured — show as greyed-out formula line */
                          <div className="cost-tooltip-row" style={{ opacity: 0.45 }}>
                            <span>− Haulage</span>
                            <span style={{ color: 'var(--color-text-tertiary)' }}>
                              — not configured
                            </span>
                          </div>
                        )}

                        <div className="cost-tooltip-divider" />
                        <div className="cost-tooltip-row total">
                          <span>= True Profit</span>
                          <span style={{
                            color: trueCostData.true_profit >= 0
                              ? 'var(--color-success)'
                              : 'var(--color-danger)',
                          }}>
                            {formatISK(trueCostData.true_profit)}
                          </span>
                        </div>
                        <div className="cost-tooltip-row">
                          <span>Margin</span>
                          <span style={{
                            color: trueCostData.true_margin >= 0
                              ? 'var(--color-success)'
                              : 'var(--color-danger)',
                          }}>
                            {trueCostData.true_margin.toFixed(2)}%
                          </span>
                        </div>

                        {/* ── Explanatory footer ──────────────────── */}
                        <div className="cost-tooltip-setup" style={{ marginTop: 8, borderTop: '0.5px solid var(--color-border-light)', paddingTop: 6 }}>
                          The opportunity list shows an estimated spread assuming
                          an unresearched blueprint and no taxes — useful for
                          comparing items at a glance. This figure is what actually
                          lands in your wallet: your blueprint's ME research trims
                          material consumption, CONCORD collects its mandatory SCC
                          levy, your structure charges its facility fee, and the
                          broker's cut and transaction tax are applied based on your
                          skills and standings.
                          {allSelfHaul &&
                            ' Self-haul is selected — no contracted freight cost is included in this figure.'
                          }
                          {haulConfigured && !allSelfHaul &&
                            ' Haulage costs are included, covering both the inbound materials run and the outbound finished-goods run.'
                          }
                          {!haulConfigured &&
                            ' Haulage is not configured — open ⚙ Mfg Setup → Haulage to include freight costs.'
                          }
                        </div>
                        {!trueCostData.setup_configured && (
                          <div className="cost-tooltip-setup">
                            Manufacturing fees not included — configure your
                            structure and system in ⚙ Mfg Setup for a complete
                            picture.
                          </div>
                        )}
                        {/* Volume loading warning — only when a provider is selected but volumes haven't loaded */}
                        {hasProviderHaul && h.total === 0 && (
                          <div className="cost-tooltip-setup" style={{ color: 'var(--color-warning)', opacity: 0.85 }}>
                            ⟳ Haulage volumes are loading — item packaged volumes
                            are needed to calculate freight costs. If this persists,
                            run sde-import.js on the server.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
    </>
  );
};

export default TrueProfitBox;
