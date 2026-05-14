/**
 * FORGE SDE Import Script
 *
 * Downloads missing SDE tables from Hoboleaks and patches the existing forge.db:
 *   1. Adds meta_level column to items table
 *   2. Creates and populates blueprint_skills table
 *
 * Usage:
 *   node sde-import.js
 *
 * Requires: sqlite3 (already installed via server dependencies)
 * Data source: https://hoboleaks.space/ (official EVE SDE mirror)
 */

const sqlite3 = require('sqlite3').verbose();
const path    = require('path');
const https   = require('https');
const fs      = require('fs');
require('dotenv').config();

const DB_PATH = path.join(__dirname, '../forge-db/forge.db');

// ── Helpers ─────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('❌ Cannot open database:', err.message); process.exit(1); }
  console.log('✓ Connected to', DB_PATH);
});

const dbRun  = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const dbAll  = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbGet  = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    console.log(`  ↓ Fetching ${url}`);
    https.get(url, { headers: { 'User-Agent': 'FORGE-SDE-Import/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Step 1: Add meta_level to items table ───────────────────────────────────

async function addMetaLevel() {
  console.log('\n═══ Step 1: Adding meta_level column to items table ═══');

  // Add column if not exists
  try {
    await dbRun('ALTER TABLE items ADD COLUMN meta_level INTEGER DEFAULT 0');
    console.log('  ✓ Column added');
  } catch (e) {
    if (e.message.includes('duplicate column')) {
      console.log('  ✓ Column already exists — skipping ALTER');
    } else {
      throw e;
    }
  }

  // Check how many items we have
  const { total } = await dbGet('SELECT COUNT(*) as total FROM items');
  console.log(`  Items in DB: ${total}`);

  // Hoboleaks provides typeIDs.json with metaGroupID
  // metaGroupID: 1=T1, 2=T2, 3=Storyline, 4=Faction, 5=Officer, 6=Deadspace, 14=T3
  console.log('  Downloading typeIDs from Hoboleaks...');
  const typeData = await fetchJson('https://sde.hoboleaks.space/tranquility/typeids.json');

  const typeIds = Object.keys(typeData);
  console.log(`  Types downloaded: ${typeIds.length}`);

  // Map metaGroupID → meta_level (T2 = metaGroupID 2, T3 = metaGroupID 14)
  const META_GROUP_TO_LEVEL = { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, 6: 0, 14: 2 };

  await dbRun('BEGIN TRANSACTION');
  let updated = 0;

  for (const typeId of typeIds) {
    const typeInfo = typeData[typeId];
    const metaGroupId = typeInfo.metaGroupID || 1;
    const metaLevel = META_GROUP_TO_LEVEL[metaGroupId] ?? 0;

    if (metaLevel > 0) {
      await dbRun('UPDATE items SET meta_level = ? WHERE type_id = ?', [metaLevel, parseInt(typeId)]);
      updated++;
    }
  }

  await dbRun('COMMIT');
  console.log(`  ✓ Updated meta_level for ${updated} T2/T3 items`);

  // Verify
  const t2Count = await dbGet('SELECT COUNT(*) as c FROM items WHERE meta_level = 1');
  const t3Count = await dbGet('SELECT COUNT(*) as c FROM items WHERE meta_level = 2');
  console.log(`  ✓ T2 items: ${t2Count.c}, T3 items: ${t3Count.c}`);
}

// ── Step 2: Create + populate blueprint_skills table ───────────────────────

async function importBlueprintSkills() {
  console.log('\n═══ Step 2: Importing blueprint_skills table ═══');

  // Create table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS blueprint_skills (
      blueprint_id  INTEGER NOT NULL,
      skill_id      INTEGER NOT NULL,
      skill_level   INTEGER NOT NULL,
      activity_id   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (blueprint_id, skill_id, activity_id)
    )
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_bp_skills_blueprint
    ON blueprint_skills (blueprint_id)
  `);

  console.log('  ✓ Table created');

  // Check how many blueprints are in our DB
  const { total: bpTotal } = await dbGet('SELECT COUNT(*) as total FROM blueprints');
  console.log(`  Blueprints in DB: ${bpTotal}`);

  // Download blueprint skills from Hoboleaks
  // blueprints.json has: { blueprintTypeID: { activities: { manufacturing: { skills: [...] } } } }
  console.log('  Downloading blueprints from Hoboleaks (this may take a minute)...');
  const bpData = await fetchJson('https://sde.hoboleaks.space/tranquility/blueprints.json');

  const blueprintIds = Object.keys(bpData);
  console.log(`  Blueprints downloaded: ${blueprintIds.length}`);

  // Clear existing skill data
  await dbRun('DELETE FROM blueprint_skills');

  await dbRun('BEGIN TRANSACTION');
  let inserted = 0;
  let skipped  = 0;

  // Activity IDs:
  // 1=Manufacturing, 3=TE Research, 4=ME Research, 5=Copying, 8=Invention, 9=Reactions
  const ACTIVITY_IDS = {
    manufacturing: 1,
    research_time: 3,
    research_material: 4,
    copying: 5,
    invention: 8,
    reaction: 9,
  };

  for (const bpId of blueprintIds) {
    const bp = bpData[bpId];
    if (!bp.activities) { skipped++; continue; }

    for (const [actName, actId] of Object.entries(ACTIVITY_IDS)) {
      const activity = bp.activities[actName];
      if (!activity || !activity.skills) continue;

      for (const skill of activity.skills) {
        try {
          await dbRun(
            'INSERT OR REPLACE INTO blueprint_skills (blueprint_id, skill_id, skill_level, activity_id) VALUES (?, ?, ?, ?)',
            [parseInt(bpId), skill.typeID, skill.level, actId]
          );
          inserted++;
        } catch (e) {
          // Skip duplicates
        }
      }
    }
  }

  await dbRun('COMMIT');
  console.log(`  ✓ Inserted ${inserted} skill requirements (${skipped} blueprints skipped)`);

  // Verify
  const { c: skillCount } = await dbGet('SELECT COUNT(*) as c FROM blueprint_skills');
  const { c: mfgSkillCount } = await dbGet('SELECT COUNT(*) as c FROM blueprint_skills WHERE activity_id = 1');
  console.log(`  ✓ Total skill entries: ${skillCount} (${mfgSkillCount} manufacturing)`);
}

// ── Step 3: Verify T2 blueprints now resolve ────────────────────────────────

async function verifyT2Coverage() {
  console.log('\n═══ Step 3: Verifying T2 coverage ═══');

  const t2Blueprints = await dbAll(`
    SELECT b.blueprint_id, i_bp.name as bp_name, i_prod.name as product_name,
           i_prod.meta_level
    FROM blueprints b
    LEFT JOIN items i_bp   ON i_bp.type_id   = b.blueprint_id
    LEFT JOIN items i_prod ON i_prod.type_id  = b.product_id
    WHERE i_prod.meta_level = 1
    LIMIT 10
  `);

  if (t2Blueprints.length === 0) {
    console.log('  ⚠ No T2 blueprints found — meta_level may not have populated correctly');
  } else {
    console.log(`  ✓ Sample T2 blueprints now in DB:`);
    t2Blueprints.forEach(bp => {
      console.log(`    • ${bp.product_name} (ID: ${bp.blueprint_id})`);
    });
  }

  const { skillTotal } = await dbGet('SELECT COUNT(*) as skillTotal FROM blueprint_skills') || {};
  console.log(`  ✓ blueprint_skills entries: ${skillTotal || 0}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║   FORGE SDE Import — Missing Tables    ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Database: ${DB_PATH}\n`);

  try {
    await addMetaLevel();
    await importBlueprintSkills();
    await verifyT2Coverage();

    console.log('\n✅ SDE import complete. Restart the server:');
    console.log('   pm2 restart forge\n');
  } catch (err) {
    console.error('\n❌ Import failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
