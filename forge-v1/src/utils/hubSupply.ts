/**
 * Prices a purchase of any quantity from a material's supply — a client copy of the algorithm in
 * server/lib/hub-price.js (priceFromSupply). It MUST stay identical to the server's so the item
 * panel's line costs, shortfall and "to buy" figure agree with True Profit.
 *
 * Rules (never silent — `scope` says which applied):
 *   1. buy what the hub's own sell orders can supply, cheapest first;
 *   2. the remainder is imported from Jita (its live sell orders, cheapest first);
 *   3. anything neither market shows is priced at the last visible price and flagged short;
 *   4. only when nobody lists the item at all, the Jita 30-day average (scope 'history').
 */

export interface SupplySide {
  /** [price, quantity] cheapest first. A quantity of null means "unlimited at this price". */
  levels: [number, number | null][];
  /** total units for sale across ALL levels (null = unlimited / unknown). */
  total: number | null;
}

export interface MaterialSupply {
  hub: SupplySide | null;
  jita: SupplySide | null;
  hubIsJita: boolean;
  history: number;
}

export type PurchaseScope = 'hub' | 'mixed' | 'jita' | 'history' | 'none';

export interface Purchase {
  qty: number;
  cost: number;
  unit: number;
  hubQty: number;
  hubCost: number;
  jitaQty: number;
  jitaCost: number;
  unfilledQty: number;
  unfilledCost: number;
  scope: PurchaseScope;
  approx: boolean;
  shortStock: boolean;
}

interface Walk { filled: number; cost: number; approx: boolean; lastPrice: number }

function walkSide(side: SupplySide | null, qty: number): Walk {
  if (!side || !(qty > 0)) return { filled: 0, cost: 0, approx: false, lastPrice: 0 };
  let remaining = qty, cost = 0, filled = 0, approx = false, seen = 0, lastPrice = 0;
  for (const [price, q] of side.levels) {
    const lvlQty = q === null ? Infinity : q;
    lastPrice = price;
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvlQty);
    cost += take * price; filled += take; remaining -= take; seen += lvlQty;
  }
  const total = side.total === null ? Infinity : side.total;
  if (remaining > 0 && total > seen) {
    // more units exist than the stored levels show; price them at the last stored level
    const take = Math.min(remaining, total - seen);
    cost += take * lastPrice; filled += take; remaining -= take; approx = true;
  }
  return { filled, cost, approx, lastPrice };
}

export function priceFromSupply(sup: MaterialSupply | null | undefined, qty: number): Purchase {
  const need = Math.max(0, Math.floor(qty) || 0);
  const res: Purchase = {
    qty: need, cost: 0, unit: 0,
    hubQty: 0, hubCost: 0, jitaQty: 0, jitaCost: 0, unfilledQty: 0, unfilledCost: 0,
    scope: 'none', approx: false, shortStock: false,
  };
  if (need === 0) { res.scope = 'hub'; return res; }

  const h = walkSide(sup ? sup.hub : null, need);
  res.hubQty = h.filled; res.hubCost = h.cost; res.approx = h.approx;
  let remaining = need - h.filled;
  let lastPrice = h.lastPrice;

  if (remaining > 0 && sup && !sup.hubIsJita) {
    const j = walkSide(sup.jita, remaining);
    res.jitaQty = j.filled; res.jitaCost = j.cost; res.approx = res.approx || j.approx;
    remaining -= j.filled;
    if (j.lastPrice > 0) lastPrice = j.lastPrice;
  }
  if (remaining > 0 && lastPrice > 0) {
    res.unfilledQty = remaining; res.unfilledCost = remaining * lastPrice; res.shortStock = true;
  }
  res.cost = res.hubCost + res.jitaCost + res.unfilledCost;

  const external = res.jitaQty + res.unfilledQty;
  const hubIsJita = !!(sup && sup.hubIsJita);
  if (res.cost === 0) {
    if (sup && sup.history > 0) {
      res.cost = sup.history * need; res.unfilledCost = 0; res.scope = 'history';
    } else {
      res.scope = 'none';
    }
  } else if (res.hubQty === 0 && external > 0 && !hubIsJita) res.scope = 'jita';
  else if (res.hubQty > 0 && external > 0 && !hubIsJita) res.scope = 'mixed';
  else res.scope = 'hub';
  res.unit = res.cost / need;
  return res;
}
