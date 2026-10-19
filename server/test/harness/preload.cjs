'use strict';
// Loaded with `node -r preload.cjs server.js` by the integration harness ONLY. It makes the real server
// testable without touching the outside world:
//   - node-fetch is replaced by a stub serving the ESI fixtures and a scripted Anthropic reply;
//   - the global fetch is sealed (anything unexpected is blocked and logged);
//   - forge-security's verifyEveToken is replaced so the character id comes from an `x-test-char` header;
//   - express-rate-limit is a pass-through (the matrix test makes hundreds of calls from one address);
//   - every route / middleware registration is written, in order, to FORGE_TEST_ROUTE_DUMP (route-table test).
const Module = require('module');
const fs = require('fs');

const FIXTURES_PATH = process.env.FORGE_TEST_FIXTURES;
const CALL_LOG = process.env.FORGE_TEST_CALL_LOG;
const fixtures = () => JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
const log = (line) => { try { fs.appendFileSync(CALL_LOG, line + '\n'); } catch (_) { /* log is best-effort */ } };

function resp(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Scripted Anthropic: a user message containing TOOLTEST asks for get_precomputed once, then answers. */
function anthropic(opts) {
  const body = JSON.parse(opts.body);
  log('ANTHROPIC ' + JSON.stringify({ model: body.model, messages: body.messages, tools: (body.tools || []).map((t) => t.name) }));
  const last = body.messages[body.messages.length - 1];
  const hasToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
  const asksForTool = typeof last.content === 'string' && last.content.includes('TOOLTEST');
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (typeof last.content === 'string' && last.content.includes('APIERRTEST')) {
    return resp({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 400);
  }
  if (asksForTool) {
    return resp({
      id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'tool_use', usage,
      content: [{ type: 'tool_use', id: 'toolu_test', name: 'get_precomputed', input: { limit: 3, regionId: 10000002 } }],
    });
  }
  return resp({ id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn', usage,
    content: [{ type: 'text', text: hasToolResult ? 'Here is what I found.' : 'Hello from the stub.' }] });
}

async function fakeFetch(url, opts = {}) {
  const u = String(url);
  log(`${opts.method || 'GET'} ${u}`);
  if (u.includes('api.anthropic.com/v1/messages')) return anthropic(opts);
  const f = fixtures();
  let m;
  if (u.includes('/markets/prices/')) return resp(f.pricesList);
  if (u.includes('/industry/systems/')) return resp(f.industrySystems);
  if (u.includes('/universe/names/')) {
    const ids = JSON.parse(opts.body || '[]');
    return resp(ids.filter((id) => f.systemNames[id]).map((id) => ({ category: 'solar_system', id, name: f.systemNames[id] })));
  }
  if ((m = u.match(/\/markets\/(\d+)\/orders\/\?(.*)$/))) {
    const q = new URLSearchParams(m[2]);
    if (Number(q.get('page') || 1) > 1) return resp([], 200, { 'x-pages': '1' });
    let orders = (f.orders[m[1]] || []).filter((o) => (q.get('order_type') === 'buy') === !!o.is_buy_order);
    if (q.get('type_id')) orders = orders.filter((o) => String(o.type_id) === q.get('type_id'));
    return resp(orders, 200, { 'x-pages': '1' });
  }
  if ((m = u.match(/\/route\/(\d+)\/(\d+)\//))) return routeResp(m[1], m[2]);
  return resp({ error: 'not in test fixtures' }, 404);
}
// Deterministic jump counts so freight maths can be asserted.
function routeResp(a, b) {
  const jumps = ((+a + +b) % 13) + 2;
  return resp(Array.from({ length: jumps + 1 }, (_, i) => i));
}
fakeFetch.default = fakeFetch;

// Records each registration as it happens: { kind, method, path, handlers } per line. Express 4 routes all end up
// in Route.prototype[method] (app.get and router.get both go through it) and layers in Router.use.
const ROUTE_DUMP = process.env.FORGE_TEST_ROUTE_DUMP;
const handlerName = (fn) => (typeof fn === 'function' ? fn.name || '<anonymous>' : '<?>');
function recordRoutes(express) {
  if (!ROUTE_DUMP || express.__routesRecorded) return;
  express.__routesRecorded = true;
  const note = (entry) => { try { fs.appendFileSync(ROUTE_DUMP, JSON.stringify(entry) + '\n'); } catch (_) { /* best-effort */ } };
  const Route = require('express/lib/router/route');
  for (const method of require('methods')) {
    const original = Route.prototype[method];
    Route.prototype[method] = function recordedRoute(...handlers) {
      note({ kind: 'route', method: method.toUpperCase(), path: String(this.path), handlers: handlers.flat(Infinity).map(handlerName) });
      return original.apply(this, handlers);
    };
  }
  const originalUse = express.Router.use;
  express.Router.use = function recordedUse(...args) {
    const hasPath = typeof args[0] !== 'function' && !Array.isArray(args[0]);
    note({ kind: 'use', path: hasPath ? String(args[0]) : '(all)', handlers: args.slice(hasPath ? 1 : 0).flat(Infinity).map(handlerName) });
    return originalUse.apply(this, args);
  };
}

const passThroughLimiter = () => (req, res, next) => next();

const realLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === 'node-fetch') return fakeFetch;
  // The route-matrix test calls every route within seconds, far past what the limiters allow a real client.
  if (request === 'express-rate-limit') return Object.assign(passThroughLimiter, { rateLimit: passThroughLimiter, default: passThroughLimiter });
  const exported = realLoad.apply(this, arguments);
  if (request === 'express') recordRoutes(exported);
  if (request === './forge-security' && exported && !exported.__testPatched) {
    exported.verifyEveToken = (req, res, next) => {
      const cid = Number(req.headers['x-test-char']);
      if (!cid) return res.status(401).json({ error: 'x-test-char header required' });
      req.characterId = cid;
      req.eveCharacter = { characterId: cid, characterName: 'Test ' + cid };
      req._evePayload = { sub: `CHARACTER:EVE:${cid}` };
      next();
    };
    exported.__testPatched = true;
  }
  return exported;
};

global.fetch = async function sealedFetch(url, opts) {
  const u = String(url);
  const m = u.match(/\/route\/(\d+)\/(\d+)\//);
  if (m) { log('ROUTE ' + m[1] + ' ' + m[2]); return routeResp(m[1], m[2]); }
  log('BLOCKED-GLOBAL-FETCH ' + u);
  return resp({ error: 'blocked in tests' }, 404);
};
