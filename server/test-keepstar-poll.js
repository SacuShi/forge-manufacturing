// test-keepstar-poll.js
// ────────────────────────────────────────────────────────────────────────────
// Proves that server-side autonomous Keepstar polling works end-to-end.
//
// SAFE — uses test_structure_token and structure_market_history_test tables
// in forge.db. Does NOT touch any live data or running server logic.
//
// ── One-time setup (do this once, in your browser) ──────────────────────────
// 1. Register this redirect URI in the EVE developer portal:
//      https://forge-ukc.com/api/ks-test-callback
// 2. Deploy the updated server.js and restart PM2.
// 3. Open in your browser (replace YOUR_ADMIN_KEY):
//      https://forge-ukc.com/api/ks-test-auth?key=YOUR_ADMIN_KEY
// 4. Authorise with a character that has C-J6MT docking access.
// 5. You'll see a green success page — the refresh token is now stored.
//
// ── Every run after setup ───────────────────────────────────────────────────
//   node test-keepstar-poll.js
// No browser needed. Decrypts stored token → refreshes autonomously →
// fetches orders → writes daily snapshot → proves the full loop.
// ────────────────────────────────────────────────────────────────────────────

'use strict';

const path   = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const EVE_CLIENT_ID     = process.env.EVE_CLIENT_ID;
const EVE_CLIENT_SECRET = process.env.EVE_CLIENT_SECRET;
const FORGE_CORP_KEY    = process.env.FORGE_CORP_KEY;
const DB_PATH           = process.env.DB_PATH || path.join(__dirname, '..', 'forge-db', 'forge.db');

function die(msg) { console.error('\n✗ ' + msg); process.exit(1); }

if (!EVE_CLIENT_ID || !EVE_CLIENT_SECRET) die('EVE_CLIENT_ID or EVE_CLIENT_SECRET missing from .env');
if (!FORGE_CORP_KEY)                       die('FORGE_CORP_KEY missing from .env');

// ── Encryption (identical to server.js) ─────────────────────────────────────

const ENCRYPTION_KEY = crypto.createHash('sha256').update(FORGE_CORP_KEY.trim()).digest();

function decryptToken(ciphertext, ivHex, tagHex) {
  const dec = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
  dec.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([dec.update(Buffer.from(ciphertext, 'base64')), dec.final()]).toString('utf8');
}

function encryptToken(plaintext) {
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: enc.toString('base64'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

// ── SQLite (same library as server.js) ───────────────────────────────────────

const sqlite3 = require('sqlite3').verbose();
let db;

function dbRun(sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, err => err ? rej(err) : res()));
}
function dbGet(sql, params = []) {
  return new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
}
function dbAll(sql, params = []) {
  return new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
}

async function initDb() {
  await new Promise((res, rej) => {
    db = new sqlite3.Database(DB_PATH, err => err ? rej(err) : res());
  });
  // Test history table — separate from any live tables
  await dbRun(`
    CREATE TABLE IF NOT EXISTS structure_market_history_test (
      structure_id INTEGER NOT NULL,
      type_id      INTEGER NOT NULL,
      date         TEXT    NOT NULL,
      avg_sell     REAL,
      min_sell     REAL,
      max_sell     REAL,
      order_count  INTEGER,
      PRIMARY KEY (structure_id, type_id, date)
    )
  `);
}

// ── Constants ────────────────────────────────────────────────────────────────

const KEEPSTAR_STRUCTURE_ID = 1049588174021;
const fetch                 = require('node-fetch');

function authHeader() {
  return 'Basic ' + Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString('base64');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  FORGE — Keepstar Autonomous Polling Test            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  await initDb();

  // ── 1. Load stored refresh token ─────────────────────────────────────────

  console.log('── Step 1: Load stored refresh token ────────────────────────────');
  const row = await dbGet(
    'SELECT * FROM test_structure_token WHERE structure_id = ?',
    [KEEPSTAR_STRUCTURE_ID]
  );

  if (!row) {
    console.error('✗ No token found in test_structure_token table.');
    console.error('\nComplete one-time setup first:');
    console.error('  1. Register https://forge-ukc.com/api/ks-test-callback in EVE developer portal');
    console.error('  2. Deploy updated server.js and restart PM2');
    console.error('  3. Open in browser: https://forge-ukc.com/api/ks-test-auth?key=YOUR_ADMIN_KEY');
    console.error('  4. Authorise with a character that has C-J6MT docking access');
    console.error('  5. Re-run this script\n');
    process.exit(1);
  }

  let refreshToken;
  try {
    refreshToken = decryptToken(row.enc_refresh_token, row.token_iv, row.token_tag);
    console.log(`✓ Decrypted stored refresh token (stored at: ${row.stored_at})`);
  } catch (err) {
    die('Decrypt failed — wrong FORGE_CORP_KEY? ' + err.message);
  }

  // ── 2. Autonomous token refresh ──────────────────────────────────────────

  console.log('\n── Step 2: Autonomous token refresh (no browser, no user) ──────');
  const refreshRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
    method:  'POST',
    headers: {
      'Authorization': authHeader(),
      'Content-Type':  'application/x-www-form-urlencoded',
      'Host':          'login.eveonline.com',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || !refreshData.access_token) {
    console.error('EVE response:', JSON.stringify(refreshData, null, 2));
    die(`Token refresh failed (${refreshRes.status}) — token may have been revoked`);
  }

  const accessToken = refreshData.access_token;
  console.log('✓ Got fresh access token — no user interaction required');

  // Store rotated refresh token if EVE issued a new one
  if (refreshData.refresh_token && refreshData.refresh_token !== refreshToken) {
    const enc = encryptToken(refreshData.refresh_token);
    await dbRun(
      `UPDATE test_structure_token
          SET enc_refresh_token = ?, token_iv = ?, token_tag = ?, stored_at = datetime('now')
        WHERE structure_id = ?`,
      [enc.ciphertext, enc.iv, enc.tag, KEEPSTAR_STRUCTURE_ID]
    );
    console.log('✓ Stored rotated refresh token');
  }

  // ── 3. Fetch Keepstar orders ──────────────────────────────────────────────

  console.log('\n── Step 3: Fetch C-J6MT Keepstar orders ─────────────────────────');

  let page = 1, allOrders = [];
  while (true) {
    const res = await fetch(
      `https://esi.evetech.net/latest/markets/structures/${KEEPSTAR_STRUCTURE_ID}/?` +
      `page=${page}&datasource=tranquility`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    if (res.status === 403) die('403 Forbidden — character may not have docking access to the Keepstar');
    if (res.status === 401) die('401 Unauthorized — token was rejected by ESI');
    if (!res.ok)            die(`ESI returned ${res.status} on page ${page}`);

    const orders = await res.json();
    if (!Array.isArray(orders) || orders.length === 0) break;

    allOrders.push(...orders);
    const totalPages = parseInt(res.headers.get('x-pages') || '1');
    console.log(`  Page ${page}/${totalPages}: ${orders.length} orders`);
    if (page >= totalPages) break;
    page++;
  }

  const sellOrders = allOrders.filter(o => !o.is_buy_order);
  const buyOrders  = allOrders.filter(o =>  o.is_buy_order);
  console.log(`✓ ${allOrders.length} orders total (${sellOrders.length} sell, ${buyOrders.length} buy)`);

  // ── 4. Compute + store daily snapshot ────────────────────────────────────

  console.log('\n── Step 4: Compute + store daily price snapshot ─────────────────');
  const today = new Date().toISOString().slice(0, 10);

  const byType = {};
  for (const o of sellOrders) {
    if (!byType[o.type_id]) byType[o.type_id] = [];
    byType[o.type_id].push(o.price);
  }

  let inserted = 0;
  for (const [typeIdStr, prices] of Object.entries(byType)) {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    await dbRun(
      `INSERT OR REPLACE INTO structure_market_history_test
         (structure_id, type_id, date, avg_sell, min_sell, max_sell, order_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [KEEPSTAR_STRUCTURE_ID, parseInt(typeIdStr), today,
       +avg.toFixed(2), Math.min(...prices), Math.max(...prices), prices.length]
    );
    inserted++;
  }
  console.log(`✓ Stored ${inserted} type-day rows for ${today}`);

  // ── 5. Sample output ─────────────────────────────────────────────────────

  console.log('\n── Step 5: Sample from test DB ──────────────────────────────────');
  const sample = await dbAll(
    `SELECT type_id, min_sell, max_sell, order_count
       FROM structure_market_history_test
      WHERE structure_id = ? AND date = ?
      ORDER BY order_count DESC LIMIT 8`,
    [KEEPSTAR_STRUCTURE_ID, today]
  );

  const fmt = n => Math.round(n).toLocaleString('en-GB');
  for (const r of sample) {
    console.log(
      `  type ${String(r.type_id).padEnd(8)} ${String(r.order_count).padStart(4)} orders` +
      `  min ${fmt(r.min_sell).padStart(16)} ISK` +
      `  max ${fmt(r.max_sell)} ISK`
    );
  }

  const totals = await dbGet(
    'SELECT COUNT(*) AS rows, COUNT(DISTINCT date) AS days FROM structure_market_history_test WHERE structure_id = ?',
    [KEEPSTAR_STRUCTURE_ID]
  );
  console.log(`\n  Total in test DB: ${totals.rows} rows across ${totals.days} snapshot day(s)`);

  db.close();

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  ✓  ALL STEPS PASSED                                 ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  • Stored refresh token decrypted OK                 ║');
  console.log('║  • Autonomous token refresh confirmed (no user)      ║');
  console.log('║  • Keepstar orders fetched via ESI                   ║');
  console.log('║  • Daily snapshot written to test table              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Re-run any time — no browser auth needed again      ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

run().catch(err => {
  console.error('\n✗ Fatal:', err.message || err);
  if (db) db.close();
  process.exit(1);
});
