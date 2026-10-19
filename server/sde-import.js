/**
 * FORGE SDE Import Script v2
 *
 * Downloads reference-data-latest.tar.xz from data.everef.net and patches forge.db:
 *   1. Adds/populates meta_level on items              (meta_group_id 2=T2, 14=T3)
 *   2. Creates/populates blueprint_skills table        (all activities)
 *   3. Imports reaction formulas into blueprints       (activity_id=9)
 *   4. Ensures reaction component items exist          (moon goo, gases, etc.)
 *   5. Ensures all blueprint-referenced items exist    (products, materials)
 *   6. Bulk-imports ALL types from types.json          (faction, clothing, SKINs, etc.)
 *   7. Tags PI tiers + ME research times
 *   8. Imports T1→T2 invention chains                 (blueprint_invention, invention_materials)
 *   9. Imports LP store offers                        (npc_corporations, lp_offers, lp_offer_required_items)
 *  10. Verification report
 *  11. Imports PI Planner geography + schematics      (sde_regions, sde_systems, sde_planets,
 *                                                       pi_planet_resources, pi_schematics, pi_schematic_materials)
 *
 * Usage:  node sde-import.js
 * IMPORTANT: Stop the server first — pm2 stop forge
 */

const sqlite3        = require('sqlite3').verbose();
const path           = require('path');
const https          = require('https');
const http           = require('http');
const fs             = require('fs');
const os             = require('os');
const { execSync }   = require('child_process');
require('dotenv').config();

const DB_PATH  = path.join(__dirname, '../forge-db/forge.db');
const DATA_URL = 'https://data.everef.net/reference-data/reference-data-latest.tar.xz';

const ACTIVITY_IDS = {
  manufacturing:     1,
  research_time:     3,
  research_material: 4,
  copying:           5,
  invention:         8,
  reaction:          9,
};

// ── DB helpers ────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error('❌ Cannot open database:', err.message); process.exit(1); }
  console.log('✓ Connected to', DB_PATH);
});
// Retry on SQLITE_BUSY for up to 10s instead of failing immediately — guards against
// a stray concurrent connection (e.g. the watchdog cron restarting pm2 mid-import).
db.configure('busyTimeout', 10000);

const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function(e) { e ? rej(e) : res(this); }));
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// ── Download ──────────────────────────────────────────────────────────────────

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  ↓ Downloading: ${url}`);
    const file = fs.createWriteStream(dest);

    const get = (u) => {
      const client = u.startsWith('https') ? https : http;
      client.get(u, { headers: { 'User-Agent': 'FORGE-SDE-Import/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`  ↪ Redirect → ${res.headers.location}`);
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.destroy();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let bytes = 0;
        res.on('data', c => { bytes += c.length; });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`  ✓ Downloaded ${(bytes / 1048576).toFixed(1)} MB`);
          resolve();
        });
      }).on('error', reject);
    };

    file.on('error', reject);
    get(url);
  });
}

// ── Locate a file within a directory tree ─────────────────────────────────────

function findFile(dir, name) {
  try {
    const out = execSync(`find "${dir}" -name "${name}" -type f 2>/dev/null`).toString().trim();
    return out.split('\n').find(Boolean) || null;
  } catch { return null; }
}

// ── Step 1: meta_level ────────────────────────────────────────────────────────

async function addMetaLevel(typesData) {
  console.log('\n═══ Step 1: meta_level on items table ═══');

  try {
    await dbRun('ALTER TABLE items ADD COLUMN meta_level INTEGER DEFAULT 0');
    console.log('  ✓ Column added');
  } catch (e) {
    if (e.message.includes('duplicate') || e.message.includes('already exists')) {
      console.log('  ✓ Column already exists');
    } else throw e;
  }

  await dbRun('UPDATE items SET meta_level = 0');

  const t2Ids = [], t3Ids = [];
  for (const type of Object.values(typesData)) {
    if (type.meta_group_id === 2)  t2Ids.push(type.type_id);
    if (type.meta_group_id === 14) t3Ids.push(type.type_id);
  }
  console.log(`  Found ${t2Ids.length} T2 types, ${t3Ids.length} T3 types`);

  const chunkUpdate = async (ids, level) => {
    if (ids.length === 0) return 0;
    let updated = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await dbRun(
        `UPDATE items SET meta_level = ${level} WHERE type_id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      updated += r.changes;
    }
    return updated;
  };

  const t2n = await chunkUpdate(t2Ids, 1);
  const t3n = await chunkUpdate(t3Ids, 2);
  console.log(`  ✓ Marked: ${t2n} T2 items, ${t3n} T3 items`);
}

// ── Step 2: blueprint_skills ──────────────────────────────────────────────────

async function importBlueprintSkills(bpData) {
  console.log('\n═══ Step 2: blueprint_skills table ═══');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blueprint_skills (
      blueprint_id  INTEGER NOT NULL,
      skill_id      INTEGER NOT NULL,
      skill_level   INTEGER NOT NULL,
      activity_id   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (blueprint_id, skill_id, activity_id)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_bp_skills ON blueprint_skills (blueprint_id)`);
  await dbRun('DELETE FROM blueprint_skills');

  await dbRun('BEGIN TRANSACTION');
  let inserted = 0;

  for (const [bpId, bp] of Object.entries(bpData)) {
    if (!bp.activities) continue;
    for (const [actName, actId] of Object.entries(ACTIVITY_IDS)) {
      const act = bp.activities[actName];
      if (!act?.required_skills) continue;
      for (const [skillId, skillLevel] of Object.entries(act.required_skills)) {
        try {
          await dbRun(
            'INSERT OR REPLACE INTO blueprint_skills (blueprint_id, skill_id, skill_level, activity_id) VALUES (?,?,?,?)',
            [parseInt(bpId), parseInt(skillId), skillLevel, actId]
          );
          inserted++;
        } catch (_) {}
      }
    }
  }

  await dbRun('COMMIT');
  console.log(`  ✓ Inserted ${inserted} skill requirements`);
}

// ── Step 3: Reaction formulas → blueprints + blueprint_materials ──────────────

async function importReactionFormulas(bpData) {
  console.log('\n═══ Step 3: reaction formulas ═══');

  // Add activity_id column to blueprints (default 1 = manufacturing)
  try {
    await dbRun('ALTER TABLE blueprints ADD COLUMN activity_id INTEGER DEFAULT 1');
    console.log('  ✓ activity_id column added to blueprints');
  } catch (e) {
    if (e.message.includes('duplicate') || e.message.includes('already exists')) {
      console.log('  ✓ activity_id column already exists');
    } else throw e;
  }

  // Ensure all existing rows have activity_id=1
  await dbRun('UPDATE blueprints SET activity_id = 1 WHERE activity_id IS NULL');

  let inserted = 0, materialsInserted = 0, skipped = 0;

  await dbRun('BEGIN TRANSACTION');

  for (const [bpId, bp] of Object.entries(bpData)) {
    const act = bp.activities?.reaction;
    if (!act) continue;

    // Reaction products is a keyed object: { "typeId": { type_id, quantity } }
    const productEntries = Object.values(act.products || {});
    if (productEntries.length === 0) continue;

    const product   = productEntries[0]; // reactions have exactly one product
    const bpIdInt   = parseInt(bpId);
    const buildTime = act.time || 3600;  // seconds (reactions are 1h by default)

    // INSERT OR IGNORE — don't overwrite if already seeded as manufacturing
    const result = await dbRun(
      `INSERT OR IGNORE INTO blueprints (blueprint_id, product_id, product_quantity, build_time, activity_id)
       VALUES (?, ?, ?, ?, 9)`,
      [bpIdInt, product.type_id, product.quantity || 1, buildTime]
    );

    if (result.changes === 0) {
      // Exists — ensure activity_id is correct (9 for reactions)
      await dbRun(
        `UPDATE blueprints SET activity_id = 9 WHERE blueprint_id = ? AND activity_id != 9`,
        [bpIdInt]
      );
      skipped++;
      continue;
    }

    // Insert materials for this reaction formula
    const materials = Object.values(act.materials || {});
    for (const mat of materials) {
      try {
        await dbRun(
          `INSERT OR IGNORE INTO blueprint_materials (blueprint_id, material_id, quantity) VALUES (?, ?, ?)`,
          [bpIdInt, mat.type_id, mat.quantity]
        );
        materialsInserted++;
      } catch (_) {}
    }

    inserted++;
  }

  await dbRun('COMMIT');
  console.log(`  ✓ Inserted ${inserted} reaction formulas (${materialsInserted} materials), ${skipped} already existed`);
}

// ── Step 3b: Manufacturing blueprints missing from the pre-seeded set ──────────
// The original manufacturing rows were seeded outside this script, so new
// blueprints CCP adds (e.g. the Akoman) never got a recipe. Insert only the
// ones that are absent; existing rows are never touched.

async function importMissingManufacturingBlueprints(bpData) {
  console.log('\n═══ Step 3b: missing manufacturing blueprints ═══');

  let inserted = 0, materialsInserted = 0, present = 0;
  const added = [];

  await dbRun('BEGIN TRANSACTION');

  for (const [bpId, bp] of Object.entries(bpData)) {
    const act = bp.activities?.manufacturing;
    if (!act) continue;

    const product   = Object.values(act.products || {})[0];
    const materials = Object.values(act.materials || {});
    if (!product || materials.length === 0) continue;

    const bpIdInt = parseInt(bpId);
    const result = await dbRun(
      `INSERT OR IGNORE INTO blueprints (blueprint_id, product_id, product_quantity, build_time, activity_id)
       VALUES (?, ?, ?, ?, 1)`,
      [bpIdInt, product.type_id, product.quantity || 1, act.time || 0]
    );

    if (result.changes === 0) { present++; continue; }

    for (const mat of materials) {
      await dbRun(
        `INSERT OR IGNORE INTO blueprint_materials (blueprint_id, material_id, quantity) VALUES (?, ?, ?)`,
        [bpIdInt, mat.type_id, mat.quantity]
      );
      materialsInserted++;
    }
    inserted++;
    added.push(bpIdInt);
  }

  await dbRun('COMMIT');
  console.log(`  ✓ Added ${inserted} new manufacturing blueprints (${materialsInserted} materials), ${present} already present`);
  if (added.length) console.log(`  New blueprint IDs: ${added.join(', ')}`);
}

// ── Step 4: Ensure reaction component items exist in items table ───────────────

async function ensureReactionItems(bpData, typesData) {
  console.log('\n═══ Step 4: ensure reaction component items in items table ═══');

  // Collect all type_ids referenced in reactions (products + materials)
  const referencedIds = new Set();
  for (const bp of Object.values(bpData)) {
    const act = bp.activities?.reaction;
    if (!act) continue;
    for (const p of Object.values(act.products || {})) referencedIds.add(p.type_id);
    for (const m of Object.values(act.materials || {})) referencedIds.add(m.type_id);
  }

  const ids = [...referencedIds];
  if (ids.length === 0) return;
  console.log(`  Reaction references ${ids.length} unique type_ids`);

  // Find which are already in items table
  const missingIds = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const existing = await new Promise((rs, rj) =>
      db.all(`SELECT type_id FROM items WHERE type_id IN (${ph})`, chunk, (e, r) => e ? rj(e) : rs(r))
    );
    const existingSet = new Set(existing.map(r => r.type_id));
    chunk.filter(id => !existingSet.has(id)).forEach(id => missingIds.push(id));
  }

  if (missingIds.length === 0) {
    console.log('  ✓ All reaction type_ids present in items table');
    return;
  }

  console.log(`  Inserting ${missingIds.length} missing items from types.json...`);

  // Build meta_level map from typesData for the inserts
  const metaMap = {};
  for (const type of Object.values(typesData)) {
    if (type.meta_group_id === 2)  metaMap[type.type_id] = 1; // T2
    if (type.meta_group_id === 14) metaMap[type.type_id] = 2; // T3
  }

  await dbRun('BEGIN TRANSACTION');
  let inserted = 0;
  for (const typeId of missingIds) {
    const type = typesData[typeId] || typesData[String(typeId)];
    if (!type) continue; // not in types.json at all — skip
    const name      = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
    const metaLevel = metaMap[typeId] ?? 0;
    try {
      await dbRun(
        `INSERT OR IGNORE INTO items (type_id, name, meta_level) VALUES (?, ?, ?)`,
        [typeId, name, metaLevel]
      );
      inserted++;
    } catch (_) {}
  }
  await dbRun('COMMIT');

  const stillMissing = missingIds.length - inserted;
  console.log(`  ✓ Inserted ${inserted} items (moon goo, reaction components, gases)`);
  if (stillMissing > 0) {
    console.log(`  ⚠ ${stillMissing} type_ids not found in types.json — may be legacy/removed items`);
  }
}

// ── Step 5: Ensure all blueprint-referenced type_ids are in items ─────────────

async function ensureAllBlueprintItems(typesData) {
  console.log('\n═══ Step 5: ensure all blueprint items in items table ═══');

  const rows = await new Promise((rs, rj) =>
    db.all(
      `SELECT blueprint_id as id FROM blueprints
       UNION SELECT product_id FROM blueprints
       UNION SELECT material_id FROM blueprint_materials`,
      [],
      (e, r) => e ? rj(e) : rs(r)
    )
  );

  const allIds = [...new Set(rows.map(r => r.id).filter(Boolean))];
  console.log(`  ${allIds.length} unique type_ids referenced across blueprints + materials`);

  const missingIds = [];
  for (let i = 0; i < allIds.length; i += 500) {
    const chunk = allIds.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const existing = await new Promise((rs, rj) =>
      db.all(`SELECT type_id FROM items WHERE type_id IN (${ph})`, chunk, (e, r) => e ? rj(e) : rs(r))
    );
    const existingSet = new Set(existing.map(r => r.type_id));
    chunk.filter(id => !existingSet.has(id)).forEach(id => missingIds.push(id));
  }

  if (missingIds.length === 0) {
    console.log('  ✓ All blueprint type_ids already in items table');
    return;
  }

  console.log(`  Inserting ${missingIds.length} missing items from types.json...`);

  const metaMap = {};
  for (const type of Object.values(typesData)) {
    if (type.meta_group_id === 2)  metaMap[type.type_id] = 1;
    if (type.meta_group_id === 14) metaMap[type.type_id] = 2;
  }

  await dbRun('BEGIN TRANSACTION');
  let inserted = 0;
  for (const typeId of missingIds) {
    const type = typesData[typeId] || typesData[String(typeId)];
    if (!type) continue;
    const name      = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
    const metaLevel = metaMap[typeId] ?? 0;
    try {
      await dbRun(`INSERT OR IGNORE INTO items (type_id, name, meta_level) VALUES (?, ?, ?)`, [typeId, name, metaLevel]);
      inserted++;
    } catch (_) {}
  }
  await dbRun('COMMIT');

  const notInSde = missingIds.length - inserted;
  console.log(`  ✓ Inserted ${inserted} items`);
  if (notInSde > 0) console.log(`  ⚠ ${notInSde} type_ids not in types.json (legacy/removed items)`);
}

// ── Step 6: Bulk-import ALL types from types.json ─────────────────────────────
// Covers everything types.json knows about — faction items, navy/pirate modules,
// clothing, SKINs, SKINR components, implants, boosters, LP store items, etc.
// Uses INSERT OR IGNORE so existing entries (with correct names) are never clobbered.

async function importAllTypes(typesData) {
  console.log('\n═══ Step 6: bulk import all types from types.json ═══');

  const metaMap = {};
  for (const type of Object.values(typesData)) {
    if (type.meta_group_id === 2)  metaMap[type.type_id] = 1;
    if (type.meta_group_id === 14) metaMap[type.type_id] = 2;
  }

  const allTypes = Object.values(typesData);
  console.log(`  ${allTypes.length} total types in types.json`);

  // Check how many are already present
  const existingCount = await dbGet('SELECT COUNT(*) as c FROM items');
  console.log(`  ${existingCount.c} items currently in DB`);

  let inserted = 0, updated = 0;
  const CHUNK = 500;

  for (let i = 0; i < allTypes.length; i += CHUNK) {
    const chunk = allTypes.slice(i, i + CHUNK);
    await dbRun('BEGIN TRANSACTION');
    for (const type of chunk) {
      if (!type.type_id) continue;
      const name           = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
      if (!name) continue; // skip types with no English name (unpublished/internal)
      const metaLevel      = metaMap[type.type_id] ?? 0;
      // packaged_volume is what haulers care about — the m³ the item occupies in a
      // freight container. Falls back to the assembled volume if not separately specified.
      const packagedVolume = type.packaged_volume ?? type.volume ?? null;
      try {
        const r = await dbRun(
          `INSERT INTO items (type_id, name, meta_level, packaged_volume) VALUES (?, ?, ?, ?)
           ON CONFLICT(type_id) DO UPDATE SET
             name             = CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE name END,
             meta_level       = excluded.meta_level,
             packaged_volume  = excluded.packaged_volume`,
          [type.type_id, name, metaLevel, packagedVolume]
        );
        if (r.changes === 1) inserted++;
        else updated++;
      } catch (_) {}
    }
    await dbRun('COMMIT');

    if (i % 10000 === 0 && i > 0) console.log(`  ... ${i}/${allTypes.length}`);
  }

  console.log(`  ✓ Inserted ${inserted} new items, updated ${updated} existing`);
}

// ── Step 7: Tag PI tiers on items ─────────────────────────────────────────────
// PI commodity names in EVE are stable (unchanged since ~2014).
// We match by exact English name. False negatives (missed items) are harmless;
// false positives would be misleading — so only include items we are certain about.
//
// If CCP renames a PI item in future, re-run this step to refresh the tags.

const PI_TIER_NAMES = {
  // P0 — Raw Materials (15 items, one of 5 per planet type — see PLANET_TYPE_RESOURCES below)
  'Aqueous Liquids': 0, 'Autotrophs': 0, 'Base Metals': 0, 'Carbon Compounds': 0,
  'Complex Organisms': 0, 'Felsic Magma': 0, 'Heavy Metals': 0, 'Ionic Solutions': 0,
  'Microorganisms': 0, 'Noble Gas': 0, 'Noble Metals': 0, 'Non-CS Crystals': 0,
  'Planktic Colonies': 0, 'Reactive Gas': 0, 'Suspended Plasma': 0,
  // P1 — Basic Commodities (15 items)
  'Bacteria': 1, 'Biofuels': 1, 'Biomass': 1, 'Chiral Structures': 1,
  'Electrolytes': 1, 'Industrial Fibers': 1, 'Oxidizing Compound': 1,
  'Oxygen': 1, 'Plasmoids': 1, 'Precious Metals': 1, 'Proteins': 1,
  'Reactive Metals': 1, 'Silicon': 1, 'Toxic Metals': 1, 'Water': 1,
  // P2 — Refined Commodities (24 items)
  'Biocells': 2, 'Construction Blocks': 2, 'Consumer Electronics': 2,
  'Coolant': 2, 'Enriched Uranium': 2, 'Fertilizer': 2,
  'Genetically Enhanced Livestock': 2, 'Livestock': 2, 'Mechanical Parts': 2,
  'Microfiber Shielding': 2, 'Miniature Electronics': 2, 'Nanites': 2,
  'Oxides': 2, 'Polyaramids': 2, 'Polytextiles': 2, 'Rocket Fuel': 2,
  'Silicate Glass': 2, 'Superconductors': 2, 'Supertensile Plastics': 2,
  'Synthetic Oil': 2, 'Test Cultures': 2,
  'Transmitter': 2, 'Viral Agent': 2, 'Water-Cooled CPU': 2,
  // P3 — Specialized Commodities (21 items)
  'Biotech Research Reports': 3, 'Camera Drones': 3, 'Condensates': 3,
  'Cryoprotectant Solution': 3, 'Data Chips': 3, 'Gel-Matrix Biopaste': 3,
  'Guidance Systems': 3, 'Hazmat Detection Systems': 3, 'Hermetic Membranes': 3,
  'High-Tech Transmitters': 3, 'Industrial Explosives': 3, 'Neocoms': 3,
  'Nuclear Reactors': 3, 'Planetary Vehicles': 3, 'Robotics': 3,
  'Smartfab Units': 3, 'Supercomputers': 3, 'Synthetic Synapses': 3,
  'Transcranial Microcontrollers': 3, 'Ukomi Superconductors': 3, 'Vaccines': 3,
  // P4 — Advanced Commodities (8 items — all verified, required for capital/structure manufacturing)
  'Broadcast Node': 4, 'Integrity Response Drones': 4, 'Nano-Factory': 4,
  'Organic Mortar Applicators': 4, 'Recursive Computing Module': 4,
  'Self-Harmonizing Power Core': 4, 'Sterile Conduits': 4, 'Wetware Mainframe': 4,
};

async function tagPiTiers(typesData) {
  console.log('\n═══ Step 7: PI tier tagging on items ═══');

  try {
    await dbRun('ALTER TABLE items ADD COLUMN pi_tier INTEGER DEFAULT NULL');
    console.log('  ✓ pi_tier column added');
  } catch (e) {
    if (e.message.includes('duplicate') || e.message.includes('already exists')) {
      console.log('  ✓ pi_tier column already exists');
    } else throw e;
  }

  // Reset all PI tags — clean slate on each import so renamed/removed items are cleared
  await dbRun('UPDATE items SET pi_tier = NULL');

  // Build (tier, typeId) pairs by matching names from types data
  const updates = [];
  for (const type of Object.values(typesData)) {
    const name = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
    if (!name) continue;
    const tier = PI_TIER_NAMES[name];
    if (tier !== undefined) updates.push([tier, type.type_id]);
  }

  console.log(`  ${updates.length} PI items identified from types.json`);

  await dbRun('BEGIN TRANSACTION');
  for (const [tier, typeId] of updates) {
    await dbRun('UPDATE items SET pi_tier = ? WHERE type_id = ?', [tier, typeId]);
  }
  await dbRun('COMMIT');

  // Summary by tier
  const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const [tier] of updates) counts[tier] = (counts[tier] || 0) + 1;
  for (const t of [0, 1, 2, 3, 4]) {
    console.log(`  P${t}: ${counts[t]} items tagged`);
  }
  console.log('  ✓ PI tagging complete');
}

// ── Step 7b: Populate ME research time (v1.11.0) ──────────────────────────────
// Manufacturing blueprint rows are pre-seeded; here we UPDATE research_time from
// the SDE research_material activity. Powers the ME Research ROI ranker.

async function importResearchTimes(bpData) {
  console.log('\n═══ Step 7b: ME research times ═══');

  try {
    await dbRun('ALTER TABLE blueprints ADD COLUMN research_time INTEGER DEFAULT NULL');
    console.log('  ✓ research_time column added to blueprints');
  } catch (e) {
    if (e.message.includes('duplicate') || e.message.includes('already exists')) {
      console.log('  ✓ research_time column already exists');
    } else throw e;
  }

  let updated = 0;
  await dbRun('BEGIN TRANSACTION');
  for (const [bpId, bp] of Object.entries(bpData)) {
    const t = bp.activities?.research_material?.time;
    if (!t) continue;
    const result = await dbRun(
      'UPDATE blueprints SET research_time = ? WHERE blueprint_id = ?',
      [t, parseInt(bpId)]
    );
    if (result.changes > 0) updated++;
  }
  await dbRun('COMMIT');
  console.log(`  ✓ research_time set on ${updated} blueprints`);
}

// ── Step 8: T1→T2 invention chains ───────────────────────────────────────────
// Populates blueprint_invention (T1 bp → T2 BPC links) and invention_materials
// (datacores + optional optional decryptor slots per T1 blueprint).
// These tables are the foundation for T2 manufacturing cost modeling.

async function importInventionChains(bpData) {
  console.log('\n═══ Step 8: T1→T2 invention chains ═══');

  await dbRun(`CREATE TABLE IF NOT EXISTS blueprint_invention (
    t1_blueprint_id  INTEGER NOT NULL,
    t2_blueprint_id  INTEGER NOT NULL,
    probability      REAL    DEFAULT 0.4,
    output_runs      INTEGER DEFAULT 1,
    PRIMARY KEY (t1_blueprint_id, t2_blueprint_id)
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS invention_materials (
    t1_blueprint_id  INTEGER NOT NULL,
    material_id      INTEGER NOT NULL,
    quantity         INTEGER NOT NULL,
    PRIMARY KEY (t1_blueprint_id, material_id)
  )`);

  let chainCount    = 0;
  let materialCount = 0;
  let skipped       = 0;

  await dbRun('BEGIN TRANSACTION');

  // Full reimport inside transaction — crash before COMMIT leaves tables intact
  await dbRun('DELETE FROM blueprint_invention');
  await dbRun('DELETE FROM invention_materials');

  for (const [bpId, bp] of Object.entries(bpData)) {
    const act = bp.activities?.invention;
    if (!act) continue;

    const t1BpId   = parseInt(bpId);
    const products  = Object.values(act.products  || {});
    const materials = Object.values(act.materials || {});

    if (products.length === 0) { skipped++; continue; }

    // Each product is a distinct T2 BPC this T1 can invent into
    for (const product of products) {
      await dbRun(
        `INSERT OR REPLACE INTO blueprint_invention
           (t1_blueprint_id, t2_blueprint_id, probability, output_runs)
         VALUES (?, ?, ?, ?)`,
        [t1BpId, product.type_id, product.probability ?? 0.4, product.quantity ?? 1]
      );
      chainCount++;
    }

    // Datacores (+ any other consumed materials) shared across all T2 products
    for (const mat of materials) {
      await dbRun(
        `INSERT OR REPLACE INTO invention_materials
           (t1_blueprint_id, material_id, quantity)
         VALUES (?, ?, ?)`,
        [t1BpId, mat.type_id, mat.quantity]
      );
      materialCount++;
    }
  }

  await dbRun('COMMIT');

  const uniqueT1s = await dbGet('SELECT COUNT(DISTINCT t1_blueprint_id) as c FROM blueprint_invention');
  console.log(`  ✓ ${chainCount} T1→T2 links across ${uniqueT1s.c} unique T1 blueprints`);
  console.log(`  ✓ ${materialCount} datacore/material rows in invention_materials`);
  if (skipped > 0) console.log(`  ⚠ ${skipped} invention entries skipped — no products listed`);
}

// ── Step 9: Verify ────────────────────────────────────────────────────────────

async function verify() {
  console.log('\n═══ Step 8: Verification ═══');

  const t2       = await dbGet(`SELECT COUNT(*) as c FROM items WHERE meta_level = 1`);
  const sk       = await dbGet(`SELECT COUNT(*) as c FROM blueprint_skills`);
  const rxCount  = await dbGet(`SELECT COUNT(*) as c FROM blueprints WHERE activity_id = 9`);
  const mfgCount = await dbGet(`SELECT COUNT(*) as c FROM blueprints WHERE activity_id = 1 OR activity_id IS NULL`);

  const sample = await dbGet(`
    SELECT GROUP_CONCAT(i.name, ', ') as names FROM (
      SELECT i.name FROM blueprints b
      JOIN items i ON i.type_id = b.product_id
      WHERE b.activity_id = 9 LIMIT 5
    ) i
  `);

  const unnamed = await dbGet(`
    SELECT COUNT(*) as c FROM blueprints b
    LEFT JOIN items i ON i.type_id = b.blueprint_id
    WHERE i.type_id IS NULL OR i.name IS NULL
  `);

  const totalItems  = await dbGet('SELECT COUNT(*) as c FROM items');
  const piTagged    = await dbGet(`SELECT COUNT(*) as c FROM items WHERE pi_tier IS NOT NULL`);
  const rtCount     = await dbGet(`SELECT COUNT(*) as c FROM blueprints WHERE research_time IS NOT NULL`);
  const invLinks    = await dbGet(`SELECT COUNT(*) as c FROM blueprint_invention`);
  const invT1s      = await dbGet(`SELECT COUNT(DISTINCT t1_blueprint_id) as c FROM blueprint_invention`);
  const invMats     = await dbGet(`SELECT COUNT(*) as c FROM invention_materials`);
  const piRegions   = await dbGet(`SELECT COUNT(*) as c FROM sde_regions`);
  const piSystems   = await dbGet(`SELECT COUNT(*) as c FROM sde_systems`);
  const piPlanets   = await dbGet(`SELECT COUNT(*) as c FROM sde_planets`);
  const piResources = await dbGet(`SELECT COUNT(*) as c FROM pi_planet_resources`);
  const piSchematics = await dbGet(`SELECT COUNT(*) as c FROM pi_schematics`);
  const piSchemMats  = await dbGet(`SELECT COUNT(*) as c FROM pi_schematic_materials`);

  console.log(`  total items in DB:              ${totalItems.c}`);
  console.log(`  items with meta_level=1 (T2):  ${t2.c}`);
  console.log(`  PI items tagged (P0–P4):        ${piTagged.c}`);
  console.log(`  blueprint_skills rows:          ${sk.c}`);
  console.log(`  blueprints — manufacturing:     ${mfgCount.c}`);
  console.log(`  blueprints — reactions:         ${rxCount.c}`);
  console.log(`  blueprints with research_time:  ${rtCount.c}`);
  console.log(`  invention T1→T2 links:          ${invLinks.c} across ${invT1s.c} T1 blueprints`);
  console.log(`  invention_materials rows:       ${invMats.c}`);
  console.log(`  blueprints without a name:      ${unnamed.c}${unnamed.c > 0 ? ' ⚠' : ' ✓'}`);
  if (sample?.names) console.log(`  Sample reaction products: ${sample.names}`);
  else console.log('  ⚠ No reaction products found — check blueprints.json reaction data');

  console.log(`  PI Planner — regions:           ${piRegions.c}`);
  console.log(`  PI Planner — solar systems:     ${piSystems.c}`);
  console.log(`  PI Planner — planets:           ${piPlanets.c}`);
  console.log(`  PI Planner — resource mappings: ${piResources.c}`);
  console.log(`  PI Planner — schematics:        ${piSchematics.c}`);
  console.log(`  PI Planner — schematic mats:    ${piSchemMats.c}`);
}

// ── Step 10: LP Store (Fuzzwork CSVs + ESI) ──────────────────────────────────

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      const client = u.startsWith('https') ? https : http;
      client.get(u, { headers: { 'User-Agent': 'FORGE-SDE-Import/2.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function parseCSVRow(line) {
  const fields = [];
  let i = 0, inQuote = false, cur = '';
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i += 2; continue; }
      inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
    i++;
  }
  fields.push(cur);
  return fields;
}

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = parseCSVRow(lines[0]).map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
    return obj;
  });
}

function fetchESILP(corpId) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'esi.evetech.net',
      path: `/v1/loyalty/stores/${corpId}/offers/`,
      headers: { 'User-Agent': 'FORGE-SDE-Import/2.0', 'Accept': 'application/json' },
    };
    https.get(opts, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

// ── Step 9b: Item group / category names ──────────────────────────────────────

async function importItemCategories(typesData) {
  console.log('\n═══ Step 9b: Item categories (group_id + category_name) ═══');

  try { await dbRun('ALTER TABLE items ADD COLUMN group_id INTEGER'); } catch (_) {}
  try { await dbRun('ALTER TABLE items ADD COLUMN category_name TEXT'); } catch (_) {}

  // Fetch group→category mapping from Fuzzwork
  let groupToCat = new Map(); // groupId → categoryName
  try {
    console.log('  Fetching invGroups.csv + invCategories.csv...');
    const [groupsCSV, catsCSV] = await Promise.all([
      fetchText('https://www.fuzzwork.co.uk/dump/latest/csv/invGroups.csv'),
      fetchText('https://www.fuzzwork.co.uk/dump/latest/csv/invCategories.csv'),
    ]);
    const catRows   = parseCSV(catsCSV);
    const groupRows = parseCSV(groupsCSV);
    const catNames  = new Map(catRows.map(r => [parseInt(r.categoryID, 10), r.categoryName]));
    for (const row of groupRows) {
      const gid = parseInt(row.groupID, 10);
      const cid = parseInt(row.categoryID, 10);
      if (gid && catNames.has(cid)) groupToCat.set(gid, catNames.get(cid));
    }
    console.log(`  ✓ ${groupToCat.size} group→category mappings`);
  } catch (e) {
    console.log(`  ⚠ Could not fetch group/category CSVs: ${e.message}`);
  }

  // Build typeId → [groupId, categoryName] from types.json
  const byCategory = new Map(); // categoryName → typeId[]
  const byGroup    = new Map(); // groupId → typeId[]

  for (const type of Object.values(typesData)) {
    const typeId  = type.type_id;
    const groupId = type.group_id ?? null;
    if (!typeId || !groupId) continue;
    const catName = groupToCat.get(groupId) || null;

    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(typeId);

    if (catName) {
      if (!byCategory.has(catName)) byCategory.set(catName, []);
      byCategory.get(catName).push(typeId);
    }
  }

  // Bulk UPDATE group_id grouped by groupId (fast: one UPDATE per group)
  let gCount = 0;
  for (const [groupId, typeIds] of byGroup) {
    for (let i = 0; i < typeIds.length; i += 500) {
      const chunk = typeIds.slice(i, i + 500);
      await dbRun(
        `UPDATE items SET group_id = ? WHERE type_id IN (${chunk.map(() => '?').join(',')})`,
        [groupId, ...chunk]
      );
      gCount += chunk.length;
    }
  }

  // Bulk UPDATE category_name grouped by category (fast: one UPDATE per category)
  let cCount = 0;
  for (const [catName, typeIds] of byCategory) {
    for (let i = 0; i < typeIds.length; i += 500) {
      const chunk = typeIds.slice(i, i + 500);
      await dbRun(
        `UPDATE items SET category_name = ? WHERE type_id IN (${chunk.map(() => '?').join(',')})`,
        [catName, ...chunk]
      );
      cCount += chunk.length;
    }
  }

  console.log(`  ✓ group_id set on ${gCount} items, category_name set on ${cCount} items across ${byCategory.size} categories`);
}

async function importLPStore() {
  console.log('\n═══ Step 10: LP Store (Fuzzwork CSVs + ESI offers) ═══');

  const CORP_CSV_URL    = 'https://www.fuzzwork.co.uk/dump/latest/csv/crpNPCCorporations.csv';
  const FACTION_CSV_URL = 'https://www.fuzzwork.co.uk/dump/latest/csv/chrFactions.csv';

  console.log('  Fetching crpNPCCorporations.csv...');
  const corpCSV = await fetchText(CORP_CSV_URL);
  console.log('  Fetching chrFactions.csv...');
  const factionCSV = await fetchText(FACTION_CSV_URL);

  const corpRows    = parseCSV(corpCSV);
  const factionRows = parseCSV(factionCSV);

  // faction name lookup
  const factionNames = new Map();
  for (const row of factionRows) {
    const id = parseInt(row.factionID, 10);
    if (id && row.factionName) factionNames.set(id, row.factionName);
  }
  console.log(`  ✓ ${factionNames.size} factions`);

  // Populate npc_corporations and collect faction-linked corps to query ESI
  await dbRun('DELETE FROM npc_corporations');
  const corpsWithFaction = [];
  let corpCount = 0;
  for (const row of corpRows) {
    const corpId    = parseInt(row.corporationID, 10);
    const corpName  = row.corporationName;
    const factionId = row.factionID ? parseInt(row.factionID, 10) : null;
    const factionName = factionId ? (factionNames.get(factionId) || null) : null;
    if (!corpId || !corpName) continue;
    await dbRun(
      'INSERT OR REPLACE INTO npc_corporations (corp_id, corp_name, faction_id, faction_name) VALUES (?,?,?,?)',
      [corpId, corpName, factionId, factionName]
    );
    corpCount++;
    if (factionId) corpsWithFaction.push({ corpId, corpName, factionId, factionName });
  }
  console.log(`  ✓ ${corpCount} NPC corps; querying ESI LP stores for ${corpsWithFaction.length} faction-linked corps...`);

  // Batch-fetch LP offers from ESI (public endpoint, no auth)
  await dbRun('DELETE FROM lp_offer_required_items');
  await dbRun('DELETE FROM lp_offers');

  const CONCURRENCY = 15;
  let offerCount = 0, reqCount = 0, corpWithOffers = 0;

  for (let i = 0; i < corpsWithFaction.length; i += CONCURRENCY) {
    const batch = corpsWithFaction.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(({ corpId }) =>
      fetchESILP(corpId).then(offers => ({ corpId, offers }))
    ));

    for (const { corpId, offers } of results) {
      if (!Array.isArray(offers) || !offers.length) continue;
      corpWithOffers++;
      for (const offer of offers) {
        const { offer_id: offerId, type_id: typeId, quantity: qty = 1,
                lp_cost: lpCost = 0, isk_cost: iskCost = 0,
                required_items: reqs = [] } = offer;
        if (!offerId || !typeId) continue;
        await dbRun(
          'INSERT OR REPLACE INTO lp_offers (corp_id, offer_id, type_id, quantity, lp_cost, isk_cost) VALUES (?,?,?,?,?,?)',
          [corpId, offerId, typeId, qty, lpCost, iskCost]
        );
        offerCount++;
        for (const r of reqs) {
          if (!r.type_id) continue;
          await dbRun(
            'INSERT OR REPLACE INTO lp_offer_required_items (offer_id, corp_id, req_type_id, quantity) VALUES (?,?,?,?)',
            [offerId, corpId, r.type_id, r.quantity || 1]
          );
          reqCount++;
        }
      }
    }
    if ((i + CONCURRENCY) % 60 === 0) {
      console.log(`  ... ${Math.min(i + CONCURRENCY, corpsWithFaction.length)}/${corpsWithFaction.length} corps queried`);
    }
  }

  console.log(`  ✓ ${corpWithOffers} corps have LP stores`);
  console.log(`  ✓ ${offerCount} LP offers, ${reqCount} required-item rows`);
}

// ── Step 11: PI Planner geography + schematics ─────────────────────────────────
// CCP's own reference-data bundle (data.everef.net, used for typesData/bpData above)
// only ships item/blueprint/dogma/region/schematic data — no solar systems, planets,
// or constellations (confirmed by inspecting the live tarball's contents). That
// geography lives in Fuzzwork's SDE CSV mirror instead, same source already used
// above for invGroups/invCategories/crpNPCCorporations/chrFactions.
//
// Which P0 raw resources a planet can produce is determined entirely by planet
// TYPE (8 types, 5 resources each) — this is NOT published as SDE or ESI data at
// all (it's baked into client-side extraction mechanics), so it's hardcoded here
// from EVE University's planet resource matrix (wiki.eveuniversity.org/Planet),
// cross-checked against that page's per-planet-type text description and its
// resource-distribution table independently — both agree exactly.

const PLANET_TYPE_RESOURCES = {
  'Barren':    ['Aqueous Liquids', 'Base Metals', 'Carbon Compounds', 'Microorganisms', 'Noble Metals'],
  'Gas':       ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Reactive Gas'],
  'Ice':       ['Aqueous Liquids', 'Heavy Metals', 'Microorganisms', 'Noble Gas', 'Planktic Colonies'],
  'Lava':      ['Base Metals', 'Felsic Magma', 'Heavy Metals', 'Non-CS Crystals', 'Suspended Plasma'],
  'Oceanic':   ['Aqueous Liquids', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms', 'Planktic Colonies'],
  'Plasma':    ['Base Metals', 'Heavy Metals', 'Noble Metals', 'Non-CS Crystals', 'Suspended Plasma'],
  'Storm':     ['Aqueous Liquids', 'Base Metals', 'Ionic Solutions', 'Noble Gas', 'Suspended Plasma'],
  'Temperate': ['Aqueous Liquids', 'Autotrophs', 'Carbon Compounds', 'Complex Organisms', 'Microorganisms'],
};

async function importPiPlannerData(typesData) {
  console.log('\n═══ Step 11: PI Planner geography + schematics ═══');

  const FUZZWORK = 'https://www.fuzzwork.co.uk/dump/latest/csv/';

  // -- Regions --
  console.log('  Fetching mapRegions.csv...');
  const regionRows = parseCSV(await fetchText(FUZZWORK + 'mapRegions.csv'));
  await dbRun('BEGIN TRANSACTION');
  await dbRun('DELETE FROM sde_regions');
  let regionCount = 0;
  for (const r of regionRows) {
    const id = parseInt(r.regionID, 10);
    if (!id || !r.regionName) continue;
    await dbRun('INSERT OR REPLACE INTO sde_regions (region_id, name) VALUES (?, ?)', [id, r.regionName]);
    regionCount++;
  }
  await dbRun('COMMIT');
  console.log(`  ✓ ${regionCount} regions`);

  // -- Solar systems --
  console.log('  Fetching mapSolarSystems.csv...');
  const systemRows = parseCSV(await fetchText(FUZZWORK + 'mapSolarSystems.csv'));
  await dbRun('BEGIN TRANSACTION');
  await dbRun('DELETE FROM sde_systems');
  let systemCount = 0;
  for (const s of systemRows) {
    const id = parseInt(s.solarSystemID, 10);
    if (!id || !s.solarSystemName) continue;
    await dbRun(
      `INSERT OR REPLACE INTO sde_systems (system_id, name, region_id, constellation_id, security_status)
       VALUES (?, ?, ?, ?, ?)`,
      [id, s.solarSystemName, parseInt(s.regionID, 10) || null, parseInt(s.constellationID, 10) || null, parseFloat(s.security) || null]
    );
    systemCount++;
  }
  await dbRun('COMMIT');
  console.log(`  ✓ ${systemCount} solar systems`);

  // -- Planets -- (filtered out of mapDenormalize.csv, ~83MB / groupID=7 = Planet)
  console.log('  Fetching mapDenormalize.csv (large file — filtering for planets)...');
  const denormText = await fetchText(FUZZWORK + 'mapDenormalize.csv');
  const denormLines = denormText.split('\n');
  const denormHeader = parseCSVRow(denormLines[0]).map(h => h.trim());
  const col = (name) => denormHeader.indexOf(name);
  const cItem = col('itemID'), cType = col('typeID'), cGroup = col('groupID'),
        cSystem = col('solarSystemID'), cName = col('itemName'), cIndex = col('celestialIndex');

  // Planet type_id → canonical type name ("Barren", "Temperate", etc.), derived from
  // the "Planet (X)" type names already loaded in typesData (same source as PI_TIER_NAMES).
  const planetTypeNameById = new Map();
  for (const type of Object.values(typesData)) {
    const name = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
    const m = name && name.match(/^Planet \((.+)\)$/);
    if (m) planetTypeNameById.set(type.type_id, m[1]);
  }

  const planetRows = [];
  for (let i = 1; i < denormLines.length; i++) {
    const line = denormLines[i];
    if (!line || line.indexOf('","7",') === -1) continue; // cheap pre-filter before full CSV parse
    const f = parseCSVRow(line);
    if (f[cGroup] !== '7') continue; // confirm — pre-filter can false-match other columns
    planetRows.push({
      planetId: parseInt(f[cItem], 10),
      typeId: parseInt(f[cType], 10),
      systemId: parseInt(f[cSystem], 10),
      name: f[cName],
      index: parseInt(f[cIndex], 10) || null,
    });
  }

  await dbRun('DELETE FROM sde_planets');
  let planetCount = 0;
  for (let i = 0; i < planetRows.length; i += 500) {
    const chunk = planetRows.slice(i, i + 500);
    await dbRun('BEGIN TRANSACTION');
    for (const p of chunk) {
      if (!p.planetId || !p.systemId) continue;
      await dbRun(
        `INSERT OR REPLACE INTO sde_planets (planet_id, system_id, planet_index, type_id, planet_type_name)
         VALUES (?, ?, ?, ?, ?)`,
        [p.planetId, p.systemId, p.index, p.typeId, planetTypeNameById.get(p.typeId) || null]
      );
      planetCount++;
    }
    await dbRun('COMMIT');
  }
  console.log(`  ✓ ${planetCount} planets`);

  // -- Planet type → P0 resource mapping (hardcoded, see PLANET_TYPE_RESOURCES above) --
  const resourceNameToTypeId = new Map();
  const allResourceNames = new Set(Object.values(PLANET_TYPE_RESOURCES).flat());
  for (const type of Object.values(typesData)) {
    const name = typeof type.name === 'string' ? type.name : (type.name?.en ?? null);
    if (name && allResourceNames.has(name)) resourceNameToTypeId.set(name, type.type_id);
  }

  await dbRun('BEGIN TRANSACTION');
  await dbRun('DELETE FROM pi_planet_resources');
  let resourceCount = 0;
  for (const [planetTypeName, resourceNames] of Object.entries(PLANET_TYPE_RESOURCES)) {
    for (const resourceName of resourceNames) {
      const typeId = resourceNameToTypeId.get(resourceName);
      if (!typeId) { console.log(`  ⚠ Could not resolve type_id for resource "${resourceName}"`); continue; }
      await dbRun(
        'INSERT OR REPLACE INTO pi_planet_resources (planet_type_name, resource_type_id) VALUES (?, ?)',
        [planetTypeName, typeId]
      );
      resourceCount++;
    }
  }
  await dbRun('COMMIT');
  console.log(`  ✓ ${resourceCount} planet-type → P0 resource mappings (${Object.keys(PLANET_TYPE_RESOURCES).length} planet types)`);

  // -- PI Schematics (P1–P4 recipes) --
  console.log('  Fetching planetSchematics.csv + planetSchematicsTypeMap.csv...');
  const schemRows    = parseCSV(await fetchText(FUZZWORK + 'planetSchematics.csv'));
  const typeMapRows  = parseCSV(await fetchText(FUZZWORK + 'planetSchematicsTypeMap.csv'));

  const products  = new Map(); // schematicId -> { typeId, qty }
  const materials = [];        // { schematicId, typeId, qty }
  for (const row of typeMapRows) {
    const schematicId = parseInt(row.schematicID, 10);
    const typeId       = parseInt(row.typeID, 10);
    const qty          = parseInt(row.quantity, 10) || 1;
    if (row.isInput === '1') materials.push({ schematicId, typeId, qty });
    else                     products.set(schematicId, { typeId, qty });
  }

  await dbRun('BEGIN TRANSACTION');
  await dbRun('DELETE FROM pi_schematics');
  await dbRun('DELETE FROM pi_schematic_materials');

  let schemCount = 0, skippedSchems = 0;
  for (const row of schemRows) {
    const schematicId = parseInt(row.schematicID, 10);
    const product = products.get(schematicId);
    if (!product) { skippedSchems++; continue; }
    await dbRun(
      `INSERT OR REPLACE INTO pi_schematics (schematic_id, product_type_id, product_quantity, cycle_time)
       VALUES (?, ?, ?, ?)`,
      [schematicId, product.typeId, product.qty, parseInt(row.cycleTime, 10) || null]
    );
    schemCount++;
  }

  let matCount = 0;
  for (const m of materials) {
    await dbRun(
      `INSERT OR REPLACE INTO pi_schematic_materials (schematic_id, material_type_id, quantity) VALUES (?, ?, ?)`,
      [m.schematicId, m.typeId, m.qty]
    );
    matCount++;
  }
  await dbRun('COMMIT');
  console.log(`  ✓ ${schemCount} schematics, ${matCount} material rows${skippedSchems ? ` (${skippedSchems} schematics skipped — no product found)` : ''}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   FORGE SDE Import v2 — data.everef.net      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Database: ${DB_PATH}\n`);

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sde-'));
  const tmpFile = path.join(tmpDir, 'reference-data.tar.xz');

  try {
    await download(DATA_URL, tmpFile);

    console.log('\n  Extracting archive...');
    execSync(`tar -xJf "${tmpFile}" -C "${tmpDir}"`, { stdio: 'pipe' });
    console.log('  ✓ Extracted');

    const typesPath      = findFile(tmpDir, 'types.json');
    const blueprintsPath = findFile(tmpDir, 'blueprints.json');

    if (!typesPath)      throw new Error('types.json not found in archive');
    if (!blueprintsPath) throw new Error('blueprints.json not found in archive');

    console.log(`  types.json:      ${typesPath}`);
    console.log(`  blueprints.json: ${blueprintsPath}`);

    // Parse both files once — shared across all steps
    console.log('\n  Parsing types.json...');
    const typesData = JSON.parse(fs.readFileSync(typesPath, 'utf8'));
    console.log(`  ✓ ${Object.keys(typesData).length} types loaded`);

    console.log('  Parsing blueprints.json...');
    const bpData = JSON.parse(fs.readFileSync(blueprintsPath, 'utf8'));
    console.log(`  ✓ ${Object.keys(bpData).length} blueprints loaded`);

    await addMetaLevel(typesData);
    await importBlueprintSkills(bpData);
    await importReactionFormulas(bpData);
    await importMissingManufacturingBlueprints(bpData);
    await ensureReactionItems(bpData, typesData);
    await ensureAllBlueprintItems(typesData);
    await importAllTypes(typesData);
    await tagPiTiers(typesData);
    await importResearchTimes(bpData);
    await importInventionChains(bpData);
    await importItemCategories(typesData);
    await importLPStore();
    await importPiPlannerData(typesData);
    await verify();

    console.log('\n✅ Done. Next steps:');
    console.log('   1. pm2 start forge');
    console.log('   2. Trigger a recompute: POST /api/trigger-precompute\n');

  } catch (err) {
    console.error('\n❌ Import failed:', err.message);
    process.exit(1);
  } finally {
    db.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    console.log('  Temp files cleaned up.');
  }
}

main().catch((err) => {
  console.error('\n❌ Import failed:', err.message);
  process.exit(1);
});
