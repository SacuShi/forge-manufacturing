/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { priceFromSupply as clientPrice, type MaterialSupply, type SupplySide } from '../hubSupply';

// The item panel prices purchases in the browser with hubSupply.ts, which must be the SAME algorithm as
// priceFromSupply in server/lib/hub-price.js (the server uses it for True Profit). This fuzzes both with 200,000
// random supplies and quantities and fails on any difference.
const require = createRequire(import.meta.url);
const server = require('../../../../server/lib/hub-price.js') as { priceFromSupply: typeof clientPrice };

describe('client and server pricing agree', () => {
  it('on 200,000 random supplies and quantities', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const side = (): SupplySide | null => {
      if (rnd() < 0.2) return null;
      const n = 1 + Math.floor(rnd() * 5);
      let price = 1 + rnd() * 100, sum = 0;
      const levels: [number, number | null][] = [];
      for (let i = 0; i < n; i++) {
        price *= 1 + rnd() * 0.3;
        const qty = rnd() < 0.1 ? null : Math.floor(1 + rnd() * 500);
        levels.push([price, qty]);
        sum += qty === null ? Infinity : qty;
      }
      const total = sum === Infinity ? null : sum + (rnd() < 0.3 ? Math.floor(rnd() * 400) : 0);
      return { levels, total };
    };

    const mismatches: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      const supply: MaterialSupply = { hub: side(), jita: side(), hubIsJita: rnd() < 0.15, history: rnd() < 0.3 ? rnd() * 50 : 0 };
      const qty = Math.floor(rnd() * 3000) - 5 + (rnd() < 0.05 ? 1e9 : 0);
      const a = JSON.stringify(server.priceFromSupply(supply, qty));
      const b = JSON.stringify(clientPrice(supply, qty));
      if (a !== b && mismatches.length < 3) mismatches.push(`${JSON.stringify(supply)} qty=${qty}\n server ${a}\n client ${b}`);
    }
    expect(mismatches).toEqual([]);
  });
});
