'use strict';
// Boots the REAL server.js in a throw-away copy with a seeded SQLite file and stubbed outside world.
// The live database is never touched: the server resolves its DB relative to its own directory, so the
// copy gets its own `forge-db/` next to it.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const universe = require('./universe.cjs');
const sqlite3 = require(path.join(SERVER_ROOT, 'node_modules', 'sqlite3'));

const COPIED = ['server.js', 'forge-security.js', 'package.json', 'lib', 'routes'];
const BOOT_TIMEOUT_MS = 60_000;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function seedDatabase(dbFile) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, (e) => (e ? rej(e) : res())));
    (async () => {
      for (const sql of universe.SEED_SQL) await run(sql);
      for (const [sql, params] of universe.seedRows()) await run(sql, params);
    })().then(() => db.close(() => resolve()), (e) => db.close(() => reject(e)));
  });
}

async function bootServer() {
  // Scratch space stays inside the project (git-ignored), never in the system temp folder.
  const base = path.join(SERVER_ROOT, '.tmp-test', `run-${process.pid}-${Date.now()}`);
  const appDir = path.join(base, 'server');
  fs.mkdirSync(path.join(base, 'forge-db'), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  for (const name of COPIED) fs.cpSync(path.join(SERVER_ROOT, name), path.join(appDir, name), { recursive: true });
  fs.symlinkSync(path.join(SERVER_ROOT, 'node_modules'), path.join(appDir, 'node_modules'), 'junction');

  const fixturesPath = path.join(base, 'fixtures.json');
  const callLog = path.join(base, 'calls.log');
  fs.writeFileSync(fixturesPath, JSON.stringify(universe.esiFixtures()));
  fs.writeFileSync(callLog, '');
  await seedDatabase(path.join(base, 'forge-db', 'forge.db'));

  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['-r', path.join(__dirname, 'preload.cjs'), 'server.js'], {
    cwd: appDir,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'test',
      FORGE_TEST_FIXTURES: fixturesPath, FORGE_TEST_CALL_LOG: callLog,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real', EVE_CLIENT_ID: 'test', EVE_CLIENT_SECRET: 'test',
    },
  });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const started = Date.now();
    child.once('exit', (code) => reject(new Error(`server exited during boot (code ${code})\n${output.slice(-3000)}`)));
    const poll = async () => {
      if (Date.now() - started > BOOT_TIMEOUT_MS) return reject(new Error(`server did not answer in time\n${output.slice(-3000)}`));
      try { await fetch(baseUrl + '/'); return resolve(); } catch (_) { setTimeout(poll, 500); }
    };
    poll();
  });

  return {
    baseUrl,
    callLogFile: callLog,
    output: () => output,
    async stop() {
      child.removeAllListeners('exit');
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* Windows may still hold the DB briefly */ }
    },
  };
}

module.exports = { bootServer };
