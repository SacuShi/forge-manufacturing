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

module.exports = {
  initDatabase, dbAll, dbGet, dbRun, addColumn,
  /** The open connection (undefined until initDatabase has finished). */
  get db() { return db; },
};
