'use strict';
// The item panel prices purchases in the browser with forge-v1/src/utils/hubSupply.ts, which must be the SAME
// algorithm as priceFromSupply in lib/hub-price.js (the server uses it for True Profit). This fuzzes both with
// 200k random supplies/quantities and fails on any difference.      node test-client-supply-parity.js
const fs = require('fs');
const path = require('path');
const ts = require(path.join(__dirname, '../forge-v1/node_modules/typescript'));
const HP = require('./lib/hub-price.js');

const src = fs.readFileSync(path.join(__dirname, '../forge-v1/src/utils/hubSupply.ts'), 'utf8');
const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', out)(mod, mod.exports);

let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const side = () => {
  if (rnd() < 0.2) return null;
  const n = 1 + Math.floor(rnd() * 5);
  let p = 1 + rnd() * 100, sum = 0;
  const levels = [];
  for (let i = 0; i < n; i++) {
    p *= 1 + rnd() * 0.3;
    const q = rnd() < 0.1 ? null : Math.floor(1 + rnd() * 500);
    levels.push([p, q]);
    sum += q === null ? Infinity : q;
  }
  const total = sum === Infinity ? null : sum + (rnd() < 0.3 ? Math.floor(rnd() * 400) : 0);
  return { levels, total };
};

let bad = 0;
const N = 200000;
for (let i = 0; i < N; i++) {
  const sup = { hub: side(), jita: side(), hubIsJita: rnd() < 0.15, history: rnd() < 0.3 ? rnd() * 50 : 0 };
  const q = Math.floor(rnd() * 3000) - 5 + (rnd() < 0.05 ? 1e9 : 0);
  const a = HP.priceFromSupply(sup, q), b = mod.exports.priceFromSupply(sup, q);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    bad++;
    if (bad < 4) console.log('MISMATCH', JSON.stringify(sup), q, JSON.stringify(a), JSON.stringify(b));
  }
}
console.log(`${N} random cases, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
