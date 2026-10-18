'use strict';
// SQLite connection and the small promise helpers (dbAll / dbGet / dbRun) the whole server uses.
// Open it once with initDatabase(path) at start-up; everything else just requires this module.

const sqlite3 = require('sqlite3').verbose();
const logger = require('./logger');

let db;

function initDatabase(dbPath) {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, (err) => {
      if (err) {
        logger.error('❌ Database not found. Run seed script first:');
        logger.info('   mkdir -p ../forge-db');
        logger.info('   cd ../forge-db && node seed.js');
        reject(err);
      } else {
        logger.info('✓ Connected to SQLite database');
        // WAL mode: allows concurrent readers while a write is in progress.
        // Without this, the precompute/volume-copy UPDATE locks every incoming request.
        db.run('PRAGMA journal_mode=WAL', () => {
          db.run('PRAGMA synchronous=NORMAL', () => resolve());
        });
      }
    });
  });
}

// Database helpers
const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

// DATABASE MIGRATION (v0.9.0)
// Additive migration: add a column unless it already exists. Any OTHER failure is logged instead of
// being swallowed, so a broken migration is visible rather than silent.
async function addColumn(table, spec) {
  try {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${spec}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) logger.error(`� migration: ALTER TABLE ${table} ADD COLUMN ${spec} failed: ${err.message}`);
  }
}

// PRE-COMPUTATION ENGINE (v0.9.0)
// Calculates profitability for ALL blueprints, stores in DB
// Replaces real-time AI calculations for common queries

// ── DB transaction mutex ──────────────────────────────────────────────────────
// SQLite rejects concurrent BEGIN TRANSACTION calls with
// "cannot start a transaction within a transaction".
// All background jobs must acquire this lock before BEGIN and release after
// COMMIT/ROLLBACK. SELECT reads are unaffected — no lock needed for reads.
class DbTxMutex {
  constructor() { this._locked = false; this._queue = []; }
  lock() {
    if (!this._locked) { this._locked = true; return Promise.resolve(); }
    return new Promise(resolve => this._queue.push(resolve));
  }
  unlock() {
    if (this._queue.length > 0) {
      this._queue.shift()();
    } else {
      this._locked = false;
    }
  }
}

const dbTxMutex = new DbTxMutex();

// Maximum number of SQL bind variables per query (SQLite default limit is 999).
// We leave headroom for other parameters in the same query (e.g. piIds + bpIds).
const SQL_VARIABLE_LIMIT = 950;

module.exports = {
  initDatabase, dbAll, dbGet, dbRun, addColumn, SQL_VARIABLE_LIMIT, dbTxMutex,
  /** The open connection (undefined until initDatabase has finished). */
  get db() { return db; },
};
