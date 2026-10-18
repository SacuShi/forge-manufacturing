// Characterisation tests for the whole HTTP surface. They exist so that moving code out of server.js can be checked
// mechanically: the route table (which routes exist, in what order, behind how many middleware) and the answer to every
// route (status and shape; values too for the calculation routes) must come out identical before and after.
//
// The expected results live in test/snapshots/. After an INTENDED change, run `npm run test:update-snapshots` and
// review the diff of those files like any other code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import request from 'supertest';
import { CASES, SESSION, ADMIN_KEY } from './route-matrix.cases.js';

const { bootServer } = createRequire(import.meta.url)('../harness/boot.cjs');

const PILOT = 2002;
const snapshot = (name) => `../snapshots/${name}`; // relative to this file

// This file runs against its OWN server: it waits for the background jobs to finish, which changes what the profit
// lists hold, and the other integration tests (which share the global server) must not see that.
let server;
beforeAll(async () => { server = await bootServer(); }, 120_000);
afterAll(async () => { await server?.stop(); });

const asPilot = (method, url, body) => {
  const r = request(server.baseUrl)[method](url).set('x-test-char', String(PILOT)).set('Authorization', 'Bearer test');
  return body === undefined ? r : r.send(body);
};
const until = async (call, ok, tries = 40) => {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await call();
    if (ok(res)) return res;
    await new Promise((r) => setTimeout(r, 500));
  }
  return res;
};

// ---------------------------------------------------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------------------------------------------------
const registrations = () => fs.readFileSync(server.routeDumpFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const routeKey = (r) => `${r.method} ${r.path}`;

/** Does registered pattern `a` (with :params) match the literal-ish path `b`? Used to find routes whose order matters. */
function overlaps(a, b) {
  if (a === b) return false;
  const re = new RegExp('^' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+') + '$');
  return re.test(b.replace(/:\w+/g, 'x'));
}

function describeTable(list) {
  const routes = list.filter((r) => r.kind === 'route');
  const layers = list.filter((r) => r.kind === 'use' && r.handlers.join() !== 'router');
  const routesBefore = (index) => list.slice(0, index).filter((r) => r.kind === 'route').map(routeKey).sort();
  const orderMatters = [];
  routes.forEach((a, i) => routes.slice(i + 1).forEach((b) => {
    if (a.method === b.method && (overlaps(a.path, b.path) || overlaps(b.path, a.path))) orderMatters.push(`${routeKey(a)}  BEFORE  ${routeKey(b)}`);
  }));
  return {
    // every route with the number of handlers behind it (security middleware, limiter, the handler itself)
    routes: routes.map((r) => `${routeKey(r)}  [${r.handlers.length} handlers]`).sort(),
    // global middleware, in order, with the routes that were registered before each (they do not cover those)
    middleware: layers.map((l) => ({ use: `${l.path} ${l.handlers.join(',')}`, routesBefore: routesBefore(list.indexOf(l)).length })),
    orderMatters,
  };
}

describe('route table', () => {
  it('lists the same routes, middleware and ordering constraints as before', async () => {
    await expect(JSON.stringify(describeTable(registrations()), null, 2) + '\n').toMatchFileSnapshot(snapshot('route-table.json'));
  });

  it('has a matrix case for every registered route, and no case for a route that does not exist', () => {
    const registered = new Set(registrations().filter((r) => r.kind === 'route').map((r) => routeKey(r)));
    const covered = new Set(CASES.map((c) => c.route));
    expect([...registered].filter((r) => !covered.has(r)).sort()).toEqual([]);
    expect([...covered].filter((r) => !registered.has(r)).sort()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Response matrix
// ---------------------------------------------------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const VOLATILE_KEYS = new Set(['cachedAt', 'generatedAt', 'fetchedAt', 'timestamp', 'uptime', 'updatedAt', 'updated_at', 'lastUpdated']);

/** Structure of a JSON value without its data: object keys, array element kinds and primitive types. */
function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return 'array(empty)';
    const kinds = [...new Set(v.slice(0, 5).map((x) => JSON.stringify(shapeOf(x, depth + 1))))].sort();
    return { array: kinds.map((k) => JSON.parse(k)) };
  }
  if (typeof v === 'object') {
    if (depth > 8) return 'object(deep)';
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shapeOf(v[k], depth + 1)]));
  }
  return typeof v;
}

/** The values, with fields that legitimately differ between runs masked. */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, VOLATILE_KEYS.has(k) ? '<varies>' : stable(v[k])]));
  if (typeof v === 'string' && ISO.test(v)) return '<date>';
  return v;
}

function summarise(res, exact) {
  const type = (res.headers['content-type'] || '').split(';')[0] || '(none)';
  const out = { status: res.status, type };
  if (type.includes('json')) {
    out.shape = shapeOf(res.body);
    if (exact) out.values = stable(res.body);
  } else {
    out.length = res.text ? (res.text.length > 0 ? 'text' : 'empty') : 'empty';
  }
  return out;
}

async function call(c, { authed }) {
  const method = (c.method || (c.body !== undefined ? 'POST' : 'GET')).toLowerCase();
  let r = request(server.baseUrl)[method](c.url);
  if (authed) r = r.set('x-test-char', String(PILOT)).set('Authorization', 'Bearer test');
  if (c.admin && authed) r = r.set('x-admin-key', ADMIN_KEY);
  if (c.body !== undefined) r = r.send(c.body);
  return r;
}

describe('response matrix', () => {
  const results = {};

  beforeAll(async () => {
    // Sign in the way the browser does: industry settings, then the session data.
    const settings = await asPilot('post', '/api/industry-settings', { system_id: 30000142, system_name: 'Jita', structure_type_id: null, rig_ids: [], facility_tax: 0 });
    expect(settings.status).toBe(200);
    const session = await asPilot('post', '/api/session-data', { ...SESSION, skills: [], wallet: 1e9 });
    expect(session.status).toBe(200);
    // The price caches fill in the background (the server answers "prices_warm: false" until they have).
    await until(
      () => asPilot('post', '/api/true-cost', { product_id: 900001, me: 10, te: 20, runs: 1, regionId: 10000002, materialRegionId: 10000002 }),
      (res) => res.status === 200 && res.body.prices_warm !== false,
    );
    // Background jobs (pre-compute, then volume enrichment) change what the profit lists contain while they run, so
    // wait until both have finished and stayed finished.
    let quiet = 0;
    for (let i = 0; i < 240 && quiet < 6; i++) {
      const { body } = await request(server.baseUrl).get('/health');
      const done = body.precompute?.lastRun && !body.precompute.isRunning && !body.volumeEnrichment?.isRunning && body.volumeEnrichment?.total > 0;
      quiet = done ? quiet + 1 : 0;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(quiet, 'background jobs never settled').toBeGreaterThanOrEqual(6);
  }, 240_000);

  it('answers every route, signed in and signed out, as it did before', async () => {
    for (const c of CASES) {
      const key = c.label ? `${c.route}  (${c.label})` : c.route;
      const entry = {};
      if (c.noProbe) { results[key] = { skipped: c.skip }; continue; }
      if (c.skip) entry.signedIn = { skipped: c.skip };
      else entry.signedIn = summarise(await call(c, { authed: true }), c.exact);
      entry.signedOut = summarise(await call(c, { authed: false }), false);
      results[key] = entry;
    }
    await expect(JSON.stringify(results, null, 1) + '\n').toMatchFileSnapshot(snapshot('route-matrix.json'));
  }, 300_000);
});
