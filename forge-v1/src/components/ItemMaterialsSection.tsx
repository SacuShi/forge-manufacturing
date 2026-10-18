import type { FC, Dispatch, SetStateAction } from 'react';
import type { MaterialSupply, Purchase } from '../utils/hubSupply';
import { formatISKDisplay as formatISK } from '../utils/format';
import { jobQuantity } from '../utils/jobQuantity';
import { Fragment } from 'react';
import { itemIconUrl } from '../utils/icons';
import { ChainTree, DecryptorSelect } from './ChainTree';
import { INVENTION_DECRYPTORS, type ItemDetailApiResponse, type EsiBlueprint, type InterHubArbRow, type Market, type MaterialStockCheckResponse, type TrueCostResponse } from '../types';
import { onActivateKey } from '../utils/a11y';

interface ItemMaterialsSectionProps {
  apiDetail: ItemDetailApiResponse | null;
  blueprints: EsiBlueprint[];
  buyFor: (m: { supply?: MaterialSupply | null | undefined; unitCost?: number | undefined; }, qty: number) => Purchase | null;
  copiedShortfall: boolean;
  copyShortfall: () => void;
  detailLoading: boolean;
  displayRuns: number;
  expandedChains: Set<number>;
  interHubContext: InterHubArbRow | null;
  inventionDecryptorType: string | null;
  inventionProbBonus: number;
  isJita: boolean;
  itemNames: Map<number, string>;
  marketLabel: string;
  materialMarketName: string;
  materialRegionId: number;
  meFactor: number;
  missing: { shortForRuns: number; materialId: number; name: string; needed: number; have: number; shortage: number; unitCost?: number | undefined; unitScope?: "hub" | "jita" | "history" | "none" | null | undefined; totalCost?: number | undefined; shortfallCost?: number | undefined; supply?: MaterialSupply | null | undefined; canManufacture?: boolean | undefined; piTier?: number | null | undefined; }[];
  onInventionDecryptorChange: (type: string | null) => void;
  onInventionProbBonusChange: (bonus: number) => void;
  onSelectItem: (typeId: number, name: string) => void;
  ownedProductTypeIds: Set<number>;
  selectedMarket: Market;
  setStockCheckOpen: Dispatch<SetStateAction<boolean>>;
  stockCheck: MaterialStockCheckResponse | null;
  stockCheckOpen: boolean;
  toggleChain: (materialId: number) => void;
  trueCostData: TrueCostResponse | null;
  walletISK: number;
}

const ItemMaterialsSection: FC<ItemMaterialsSectionProps> = ({ apiDetail, blueprints, buyFor, copiedShortfall, copyShortfall, detailLoading, displayRuns, expandedChains, interHubContext, inventionDecryptorType, inventionProbBonus, isJita, itemNames, marketLabel, materialMarketName, materialRegionId, meFactor, missing, onInventionDecryptorChange, onInventionProbBonusChange, onSelectItem, ownedProductTypeIds, selectedMarket, setStockCheckOpen, stockCheck, stockCheckOpen, toggleChain, trueCostData, walletISK }) => {
  return (
    <>
{!interHubContext && apiDetail && !detailLoading && (
          <>
            {/* Build readiness badge — only positive/negative ownership; missing-materials moved below Limited Stock */}
            {apiDetail.buildInfo && (
              <div style={{ padding: '6px 12px' }}>
                {apiDetail.buildInfo.blueprintOwned && apiDetail.buildInfo.canBuild && (
                  <span className="status-badge can-build">✓ Can Build Now</span>
                )}
                {!apiDetail.buildInfo.blueprintOwned && (
                  <span className="status-badge no-bp">✗ No Blueprint</span>
                )}
              </div>
            )}

            {/* Price history sparkline */}
            {apiDetail.priceHistory && apiDetail.priceHistory.length > 0 && (() => {
              const prices     = apiDetail.priceHistory!.map((d) => d.average);
              const min        = Math.min(...prices);
              const max        = Math.max(...prices);
              const range      = max - min;
              const latest     = prices[prices.length - 1];
              const isKeestar  = apiDetail.priceHistorySource === 'keepstar';
              const days       = apiDetail.priceHistory!.length;
              const heading    = isKeestar
                ? `C-J6MT Price (${days} Days)`
                : 'Jita Price (90 Days)';
              return (
                <div className="detail-section">
                  <div className="detail-section-heading">
                    {heading}
                    {!isJita && !isKeestar && (
                      <span style={{ float: 'right', fontSize: 10, fontWeight: 400,
                        color: 'var(--color-text-tertiary)', letterSpacing: 0 }}>
                        history always Jita
                      </span>
                    )}
                    {isKeestar && days < 30 && (
                      <span style={{ float: 'right', fontSize: 10, fontWeight: 400,
                        color: 'var(--color-text-tertiary)', letterSpacing: 0 }}>
                        accumulating…
                      </span>
                    )}
                  </div>
                  <div style={{ color: 'var(--color-success)', fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
                    {formatISK(latest)}
                  </div>
                  <div className="sparkline">
                    {prices.slice(-30).map((p, i) => {
                      const height = range > 0 ? ((p - min) / range) * 100 : 50;
                      return (
                        <div
                          // Combine index with price value: switching items produces a
                          // different set of values so React replaces bars cleanly.
                          key={`bar-${i}-${Math.round(p)}`}
                          className="sparkline-bar"
                          style={{ height: `${Math.max(height, 4)}%` }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Current market prices */}
            {apiDetail.currentPrice && (
              <div className="detail-section">
                <div className="detail-section-heading">Current {marketLabel} Market</div>

                {/* Warn when there are no live sell orders — price estimated from history */}
                {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0 && (
                  <div className="price-hist-notice">
                    ⚠ No live sell orders — prices below estimated from 30-day trade average
                  </div>
                )}

                <div className="price-grid">
                  <div>
                    <div className="price-cell-label">
                      LOWEST SELL
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? <span className="price-cell-label-hist"> (no orders)</span>
                        : null}
                    </div>
                    <div className="price-cell-value" style={{ color: 'var(--color-danger)' }}>
                      {apiDetail.currentPrice.sell > 0
                        ? formatISK(apiDetail.currentPrice.sell)
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? '30D AVG TRADE' : 'MEDIAN'}
                    </div>
                    <div className="price-cell-value" style={{ color: 'var(--color-accent-primary)' }}>
                      {apiDetail.currentPrice.sell === 0 && (apiDetail.currentPrice.avg30d ?? 0) > 0
                        ? formatISK(apiDetail.currentPrice.avg30d!)
                        : formatISK(apiDetail.currentPrice.median)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">HIGHEST BUY</div>
                    <div className="price-cell-value" style={{ color: 'var(--color-success)' }}>
                      {apiDetail.currentPrice.buy > 0
                        ? formatISK(apiDetail.currentPrice.buy)
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Contract pricing (v1.12.0) — distinct amber callout ────────── */}
            {apiDetail.contractPricing && (
              <div className="detail-section contract-pricing">
                <div className="contract-pricing-heading">
                  ◆ CONTRACT PRICING — {apiDetail.contractPricing.regionName}
                </div>
                <div className="contract-pricing-sub">live single-item contracts</div>

                <div className="price-grid" style={{ marginTop: 6 }}>
                  <div>
                    <div className="price-cell-label">LOWEST LISTED</div>
                    <div className="price-cell-value contract-price">
                      {formatISK(apiDetail.contractPricing.low)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">SUGGESTED SELL</div>
                    <div className="price-cell-value contract-price-suggested">
                      {formatISK(apiDetail.contractPricing.suggested)}
                    </div>
                  </div>
                  <div>
                    <div className="price-cell-label">HIGHEST LISTED</div>
                    <div className="price-cell-value contract-price">
                      {formatISK(apiDetail.contractPricing.high)}
                    </div>
                  </div>
                </div>

                <div className="contract-rationale">
                  “{apiDetail.contractPricing.rationale}”
                </div>
              </div>
            )}

            {/* ── Build requirements + materials ───────────────────────────── */}
            {apiDetail.buildInfo && (
              <div className="detail-section">
                <div className="detail-section-heading">
                  Build Requirements
                  <span style={{ float: 'right', fontSize: 10, color: 'var(--color-text-tertiary)',
                    fontWeight: 400, letterSpacing: 0 }}>
                    have / needed
                  </span>
                </div>

                {/* Cost summary row */}
                {apiDetail.pricesWarm === false && (
                  <div className="bp-ownership-note" style={{ marginBottom: 6 }}>
                    ⏳ {materialMarketName}{selectedMarket.id !== materialRegionId ? ` / ${selectedMarket.name}` : ''} prices are still loading — this refreshes automatically.
                  </div>
                )}
                {apiDetail.buildInfo.sellPriceSource === 'history_30d' && (
                  <div className="bp-ownership-note" style={{ marginBottom: 6 }}>
                    ⚠ No live sell orders — profit estimated from 30-day trade average
                  </div>
                )}
                {/* v1.19.0 — money figures (material cost, profit, ISK/hr) live ONLY in the
                    True Profit panel below, to avoid showing competing numbers for the same
                    item. This section is purely the build's material requirements. */}
                <div className="mat-section-heading">Materials required</div>

                {/* Materials list — every row is clickable → drills into that item */}
                <div className="mat-list">
                  {apiDetail.buildInfo.materials.map((mat) => {
                    // ME + runs-adjusted needed — mirrors /api/true-cost exactly: one rounding
                    // per job, ≥ 1 per run. meFactor = the server's material multiplier.
                    const needForRuns  = jobQuantity(mat.needed, displayRuns, meFactor);
                    const shortForRuns = Math.max(0, needForRuns - mat.have);
                    const ok           = shortForRuns <= 0;
                    // canManufacture: set by server from blueprints DB (any game blueprint exists)
                    // isOwned: user personally owns a blueprint for this material
                    const isChain     = mat.canManufacture ?? ownedProductTypeIds.has(mat.materialId);
                    const isOwned     = ownedProductTypeIds.has(mat.materialId);
                    const isExpanded  = expandedChains.has(mat.materialId);
                    return (
                      <Fragment key={mat.materialId}>
                      <div
                        className={`mat-row mat-row-clickable${ok ? ' mat-ok' : ' mat-bad'}`}
                        role="button"
                        tabIndex={0}
                        title={`Click to view market data for ${mat.name}`}
                        onClick={() => onSelectItem(mat.materialId, mat.name)}
                        onKeyDown={onActivateKey(() => onSelectItem(mat.materialId, mat.name))}
                      >
                        {/* Material icon */}
                        <span className="mat-icon">
                          <img
                            src={itemIconUrl(mat.materialId)}
                            alt=""
                            width={16}
                            height={16}
                            crossOrigin="anonymous"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
                            }}
                          />
                        </span>

                        {/* Have/need tick */}
                        <span style={{
                          color: ok ? 'var(--color-success)' : 'var(--color-danger)',
                          fontWeight: 700,
                          fontSize: 12,
                          flexShrink: 0,
                          width: 14,
                        }}>
                          {ok ? '✓' : '✗'}
                        </span>

                        {/* Name + chain badge + PI tier badge */}
                        <span className="mat-name" style={{ flex: 1 }}>
                          {mat.name}
                          {isChain && (
                            <button type="button"
                              title={isExpanded ? 'Collapse production chain' : 'Expand production chain'}
                              onClick={(e) => { e.stopPropagation(); toggleChain(mat.materialId); }}
                              className={`btn-reset btn-reset-inline mat-badge ${isOwned ? 'mat-badge-own' : 'mat-badge-chain'}`}>
                              {isExpanded ? '▾' : '▸'} ⛓ {isOwned ? 'owned' : 'chain'}
                            </button>
                          )}
                          {mat.piTier && (
                            <span className="mat-badge mat-badge-pi">
                              PI·P{mat.piTier}
                            </span>
                          )}
                        </span>

                        {/* Have / needed counts — runs-adjusted */}
                        <span className="mat-qty">
                          {mat.have.toLocaleString()}/{needForRuns.toLocaleString()}
                        </span>

                        {/* Per-material cost — runs-adjusted, priced from the hub's own orders with the
                            remainder imported from Jita (flagged). */}
                        {(() => {
                          const p    = buyFor(mat, needForRuns);
                          const cost = p ? p.cost : (mat.unitCost ?? 0) * needForRuns;
                          const tag  = !p ? null
                            : p.scope === 'jita'    ? { t: 'J', tip: `None for sale at ${materialMarketName} — priced at Jita's lowest sell; has to be imported or manufactured.` }
                            : p.scope === 'mixed'   ? { t: 'J', tip: p.jitaQty > 0
                                ? `${p.hubQty.toLocaleString()} from ${materialMarketName}; ${p.jitaQty.toLocaleString()} priced at Jita (import or manufacture them)${p.unfilledQty > 0 ? `; ${p.unfilledQty.toLocaleString()} more aren't listed anywhere and are priced at the last visible price` : ''}.`
                                : `${p.hubQty.toLocaleString()} from ${materialMarketName}; the other ${p.unfilledQty.toLocaleString()} aren't listed at Jita either and are priced at the last visible price.` }
                            : p.scope === 'history' ? { t: '~', tip: 'No sell orders at this hub or at Jita — priced at the 30-day average.' }
                            : p.scope === 'none'    ? { t: '?', tip: 'No sell orders at this hub or at Jita, and no price history.' }
                            : p.shortStock          ? { t: '!', tip: 'Not enough listed to fill this quantity — the rest is priced at the last visible price, so the real cost may be higher.' }
                            : null;
                          if (!(cost > 0) && !tag) return null;
                          return (
                            <>
                              {cost > 0 && (
                                <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)',
                                  marginLeft: 4, flexShrink: 0 }}>
                                  {formatISK(cost)}
                                </span>
                              )}
                              {tag && (
                                <span className="price-source-hist" title={tag.tip}>{tag.t}</span>
                              )}
                            </>
                          );
                        })()}

                        {/* Drill-in arrow hint */}
                        <span style={{
                          fontSize: 9,
                          color: 'var(--color-text-tertiary)',
                          marginLeft: 3,
                          flexShrink: 0,
                          opacity: 0.6,
                        }}>▶</span>
                      </div>

                      {/* Inline production-chain tree (lazy-loaded on badge click) */}
                      {isChain && isExpanded && (
                        <ChainTree
                          parentTypeId={mat.materialId}
                          regionId={selectedMarket.id}
                          ownedBlueprints={blueprints}
                          depth={1}
                          onSelectItem={onSelectItem}
                        />
                      )}
                      </Fragment>
                    );
                  })}
                </div>

                {/* v1.33.3 — Buyable Now / Limited Stock / Can't Afford pill (shown first) */}
                {missing.length > 0 && stockCheck && (() => {
                  const STOCK_CHECK_CFG = {
                    ok:      { icon: '✓', label: 'Buyable Now',    color: 'var(--color-success)', bg: 'rgba(76, 175, 80, 0.08)',  border: 'rgba(76, 175, 80, 0.2)' },
                    mixed:   { icon: '⚠', label: 'Limited Stock',  color: 'var(--color-warning)', bg: 'rgba(255, 152, 0, 0.08)', border: 'rgba(255, 152, 0, 0.2)' },
                    blocked: { icon: '✗', label: "Can't Afford",   color: 'var(--color-danger)',  bg: 'rgba(244, 67, 54, 0.08)', border: 'rgba(244, 67, 54, 0.2)' },
                  } as const;
                  const cfg = STOCK_CHECK_CFG[stockCheck.verdict];

                  const thinNames = stockCheck.materials
                    .filter(m => !m.covered)
                    .map(m => itemNames.get(m.materialId) ?? `Material #${m.materialId}`);

                  const message = stockCheck.verdict === 'ok'
                    ? `Missing materials are available on the ${materialMarketName} market — buying them now costs ${formatISK(stockCheck.totalCost)}, within your ${formatISK(walletISK)} wallet. Use Multibuy below to purchase the shortfall.`
                    : stockCheck.verdict === 'mixed'
                    ? `${thinNames.join(', ')} ${thinNames.length === 1 ? 'has' : 'have'} limited stock on the ${materialMarketName} market right now — not enough listed to fill the full shortage. ${materialRegionId === 10000002 ? `Jita doesn't have enough listed; the rest is priced at the last visible price, so buying everything costs at least ~${formatISK(stockCheck.totalCost)}.` : `What ${materialMarketName} can't supply is priced at Jita and has to be imported or manufactured; buying everything costs ~${formatISK(stockCheck.totalCost)}.`}`
                    : `Materials are in stock on the ${materialMarketName} market, but buying them (${formatISK(stockCheck.totalCost)}) would exceed your ${formatISK(walletISK)} wallet.`;

                  return (
                    <div style={{ marginTop: 6 }}>
                      <button type="button" className="btn-reset"
                        title={message}
                        onClick={(e) => { e.stopPropagation(); setStockCheckOpen(o => !o); }}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                          fontSize: 10, cursor: 'pointer', color: cfg.color,
                          background: cfg.bg, border: `0.5px solid ${cfg.border}`,
                          borderRadius: 3, padding: '6px 8px',
                        }}
                      >
                        <span>{cfg.icon} {cfg.label}</span>
                        <span style={{ opacity: 0.6, fontSize: 8 }}>{stockCheckOpen ? '▾' : '▸'}</span>
                      </button>
                      {stockCheckOpen && (
                        <div style={{
                          marginTop: 4, fontSize: 10, color: 'var(--color-text-secondary)',
                          padding: '6px 8px', background: 'var(--color-bg-primary)',
                          border: '0.5px solid var(--color-border-light)', borderRadius: 3,
                        }}>
                          {message}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Missing Materials banner + Multibuy — full-width, below stock-check pill */}
                {missing.length > 0 && (() => {
                  const shortfallTotal = missing.reduce(
                    (s, m) => s + (buyFor(m, m.shortForRuns)?.cost ?? m.shortForRuns * (m.unitCost ?? 0)), 0
                  );
                  const canAffordShortfall = shortfallTotal > 0 && walletISK >= shortfallTotal;
                  return (
                    <>
                      <div style={{
                        marginTop: 6, padding: '6px 8px', borderRadius: 3,
                        background: 'rgba(244, 67, 54, 0.08)', border: '0.5px solid rgba(244, 67, 54, 0.2)',
                        fontSize: 10, color: 'var(--color-danger)',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      }}>
                        <span>
                          ⚠ Missing Materials · {missing.length} material{missing.length !== 1 ? 's' : ''} short
                          {shortfallTotal > 0 && <> · {formatISK(shortfallTotal)} to buy</>}
                        </span>
                        <button
                          disabled={!trueCostData?.manufacturing_setup}
                          onClick={(e) => { e.stopPropagation(); copyShortfall(); }}
                          title={`Copy shortfall list to clipboard in EVE Multibuy format.\nPaste directly into the Multibuy window (right-click → Paste).\nQuantities are raw blueprint amounts × runs (before ME adjustment).`}
                          style={{
                            background: copiedShortfall
                              ? 'rgba(76, 175, 80, 0.18)' : 'rgba(244, 67, 54, 0.15)',
                            color: copiedShortfall
                              ? 'var(--color-success)' : 'var(--color-danger)',
                            border: `0.5px solid ${copiedShortfall
                              ? 'rgba(76, 175, 80, 0.4)' : 'rgba(244, 67, 54, 0.35)'}`,
                            borderRadius: 3, padding: '2px 7px', fontSize: 9,
                            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                            transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {copiedShortfall ? '✓ Copied!' : '📋 Multibuy'}
                        </button>
                      </div>
                      {canAffordShortfall && (
                        <div style={{
                          marginTop: 3, padding: '4px 8px', borderRadius: 3,
                          background: 'rgba(76, 175, 80, 0.07)', border: '0.5px solid rgba(76, 175, 80, 0.25)',
                          fontSize: 10, color: 'var(--color-success)',
                        }}>
                          ✓ You have enough ISK to buy the missing materials
                        </div>
                      )}
                    </>
                  );
                })()}

              </div>
            )}

            {/* Description */}
            {apiDetail.description && (
              <div className="description-text">
                {apiDetail.description.length > 240
                  ? apiDetail.description.substring(0, 240) + '…'
                  : apiDetail.description}
              </div>
            )}

            {/* ── Invention origin (T2 items) ───────────────────────────────── */}
            {apiDetail.inventionInfo && (() => {
              const decr = INVENTION_DECRYPTORS.find(d => d.type === (inventionDecryptorType || 'none')) ?? INVENTION_DECRYPTORS[0];
              // Prefer the server's authoritative, skill-and-rig-aware probability
              // (/api/true-cost's calcInventionCost — factors in science/encryption
              // skills and invention rigs, which this naive fallback doesn't) once
              // it's loaded; the naive base×decryptor-only estimate below is only
              // for the brief window before trueCostData arrives. Previously this
              // stat card ALWAYS used the naive number even after the authoritative
              // one loaded, while the cost card a few rows down (see hasSkills
              // below) already preferred it — the two disagreed for any character
              // with science/encryption skills or invention rigs, which is nearly
              // every real T2 inventor.
              const skillProb  = trueCostData?.invention_cost?.effective_probability;
              const naiveProb  = Math.min(1, apiDetail.inventionInfo.baseProbability * (1 + decr.probMult / 100) + (inventionProbBonus / 100));
              const adjProb     = skillProb ?? naiveProb;
              const adjAttempts = 1 / adjProb;
              const hasSkillProb = skillProb != null;
              const adjRuns = apiDetail.inventionInfo.outputRuns + decr.runs;
              return (
                <div className="detail-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div className="detail-section-heading" style={{ marginBottom: 0 }}>Invention</div>
                    <DecryptorSelect
                      value={inventionDecryptorType || 'none'}
                      onChange={val => onInventionDecryptorChange(val === 'none' ? null : val)}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                    Invented from:{' '}
                    <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>
                      {apiDetail.inventionInfo.t1BlueprintName ?? `Blueprint #${apiDetail.inventionInfo.t1BlueprintId}`}
                    </span>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 2 }}>
                    <div className="stat-card-label">
                      Chance per attempt
                      {hasSkillProb
                        ? <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(your skills + decryptor)</span>
                        : <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(base prob, no skills)</span>
                      }
                    </div>
                    <div className="stat-card-value" style={{ fontWeight: 600 }}>
                      {(adjProb * 100).toFixed(1)}%
                      {(decr.probMult !== 0 || hasSkillProb) && (
                        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10, marginLeft: 4 }}>
                          (base {(apiDetail.inventionInfo.baseProbability * 100).toFixed(1)}%)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 2 }}>
                    <div className="stat-card-label">Expected attempts per BPC</div>
                    <div className="stat-card-value">{adjAttempts.toFixed(2)}×</div>
                  </div>
                  <div className="stat-card" style={{ marginBottom: 6 }}>
                    <div className="stat-card-label">Runs per invented BPC</div>
                    <div className="stat-card-value">
                      {adjRuns}
                      {decr.runs !== 0 && <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10, marginLeft: 4 }}>(base {apiDetail.inventionInfo.outputRuns})</span>}
                    </div>
                  </div>
                  {decr.type !== 'none' && (
                    <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 6 }}>
                      Decryptor: ME{decr.me >= 0 ? '+' : ''}{decr.me} · TE{decr.te >= 0 ? '+' : ''}{decr.te} on output BPC
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Datacores per attempt:</div>
                  {apiDetail.inventionInfo.datacores.map(dc => (
                    <div key={dc.materialId} className="stat-card" style={{ marginBottom: 2 }}>
                      <div className="stat-card-label">{dc.name} ×{dc.quantity}</div>
                      <div className="stat-card-value">{dc.unitPrice > 0 ? formatISK(dc.unitPrice) + '/ea' : '—'}</div>
                    </div>
                  ))}
                  {(() => {
                    const skillCost = trueCostData?.invention_cost?.per_bpc_cost;
                    const displayCost = skillCost ?? (apiDetail.inventionInfo.perBpcCost > 0 ? apiDetail.inventionInfo.perBpcCost : null);
                    if (!displayCost) return null;
                    const hasSkills = skillCost != null;
                    return (
                      <div className="stat-card" style={{ marginTop: 4, borderTop: '1px solid var(--color-border)' }}>
                        <div className="stat-card-label">
                          Est. cost/BPC
                          {hasSkills
                            ? <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(your skills + decryptor)</span>
                            : <span style={{ color: 'var(--color-text-tertiary)', marginLeft: 4 }}>(base prob, no skills)</span>
                          }
                        </div>
                        <div className="stat-card-value" style={{ color: 'var(--color-danger)' }}>
                          {formatISK(displayCost)}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* ── Invention options (T1 items) ──────────────────────────────── */}
            {apiDetail.inventionOptions && apiDetail.inventionOptions.length > 0 && (() => {
              const decr = INVENTION_DECRYPTORS.find(d => d.type === (inventionDecryptorType || 'none')) ?? INVENTION_DECRYPTORS[0];
              return (
                <div className="detail-section" style={{
                  border: '1px solid rgba(255,152,0,0.35)', borderRadius: 'var(--radius-sm)',
                  padding: '8px 10px', background: 'rgba(255,152,0,0.04)',
                }}>
                  {/* Header row with decryptor selector */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div className="detail-section-heading" style={{ color: '#ff9800', marginBottom: 0 }}>
                      Can Invent Into (T2)
                    </div>
                    <DecryptorSelect
                      value={inventionDecryptorType || 'none'}
                      onChange={val => onInventionDecryptorChange(val === 'none' ? null : val)}
                    />
                  </div>

                  {/* Decryptor stats badge (when one is selected) */}
                  {decr.type !== 'none' && (
                    <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.75, marginBottom: 8, padding: '3px 6px', background: 'rgba(255,152,0,0.08)', borderRadius: 'var(--radius-sm)', border: '0.5px solid rgba(255,152,0,0.2)' }}>
                      {decr.name}: {decr.probMult > 0 ? '+' : ''}{decr.probMult}% chance · {decr.runs >= 0 ? '+' : ''}{decr.runs} runs · ME{decr.me >= 0 ? '+' : ''}{decr.me} · TE{decr.te >= 0 ? '+' : ''}{decr.te}
                    </div>
                  )}

                  {/* Probability bonus input */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <span style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, flexShrink: 0 }}>Extra prob bonus %</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={inventionProbBonus}
                      onChange={e => onInventionProbBonusChange(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                      style={{ width: 48, fontSize: 10, background: 'var(--color-bg-elevated)', color: 'var(--color-text-primary)', border: '0.5px solid rgba(255,152,0,0.3)', borderRadius: 'var(--radius-sm)', padding: '2px 4px', textAlign: 'right' }}
                    />
                    <span style={{ fontSize: 9, color: 'var(--color-text-tertiary)' }}>rigs / implants</span>
                  </div>

                  {/* Datacores */}
                  {apiDetail.inventionDatacores && apiDetail.inventionDatacores.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, marginBottom: 4 }}>Datacores per attempt:</div>
                      {apiDetail.inventionDatacores.map(dc => (
                        <div key={dc.materialId} className="stat-card" style={{ marginBottom: 2, border: '0.5px solid rgba(255,152,0,0.2)' }}>
                          <div className="stat-card-label" style={{ color: '#ff9800', opacity: 0.85 }}>{dc.name} ×{dc.quantity}</div>
                          <div className="stat-card-value">{dc.unitPrice > 0 ? formatISK(dc.unitPrice) + '/ea' : '—'}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* T2 outcome list */}
                  <div style={{ fontSize: 10, color: '#ff9800', opacity: 0.7, marginBottom: 4 }}>T2 outcomes — click to view item:</div>
                  {apiDetail.inventionOptions.map(opt => {
                    const adjProb = Math.min(1, opt.baseProbability * (1 + decr.probMult / 100) + (inventionProbBonus / 100));
                    const adjRuns = opt.outputRuns + decr.runs;
                    return (
                      <button type="button"
                        key={opt.t2BlueprintId}
                        className="btn-reset stat-card"
                        style={{ marginBottom: 3, cursor: 'pointer', border: '0.5px solid rgba(255,152,0,0.3)' }}
                        onClick={() => onSelectItem(opt.t2ProductId, opt.t2Name)}
                      >
                        <div className="stat-card-label" style={{ color: '#ff9800' }}>
                          {opt.t2Name}
                          <span style={{ color: 'rgba(255,152,0,0.55)', marginLeft: 6 }}>
                            {(adjProb * 100).toFixed(1)}% / attempt
                            {adjRuns > 1 && ` · ${adjRuns} runs`}
                          </span>
                        </div>
                        <div className="stat-card-value" style={{ textAlign: 'right' }}>
                          {opt.t2SellPrice > 0 ? <span style={{ color: 'var(--color-success)' }}>{formatISK(opt.t2SellPrice)}</span> : '—'}
                          {opt.perBpcCost > 0 && (
                            <span style={{ color: 'rgba(255,152,0,0.55)', fontSize: 10, marginLeft: 6 }}>(cost ~{formatISK(opt.perBpcCost)})</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })()}
          </>
        )}
    </>
  );
};

export default ItemMaterialsSection;
