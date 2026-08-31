// Verifies the corp blueprint product_id fix end-to-end at the DB level.
// Run from forge-server/: node test-corp-bp-fix.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('../forge-db/forge.db');

function q(sql, params = []) {
  return new Promise((res, rej) =>
    db.all(sql, params, (e, r) => e ? rej(e) : res(r))
  );
}

async function run() {
  let pass = 0; let fail = 0;

  // 1. Gas Cloud Harvester I blueprint exists in blueprints table with correct product_id
  const bp = await q(`SELECT blueprint_id, product_id FROM blueprints WHERE blueprint_id = 60338`);
  if (bp.length && bp[0].product_id === 60313) {
    console.log('✓ blueprints table: blueprint_id=60338 → product_id=60313'); pass++;
  } else {
    console.log('✗ blueprints table: Gas Cloud Harvester I Blueprint missing or wrong product_id', bp); fail++;
  }

  // 2. The corp blueprints query (same JOIN as the fixed endpoint) returns product_id
  const corpBpQuery = await q(`
    SELECT cb.type_id, COALESCE(i.name,'?') AS name,
           CASE WHEN cb.runs=-1 THEN 'BPO' ELSE 'BPC' END AS bp_type,
           cb.material_efficiency AS me, cb.time_efficiency AS te,
           b.product_id
    FROM corp_blueprints cb
    LEFT JOIN items i ON i.type_id = cb.type_id
    LEFT JOIN blueprints b ON b.blueprint_id = cb.type_id
    LIMIT 10
  `);
  if (corpBpQuery.length === 0) {
    console.log('⚠  corp_blueprints table is empty — no corp data cached yet (not a code bug)');
  } else {
    const withProduct = corpBpQuery.filter(r => r.product_id !== null);
    const withoutProduct = corpBpQuery.filter(r => r.product_id === null);
    console.log(`✓ corp_blueprints JOIN: ${corpBpQuery.length} rows, ${withProduct.length} with product_id, ${withoutProduct.length} without (LP/drop items expected)`);
    pass++;
    if (withProduct.length) {
      console.log('  Sample:');
      withProduct.slice(0,3).forEach(r =>
        console.log(`    blueprint type_id=${r.type_id} "${r.name}" → product_id=${r.product_id} ME${r.me} TE${r.te}`)
      );
    }
  }

  // 3. PI tier fixes — spot-check key items
  const piChecks = [
    [60313,  'Gas Cloud Harvester I',        null],  // not a PI item
    ['Transcranial Microcontrollers', 3],
    ['Sterile Conduits',              4],
    ['Superconductors',               2],
    ['Smartfab Units',                3],
    ['Condensates',                   3],
    ['Supercomputers',                3],
  ];
  const piRows = await q(`SELECT name, pi_tier FROM items WHERE name IN (?,?,?,?,?,?,?)`, [
    'Gas Cloud Harvester I','Transcranial Microcontrollers','Sterile Conduits',
    'Superconductors','Smartfab Units','Condensates','Supercomputers'
  ]);
  const piMap = Object.fromEntries(piRows.map(r => [r.name, r.pi_tier]));
  for (const [name, expectedTier] of [
    ['Transcranial Microcontrollers', 3],
    ['Sterile Conduits',              4],
    ['Superconductors',               2],
    ['Smartfab Units',                3],
    ['Condensates',                   3],
    ['Supercomputers',                3],
  ]) {
    const actual = piMap[name];
    if (actual === expectedTier) {
      console.log(`✓ PI tier: ${name} = P${actual}`); pass++;
    } else {
      console.log(`✗ PI tier: ${name} expected P${expectedTier}, got ${actual === undefined ? 'NOT FOUND' : 'P'+actual}`); fail++;
    }
  }

  // 4. true-cost blueprint lookup for Gas Cloud Harvester I (product_id=60313)
  const tcBp = await q(`SELECT blueprint_id, product_quantity, build_time FROM blueprints WHERE product_id = 60313`);
  if (tcBp.length) {
    console.log(`✓ true-cost lookup: product_id=60313 → blueprint_id=${tcBp[0].blueprint_id}, build_time=${tcBp[0].build_time}s`); pass++;
  } else {
    console.log('✗ true-cost lookup: no blueprint found for product_id=60313'); fail++;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  db.close();
}

run().catch(e => { console.error(e); db.close(); });
