// Smoke test for lib/ai-tools.js: every tool must run to completion against stub dependencies without a
// ReferenceError (a missing injected dependency is swallowed by the tool's try/catch and only shows as
// "x is not defined" in the result). Run: node test-ai-tools.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createAiTools } = require('./lib/ai-tools');

const names = [...fs.readFileSync(path.join(__dirname, 'lib/ai-tools.js'), 'utf8').matchAll(/case ["']([a-z_]+)["']:/g)].map((m) => m[1]);
assert.ok(names.length >= 10, 'found the tool cases (' + names.length + ')');

const deps = {
  CORP_BP_USABLE_SQL: '1=1', PORT: 0, REGIONS: { 10000002: { hub: 'Jita' } }, VALID_REGIONS: [10000002],
  dbAll: async () => [], dbGet: async () => undefined,
  ensureCorpDataFresh: async () => {}, esiFetch: async () => ({ ok: true, status: 200, json: async () => [] }),
  fetch: async () => ({ ok: true, json: async () => ({}) }), getItemPricesAllRegions: async () => ({}),
  hubBooks: {}, resolveViewerCorpAccess: async () => ({ allowed: false }), security: {},
};
const { executeAiTool } = createAiTools(deps);

(async () => {
  const bad = [];
  for (const name of [...new Set(names)]) {
    for (const input of [{}, { search: 'rifter', regionId: 10000002, groupByHub: true, limit: 3, query: 'tritanium', itemName: 'Tritanium' }]) {
      const r = await executeAiTool({ name, input }, { characterId: 1, req: { eveAuth: {}, headers: {} }, jobs: [], blueprints: [], assets: [] });
      const msg = JSON.stringify(r);
      if (/is not defined|is not a function|Cannot read prop/.test(msg)) bad.push(name + ' ' + JSON.stringify(input).slice(0, 40) + ' -> ' + msg.slice(0, 160));
    }
  }
  const unknown = await executeAiTool({ name: 'definitely_not_a_tool', input: {} }, { characterId: 1, req: {}, jobs: [], blueprints: [], assets: [] });
  assert.ok(/Unknown tool/.test(unknown.error));
  if (bad.length) { console.error('FAILED:\n' + bad.join('\n')); process.exit(1); }
  console.log('ai-tools: ' + new Set(names).size + ' tools ran clean against stubs');
})();
