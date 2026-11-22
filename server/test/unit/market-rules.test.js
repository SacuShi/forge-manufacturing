// Deploy 2 of the Nov 2026 CCP-accuracy audit: fees, volumes, recipe costs, liquidity and hauling follow CCP's rules.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hubFeeRates, activeFeePromotion, defaultHubTaxRate, calcSalesFeeRates } = require('../../lib/character-session');
const { summariseHistory } = require('../../lib/market-history');
const { calculateMaterialCostSync } = require('../../lib/precompute');
const { classifyLiquidity, historyPricedProfit } = require('../../lib/volume-enrichment');
const { calcProviderFee, perUnitHaulCost, HAUL_PROVIDERS } = require('../../lib/haul');

const JITA = 10000002, AMARR = 10000043, KEEPSTAR = 10099000;
const SKILLS_V = { 3446: 5, 16622: 5 };           // Broker Relations V, Accounting V
const NO_STANDINGS = { factions: {}, corps: {} };
const BEFORE = Date.parse('2026-11-09T23:59:59Z');
const DURING = Date.parse('2026-11-22T12:00:00Z');
const AFTER  = Date.parse('2027-05-10T00:00:00Z');

describe('hub fees (one helper for every route)', () => {
  it('Jita: skills + standings formula unchanged', () => {
    const r = hubFeeRates(SKILLS_V, NO_STANDINGS, JITA, DURING);
    expect(r.brokerFeeRate).toBeCloseTo(0.015, 10);           // 3% − 5 × 0.3%
    expect(r.transactionTaxRate).toBeCloseTo(0.03375, 10);    // 7.5% × (1 − 0.55)
    expect(r.feePromotion).toBeNull();
  });

  it('C-J6MT Keepstar: owner 1.5% + CCP SCC 0.5% = 2.0%, no standings discount', () => {
    const st = { factions: { 500003: 10 }, corps: { 1000086: 10 } };
    const r = hubFeeRates({ 3446: 0, 16622: 5 }, st, KEEPSTAR, DURING);
    expect(r.brokerFeeRate).toBeCloseTo(0.02, 10);
    expect(r.factionStanding).toBe(0);
  });

  it('Amarr EFA: Fractured Skies halves sales tax AND broker fee from 10 Nov 2026 to 10 May 2027 only', () => {
    const base = calcSalesFeeRates(SKILLS_V, NO_STANDINGS, { faction_id: 500003, corp_id: 1000086 });
    const during = hubFeeRates(SKILLS_V, NO_STANDINGS, AMARR, DURING);
    expect(during.brokerFeeRate).toBeCloseTo(base.brokerFeeRate / 2, 10);
    expect(during.transactionTaxRate).toBeCloseTo(base.transactionTaxRate / 2, 10);
    expect(during.feePromotion).toMatch(/Fractured Skies/);
    for (const t of [BEFORE, AFTER]) {
      const r = hubFeeRates(SKILLS_V, NO_STANDINGS, AMARR, t);
      expect(r.brokerFeeRate).toBeCloseTo(base.brokerFeeRate, 10);
      expect(r.feePromotion).toBeNull();
    }
    expect(activeFeePromotion(JITA, DURING)).toBeNull();
  });

  it('pilot unknown → Accounting V at that hub (discount included)', () => {
    expect(defaultHubTaxRate(JITA, DURING)).toBeCloseTo(0.03375, 10);
    expect(defaultHubTaxRate(AMARR, DURING)).toBeCloseTo(0.016875, 10);
  });
});

describe('daily volume = units traded in the last 30 calendar days ÷ 30', () => {
  const NOW = Date.parse('2026-11-22T10:00:00Z');
  it('days with no trades count as zero (ESI leaves them out)', () => {
    // 3 trading days in the window, 300 units, plus older rows outside it
    const h = [
      { date: '2026-08-01', volume: 9999, average: 50 },
      { date: '2026-11-01', volume: 100, average: 10 },
      { date: '2026-11-10', volume: 100, average: 12 },
      { date: '2026-11-21', volume: 100, average: 14 },
    ];
    const s = summariseHistory(h, NOW);
    expect(s.avgDailyVolume).toBeCloseTo(10, 10);     // 300 / 30, not 300 / 3 = 100
    expect(s.tradingDays).toBe(3);
    expect(s.avgPrice).toBeCloseTo((50 + 10 + 12 + 14) / 4, 10);   // recent trading days' average price
  });
  it('today (not over, no ESI row yet) and days older than 30 are outside the window', () => {
    const s = summariseHistory([{ date: '2026-10-22', volume: 60 }, { date: '2026-10-23', volume: 30 }, { date: '2026-11-22', volume: 90 }], NOW);
    expect(s.avgDailyVolume).toBeCloseTo(1, 10);      // only 2026-10-23 is inside
  });
  it('no history → zeros', () => {
    expect(summariseHistory([], NOW)).toEqual({ avgDailyVolume: 0, avgPrice: 0, tradingDays: 0 });
  });
});

describe('recipe cost with buildable components', () => {
  // Product needs 10 of component C (type 20). C's blueprint (900) makes 100 units per run from 1000 × mineral 30.
  const materialsByBp = { 900: [{ material_id: 30, quantity: 1000 }] };
  const bpByProduct = { 20: 900 };
  const qtyByBp = { 900: 100 };
  it('a sub-blueprint run that makes 100 units costs 1/100 of the run per unit', () => {
    const prices = { 20: { sell: 1000 }, 30: { sell: 5 } };   // build: 1000×5/100 = 50 per unit; buy: 1000
    expect(calculateMaterialCostSync(20, 10, prices, materialsByBp, bpByProduct, qtyByBp)).toBeCloseTo(500, 10);
  });
  it('a material with no price at all is unknown (null), never free', () => {
    expect(calculateMaterialCostSync(99, 3, {}, {}, {}, {})).toBeNull();
  });
  it('unpriced component but buildable from priced minerals → build cost', () => {
    expect(calculateMaterialCostSync(20, 10, { 30: { sell: 5 } }, materialsByBp, bpByProduct, qtyByBp)).toBeCloseTo(500, 10);
  });
  it('priced component whose minerals are unpriced → buy cost', () => {
    expect(calculateMaterialCostSync(20, 10, { 20: { sell: 40 } }, materialsByBp, bpByProduct, qtyByBp)).toBeCloseTo(400, 10);
  });
});

describe('liquidity labels compare a run’s revenue with the run’s cost', () => {
  it('a 10,000-unit reaction run worth 10× its inputs is flagged (per unit it looked like a loss)', () => {
    // 10,000 × 100 = 1,000,000 revenue vs 100,000 cost. Per unit (100 vs 100,000) the old check saw nothing.
    expect(classifyLiquidity({ marketGroupId: 1, sellPrice: 100, materialCost: 100000, buyPrice: 90, avgVolume: 1e6, productQty: 10000 })).toBe('extreme_margin');
  });
  it('a normal 40-unit fuel-block run gets no label', () => {
    expect(classifyLiquidity({ marketGroupId: 1, sellPrice: 300, materialCost: 10000, buyPrice: 290, avgVolume: 1000, productQty: 40 })).toBeNull();
  });
  it('extreme margin still caught per run', () => {
    expect(classifyLiquidity({ marketGroupId: 1, sellPrice: 1000, materialCost: 10, buyPrice: 900, avgVolume: 1000, productQty: 1 })).toBe('extreme_margin');
  });
  it('history-priced profit uses units per run; unknown cost stays unknown', () => {
    expect(historyPricedProfit(300, { material_cost: 10000, build_time: 3600, product_qty: 40 })).toEqual({ profit: 2000, profitMargin: 2000 / 12000 * 100, iskPerHour: 2000 });
    expect(historyPricedProfit(300, { material_cost: null, build_time: 3600, product_qty: 40 }).profit).toBeNull();
  });
});

describe('hauling: a trip’s cost is shared by the units on it', () => {
  const rf = HAUL_PROVIDERS.red_frog;
  it('Red Frog minimum fee is per contract, not per unit', () => {
    // 1 m³ items worth 1,000 ISK, 500 traded a day: one contract of 500 m³ → 1M min fee ÷ 500 = 2,000 per unit
    const r = perUnitHaulCost({ method: 'red_frog' }, { unitVolM3: 1, unitValue: 1000, jumps: 9, tradeUnits: 500 });
    expect(r.unitsPerTrip).toBe(500);
    expect(r.tripCost).toBe(rf.min_fee);
    expect(r.perUnit).toBeCloseTo(rf.min_fee / 500, 10);
  });
  it('units per trip capped by the courier volume and collateral limits', () => {
    const vol = perUnitHaulCost({ method: 'red_frog' }, { unitVolM3: 10000, unitValue: 1, jumps: 9, tradeUnits: 1000 });
    expect(vol.unitsPerTrip).toBe(Math.floor(rf.max_volume_m3 / 10000));
    const coll = perUnitHaulCost({ method: 'red_frog' }, { unitVolM3: 1, unitValue: 100_000_000, jumps: 9, tradeUnits: 1000 });
    expect(coll.unitsPerTrip).toBe(10);   // 1B collateral limit ÷ 100M
  });
  it('collateral over the provider limit is split into more contracts', () => {
    expect(calcProviderFee('red_frog', 100, 2.5e9).contracts).toBe(3);
  });
  it('no limit known → one unit per trip (the cautious old figure)', () => {
    const r = perUnitHaulCost({ method: 'user_defined', flat_total: 5_000_000 }, { unitVolM3: 1, unitValue: 1, jumps: 5 });
    expect(r.unitsPerTrip).toBe(1);
    expect(r.perUnit).toBe(5_000_000);
  });
  it('per-m³ rate is the same per unit whatever the trip size', () => {
    const r = perUnitHaulCost({ method: 'user_defined', rate: 300 }, { unitVolM3: 2, unitValue: 1, jumps: 5, tradeUnits: 77 });
    expect(r.perUnit).toBeCloseTo(600, 10);
  });
});

describe('inter-hub arbitrage list (shared by the tab and the AI advisor)', () => {
  const sqlite3 = require('sqlite3');
  const { queryInterHubArb } = require('../../lib/inter-hub');
  it('buys only from live asks and deducts the given sales tax', async () => {
    const db = new sqlite3.Database(':memory:');
    const run = (q, p = []) => new Promise((res, rej) => db.run(q, p, (e) => (e ? rej(e) : res())));
    const all = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
    await run(`CREATE TABLE precomputed_profits (blueprint_id INT, region_id INT, product_id INT, product_name TEXT,
      sell_price REAL, buy_price REAL, avg_daily_volume REAL, price_source TEXT)`);
    await run('CREATE TABLE items (type_id INT, packaged_volume REAL)');
    const ins = (bp, region, id, name, sell, buy, src) => run('INSERT INTO precomputed_profits VALUES (?,?,?,?,?,?,?,?)', [bp, region, id, name, sell, buy, 10, src]);
    await ins(1, JITA, 100, 'Live Item', 100, 90, 'jita');            await ins(1, AMARR, 100, 'Live Item', 150, 130, 'region_10000043');
    await ins(2, JITA, 200, 'History Item', 100, 0, 'history_30d');   await ins(2, AMARR, 200, 'History Item', 150, 130, 'region_10000043');
    await ins(3, JITA, 300, 'Fallback Item', 100, 0, 'jita_fallback'); await ins(3, AMARR, 300, 'Fallback Item', 150, 130, 'region_10000043');
    const rows = await queryInterHubArb({ buyHub: JITA, sellHub: AMARR, taxRate: 0.016875, minMargin: 0, limit: 10 }, all);
    expect(rows.map((r) => r.product_name)).toEqual(['Live Item']);
    expect(rows[0].net_profit).toBeCloseTo(130 * (1 - 0.016875) - 100, 9);
    db.close();
  });
});
