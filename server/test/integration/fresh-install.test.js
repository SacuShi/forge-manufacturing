import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import request from 'supertest';

const require = createRequire(import.meta.url);
const { bootServer } = require('../harness/boot.cjs');
const sqlite3 = require('sqlite3');

// A brand-new install (for example an empty Docker volume) has no tables at all. The server must create what it
// needs to start, instead of stopping with "no such table: items".
describe('first start on an empty database', () => {
  let server;
  beforeAll(async () => { server = await bootServer({ seed: false }); });
  afterAll(async () => { if (server) await server.stop(); });

  it('boots and reports healthy', async () => {
    const res = await request(server.baseUrl).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('logs no failed migration and no start-up failure', () => {
    const out = server.output();
    expect(out).not.toMatch(/Failed to start server/);
    expect(out).not.toMatch(/migration: .* failed/);
    expect(out).not.toMatch(/no such table/);
  });

  it('created the core tables with every column the code reads', async () => {
    const db = new sqlite3.Database(server.dbFile, sqlite3.OPEN_READONLY);
    const columns = (table) => new Promise((res, rej) => db.all(`PRAGMA table_info(${table})`, (e, rows) => (e ? rej(e) : res(rows.map((r) => r.name)))));
    const items = await columns('items');
    const blueprints = await columns('blueprints');
    const materials = await columns('blueprint_materials');
    await new Promise((r) => db.close(r));
    expect(items).toEqual(expect.arrayContaining(['type_id', 'name', 'description', 'icon_url', 'volume', 'mass', 'meta_level', 'packaged_volume', 'pi_tier', 'group_id', 'category_name']));
    expect(blueprints).toEqual(expect.arrayContaining(['blueprint_id', 'product_id', 'product_quantity', 'build_time', 'activity_id', 'research_time']));
    expect(materials).toEqual(expect.arrayContaining(['blueprint_id', 'material_id', 'quantity']));
  });
});
