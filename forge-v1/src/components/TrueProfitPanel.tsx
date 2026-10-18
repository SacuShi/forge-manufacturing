import type { FC } from 'react';
import { formatISKDisplay as formatISK, liquidityInfo, formatPerDay } from '../utils/format';
import { INVENTION_DECRYPTORS, type AltCharacter, type ItemDetailApiResponse, type InterHubArbRow, type JumpClone, type Market, type TrueCostResponse } from '../types';
import HaulBoxRow from './HaulBoxRow';
import TrueProfitBox from './TrueProfitBox';
import MaterialCostTooltip from './MaterialCostTooltip';
import SourcingNotices from './SourcingNotices';
import ImplantSelector from './ImplantSelector';

interface TrueProfitPanelProps {
  activeImplants: number[];
  altCharacters: AltCharacter[];
  apiDetail: ItemDetailApiResponse | null;
  blueprintME: number;
  commitRuns: () => void;
  displayName: string;
  displayRuns: number;
  effectiveTrueCostError: string | null;
  feeCharacterId: number | null;
  feeCharacterName: string;
  handleRunsChange: (raw: string) => void;
  interHubContext: InterHubArbRow | null;
  isBlueprintClick: boolean;
  itemNames: Map<number, string>;
  jumpClones: JumpClone[];
  materialMarketName: string;
  onFeeCharacterChange: (characterId: number | null) => void;
  onImplantsChange: (implants: number[]) => void;
  onOpenSettings: (section?: "haulage" | undefined) => void;
  primaryCharacterName: string;
  runsInputVal: string;
  selectedImplants: number[];
  selectedLiquidityRisk: string | null;
  selectedMarket: Market;
  selectedTypeId: number;
  selectedVolume: number | null;
  selectedVolumeSource: "hub" | "jita" | null;
  trueCostData: TrueCostResponse | null;
  trueCostError: string | null;
  trueCostLoading: boolean;
}

const TrueProfitPanel: FC<TrueProfitPanelProps> = ({ activeImplants, altCharacters, apiDetail, blueprintME, commitRuns, displayName, displayRuns, effectiveTrueCostError, feeCharacterId, feeCharacterName, handleRunsChange, interHubContext, isBlueprintClick, itemNames, jumpClones, materialMarketName, onFeeCharacterChange, onImplantsChange, onOpenSettings, primaryCharacterName, runsInputVal, selectedImplants, selectedLiquidityRisk, selectedMarket, selectedTypeId, selectedVolume, selectedVolumeSource, trueCostData, trueCostError, trueCostLoading }) => {
  return (
    <>
{!interHubContext && selectedTypeId && (
          <div className="detail-section">
            <div className="detail-section-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>True Profit (Net)</span>
              {/* v1.5 — Fee character selector (only shown when alts are loaded) */}
              {altCharacters.length > 0 && (
                <select
                  className="fee-char-select"
                  value={feeCharacterId ?? 'primary'}
                  title={`Fees calculated using ${feeCharacterName}'s skills & standings`}
                  onChange={(e) => onFeeCharacterChange(
                    e.target.value === 'primary' ? null : Number(e.target.value)
                  )}
                  aria-label="Character to use for fee calculations"
                >
                  <option value="primary">{primaryCharacterName}</option>
                  {altCharacters.map((a) => (
                    <option key={a.characterId} value={a.characterId} disabled={a.loading}>
                      {a.loading ? 'Loading…' : a.name}
                    </option>
                  ))}
                </select>
              )}
              {/* v1.9.1 — Free-entry build runs input (hidden for non-manufacturable items) */}
              {!effectiveTrueCostError?.startsWith('Not manufacturable') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>×</span>
                <input
                  type="number"
                  className="fee-char-select"
                  value={runsInputVal}
                  min={1}
                  step={1}
                  style={{ width: 64, textAlign: 'center', paddingRight: 2 }}
                  onChange={(e) => handleRunsChange(e.target.value)}
                  onBlur={commitRuns}
                  onKeyDown={(e) => e.key === 'Enter' && commitRuns()}
                  aria-label="Number of manufacturing runs"
                  title="Type any number of runs — True Profit updates when you stop typing"
                />
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>runs</span>
              </div>
              )}
            </div>

            {/* v1.22 — Honesty badge: True Profit assumes you OWN the blueprint (ME-researched,
                free). When the user owns neither a BPO nor a BPC for this item, that's a silent
                flatter — flag that the acquisition cost isn't in the figure. (Phase 0 of the
                BPC-cost feature; full per-run BPC pricing is a later phase.) */}
            {!isBlueprintClick && apiDetail?.buildInfo && !apiDetail.buildInfo.blueprintOwned && (
              <div
                className="bp-ownership-note"
                title={
                  "You don't own a BPO or BPC for this item. True Profit does NOT include the cost of obtaining one. " +
                  "For T1 items, buy a BPO from the market (one-time cost, unlimited runs). " +
                  "For T2/T3, buy a BPC from contracts or invent one — this is a real per-run cost not reflected here."
                }
              >
                ⚠ You don't own a blueprint for this item — obtain a BPC or BPO before manufacturing. Acquisition cost not included in True Profit.
              </div>
            )}

            {/* v1.17.1 — Implant selector (hidden for non-manufacturable items) */}
            <ImplantSelector activeImplants={activeImplants} effectiveTrueCostError={effectiveTrueCostError} jumpClones={jumpClones} onImplantsChange={onImplantsChange} selectedImplants={selectedImplants} />

            {trueCostLoading && (
              <div style={{ textAlign: 'center', padding: '12px 0',
                color: 'var(--color-text-tertiary)', fontSize: 11 }}>
                <div className="loading-spinner"
                  style={{ width: 16, height: 16, margin: '0 auto 6px' }} />
                Calculating…
              </div>
            )}

            {trueCostError && !trueCostLoading && (
              <div style={{
                color: trueCostError.startsWith('Not manufacturable')
                  ? 'var(--color-text-tertiary)'
                  : 'var(--color-danger)',
                fontSize: 11, padding: '8px 0', textAlign: 'center'
              }}>
                {trueCostError.startsWith('Not manufacturable')
                  ? <>ℹ Not manufacturable — this item comes from the LP store,<br/>drops, or contracts only.</>
                  : <>⚠ {trueCostError}</>}
              </div>
            )}

            {trueCostData && !trueCostLoading && !trueCostData.prices_warm && (
              <div className="bp-ownership-note">
                ⟳ Using cached estimates — live prices are updating in the background.
              </div>
            )}

            {/* Data-quality notices — every one is an amber box (same as the "no blueprint" box): each says
                exactly which assumption a figure leans on, never a silent substitution. */}
            {trueCostData && !trueCostLoading && trueCostData.sell_price_anomaly && (
              <div className="bp-ownership-note">
                ⚠ Outlier sell order — profit uses median price, not lowest ask.
              </div>
            )}
            {trueCostData && !trueCostLoading && trueCostData.skills_source === 'none' && (
              <div className="bp-ownership-note">
                ⚠ Your skills aren&apos;t loaded on the server yet — fees and build time assume untrained
                skills (level 0). Reload the page to refresh them.
              </div>
            )}
            {trueCostData && !trueCostLoading && (trueCostData.manufacturing_setup?.invalid_rig_ids?.length ?? 0) > 0 && (
              <div className="bp-ownership-note">
                ⚠ {trueCostData.manufacturing_setup?.invalid_rig_ids?.length ?? 0} saved rig(s) are not valid in the
                current game data and count as no bonus. Open Mfg Setup to re-select them.
              </div>
            )}
            {trueCostData && !trueCostLoading && (trueCostData.manufacturing_setup?.ignored_rig_ids?.length ?? 0) > 0 && (
              <div className="bp-ownership-note">
                ⚠ {trueCostData.manufacturing_setup?.ignored_rig_ids?.length ?? 0} saved rig(s) can&apos;t apply to
                your structure (wrong size, no structure, or more than 3) and are ignored. Open Mfg Setup to fix them.
              </div>
            )}
            {trueCostData && !trueCostLoading
              && (trueCostData.manufacturing_setup?.rigs?.length ?? 0) > 0
              && trueCostData.manufacturing_setup.security_known === false && (
              <div className="bp-ownership-note">
                ⚠ Your build system&apos;s security isn&apos;t known — rig bonuses are shown at highsec values.
              </div>
            )}
            {/* Where the money figures' prices came from: the hub's own orders, Jita for what the hub can't supply. */}
            <SourcingNotices apiDetail={apiDetail} displayName={displayName} itemNames={itemNames} materialMarketName={materialMarketName} onOpenSettings={onOpenSettings} selectedMarket={selectedMarket} trueCostData={trueCostData} trueCostLoading={trueCostLoading} />

            {trueCostData && !trueCostLoading && (
              <div className="cost-breakdown-row">

                {/* Box 1 — Material Cost (with tooltip explaining ME reduction) */}
                <div className="cost-box material">
                  <span className="cost-box-label">Materials</span>
                  <span className="cost-box-value">
                    {formatISK(trueCostData.total_material_cost)}
                  </span>
                  {/* Tooltip — shows full effective ME breakdown */}
                  <div className="cost-tooltip">
                    <MaterialCostTooltip blueprintME={blueprintME} trueCostData={trueCostData} />
                  </div>
                </div>

                {/* Box 2 — Manufacturing Fees (with tooltip) */}
                <div className={`cost-box mfg-fees${trueCostData.setup_configured ? '' : ' unconfigured'}`}>
                  <span className="cost-box-label">Mfg Fees</span>
                  {trueCostData.setup_configured ? (
                    <span className="cost-box-value">
                      {formatISK(trueCostData.mfg_fees.total)}
                    </span>
                  ) : (
                    <span className="cost-box-value cost-box-unknown">
                      ?{' '}
                      <button
                        type="button"
                        className="cost-configure-link"
                        onClick={() => onOpenSettings()}
                      >
                        Configure
                      </button>
                    </span>
                  )}
                  {/* Tooltip */}
                  {trueCostData.setup_configured && (
                    <div className="cost-tooltip">
                      <div className="cost-tooltip-row">
                        <span>Est. Item Value</span>
                        <span>{formatISK(trueCostData.mfg_fees.estimated_item_value)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>
                          System Cost
                          {trueCostData.manufacturing_setup.sci_raw > 0 && (
                            <span style={{ opacity: 0.65, fontSize: 10 }}>
                              {' '}({(trueCostData.manufacturing_setup.sci_raw * 100).toFixed(2)}% SCI)
                            </span>
                          )}
                        </span>
                        <span>{formatISK(trueCostData.mfg_fees.system_cost_index)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>Facility Tax</span>
                        <span>{formatISK(trueCostData.mfg_fees.facility_tax)}</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>SCC Surcharge</span>
                        <span>{formatISK(trueCostData.mfg_fees.scc_surcharge)}</span>
                      </div>
                      {trueCostData.mfg_fees.alpha_clone_tax > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Alpha Tax</span>
                          <span>{formatISK(trueCostData.mfg_fees.alpha_clone_tax)}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total</span>
                        <span>{formatISK(trueCostData.mfg_fees.total)}</span>
                      </div>
                      <div className="cost-tooltip-setup">
                        {trueCostData.manufacturing_setup.system_name}
                        {' · '}
                        {trueCostData.manufacturing_setup.structure_label}
                        {' · '}
                        {trueCostData.manufacturing_setup.facility_tax_pct}% tax
                      </div>
                    </div>
                  )}
                </div>

                {/* Box 3 — Sales Tax (with tooltip) */}
                <div className="cost-box sales-tax">
                  <span className="cost-box-label">Sales Tax</span>
                  <span className="cost-box-value">
                    {formatISK(trueCostData.sales_tax.total)}
                  </span>
                  {/* Tooltip */}
                  <div className="cost-tooltip">
                    <div className="cost-tooltip-row">
                      <span>
                        Broker Fee
                        ({(trueCostData.sales_tax.broker_fee_rate * 100).toFixed(2)}%)
                      </span>
                      <span>{formatISK(trueCostData.sales_tax.broker_fee)}</span>
                    </div>
                    <div className="cost-tooltip-sub">
                      Broker Relations {trueCostData.sales_tax.broker_relations_level}
                    </div>
                    <div className="cost-tooltip-sub">
                      Faction standing: {trueCostData.sales_tax.faction_standing.toFixed(2)}
                    </div>
                    <div className="cost-tooltip-sub">
                      Corp standing: {trueCostData.sales_tax.corp_standing.toFixed(2)}
                    </div>
                    <div className="cost-tooltip-row">
                      <span>
                        Transaction Tax
                        ({(trueCostData.sales_tax.transaction_tax_rate * 100).toFixed(2)}%)
                      </span>
                      <span>{formatISK(trueCostData.sales_tax.transaction_tax)}</span>
                    </div>
                    <div className="cost-tooltip-sub">
                      Accounting {trueCostData.sales_tax.accounting_level}
                    </div>
                    <div className="cost-tooltip-divider" />
                    <div className="cost-tooltip-row total">
                      <span>Total</span>
                      <span>{formatISK(trueCostData.sales_tax.total)}</span>
                    </div>
                  </div>
                </div>

                {/* Box 4b — Invention Cost (T2 items only) */}
                {trueCostData.invention_cost && (
                  <div className="cost-box invention-cost">
                    <span className="cost-box-label">Invention</span>
                    <span className="cost-box-value" style={{ color: 'var(--color-danger)' }}>
                      {formatISK(trueCostData.invention_cost.total)}
                    </span>
                    <div className="cost-tooltip">
                      <div className="cost-tooltip-row">
                        <span>Base chance / attempt</span>
                        <span>{(trueCostData.invention_cost.base_probability * 100).toFixed(1)}%</span>
                      </div>
                      {trueCostData.invention_cost.skill_bonus > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Skill factor</span>
                          <span>×{trueCostData.invention_cost.skill_factor.toFixed(3)}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.decryptor_type !== 'none' && trueCostData.invention_cost.decryptor && (
                        <div className="cost-tooltip-row">
                          <span>Decryptor ({INVENTION_DECRYPTORS.find(d => d.type === trueCostData.invention_cost!.decryptor_type)?.name ?? trueCostData.invention_cost.decryptor_type})</span>
                          <span>×{(1 + trueCostData.invention_cost.decryptor.probMult / 100).toFixed(2)}</span>
                        </div>
                      )}
                      {(trueCostData.invention_cost.rig_bonus > 0 || trueCostData.invention_cost.prob_bonus > 0) && (
                        <div className="cost-tooltip-row">
                          <span>Rig / bonus</span>
                          <span>+{((trueCostData.invention_cost.rig_bonus + trueCostData.invention_cost.prob_bonus) * 100).toFixed(1)} pp</span>
                        </div>
                      )}
                      <div className="cost-tooltip-row">
                        <span style={{ fontWeight: 600 }}>Effective chance / attempt</span>
                        <span style={{ fontWeight: 600 }}>{(trueCostData.invention_cost.effective_probability * 100).toFixed(1)}%</span>
                      </div>
                      <div className="cost-tooltip-row">
                        <span>Expected attempts per BPC</span>
                        <span>{trueCostData.invention_cost.expected_attempts.toFixed(2)}×</span>
                      </div>
                      {trueCostData.invention_cost.output_runs > 1 && (
                        <div className="cost-tooltip-row">
                          <span>Runs per invented BPC</span>
                          <span>{trueCostData.invention_cost.output_runs}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.decryptor && trueCostData.invention_cost.decryptor_type !== 'none' && (
                        <div className="cost-tooltip-row">
                          <span>Output BPC ME / TE</span>
                          <span>{trueCostData.invention_cost.decryptor.me >= 0 ? '+' : ''}{trueCostData.invention_cost.decryptor.me} / {trueCostData.invention_cost.decryptor.te >= 0 ? '+' : ''}{trueCostData.invention_cost.decryptor.te}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      {trueCostData.invention_cost.datacores.map(dc => (
                        <div key={dc.materialId} className="cost-tooltip-row">
                          <span>{dc.name} ×{dc.quantity}</span>
                          <span>{formatISK(dc.unitPrice)}/ea</span>
                        </div>
                      ))}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row">
                        <span>Datacores (×{trueCostData.invention_cost.expected_attempts.toFixed(2)} att{trueCostData.invention_cost.output_runs > 1 ? ` ÷ ${trueCostData.invention_cost.output_runs} runs` : ''})</span>
                        <span>{formatISK(trueCostData.invention_cost.datacores_cost)}</span>
                      </div>
                      {trueCostData.invention_cost.decryptor_type !== 'none' && (
                        <div className="cost-tooltip-row">
                          <span>Decryptor (×{trueCostData.invention_cost.expected_attempts.toFixed(2)} att{trueCostData.invention_cost.output_runs > 1 ? ` ÷ ${trueCostData.invention_cost.output_runs} runs` : ''})</span>
                          <span>{trueCostData.invention_cost.decryptor_cost > 0 ? formatISK(trueCostData.invention_cost.decryptor_cost) : '(price unknown)'}</span>
                        </div>
                      )}
                      {trueCostData.invention_cost.job_cost > 0 && (
                        <div className="cost-tooltip-row">
                          <span>Invention job fees</span>
                          <span>{formatISK(trueCostData.invention_cost.job_cost)}</span>
                        </div>
                      )}
                      <div className="cost-tooltip-divider" />
                      <div className="cost-tooltip-row total">
                        <span>Total ({trueCostData.runs} run{trueCostData.runs !== 1 ? 's' : ''})</span>
                        <span>{formatISK(trueCostData.invention_cost.total)}</span>
                      </div>
                      {trueCostData.invention_cost.skills.length > 0 && (
                        <div className="cost-tooltip-setup">
                          Skills: {trueCostData.invention_cost.skills.map(s => `L${s.level}`).join(' · ')}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Box 4 — True Profit (with full formula + haulage breakdown tooltip) */}
                <TrueProfitBox trueCostData={trueCostData} />

              </div>
            )}

            {/* ── Market liquidity — can you actually sell it? (v1.20) ── */}
            {(selectedVolume != null || selectedLiquidityRisk === 'contract_only') && (() => {
              const liq  = liquidityInfo(selectedLiquidityRisk);
              const vol  = selectedVolume ?? 0;
              // Units to offload ≈ runs (1 output/run for the high-value items this
              // matters for). A rough, honestly-hedged "days to clear" — not a promise.
              const days = vol > 0 ? Math.ceil(displayRuns / vol) : 0;

              let body;
              if (selectedLiquidityRisk === 'contract_only') {
                body = <>Not sold on the open market — moves via <strong>contracts</strong> only. The daily-volume signal doesn&rsquo;t apply here.</>;
              } else if (selectedLiquidityRisk === 'low_volume') {
                body = <>Thin market — only <strong>{formatPerDay(vol)}</strong> trade. Your {displayRuns}-run batch ≈ <strong>{days} day{days !== 1 ? 's' : ''}</strong> to clear; expect to undercut to sell faster.</>;
              } else if (liq.dot === 'danger') {
                body = <><strong>{liq.label}.</strong> {liq.tip}</>;
              } else {
                body = <>Liquid — market trades <strong>{formatPerDay(vol)}</strong>. Your {displayRuns}-run batch should sell without moving the price.</>;
              }

              return (
                <>
                  <div className="liquidity-note" title={liq.tip}>
                    <span className={`liq-dot liq-${liq.dot}`} aria-hidden="true" />
                    <span>{body}</span>
                  </div>
                  {selectedVolumeSource === 'jita' && selectedLiquidityRisk !== 'contract_only' && (
                    <div className="bp-ownership-note">
                      ⚠ There&apos;s no trading data for {selectedMarket.name} yet, so this daily volume is Jita&apos;s.
                    </div>
                  )}
                </>
              );
            })()}

            {/* ── Throughput: effective build time + ISK/hr (v1.17.0) ── */}
            {trueCostData && !trueCostLoading && trueCostData.time && trueCostData.time.base_build_seconds > 0 && (() => {
              const t = trueCostData.time;
              const fmtDur = (s: number) => {
                if (!s || s <= 0) return '—';
                const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
                if (d > 0) return `${d}d ${h}h`;
                if (h > 0) return `${h}h ${m}m`;
                return `${m}m`;
              };
              const tip =
                `Effective build time for ${trueCostData.runs} run(s): ${fmtDur(t.effective_build_seconds)} ` +
                `(base ${fmtDur(t.base_build_seconds)}).\n` +
                `Applied: TE ${t.te_pct}%, Industry L${t.industry_level} (−${4 * t.industry_level}%), ` +
                `Adv. Industry L${t.advanced_industry_level} (−${3 * t.advanced_industry_level}%), ` +
                `structure TE −${t.structure_te_bonus_pct}%` +
                (t.mfg_implant ? `, ${t.mfg_implant.name} (−${t.mfg_implant.pct}%)` : ', no mfg-time implant') +
                `.\nISK/hr = True Profit ÷ build hours.` +
                (t.reproc_implant ? `\nAlso plugged in: ${t.reproc_implant.name} (+${t.reproc_implant.pct}% reprocessing).` : '');
              return (
                <div className="iskhr-row" title={tip}>
                  <span className="iskhr-time">⏱ {fmtDur(t.effective_build_seconds)}</span>
                  <span className="iskhr-value" style={{ color: t.isk_per_hour >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                    {formatISK(t.isk_per_hour)}/hr
                  </span>
                  {t.mfg_implant
                    ? <span className="iskhr-implant" title={t.mfg_implant.name}>💊 −{t.mfg_implant.pct}%</span>
                    : <span className="iskhr-implant iskhr-implant-none">no implant</span>}
                </div>
              );
            })()}

            {/* ── Haul box row — shown when any haul is configured ── */}
            <HaulBoxRow trueCostData={trueCostData} trueCostLoading={trueCostLoading} />

            {!trueCostData && !trueCostLoading && !trueCostError && (
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', padding: '6px 0' }}>
                Select an item to see True Profit.
              </div>
            )}
          </div>
        )}
    </>
  );
};

export default TrueProfitPanel;
