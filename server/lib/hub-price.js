'use strict';
/**
 * Hub price resolution — the one place that decides where a hub's price comes from.
 *
 * Rule: every hub uses ITS OWN orders. Only what the hub cannot supply is taken from Jita's
 * live sell orders, and it is always tagged so the UI can say "no/not enough stock here —
 * priced at Jita". Nothing is ever substituted silently.
 *
 * Price entries look like { sell, buy, median, sellScope?, buyScope?, avg30d? }.
 * sellScope: 'hub' | 'region' (the hub's own orders) | 'jita' (fallback) | undefined (none).
 */

const JITA_REGION_ID = 10000002;

// Overlay cache keyed by the hub's price object. Prices maps are replaced (never mutated)
// on every refresh, so identity is a safe cache key and old overlays are garbage collected.
const overlayCache = new WeakMap();

function hasSell(p) {
  return !!p && Number.isFinite(p.sell) && p.sell > 0;
}

/**
 * Returns hubPrices with Jita's live sell price filled in for every type the hub has no sell
 * order for. Entries the hub does price are returned untouched (same object). Never mutates
 * its inputs. For Jita itself (or when Jita prices are unavailable) returns hubPrices as is.
 *
 * Fallback entries keep the hub's own buy price (a buy order at the hub is still that hub's)
 * and take Jita's median, since the hub has no sell side to take a median from.
 */
function withJitaFallback(hubPrices, jitaPrices) {
  if (!hubPrices) return hubPrices;
  if (!jitaPrices || hubPrices === jitaPrices) return hubPrices;

  const cached = overlayCache.get(hubPrices);
  if (cached && cached.jita === jitaPrices) return cached.result;

  const result = {};
  for (const typeId of Object.keys(hubPrices)) {
    const hub = hubPrices[typeId];
    if (hasSell(hub)) { result[typeId] = hub; continue; }
    const j = jitaPrices[typeId];
    if (hasSell(j)) {
      result[typeId] = {
        ...hub,
        sell:      j.sell,
        median:    j.median ?? hub.median,
        sellScope: 'jita',
        jitaSell:  j.sell,
      };
    } else {
      result[typeId] = hub;
    }
  }
  // Types the hub has no entry for at all (never listed there) but Jita sells.
  for (const typeId of Object.keys(jitaPrices)) {
    if (result[typeId] !== undefined) continue;
    const j = jitaPrices[typeId];
    if (hasSell(j)) {
      result[typeId] = { sell: j.sell, buy: 0, median: j.median ?? j.sell, sellScope: 'jita', jitaSell: j.sell };
    }
  }
  overlayCache.set(hubPrices, { jita: jitaPrices, result });
  return result;
}

/** True when the price entry's sell side came from Jita because the hub had none. */
function isJitaFallback(entry) {
  return !!entry && entry.sellScope === 'jita';
}

// ════════════════════════════════════════════════════════════════════════════
// Order depth — how many units are actually for sale, and at what price.
// A price map only keeps each type's lowest price, which says nothing about whether the hub
// can supply the quantity a job needs. Depth keeps the cheapest sell levels per type.
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_LEVELS = 20;

/** Collects sell orders per type and keeps the cheapest `maxLevels` price levels + total units. */
function makeDepthAccumulator(maxLevels = DEFAULT_LEVELS) {
  const byType = new Map();   // typeId -> Map(price -> qty)
  const totals = new Map();   // typeId -> total qty across ALL levels
  return {
    add(typeId, price, qty) {
      if (!(price > 0) || !(qty > 0)) return;
      let m = byType.get(typeId);
      if (!m) { m = new Map(); byType.set(typeId, m); }
      m.set(price, (m.get(price) || 0) + qty);
      totals.set(typeId, (totals.get(typeId) || 0) + qty);
    },
    finish() {
      const out = new Map();
      for (const [typeId, m] of byType) {
        const levels = [...m.entries()].sort((a, b) => a[0] - b[0]).slice(0, maxLevels);
        out.set(typeId, { levels, total: totals.get(typeId) });
      }
      return out;
    },
  };
}

// Depth maps are attached to price maps without being part of them: price maps are sent to the
// browser as JSON, and depth must not be.
const depthByPrices = new WeakMap();
function attachDepth(prices, depthMap) { depthByPrices.set(prices, depthMap); return prices; }
function getDepth(prices) { return prices ? depthByPrices.get(prices) || null : null; }

/**
 * Depth for one type. If the price map has no depth at all (a cache from before depth existed),
 * a single unlimited level at the known lowest sell keeps the old "price x quantity" behaviour.
 * Returns null when the hub has no sell order for the type.
 */
function depthFor(prices, typeId) {
  const d = getDepth(prices);
  const real = d && d.get(Number(typeId));
  if (real) return real;
  const p = prices && prices[typeId];
  // A priced type with no depth entry (older cache, or orders missing a quantity): assume the lowest
  // sell is available in any quantity, i.e. the old price x quantity behaviour.
  if (hasSell(p)) return { levels: [[p.sell, Infinity]], total: Infinity, assumed: true };
  return null;
}

/** Buy `qty` units walking up the book. Returns units filled, their cost, and whether the cost
 *  is an approximation (units beyond the stored levels are priced at the last stored level). */
function walkDepth(depth, qty) {
  if (!depth || !(qty > 0)) return { filled: 0, cost: 0, approx: false, lastPrice: 0 };
  let remaining = qty, cost = 0, filled = 0, approx = false, seen = 0, lastPrice = 0;
  for (const [price, q] of depth.levels) {
    lastPrice = price;
    if (remaining <= 0) break;
    const take = Math.min(remaining, q);
    cost += take * price; filled += take; remaining -= take; seen += q;
  }
  if (remaining > 0 && depth.total > seen) {
    // more units exist than the stored levels show; price them at the last stored level
    const take = Math.min(remaining, depth.total - seen);
    cost += take * lastPrice; filled += take; remaining -= take; approx = true;
  }
  return { filled, cost, approx, lastPrice };
}

// A material's supply, in a form that is safe to send to the browser as JSON (an unlimited level
// is qty null). The browser walks it with the identical algorithm (forge-v1/src/utils/hubSupply.ts),
// so the item panel can price any quantity — runs, owned stock, shortfall — without another request.
function supplyOf(prices, typeId) {
  const d = depthFor(prices, typeId);
  if (!d) return null;
  return {
    levels: d.levels.map(([p, q]) => [p, Number.isFinite(q) ? q : null]),
    total:  Number.isFinite(d.total) ? d.total : null,
  };
}

function describeSupply({ hubPrices, jitaPrices, typeId, hubIsJita = false, history = 0 }) {
  return {
    hub:   supplyOf(hubPrices, typeId),
    jita:  hubIsJita ? null : supplyOf(jitaPrices, typeId),
    hubIsJita: !!hubIsJita,
    history: Number.isFinite(history) && history > 0 ? history : 0,   // last resort only (Jita 30-day average)
  };
}

function walkSupply(sup, qty) {
  if (!sup || !(qty > 0)) return { filled: 0, cost: 0, approx: false, lastPrice: 0 };
  return walkDepth({
    levels: sup.levels.map(([p, q]) => [p, q === null ? Infinity : q]),
    total:  sup.total === null ? Infinity : sup.total,
  }, qty);
}

/**
 * Price buying `qty` units from a supply description (see describeSupply):
 *   1. what the hub's own sell orders can supply, cheapest first;
 *   2. the remainder imported from Jita (its live sell orders, cheapest first);
 *   3. anything neither market shows is priced at the last visible price and flagged short;
 *   4. only when nobody lists the item at all, the Jita 30-day average (scope 'history').
 */
function priceFromSupply(sup, qty) {
  const need = Math.max(0, Math.floor(qty) || 0);
  const res = {
    qty: need, cost: 0, unit: 0,
    hubQty: 0, hubCost: 0, jitaQty: 0, jitaCost: 0, unfilledQty: 0, unfilledCost: 0,
    scope: 'none', approx: false, shortStock: false,
  };
  if (need === 0) { res.scope = 'hub'; return res; }

  const h = walkSupply(sup && sup.hub, need);
  res.hubQty = h.filled; res.hubCost = h.cost; res.approx = h.approx;
  let remaining = need - h.filled;
  let lastPrice = h.lastPrice;

  if (remaining > 0 && sup && !sup.hubIsJita) {
    const j = walkSupply(sup.jita, remaining);
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
  else res.scope = 'hub';      // for Jita itself a shortfall stays 'hub'; shortStock carries the warning
  res.unit = res.cost / need;
  return res;
}

/** priceFromSupply over the raw hub and Jita price maps (server side). */
function priceBuy({ hubPrices, jitaPrices, typeId, qty, hubIsJita = false, history = 0 }) {
  return priceFromSupply(describeSupply({ hubPrices, jitaPrices, typeId, hubIsJita, history }), qty);
}

module.exports = {
  JITA_REGION_ID, DEFAULT_LEVELS,
  hasSell, withJitaFallback, isJitaFallback,
  makeDepthAccumulator, attachDepth, getDepth, depthFor, walkDepth,
  supplyOf, describeSupply, priceFromSupply, priceBuy,
};
