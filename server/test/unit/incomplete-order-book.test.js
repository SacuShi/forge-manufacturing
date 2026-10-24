// Regression: when the server lost its connection mid-fetch (Oct 2026, DNS EAI_AGAIN), fetchRegionPrices returned the
// pages it had (or none) as if they were the whole market, and the pre-compute then replaced every hub's profit rows
// with numbers built from an empty book. An incomplete book must now fail, and the last good prices and rows stay.
// Runs the real code against an in-memory database and a stubbed ESI.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const JITA = 10000002, AMARR = 10000043, DODIXIE = 10000032;
const JITA_STATION = 60003760;
const TRITANIUM = 34, RIFTER = 587, RIFTER_BP = 691;

// Order books per region; a region in `offline` fails like the server's DNS did.
let books = {};
let offline = new Set();
let failPage = null; // { regionId, side, page }: only this page fails

const respond = (data, pages) => ({
  status: 200, ok: true,
  headers: { get: (h) => (h.toLowerCase() === 'x-pages' ? String(pages) : null) },
  json: async () => data,
});

beforeAll(async () => {
  const fakeFetch = async (url) => {
    const m = /\/markets\/(\d+)\/orders\/.*order_type=(sell|buy)&page=(\d+)/.exec(String(url));
    if (!m) throw new Error(`unexpected request in test: ${url}`);
    const [regionId, side, page] = [Number(m[1]), m[2], Number(m[3])];
    if (offline.has(regionId)) throw new Error('request failed, reason: getaddrinfo EAI_AGAIN esi.evetech.net');
    if (failPage && failPage.regionId === regionId && failPage.side === side && failPage.page === page) {
      throw new Error('request failed, reason: read ETIMEDOUT');
    }
    const pages = books[regionId]?.[side] || [[]];
    return respond(pages[page - 1] || [], pages.length);
  };
  const fetchPath = require.resolve('node-fetch');
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };

  const { initDatabase, dbRun } = require('../../lib/db');
  await initDatabase(':memory:');
  await require('../../lib/migrations').runMigrations();
  await dbRun('INSERT INTO items (type_id, name) VALUES (?, ?), (?, ?)', [TRITANIUM, 'Tritanium', RIFTER, 'Rifter']);
  await dbRun('INSERT INTO blueprints (blueprint_id, product_id, product_quantity, build_time) VALUES (?, ?, 1, 3600)',
    [RIFTER_BP, RIFTER]);
  await dbRun('INSERT INTO blueprint_materials (blueprint_id, material_id, quantity) VALUES (?, ?, 1000)',
    [RIFTER_BP, TRITANIUM]);
});

beforeEach(() => {
  offline = new Set();
  failPage = null;
  books = {
    [JITA]: {
      sell: [[
        { type_id: RIFTER, price: 500_000, volume_remain: 10, location_id: JITA_STATION },
        { type_id: TRITANIUM, price: 5, volume_remain: 1e6, location_id: JITA_STATION },
      ]],
      buy: [[{ type_id: RIFTER, price: 400_000, volume_remain: 10, location_id: JITA_STATION }]],
    },
    [AMARR]: {
      sell: [
        [{ type_id: RIFTER, price: 600_000, volume_remain: 5, location_id: 60008494 }],
        [{ type_id: TRITANIUM, price: 6, volume_remain: 1e6, location_id: 60008494 }],
      ],
      buy: [[]],
    },
  };
});

describe('fetchRegionPrices', () => {
  it('returns the full book when every page arrives', async () => {
    const { fetchRegionPrices } = require('../../lib/market-cache');
    const prices = await fetchRegionPrices(AMARR);
    expect(prices[RIFTER].sell).toBe(600_000);
    expect(prices[TRITANIUM].sell).toBe(6);
  });

  it('fails instead of returning a partial book when a later page is lost', async () => {
    const { fetchRegionPrices } = require('../../lib/market-cache');
    failPage = { regionId: AMARR, side: 'sell', page: 2 };
    await expect(fetchRegionPrices(AMARR)).rejects.toThrow(/incomplete sell order book \(page 2: .*ETIMEDOUT/);
  });

  it('fails instead of returning an empty book when the network is down', async () => {
    const { fetchRegionPrices } = require('../../lib/market-cache');
    offline.add(JITA);
    await expect(fetchRegionPrices(JITA)).rejects.toThrow(/incomplete sell order book \(page 1: .*EAI_AGAIN/);
  });
});

describe('runPreCompute during an outage', () => {
  it("keeps a failed hub's cached prices, profit rows and strategies, and refreshes the hubs that answered", async () => {
    const { dbRun, dbGet } = require('../../lib/db');
    const market = require('../../lib/market-cache');
    const { runPreCompute } = require('../../lib/precompute');

    // The last good run: Amarr and Dodixie rows, an Amarr strategy, and Amarr prices in the cache.
    const { lastID: lastRun } = await dbRun(
      `INSERT INTO precompute_runs (started_at, status) VALUES (datetime('now'), 'completed')`);
    const oldRow = `INSERT INTO precomputed_profits
      (blueprint_id, region_id, product_id, product_name, material_cost, sell_price, buy_price, profit, profit_margin,
       isk_per_hour, build_time, material_count, computed_at, price_source, activity_id, avg_30d_price, run_id)
      VALUES (?, ?, ?, 'Rifter', 6000, ?, 0, 1, 1, 1, 3600, 1, 'earlier', 'hub', 1, NULL, ?)`;
    await dbRun(oldRow, [RIFTER_BP, AMARR, RIFTER, 611_111, lastRun]);
    await dbRun(oldRow, [RIFTER_BP, DODIXIE, RIFTER, 622_222, lastRun]);
    await dbRun(`INSERT INTO precomputed_strategies (blueprint_id, sell_region_id, product_id, sell_price, computed_at, run_id)
      VALUES (?, ?, ?, 611111, 'earlier', ?)`, [RIFTER_BP, AMARR, RIFTER, lastRun]);
    const lastGoodAmarr = { [RIFTER]: { sell: 611_111, buy: 0, median: 611_111 } };
    market.setRegionPriceCache(AMARR, lastGoodAmarr);

    offline.add(AMARR);
    const result = await runPreCompute();
    expect(result.status).toBe('completed');

    const amarr = await dbGet('SELECT sell_price, run_id FROM precomputed_profits WHERE blueprint_id = ? AND region_id = ?',
      [RIFTER_BP, AMARR]);
    expect(amarr).toEqual({ sell_price: 611_111, run_id: lastRun });                       // kept, not wiped or zeroed
    expect(market.regionPriceCache.get(AMARR).prices).toBe(lastGoodAmarr);          // cache untouched

    const strategy = await dbGet('SELECT run_id FROM precomputed_strategies WHERE blueprint_id = ? AND sell_region_id = ?',
      [RIFTER_BP, AMARR]);
    expect(strategy).toEqual({ run_id: lastRun });

    const jita = await dbGet('SELECT sell_price, run_id FROM precomputed_profits WHERE blueprint_id = ? AND region_id = ?',
      [RIFTER_BP, JITA]);
    expect(jita.sell_price).toBe(500_000);
    expect(jita.run_id).not.toBe(lastRun);

    const dodixie = await dbGet('SELECT run_id FROM precomputed_profits WHERE blueprint_id = ? AND region_id = ?',
      [RIFTER_BP, DODIXIE]);
    expect(dodixie.run_id).toBe(jita.run_id);                                         // answered, so rewritten
  });
});
