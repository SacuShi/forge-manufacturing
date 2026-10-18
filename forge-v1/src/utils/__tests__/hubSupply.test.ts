import { describe, it, expect } from 'vitest';
import { priceFromSupply, type MaterialSupply } from '../hubSupply';

const supply = (over: Partial<MaterialSupply>): MaterialSupply => ({ hub: null, jita: null, hubIsJita: false, history: 0, ...over });

describe('priceFromSupply', () => {
  it('buys cheapest orders first at the hub', () => {
    const p = priceFromSupply(supply({ hub: { levels: [[10, 5], [12, 10]], total: 15 } }), 8);
    expect(p.cost).toBe(5 * 10 + 3 * 12);
    expect(p).toMatchObject({ scope: 'hub', hubQty: 8, jitaQty: 0, shortStock: false });
  });

  it('takes the remainder from Jita when the hub runs out, and says so', () => {
    const p = priceFromSupply(supply({ hub: { levels: [[10, 5]], total: 5 }, jita: { levels: [[8, 100]], total: 100 } }), 8);
    expect(p).toMatchObject({ scope: 'mixed', hubQty: 5, jitaQty: 3, cost: 5 * 10 + 3 * 8 });
  });

  it('prices everything at Jita when the hub has none for sale', () => {
    const p = priceFromSupply(supply({ jita: { levels: [[8, 100]], total: 100 } }), 10);
    expect(p).toMatchObject({ scope: 'jita', hubQty: 0, jitaQty: 10, cost: 80 });
  });

  it('never double-counts Jita when the hub IS Jita', () => {
    const p = priceFromSupply(supply({ hubIsJita: true, hub: { levels: [[8, 5]], total: 5 }, jita: { levels: [[8, 5]], total: 5 } }), 8);
    expect(p.scope).toBe('hub');
    expect(p.jitaQty).toBe(0);
    expect(p.shortStock).toBe(true); // only 5 exist: the other 3 are priced at the last price and flagged
    expect(p.unfilledQty).toBe(3);
  });

  it('flags a shortfall neither market can fill, priced at the last visible price', () => {
    const p = priceFromSupply(supply({ hub: { levels: [[10, 2]], total: 2 }, jita: { levels: [[9, 2]], total: 2 } }), 10);
    expect(p).toMatchObject({ shortStock: true, unfilledQty: 6, unfilledCost: 6 * 9 });
  });

  it('falls back to the 30-day average only when nobody lists the item', () => {
    expect(priceFromSupply(supply({ history: 5 }), 4)).toMatchObject({ scope: 'history', cost: 20 });
    expect(priceFromSupply(supply({}), 4)).toMatchObject({ scope: 'none', cost: 0 });
  });

  it('is free to buy nothing', () => {
    expect(priceFromSupply(null, 0)).toMatchObject({ qty: 0, cost: 0, scope: 'hub' });
  });
});
