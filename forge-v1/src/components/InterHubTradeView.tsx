import type { FC } from 'react';
import { formatISKDisplay as formatISK } from '../utils/format';
import { type InterHubArbRow, type InterHubHaulResult } from '../types';

interface InterHubTradeViewProps {
  interHubContext: InterHubArbRow | null;
  interHubHaulData: InterHubHaulResult | null;
  interHubHaulLoading: boolean;
  onConfigureInterHubHaul: () => void;
  profError: string | null;
  profLoading: boolean;
  profOrders: { count: number; volume: number; totalAtStation: number | null; } | null;
}

const InterHubTradeView: FC<InterHubTradeViewProps> = ({ interHubContext, interHubHaulData, interHubHaulLoading, onConfigureInterHubHaul, profError, profLoading, profOrders }) => {
  return (
    <>
{interHubContext && (() => {
          // Use character's actual rates once loaded; fall back to Accounting V estimate while loading
          const taxRate    = interHubHaulData ? interHubHaulData.transaction_tax_rate : 0.03375;
          const brokerRate = interHubHaulData ? interHubHaulData.broker_fee_rate      : null;
          const taxAmount  = interHubContext.sell_into * taxRate;
          const brokerAmt  = brokerRate != null ? interHubContext.sell_into * brokerRate : null;
          const haulCost   = interHubHaulData?.haul_cost ?? 0;
          // net_profit (from arb row) used TAX=0.964 estimate; recalc with real rates once loaded
          const netProfitReal = interHubHaulData
            ? interHubContext.sell_into * (1 - taxRate) - interHubContext.buy_at
            : interHubContext.net_profit;
          const netMarginReal = interHubContext.buy_at > 0
            ? (netProfitReal / interHubContext.buy_at) * 100
            : interHubContext.net_margin_pct;
          const afterHaul  = interHubHaulData?.haul_enabled ? netProfitReal - haulCost : null;
          const row        = interHubContext;
          const haul       = interHubHaulData;
          const haulLabel  = haul?.haul_enabled
            ? `${haul.method_label}${(haul.contracts ?? 0) > 1 ? `, ${haul.contracts} contracts` : ''}`
            : null;

          const rowStyle: React.CSSProperties = {
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            gap: 8, padding: '3px 0',
          };
          const labelStyle: React.CSSProperties = {
            fontSize: 11, color: 'var(--color-text-tertiary)', flexShrink: 0,
          };
          const valueStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, textAlign: 'right' };

          return (
            <>
              {/* Price breakdown */}
              <div className="detail-section">
                <div className="detail-section-heading">Trade Breakdown</div>

                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {/* Buy at */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>Buy at (sell orders, {row.buy_hub_name})</span>
                    <span style={valueStyle}>{formatISK(row.buy_at)}</span>
                  </div>
                  {(row.sell_orders_at_buy != null || row.sell_vol_at_buy != null) && (
                    <div style={{ ...rowStyle, marginTop: -2, marginBottom: 2 }}>
                      <span
                        style={{ ...labelStyle, fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}
                        title="Total units remaining across all sell orders at this hub — not all are at the displayed best price"
                      >
                        {row.sell_orders_at_buy != null ? `${row.sell_orders_at_buy.toLocaleString()} sell orders` : ''}
                        {row.sell_orders_at_buy != null && row.sell_vol_at_buy != null ? ' · ' : ''}
                        {row.sell_vol_at_buy != null ? `${row.sell_vol_at_buy.toLocaleString()} units total depth` : ''}
                      </span>
                    </div>
                  )}

                  {/* Haul */}
                  {interHubHaulLoading ? (
                    <div style={{ ...rowStyle }}>
                      <span style={labelStyle}>Haul cost</span>
                      <span style={{ ...valueStyle, color: 'var(--color-text-tertiary)', fontSize: 11 }}>calculating…</span>
                    </div>
                  ) : haul?.haul_enabled ? (
                    <div style={rowStyle}>
                      <span style={labelStyle}>Haul ({haulLabel}{haul.jumps > 0 ? `, ${haul.jumps} jumps` : ''})</span>
                      <span style={{ ...valueStyle, color: haulCost > 0 ? 'var(--color-danger)' : 'var(--color-text-tertiary)' }}>
                        {haulCost > 0 ? `−${formatISK(haulCost)}` : '—'}
                      </span>
                    </div>
                  ) : (
                    <div style={rowStyle}>
                      <span style={labelStyle}>Haul cost</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ ...valueStyle, color: 'var(--color-text-tertiary)', fontSize: 10 }}>not configured</span>
                        <button
                          type="button"
                          onClick={onConfigureInterHubHaul}
                          title="Configure inter-hub haulage"
                          style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 10,
                            background: 'rgba(79,195,247,0.12)',
                            border: '0.5px solid rgba(79,195,247,0.35)',
                            color: 'var(--color-accent-primary)',
                            cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                          }}
                        >
                          ⚙ Configure haulage
                        </button>
                      </span>
                    </div>
                  )}

                  {/* Sales tax — rate from Accounting skill once haul data loads */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>
                      Transaction tax
                      {haul ? ` (Accounting ${haul.accounting_level}, ${(taxRate * 100).toFixed(2)}%)` : ' (est. Acct V)'}
                    </span>
                    <span style={{ ...valueStyle, color: 'var(--color-danger)' }}>−{formatISK(taxAmount)}</span>
                  </div>

                  {/* Broker fee — only applicable when placing sell orders (not filling buy orders) */}
                  {brokerAmt != null && (
                    <div style={rowStyle}>
                      <span style={labelStyle}>
                        Broker fee if placing orders
                        {haul ? ` (BR ${haul.broker_relations}, ${(brokerRate! * 100).toFixed(2)}%)` : ''}
                      </span>
                      <span style={{ ...valueStyle, color: 'var(--color-warning)', fontSize: 11 }}>
                        −{formatISK(brokerAmt)}
                      </span>
                    </div>
                  )}

                  {/* Divider */}
                  <div style={{ height: 0.5, background: 'var(--color-border-light)', margin: '6px 0' }} />

                  {/* Sell into — merged with profitable order breakdown */}
                  <div style={rowStyle}>
                    <span style={labelStyle}>Sell into (buy orders, {row.sell_hub_name})</span>
                    <span style={valueStyle}>{formatISK(row.sell_into)}</span>
                  </div>
                  {/* Profitable order summary — auto-loads, same data source as totals */}
                  <div style={{ ...rowStyle, marginTop: 2, alignItems: 'flex-start' }}>
                    {profLoading && (
                      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}>
                        Checking orders…
                      </span>
                    )}
                    {profError && !profLoading && (
                      <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)', paddingLeft: 8 }}>
                        {row.buy_orders_at_sell != null ? `${row.buy_orders_at_sell.toLocaleString()} buy orders total` : ''}
                      </span>
                    )}
                    {profOrders && (
                      <div style={{ paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>
                          {(profOrders.totalAtStation ?? row.buy_orders_at_sell ?? 0).toLocaleString()} buy orders total
                          {row.buy_vol_at_sell != null ? ` · ${row.buy_vol_at_sell.toLocaleString()} units` : ''}
                        </span>
                        <span style={{ fontSize: 9, color: profOrders.count > 0 ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}>
                          {profOrders.count > 0
                            ? `${profOrders.count.toLocaleString()} profitable · ${profOrders.volume.toLocaleString()} units to fill`
                            : 'No profitable orders at current prices'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Net profit summary */}
              <div className="detail-section">
                <div className="detail-section-heading">Net Result</div>
                <div style={{ display: 'grid', gridTemplateColumns: afterHaul !== null ? '1fr 1fr 1fr' : '1fr 1fr', gap: 4 }}>
                  <div className="stat-card" style={{ textAlign: 'center' }}>
                    <div className="stat-card-label">PROFIT / UNIT</div>
                    <div className="stat-card-value" style={{
                      color: netProfitReal > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                      fontSize: 13,
                    }}>
                      {formatISK(netProfitReal)}
                    </div>
                  </div>
                  <div className="stat-card" style={{ textAlign: 'center' }}>
                    <div className="stat-card-label">MARGIN</div>
                    <div className="stat-card-value" style={{
                      color: netMarginReal >= 10 ? 'var(--color-success)' : netMarginReal >= 5 ? 'var(--color-warning)' : 'var(--color-text-secondary)',
                      fontSize: 13,
                    }}>
                      {netMarginReal.toFixed(1)}%
                    </div>
                  </div>
                  {afterHaul !== null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">AFTER HAUL</div>
                      <div className="stat-card-value" style={{
                        color: afterHaul > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 13,
                      }}>
                        {formatISK(afterHaul)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Cargo stats */}
              <div className="detail-section">
                <div className="detail-section-heading">Cargo &amp; Volume</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {row.volume_m3 > 0 && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">VOL / UNIT</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {row.volume_m3 < 1 ? row.volume_m3.toFixed(3) : row.volume_m3.toFixed(2)} m³
                      </div>
                    </div>
                  )}
                  {row.isk_per_m3 != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">ISK / M³</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>{formatISK(row.isk_per_m3)}</div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">VOL / DAY</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {row.avg_daily_volume >= 1000
                          ? (row.avg_daily_volume / 1000).toFixed(1) + 'k'
                          : row.avg_daily_volume.toFixed(0)}
                      </div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}>
                      <div className="stat-card-label">EST. DAILY</div>
                      <div className="stat-card-value" style={{
                        color: netProfitReal > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 12,
                      }}>
                        {formatISK(netProfitReal * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                  {afterHaul !== null && row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center', gridColumn: '1 / -1' }}>
                      <div className="stat-card-label">EST. DAILY (AFTER HAUL)</div>
                      <div className="stat-card-value" style={{
                        color: (afterHaul * row.avg_daily_volume) > 0 ? 'var(--color-success)' : 'var(--color-danger)',
                        fontSize: 12,
                      }}>
                        {formatISK(afterHaul * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                </div>

                {/* Jump count from haul data */}
                {(haul?.jumps ?? 0) > 0 && (
                  <div style={{ marginTop: 6, fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                    Route: {row.buy_hub_name} → {row.sell_hub_name} · {haul!.jumps} jump{haul!.jumps !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              {/* ── Capital & Risk ─────────────────────────────────────── */}
              <div className="detail-section" style={{ marginTop: 0 }}>
                <div className="detail-section-heading">Capital &amp; Risk</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  <div className="stat-card" style={{ textAlign: 'center' }}
                    title="Cash tied up per unit while in transit (buy price + haul cost)">
                    <div className="stat-card-label">CAPITAL / UNIT</div>
                    <div className="stat-card-value" style={{ fontSize: 12 }}>
                      {formatISK(row.buy_at + (haul?.haul_enabled ? haulCost : 0))}
                    </div>
                  </div>
                  {row.avg_daily_volume != null && (
                    <div className="stat-card" style={{ textAlign: 'center' }}
                      title="Full capital needed to move one day's worth of volume">
                      <div className="stat-card-label">DAILY CAPITAL</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {formatISK((row.buy_at + (haul?.haul_enabled ? haulCost : 0)) * row.avg_daily_volume)}
                      </div>
                    </div>
                  )}
                  {netProfitReal > 0 && row.buy_at > 0 && (
                    <div className="stat-card" style={{ textAlign: 'center' }}
                      title="How many units you need to sell to recover one unit's capital outlay">
                      <div className="stat-card-label">BREAK-EVEN UNITS</div>
                      <div className="stat-card-value" style={{ fontSize: 12 }}>
                        {Math.ceil(row.buy_at / netProfitReal).toLocaleString()}
                      </div>
                    </div>
                  )}
                  {row.avg_daily_volume != null && row.avg_daily_volume < 5 && (
                    <div className="stat-card" style={{ textAlign: 'center', gridColumn: netProfitReal > 0 && row.buy_at > 0 ? undefined : '1 / -1' }}
                      title="Low daily volume — orders may sit unsold for extended periods">
                      <div className="stat-card-label" style={{ color: 'var(--color-warning)' }}>⚠ THIN MARKET</div>
                      <div className="stat-card-value" style={{ fontSize: 11, color: 'var(--color-warning)' }}>
                        {row.avg_daily_volume.toFixed(1)} / day
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}
    </>
  );
};

export default InterHubTradeView;
