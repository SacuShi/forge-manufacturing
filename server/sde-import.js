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
 *   7. Verification report
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
  'Silicon Diborite': 2, 'Silicate Glass': 2, 'Supertensile Plastics': 2,
  'Synthetic Oil': 2, 'Test Cultures': 2, 'Transcranial Microcontrollers': 2,
  'Transmitter': 2, 'Viral Agent': 2, 'Water-Cooled CPU': 2,
  // P3 — Specialized Commodities (19 items)
  'Biotech Research Reports': 3, 'Camera Drones': 3, 'Cryoprotectant Solution': 3,
  'Data Chips': 3, 'Gel-Matrix Biopaste': 3, 'Guidance Systems': 3,
  'Hazmat Detection Systems': 3, 'Hermetic Membranes': 3, 'High-Tech Transmitters': 3,
  'Industrial Explosives': 3, 'Neocoms': 3, 'Nuclear Reactors': 3,
  'Planetary Vehicles': 3, 'Robotics': 3, 'Smart Fabric': 3,
  'Sterile Conduits': 3, 'Synthetic Synapses': 3, 'Ukomi Superconductors': 3,
  'Vaccines': 3,
  // P4 — Advanced Commodities (7 items — all verified, required for capital/structure manufacturing)
  'Broadcast Node': 4, 'Integrity Response Drones': 4, 'Nano-Factory': 4,
  'Organic Mortar Applicators': 4, 'Recursive Computing Module': 4,
  'Self-Harmonizing Power Core': 4, 'Wetware Mainframe': 4,
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
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const [tier] of updates) counts[tier] = (counts[tier] || 0) + 1;
  for (const t of [1, 2, 3, 4]) {
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

// ── Step 8: Verify ────────────────────────────────────────────────────────────

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

  const totalItems = await dbGet('SELECT COUNT(*) as c FROM items');
  const piTagged   = await dbGet(`SELECT COUNT(*) as c FROM items WHERE pi_tier IS NOT NULL`);
  const rtCount    = await dbGet(`SELECT COUNT(*) as c FROM blueprints WHERE research_time IS NOT NULL`);

  console.log(`  total items in DB:              ${totalItems.c}`);
  console.log(`  items with meta_level=1 (T2):  ${t2.c}`);
  console.log(`  PI items tagged (P1–P4):        ${piTagged.c}`);
  console.log(`  blueprint_skills rows:          ${sk.c}`);
  console.log(`  blueprints — manufacturing:     ${mfgCount.c}`);
  console.log(`  blueprints — reactions:         ${rxCount.c}`);
  console.log(`  blueprints with research_time:  ${rtCount.c}`);
  console.log(`  blueprints without a name:      ${unnamed.c}${unnamed.c > 0 ? ' ⚠' : ' ✓'}`);
  if (sample?.names) console.log(`  Sample reaction products: ${sample.names}`);
  else console.log('  ⚠ No reaction products found — check blueprints.json reaction data');
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
    await ensureReactionItems(bpData, typesData);
    await ensureAllBlueprintItems(typesData);
    await importAllTypes(typesData);
    await tagPiTiers(typesData);
    await importResearchTimes(bpData);
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

main();
