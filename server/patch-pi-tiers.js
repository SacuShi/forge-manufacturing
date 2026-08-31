const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('../forge-db/forge.db');

const updates = [
  ["UPDATE items SET pi_tier = 3 WHERE name = 'Transcranial Microcontrollers'", 'Transcranial Microcontrollers → P3'],
  ["UPDATE items SET pi_tier = 4 WHERE name = 'Sterile Conduits'",              'Sterile Conduits → P4'],
  ["UPDATE items SET pi_tier = 2 WHERE name = 'Superconductors'",               'Superconductors → P2'],
  ["UPDATE items SET pi_tier = NULL WHERE name = 'Silicon Diborite'",            'Silicon Diborite → cleared'],
  ["UPDATE items SET pi_tier = 3 WHERE name = 'Smartfab Units'",                'Smartfab Units → P3'],
  ["UPDATE items SET pi_tier = NULL WHERE name = 'Smart Fabric'",               'Smart Fabric → cleared'],
  ["UPDATE items SET pi_tier = 3 WHERE name = 'Condensates'",                   'Condensates → P3'],
  ["UPDATE items SET pi_tier = 3 WHERE name = 'Supercomputers'",                'Supercomputers → P3'],
];

function runNext(i) {
  if (i >= updates.length) {
    db.all('SELECT name, pi_tier FROM items WHERE pi_tier IS NOT NULL ORDER BY pi_tier, name', (err, rows) => {
      if (err) { console.error(err); db.close(); return; }
      console.log(`\nFull PI item list (${rows.length} items):`);
      for (const r of rows) console.log(`  P${r.pi_tier}: ${r.name}`);
      db.close();
    });
    return;
  }
  const [sql, label] = updates[i];
  db.run(sql, function(err) {
    if (err) console.error(`  ✗ ${label}: ${err.message}`);
    else console.log(`  ${this.changes > 0 ? '✓' : '✗ NOT FOUND'} ${label}`);
    runNext(i + 1);
  });
}

runNext(0);
