// FORGE v1.27.0 — Planetary Industry tab (Phase 3)
// Colony dashboard: extractor status, expiry countdowns, factory schematics,
// ISK/day valuation, schematic profitability rankings, and blueprint PI cost breakdown.

import { useState, useEffect, useMemo, type FC } from 'react';
import { apiGet } from '../api/client';
import { formatISK } from '../utils/format';
import { itemIconUrl } from '../utils/icons';
import type { PiCharacter } from '../types';
import { usePocoTaxRate } from '../hooks/usePocoTaxRate';
import ForgeWait       from './ForgeWait';
import TickerPinButton from './TickerPinButton';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractorDetails {
  product_type_id?: number;
  qty_per_cycle?:   number;
  cycle_time?:      number;
  expiry_time?:     string;
}
interface FactoryDetails { schematic_id: number; }
interface EsiPin {
  pin_id:             number;
  type_id:            number;
  extractor_details?: ExtractorDetails;
  factory_details?:   FactoryDetails;
}
interface Colony {
  planet_id:       number;
  planet_type:     string;
  upgrade_level:   number;
  num_pins:        number;
  solar_system_id: number;
  pins:            EsiPin[];
  error?:          string;
  characterName?:  string;  // populated during multi-char merge
}
interface ProductInfo { name: string; piTier: number | null; }
interface SchematicInfo { name: string; cycleTime: number; }
interface BpRef { bpTypeId: number; productName: string; productTypeId: number; }
interface PiData {
  colonies:       Colony[];
  productNames:   Record<number, ProductInfo>;
  schematics:     Record<number, SchematicInfo>;
  systemNames:    Record<number, string>;
  prices:         Record<number, { sell: number; buy: number }>;
  factoryOutputs: Record<number, number>;           // schematicId → output typeId
  bpCrossRef:     Record<number, BpRef[]>;          // piTypeId → owned BPs that use it
}

// Phase 3 types
interface MarketRanking {
  typeId:      number;
  name:        string;
  tier:        number;
  unitsPerDay: number;
  sell:        number;
  grossPerDay: number;
  taxPerDay:   number;
  netPerDay:   number;
}
interface PiMaterial {
  typeId:    number;
  name:      string;
  tier:      number;
  qtyPerRun: number;
  sell:      number;
  iskPerRun: number;
}
interface BpPiReq {
  bpTypeId:    number;
  productId:   number;
  productName: string;
  piMaterials: PiMaterial[];
}
interface MarketData {
  rankings: MarketRanking[];
  bpPiReqs: BpPiReq[];
}

// ── EVE PI constants (game mechanics, never change) ───────────────────────────

const PLANET_COLORS: Record<string, string> = {
  temperate: 'var(--color-success)',
  barren:    '#a1887f',
  oceanic:   'var(--color-info)',
  ice:       '#80deea',
  gas:       'var(--color-warning)',
  lava:      'var(--color-danger)',
  storm:     'var(--color-contract)',
  plasma:    '#ff7043',
};
const PLANET_LABELS: Record<string, string> = {
  temperate: 'Temperate', barren: 'Barren', oceanic: 'Oceanic',
  ice: 'Ice', gas: 'Gas', lava: 'Lava', storm: 'Storm', plasma: 'Plasma',
};
const PI_TIER_COLORS: Record<number, string> = {
  0: 'var(--color-text-tertiary)',
  1: 'var(--color-pi-t1)',
  2: 'var(--color-pi-t2)',
  3: 'var(--color-pi-t3)',
  4: 'var(--color-pi-t4)',
};
// CCP-fixed base values (ISK/unit) used for POCO export tax calculation
const PI_BASE_VALUE: Record<number, number> = { 0: 5, 1: 400, 2: 7200, 3: 60000, 4: 1200000 };
// Fixed factory outputs per cycle (EVE game mechanic)
const PI_FACTORY_OUTPUT_QTY: Record<number, number> = { 1: 20, 2: 5, 3: 3, 4: 1 };

// ── Helpers ───────────────────────────────────────────────────────────────────

type Urgency = 'ok' | 'warn' | 'critical' | 'expired' | 'idle';

function formatCountdown(iso: string | undefined): { label: string; urgency: Urgency } {
  if (!iso) return { label: 'Not running', urgency: 'idle' };
  const diff = new Date(iso).getTime() - Date.now();
  // ESI occasionally returns malformed date strings; guard against NaN propagation.
  if (isNaN(diff)) return { label: 'Unknown', urgency: 'idle' };
  if (diff <= 0) return { label: 'Expired', urgency: 'expired' };
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  const label = h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
  if (diff < 4  * 3_600_000) return { label, urgency: 'critical' };
  if (diff < 24 * 3_600_000) return { label, urgency: 'warn' };
  return { label, urgency: 'ok' };
}


function fmtQty(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
}

// Per-output daily value line (extractor or factory)
interface YieldLine {
  label:       string;
  typeId:      number;
  tier:        number;
  unitsPerDay: number;
  grossISK:    number;
  taxISK:      number;
  netISK:      number;
  hasPrices:   boolean;
}

/**
 * Computes estimated daily ISK yield for one colony.
 *
 * Takes a pre-built `grouped` array (from groupFactories) so the caller can share
 * that result with the factory-display UI without rebuilding it a second time here.
 *
 * EVE PI note: extractor output is variable (depends on resource depletion); factory
 * output is fixed by CCP (PI_FACTORY_OUTPUT_QTY).  Both are converted to per-day
 * units then multiplied by Jita sell price.  POCO export tax is subtracted (10% of
 * CCP's base value per unit — different from the Jita market price).
 */
function colonyYield(
  colony:      Colony,
  data:        PiData,
  grouped:     Array<{ schematicId: number; count: number }>,
  pocoTaxRate: number,
): YieldLine[] {
  const { productNames, schematics, prices, factoryOutputs } = data;
  const lines: YieldLine[] = [];

  // Extractors — each ECU (Extractor Control Unit) harvests one raw resource (P0).
  for (const pin of colony.pins) {
    const ex = pin.extractor_details;
    if (!ex?.product_type_id || !ex.qty_per_cycle || !ex.cycle_time) continue;
    // Skip extractors that have already stopped (expiry_time is in the past).
    if (ex.expiry_time && new Date(ex.expiry_time).getTime() <= Date.now()) continue;

    const typeId      = ex.product_type_id;
    const tier        = productNames[typeId]?.piTier ?? 0;
    const unitsPerDay = ex.qty_per_cycle * (86400 / ex.cycle_time);
    const sell        = prices[typeId]?.sell ?? 0;
    const grossISK    = unitsPerDay * sell;
    const taxISK      = unitsPerDay * (PI_BASE_VALUE[tier] ?? 5) * pocoTaxRate;
    lines.push({
      label: productNames[typeId]?.name ?? `Type ${typeId}`,
      typeId, tier, unitsPerDay: Math.round(unitsPerDay),
      grossISK, taxISK, netISK: grossISK - taxISK,
      hasPrices: sell > 0,
    });
  }

  // Factories — use the pre-built grouped array passed in by the caller.
  // `grouped` is already produced by groupFactories() for the colony card display,
  // so we reuse it here rather than iterating colony.pins a second time.
  for (const { schematicId: sid, count } of grouped) {
    const sch    = schematics[sid];
    const typeId = factoryOutputs[sid];
    if (!sch || !typeId) continue;
    const tier       = productNames[typeId]?.piTier ?? null;
    if (tier == null) continue;
    // outputQty: units produced per cycle — fixed by CCP (see PI_FACTORY_OUTPUT_QTY constant)
    const outputQty   = PI_FACTORY_OUTPUT_QTY[tier] ?? 0;
    const unitsPerDay = count * outputQty * (86400 / sch.cycleTime);
    const sell        = prices[typeId]?.sell ?? 0;
    const grossISK    = unitsPerDay * sell;
    const taxISK      = unitsPerDay * (PI_BASE_VALUE[tier] ?? 400) * pocoTaxRate;
    lines.push({
      label: productNames[typeId]?.name ?? sch.name,
      typeId, tier, unitsPerDay: Math.round(unitsPerDay),
      grossISK, taxISK, netISK: grossISK - taxISK,
      hasPrices: sell > 0,
    });
  }

  return lines;
}

function groupFactories(pins: EsiPin[]): Array<{ schematicId: number; count: number }> {
  const m = new Map<number, number>();
  for (const p of pins) {
    if (!p.factory_details) continue;
    const sid = p.factory_details.schematic_id;
    m.set(sid, (m.get(sid) ?? 0) + 1);
  }
  return [...m.entries()].map(([schematicId, count]) => ({ schematicId, count }));
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PiTabProps { piCharacters: PiCharacter[]; }

const PiTab: FC<PiTabProps> = ({ piCharacters }) => {
  const [data,          setData]          = useState<PiData | null>(null);
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);
  const [partialErrors, setPartialErrors] = useState<string[]>([]);
  const [market,        setMarket]        = useState<MarketData | null>(null);
  const [marketError,   setMarketError]   = useState<string | null>(null);
  const [showAllRankings, setShowAllRankings] = useState(false);
  const [pocoTaxRate, setPocoTaxRate] = usePocoTaxRate();
  const [, forceUpdate] = useState(0);

  // Stable key so we only re-fetch when the set of characters actually changes.
  const charKey = piCharacters.map(c => `${c.characterId}:${c.token}`).join('|');

  useEffect(() => {
    if (!piCharacters.length) return;
    setLoading(true); setError(null); setPartialErrors([]);

    // Fetch PI colonies for every character in parallel, then merge.
    Promise.allSettled(
      piCharacters.map(c =>
        apiGet<PiData>('/api/pi/colonies', c.token)
          .then(d => ({ d, name: c.name }))
      )
    ).then(results => {
      const merged: PiData = {
        colonies: [], productNames: {}, schematics: {},
        systemNames: {}, prices: {}, factoryOutputs: {}, bpCrossRef: {},
      };
      const failed: string[] = [];

      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          const { d, name } = r.value;
          // Tag each colony with the character name for per-card attribution.
          merged.colonies.push(...d.colonies.map(c => ({ ...c, characterName: name })));
          Object.assign(merged.productNames,   d.productNames);
          Object.assign(merged.schematics,     d.schematics);
          Object.assign(merged.systemNames,    d.systemNames);
          Object.assign(merged.prices,         d.prices);
          Object.assign(merged.factoryOutputs, d.factoryOutputs);
          // Deduplicate bpCrossRef entries across characters
          for (const [tidStr, bps] of Object.entries(d.bpCrossRef)) {
            const tid = Number(tidStr);
            if (!merged.bpCrossRef[tid]) merged.bpCrossRef[tid] = [];
            bps.forEach((bp: BpRef) => {
              if (!merged.bpCrossRef[tid].find((b: BpRef) => b.bpTypeId === bp.bpTypeId))
                merged.bpCrossRef[tid].push(bp);
            });
          }
        } else {
          failed.push(piCharacters[i].name);
        }
      });

      if (merged.colonies.length > 0 || failed.length < piCharacters.length) {
        setData(merged);
        setPartialErrors(failed);
      } else {
        setError('Failed to load PI data — check that your characters have PI colonies set up in-game');
      }
      setLoading(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charKey]);

  // Market rankings only need one call (not character-specific) — refetches when the
  // POCO tax rate changes so rankings reflect the user's real rate.
  useEffect(() => {
    if (!piCharacters.length) return;
    setMarketError(null);
    apiGet<MarketData>(`/api/pi/market?pocoTaxRate=${pocoTaxRate}`, piCharacters[0].token)
      .then(d  => setMarket(d))
      .catch(e => setMarketError(e.message || 'Failed to load market data'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charKey, pocoTaxRate]);

  useEffect(() => {
    const id = setInterval(() => forceUpdate(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // useMemo must be before any early returns to satisfy React's Rules of Hooks
  // (hooks must be called the same number of times on every render).
  // When data is null (loading / error), this safely returns an empty array.
  const allYieldLines = useMemo(
    () => !data ? [] : data.colonies.flatMap(c => colonyYield(c, data, groupFactories(c.pins), pocoTaxRate)),
    [data, pocoTaxRate],
  );

  if (!piCharacters.length) return <div className="pi-state-msg">Log in to view PI colonies.</div>;
  if (loading)              return <ForgeWait message="Loading PI colonies…" detail="Fetching colony data and Jita market prices — please wait." quip="I am contacting your planets. The planets have been informed you are waiting. They did not respond. I am told this is normal." />;
  if (error)                return <div className="pi-state-msg pi-error-msg">{error}</div>;
  if (!data)                return null;

  const { colonies, productNames, schematics, systemNames, prices, factoryOutputs, bpCrossRef } = data;
  const multiChar = piCharacters.length > 1;

  if (colonies.length === 0) {
    return (
      <div className="pi-state-msg pi-empty-msg">
        <div style={{ fontSize: 28, marginBottom: 8 }}>🌍</div>
        <div>No PI colonies found.</div>
        <div className="pi-empty-hint">Set up colonies in-game, then refresh FORGE.</div>
      </div>
    );
  }
  const totalGross    = allYieldLines.reduce((s, l) => s + l.grossISK, 0);
  const totalTax      = allYieldLines.reduce((s, l) => s + l.taxISK,   0);
  const totalNet      = totalGross - totalTax;
  const hasPrices     = allYieldLines.some(l => l.hasPrices);

  // Phase 3: set of typeIds the user is currently producing in factories (for ranking highlight)
  const runningTypeIds = new Set<number>(Object.values(factoryOutputs).filter(Boolean));

  // Alert colonies (ECU expiring / expired)
  const urgentColonies = colonies.filter(c =>
    c.pins.some(p => {
      const u = formatCountdown(p.extractor_details?.expiry_time).urgency;
      return u === 'critical' || u === 'expired';
    })
  );

  // Blueprint cross-reference: collect all PI materials that appear in owned BPs
  const crossRefEntries = Object.entries(bpCrossRef)
    .map(([typeIdStr, bps]) => ({
      typeId:    Number(typeIdStr),
      name:      productNames[Number(typeIdStr)]?.name ?? `Type ${typeIdStr}`,
      tier:      productNames[Number(typeIdStr)]?.piTier ?? null,
      blueprints: bps,
    }))
    .filter(e => e.blueprints.length > 0)
    .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));

  return (
    <div className="pi-tab">

      {/* ── Portfolio summary bar ── */}
      <div className="pi-summary-bar">
        <span className="pi-summary-label">Portfolio</span>
        {hasPrices ? (
          <>
            <span className="pi-summary-gross">{formatISK(totalGross)} gross</span>
            <span className="pi-summary-sep">·</span>
            <span className="pi-summary-tax">−{formatISK(totalTax)} tax</span>
            <span className="pi-summary-sep">·</span>
            <span className="pi-summary-net">{formatISK(totalNet)} ISK/day</span>
            <span className="pi-summary-note">Jita · est.</span>
          </>
        ) : (
          <span className="pi-summary-note">Prices not yet loaded — check back shortly</span>
        )}
        <label className="pi-poco-input" title="Your actual POCO export tax rate — varies by structure/owner, not available live">
          POCO tax
          <input
            type="number" min={0} max={100} step={0.5}
            value={Math.round(pocoTaxRate * 1000) / 10}
            onChange={e => {
              if (e.target.value === '') return; // mid-edit: keep current rate
              setPocoTaxRate((parseFloat(e.target.value) || 0) / 100);
            }}
          />
          %
        </label>
      </div>

      {partialErrors.length > 0 && (
        <div className="pi-alert-banner pi-alert-warn">
          ⚠&nbsp; Could not load PI for: {partialErrors.join(', ')} — try refreshing
        </div>
      )}

      {urgentColonies.length > 0 && (
        <div className="pi-alert-banner">
          ⚠&nbsp; {urgentColonies.length === 1 ? '1 colony needs' : `${urgentColonies.length} colonies need`} attention — ECU expiring or expired
        </div>
      )}

      {/* ── Colony cards ── */}
      <div className="pi-colony-grid">
        {colonies.map(colony => {
          const sysName   = systemNames[colony.solar_system_id] ?? `System ${colony.solar_system_id}`;
          const color     = PLANET_COLORS[colony.planet_type]   ?? '#888';
          const typeLabel = PLANET_LABELS[colony.planet_type]   ?? colony.planet_type;
          const extractors = colony.pins.filter(p => p.extractor_details);
          const grouped    = groupFactories(colony.pins);
          const yieldLines = colonyYield(colony, data, grouped, pocoTaxRate);
          const colonyNet  = yieldLines.reduce((s, l) => s + l.netISK, 0);
          const colonyHasPrices = yieldLines.some(l => l.hasPrices);

          const worstUrgency: Urgency = (() => {
            for (const p of extractors) {
              const { urgency } = formatCountdown(p.extractor_details!.expiry_time);
              if (urgency === 'expired' || urgency === 'critical') return 'critical';
            }
            const hasWarn = extractors.some(p => formatCountdown(p.extractor_details!.expiry_time).urgency === 'warn');
            if (hasWarn) return 'warn';
            return extractors.length === 0 ? 'idle' : 'ok';
          })();

          return (
            <div key={colony.planet_id} className={`pi-colony-card pi-colony-${worstUrgency}`}>

              {/* Header */}
              <div className="pi-colony-header">
                <span className="pi-planet-dot" style={{ background: color }} />
                <span className="pi-colony-name">{sysName}</span>
                <span className="pi-type-badge" style={{ borderColor: color, color }}>{typeLabel}</span>
                <span className="pi-ccu-badge">CCU&nbsp;{colony.upgrade_level}</span>
                {multiChar && colony.characterName && (
                  <span className="pi-char-badge">{colony.characterName}</span>
                )}
              </div>

              {/* Extractors */}
              <div className="pi-section">
                <div className="pi-section-label">Extracting</div>
                {extractors.length === 0
                  ? <div className="pi-no-extractor">No ECU running</div>
                  : extractors.map(p => {
                    const pid      = p.extractor_details!.product_type_id;
                    const info     = pid != null ? productNames[pid] : null;
                    const tier     = info?.piTier ?? null;
                    const qty      = p.extractor_details!.qty_per_cycle;
                    const ct       = p.extractor_details!.cycle_time;
                    const { label: countdown, urgency } = formatCountdown(p.extractor_details!.expiry_time);
                    const perDay   = qty && ct ? Math.round(qty * 86400 / ct) : null;

                    return (
                      <div key={p.pin_id} className="pi-extractor-row">
                        <span className="pi-product-name">{info?.name ?? (pid != null ? `Type ${pid}` : 'Unknown')}</span>
                        {tier != null && (
                          <span className="pi-tier-badge" style={{ color: PI_TIER_COLORS[tier] ?? 'inherit' }}>P{tier}</span>
                        )}
                        {qty != null && <span className="pi-qty">{qty.toLocaleString()}/cycle</span>}
                        {perDay != null && <span className="pi-per-day">~{fmtQty(perDay)}/day</span>}
                        <span className={`pi-expiry pi-expiry-${urgency}`}>
                          {urgency === 'expired' ? '⚠ ' : ''}{countdown}
                        </span>
                        <TickerPinButton
                          options={[{ type: 'pi_extractor', label: `${info?.name ?? 'ECU'} expiry` }]}
                          baseConfig={{
                            typeId:     p.pin_id,
                            itemName:   `${info?.name ?? 'ECU'} · ${sysName}`,
                            expiryTime: p.extractor_details!.expiry_time,
                          }}
                        />
                      </div>
                    );
                  })
                }
              </div>

              {/* Factories */}
              {grouped.length > 0 && (
                <div className="pi-section">
                  <div className="pi-section-label">Factories ({colony.pins.filter(p => p.factory_details).length})</div>
                  <div className="pi-factory-list">
                    {grouped.map(({ schematicId, count }) => {
                      const sch    = schematics[schematicId];
                      const typeId = factoryOutputs[schematicId];
                      const tier   = typeId ? productNames[typeId]?.piTier : null;
                      return (
                        <span key={schematicId} className="pi-factory-tag">
                          {sch?.name ?? `Schematic #${schematicId}`}
                          {count > 1 && <span className="pi-factory-count"> ×{count}</span>}
                          {tier != null && (
                            <span className="pi-factory-tier" style={{ color: PI_TIER_COLORS[tier] ?? 'inherit' }}> P{tier}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ISK/day valuation */}
              {yieldLines.length > 0 && (
                <div className="pi-section pi-valuation">
                  <div className="pi-section-label">Est. daily value</div>
                  {yieldLines.map((line, i) => (
                    <div key={i} className="pi-val-row">
                      <span className="pi-val-label">{line.label}</span>
                      <span className="pi-val-qty">{fmtQty(line.unitsPerDay)}/day</span>
                      {line.hasPrices
                        ? <span className="pi-val-isk">{formatISK(line.netISK)} ISK</span>
                        : <span className="pi-val-nodata">no price</span>
                      }
                    </div>
                  ))}
                  <div className="pi-val-total">
                    <span>Colony net</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {colonyHasPrices ? `${formatISK(colonyNet)} ISK/day` : '—'}
                      {colonyHasPrices && (
                        <TickerPinButton
                          options={[{ type: 'pi_colony_isk', label: `${sysName} ISK/day` }]}
                          baseConfig={{
                            typeId:        colony.planet_id,
                            itemName:      sysName,
                            snapshotValue: colonyNet,
                          }}
                        />
                      )}
                    </span>
                  </div>
                </div>
              )}

              {colony.error && (
                <div className="pi-colony-error">Layout unavailable — open this colony in the EVE client to refresh ESI cache</div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Blueprint cross-reference ── */}
      {crossRefEntries.length > 0 && (
        <div className="pi-bp-crossref">
          <div className="pi-bp-crossref-title">PI supplies your blueprints</div>
          <div className="pi-bp-crossref-grid">
            {crossRefEntries.map(({ typeId, name, tier, blueprints }) => (
              <div key={typeId} className="pi-bp-crossref-row">
                <span className="pi-bp-mat">
                  {tier != null && (
                    <span className="pi-tier-badge" style={{ color: PI_TIER_COLORS[tier] ?? 'inherit', marginRight: 4 }}>P{tier}</span>
                  )}
                  {name}
                  {prices[typeId]?.sell ? (
                    <span className="pi-bp-mat-price"> · {formatISK(prices[typeId].sell)} ISK/u</span>
                  ) : null}
                </span>
                <span className="pi-bp-arrow">→</span>
                <span className="pi-bp-products">
                  {blueprints.map((bp, i) => (
                    <span key={bp.bpTypeId}>
                      {i > 0 && <span className="pi-bp-sep">, </span>}
                      <img
                        className="pi-bp-icon"
                        src={itemIconUrl(bp.productTypeId, 22)}
                        alt={bp.productName}
                        width={18}
                        height={18}
                        crossOrigin="anonymous"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                      {bp.productName}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Phase 3: Schematic market rankings ── */}
      {marketError && (
        <div className="pi-state-msg pi-error-msg" style={{ margin: '8px 0' }}>
          Market rankings unavailable — {marketError}
        </div>
      )}
      {market && market.rankings.length > 0 && (
        <div className="pi-rankings">
          <div className="pi-rankings-header">
            <span className="pi-rankings-title">Schematic Market Rankings</span>
            <span className="pi-rankings-sub">net ISK/day per single factory slot · Jita sell · {Math.round(pocoTaxRate * 100)}% POCO tax</span>
          </div>
          <div className="pi-rankings-table">
            <div className="pi-rankings-thead">
              <span className="pi-rank-col">#</span>
              <span className="pi-rankname-col">Product</span>
              <span className="pi-ranktier-col">Tier</span>
              <span className="pi-rankqty-col">/day</span>
              <span className="pi-rankgross-col">Gross</span>
              <span className="pi-ranktax-col">Tax</span>
              <span className="pi-ranknet-col">Net ISK/day</span>
            </div>
            {(showAllRankings ? market.rankings : market.rankings.slice(0, 12)).map((r, i) => (
              <div key={r.typeId} className={`pi-rankings-row${runningTypeIds.has(r.typeId) ? ' pi-rank-running' : ''}`}>
                <span className="pi-rank-col">{i + 1}</span>
                <span className="pi-rankname-col">
                  {runningTypeIds.has(r.typeId) && <span className="pi-rank-active-dot" title="Currently producing" />}
                  {r.name}
                </span>
                <span className="pi-ranktier-col">
                  <span className="pi-tier-badge" style={{ color: PI_TIER_COLORS[r.tier] ?? 'inherit' }}>P{r.tier}</span>
                </span>
                <span className="pi-rankqty-col">{fmtQty(r.unitsPerDay)}</span>
                <span className="pi-rankgross-col">{r.sell > 0 ? formatISK(r.grossPerDay) : '—'}</span>
                <span className="pi-ranktax-col">{r.sell > 0 ? `−${formatISK(r.taxPerDay)}` : '—'}</span>
                <span className="pi-ranknet-col">{r.sell > 0 ? formatISK(r.netPerDay) : <span className="pi-val-nodata">no price</span>}</span>
              </div>
            ))}
          </div>
          {market.rankings.length > 12 && (
            <button className="pi-rankings-toggle" onClick={() => setShowAllRankings(v => !v)}>
              {showAllRankings ? 'Show top 12 only' : `Show all ${market.rankings.length} schematics`}
            </button>
          )}
        </div>
      )}

      {/* ── Phase 3: Blueprint PI cost breakdown ── */}
      {market && market.bpPiReqs.length > 0 && (
        <div className="pi-bpreqs">
          <div className="pi-bpreqs-title">Blueprint PI Material Costs</div>
          <div className="pi-bpreqs-list">
            {market.bpPiReqs.map(bp => {
              const totalIsk = bp.piMaterials.reduce((s, m) => s + m.iskPerRun, 0);
              return (
                <div key={bp.bpTypeId} className="pi-bpreq-card">
                  <div className="pi-bpreq-header">
                    <img
                      className="pi-bpreq-icon"
                      src={itemIconUrl(bp.productId)}
                      alt={bp.productName}
                      width={22} height={22}
                      crossOrigin="anonymous"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                    <span className="pi-bpreq-name">{bp.productName}</span>
                    {totalIsk > 0 && (
                      <span className="pi-bpreq-total">{formatISK(totalIsk)} ISK/run</span>
                    )}
                  </div>
                  <div className="pi-bpreq-mats">
                    {bp.piMaterials.map(m => (
                      <div key={m.typeId} className="pi-bpreq-mat-row">
                        <span className="pi-tier-badge" style={{ color: PI_TIER_COLORS[m.tier] ?? 'inherit' }}>P{m.tier}</span>
                        <span className="pi-bpreq-mat-name">{m.name}</span>
                        <span className="pi-bpreq-qty">{m.qtyPerRun.toLocaleString()} u</span>
                        {m.sell > 0
                          ? <span className="pi-bpreq-isk">{formatISK(m.iskPerRun)}</span>
                          : <span className="pi-val-nodata">no price</span>
                        }
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="pi-footnote">
        Colony layouts cached ~10 min by ESI · Prices: Jita sell · POCO export tax {Math.round(pocoTaxRate * 100)}% (your rate, set above) · Self-contained planets (extractor + factory) show both P0 and processed values separately
      </p>
    </div>
  );
};

export default PiTab;
