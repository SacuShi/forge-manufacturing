// One request per route (plus a few error paths) for the route matrix. The matrix test calls each of these against the
// real server, with and without a login, and compares the status and the SHAPE of the answer (and, for the calculation
// routes marked `exact`, the values) with test/snapshots/route-matrix.json.
//
// To add a route: add a case here, then run `npm run test:update-matrix` and review the snapshot diff.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('../harness/universe.cjs');

export const ADMIN_KEY = 'test-admin-key';

const owned = [{
  item_id: 7001, type_id: U.BLUEPRINT, location_id: U.HUB_STATION, location_flag: 'Hangar', quantity: -1, runs: -1,
  material_efficiency: 10, time_efficiency: 20,
}];
const assets = [
  { item_id: 8001, type_id: U.TRIT, quantity: 5000, location_id: U.HUB_STATION, location_flag: 'Hangar', is_singleton: false },
  { item_id: 8002, type_id: U.PYER, quantity: 2000, location_id: U.HUB_STATION, location_flag: 'Hangar', is_singleton: false },
];
export const SESSION = { assets, blueprints: owned };

const REGION = U.JITA_REGION;
const ownedBlueprints = owned.map((b) => ({ ...b, type_id: b.type_id, typeId: b.type_id, me: 10, te: 20 }));

/**
 * route:  "METHOD /path/with/:params" exactly as registered (the test fails if a registered route has no case)
 * url:    the concrete URL to call
 * body:   JSON body for POST/PUT/DELETE
 * admin:  send the admin key header
 * exact:  also compare the values (volatile fields such as timestamps are masked), not just the shape
 * skip:   don't call it signed in (explained in the value); the route is still listed and still probed signed out
 * noProbe: don't call it at all
 */
export const CASES = [
  // --- public / infrastructure
  { route: 'GET /health', url: '/health' },
  { route: 'GET /api/jita-prices', url: '/api/jita-prices' },
  { route: 'GET /api/prices/:regionId', url: `/api/prices/${REGION}` },
  { route: 'GET /api/item-names', url: '/api/item-names' },
  { route: 'POST /api/resolve-type-names', url: '/api/resolve-type-names', body: { typeIds: [U.TRIT, U.PRODUCT, 999999999] }, exact: true },
  { route: 'GET /api/blueprint-database', url: '/api/blueprint-database' },
  { route: 'GET /api/system-search', url: '/api/system-search?q=jit', exact: true },
  { route: 'GET /api/industry-rigs', url: '/api/industry-rigs' },
  { route: 'GET /api/icon/:typeId', url: `/api/icon/${U.TRIT}`, skip: 'fetches the CCP image server (tests keep the real internet sealed)', noProbe: true },

  // --- login and remembered characters
  { route: 'POST /api/eve-token', url: '/api/eve-token', body: { code: 'abc', redirect_uri: 'http://localhost:5173/' } },
  { route: 'POST /api/eve-token', url: '/api/eve-token', body: {}, label: 'missing code' },
  { route: 'GET /api/remember/status', url: '/api/remember/status' },
  { route: 'POST /api/remember/status', url: '/api/remember/status', body: { enabled: true } },
  { route: 'GET /api/remember/list', url: '/api/remember/list' },
  { route: 'POST /api/remember/restore', url: '/api/remember/restore', body: { characterIds: [] } },
  { route: 'POST /api/remember/forget', url: '/api/remember/forget', body: { all: true } },

  // --- industry settings
  { route: 'GET /api/industry-settings', url: '/api/industry-settings' },
  { route: 'POST /api/industry-settings', url: '/api/industry-settings', body: { system_id: U.JITA_SYSTEM, system_name: 'Jita', structure_type_id: null, rig_ids: [], facility_tax: 0 } },
  { route: 'POST /api/industry-settings', url: '/api/industry-settings', body: { system_id: 5 }, label: 'invalid system' },
  { route: 'GET /api/structure-fit-suggestions', url: `/api/structure-fit-suggestions?system_id=${U.JITA_SYSTEM}&structure_type_id=35827` },
  { route: 'GET /api/job-cost-check', url: '/api/job-cost-check' },
  { route: 'GET /api/character-fee-rates', url: `/api/character-fee-rates?sellRegionId=${REGION}` },

  // --- session and snapshots
  { route: 'POST /api/session-data', url: '/api/session-data', body: { ...SESSION, skills: [], wallet: 1e9 } },
  { route: 'POST /api/session-data', url: '/api/session-data', body: {}, label: 'missing data' },
  { route: 'GET /api/session-data/:characterId', url: '/api/session-data/2002' },
  { route: 'GET /api/session-data/:characterId', url: '/api/session-data/3003', label: 'someone else' },
  { route: 'POST /api/skill-snapshot', url: '/api/skill-snapshot', body: { skills: [{ skill_id: 3380, active_skill_level: 5 }], standings: { factions: {}, corps: {} }, implants: [] } },
  { route: 'POST /api/warm-blueprint-icons', url: '/api/warm-blueprint-icons', body: { blueprints: owned } },

  // --- blueprints and profit
  { route: 'POST /api/true-cost', url: '/api/true-cost', body: { product_id: U.PRODUCT, me: 10, te: 20, runs: 1, regionId: REGION, materialRegionId: REGION }, exact: true },
  { route: 'POST /api/true-cost', url: '/api/true-cost', body: {}, label: 'missing product' },
  { route: 'POST /api/calculate-profitability', url: '/api/calculate-profitability', body: { ownedBlueprints, topN: 5, regionId: REGION } },
  { route: 'POST /api/production-chain', url: '/api/production-chain', body: { itemName: 'Test Frigate', ownedBlueprints } },
  { route: 'POST /api/material-breakdown', url: '/api/material-breakdown', body: { typeId: U.PRODUCT, regionId: REGION, ownedBlueprints } },
  { route: 'POST /api/me-research-roi', url: '/api/me-research-roi', body: { blueprints: ownedBlueprints, regionId: REGION, targetME: 10 } },
  { route: 'POST /api/get-price', url: `/api/get-price?regionId=${REGION}`, body: { typeId: U.PRODUCT } },
  { route: 'POST /api/get-blueprint', url: '/api/get-blueprint', body: { productId: U.PRODUCT } },
  { route: 'POST /api/item-details', url: '/api/item-details', body: { typeId: U.PRODUCT, assets, ownedBlueprints, regionId: REGION, materialRegionId: REGION } },
  { route: 'POST /api/analyze-blueprints', url: '/api/analyze-blueprints', body: { ownedBlueprints, assets, sortBy: 'profit', limit: 5 } },
  { route: 'GET /api/diagnose-t2/:characterId', url: '/api/diagnose-t2/2002' },
  { route: 'POST /api/blueprint-metadata', url: '/api/blueprint-metadata', body: { blueprintTypeIds: [U.BLUEPRINT] }, exact: true },
  { route: 'POST /api/blueprint-profits', url: '/api/blueprint-profits', body: { blueprintTypeIds: [U.BLUEPRINT], regionId: REGION, assets, walletISK: 1e9 } },
  { route: 'POST /api/material-stock-check', url: '/api/material-stock-check', body: { materials: [{ typeId: U.TRIT, quantity: 100 }], regionId: REGION, walletISK: 1e9 } },
  { route: 'POST /api/appraise', url: '/api/appraise', body: { items: [{ typeId: U.TRIT, qty: 10 }, { name: 'Test Frigate', qty: 1 }], regionId: REGION } },
  { route: 'POST /api/queue-planner', url: '/api/queue-planner', body: {} },

  // --- profit lists
  { route: 'GET /api/top-profitable', url: `/api/top-profitable?regionId=${REGION}&limit=5&minVolume=0&includeRisky=true` },
  { route: 'GET /api/top-profitable-by-skills', url: `/api/top-profitable-by-skills?regionId=${REGION}&limit=5&minVolume=0&includeRisky=true` },
  { route: 'GET /api/search-profitable', url: `/api/search-profitable?q=frigate&regionId=${REGION}&includeRisky=true` },
  { route: 'GET /api/inter-hub-arb', url: '/api/inter-hub-arb?buyHub=jita&sellHub=amarr&limit=5' },
  { route: 'GET /api/inter-hub-item-profitable', url: `/api/inter-hub-item-profitable?typeId=${U.PRODUCT}&regionId=${REGION}&breakEven=1000000` },
  { route: 'GET /api/inter-hub-haul', url: `/api/inter-hub-haul?typeId=${U.PRODUCT}&buyHub=jita&sellHub=amarr&collateral=0` },

  // --- trading
  { route: 'GET /api/trading/meta', url: '/api/trading/meta?hub=jita' },
  { route: 'GET /api/trading/jita', url: '/api/trading/jita?hub=jita' },
  { route: 'GET /api/trading/jita/:typeId', url: `/api/trading/jita/${U.PRODUCT}?hub=jita` },
  { route: 'POST /api/trading/scan', url: '/api/trading/scan', body: { hub: 'jita', minMarginPct: 3, minVolume: 0 } },
  { route: 'GET /api/trading/character-orders', url: '/api/trading/character-orders' },
  { route: 'GET /api/can-dock-keepstar', url: '/api/can-dock-keepstar' },

  // --- locations and structures
  { route: 'GET /api/location-names', url: `/api/location-names?ids=${U.HUB_STATION}` },
  { route: 'GET /api/find-structure', url: `/api/find-structure?typeId=${U.TRIT}` },
  { route: 'GET /api/asset-location', url: `/api/asset-location?typeId=${U.TRIT}` },
  { route: 'GET /api/resolve-structures', url: '/api/resolve-structures' },

  // --- ticker and chat
  { route: 'GET /api/ticker-config', url: '/api/ticker-config' },
  { route: 'POST /api/ticker-config', url: '/api/ticker-config', body: { pins: [], groups: [], activeGroupId: null, dualRow: false } },
  { route: 'POST /api/ticker-prices', url: '/api/ticker-prices', body: { items: [{ typeId: U.TRIT, regionId: REGION }] } },
  { route: 'POST /api/save-message', url: '/api/save-message', body: { role: 'user', content: 'matrix hello', conversationId: 'matrix' } },
  { route: 'GET /api/chat-history/:characterId', url: '/api/chat-history/2002' },
  { route: 'DELETE /api/chat-history/:characterId', url: '/api/chat-history/2002', method: 'DELETE' },
  { route: 'POST /api/ai-chat', url: '/api/ai-chat', body: { messages: [{ role: 'user', content: 'What should I build?' }] } },

  // --- PI, PI planner, LP store
  { route: 'GET /api/pi/colonies', url: '/api/pi/colonies' },
  { route: 'GET /api/pi/market', url: '/api/pi/market?pocoTaxRate=5' },
  { route: 'GET /api/pi-planner/regions', url: '/api/pi-planner/regions' },
  { route: 'GET /api/pi-planner/targets', url: '/api/pi-planner/targets' },
  { route: 'POST /api/pi-planner/plan', url: '/api/pi-planner/plan', body: {} },
  { route: 'GET /api/lp-balance', url: '/api/lp-balance' },
  { route: 'GET /api/lp-store/factions', url: '/api/lp-store/factions' },
  { route: 'GET /api/lp-store/corps', url: '/api/lp-store/corps?factionId=500001' },
  { route: 'GET /api/lp-store', url: '/api/lp-store?factionId=500001&corpId=1000001&limit=5' },

  // --- push
  { route: 'GET /api/push/vapid-public-key', url: '/api/push/vapid-public-key' },
  { route: 'POST /api/push/subscribe', url: '/api/push/subscribe', body: {} },
  { route: 'DELETE /api/push/unsubscribe', url: '/api/push/unsubscribe', method: 'DELETE', body: {} },
  { route: 'POST /api/push/sync-jobs', url: '/api/push/sync-jobs', body: { jobs: [] } },

  // --- corp
  { route: 'GET /api/corp/status', url: '/api/corp/status' },
  { route: 'POST /api/corp/setup', url: '/api/corp/setup', body: { code: 'abc', redirect_uri: 'http://localhost:5173/' } },
  { route: 'GET /api/corp/access-status', url: '/api/corp/access-status' },
  { route: 'GET /api/corp/access-debug', url: '/api/corp/access-debug' },
  { route: 'GET /api/corp/blueprints', url: '/api/corp/blueprints?limit=5' },
  { route: 'GET /api/corp/assets', url: '/api/corp/assets?limit=5' },
  { route: 'GET /api/corp/jobs', url: '/api/corp/jobs' },
  { route: 'POST /api/corp/refresh', url: '/api/corp/refresh', body: {} },
  { route: 'GET /api/corp/admin/whitelist', url: '/api/corp/admin/whitelist', admin: true },
  { route: 'POST /api/corp/admin/whitelist', url: '/api/corp/admin/whitelist', admin: true, body: { character_id: 9009, note: 'matrix' } },
  { route: 'DELETE /api/corp/admin/whitelist/:characterId', url: '/api/corp/admin/whitelist/9009', admin: true, method: 'DELETE' },
  { route: 'DELETE /api/corp/admin/config', url: '/api/corp/admin/config', admin: true, method: 'DELETE', skip: 'would wipe the corp configuration other cases read' },

  // --- admin and Keepstar set-up
  { route: 'POST /api/admin/precompute', url: '/api/admin/precompute', method: 'POST', admin: true, skip: 'starts the heavy pre-compute job' },
  { route: 'POST /api/admin/contract-ingest', url: '/api/admin/contract-ingest', admin: true, body: {}, skip: 'starts a contract download' },
  { route: 'GET /api/admin/precompute-status', url: '/api/admin/precompute-status', admin: true },
  { route: 'POST /api/admin/volume-enrichment', url: '/api/admin/volume-enrichment', method: 'POST', admin: true, skip: 'starts the volume enrichment job' },
  { route: 'GET /api/admin/ai-costs', url: '/api/admin/ai-costs', admin: true },
  { route: 'GET /api/ks-test-auth', url: `/api/ks-test-auth?key=${ADMIN_KEY}` },
  { route: 'GET /api/ks-test-callback', url: '/api/ks-test-callback?code=abc&state=bad' },

  // --- last: ends the session the other cases used
  { route: 'POST /api/invalidate-session', url: '/api/invalidate-session', body: {} },
];
