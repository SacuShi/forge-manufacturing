'use strict';
// Item and blueprint reference data straight from the SDE tables.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, dbGet } = require('../lib/db');
const { clientErrMsg } = require('../lib/http-errors');
const { getCached, setCached } = require('../lib/cache');

const router = express.Router();

// ITEM NAMES DATABASE - From SQLite
router.get('/api/item-names', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('item_names');
    if (cached) {
      logger.info(`✓ Item names (cached) — ${Object.keys(cached).length} items`);
      return res.json({ items: cached });
    }

    logger.info('⟳ Loading item names from database...');
    // Load ALL items regardless of published flag — assets can contain containers,
    // mission items and legacy types that have published = 0 in the SDE.
    const rows = await dbAll('SELECT type_id, name FROM items WHERE name IS NOT NULL AND name != \'\'');
    
    const items = {};
    rows.forEach(row => {
      items[row.type_id] = row.name;
    });

    setCached('item_names', items, 86400000); // 24h
    logger.info(`✓ Item names loaded — ${Object.keys(items).length} items`);
    res.json({ items });

  } catch (err) {
    logger.error('Item names error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), items: {} });
  }
});

// BLUEPRINT DATABASE - From SQLite with Materials
router.get('/api/blueprint-database', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('blueprint_db');
    if (cached) {
      logger.info(`✓ Blueprint database (cached) — ${Object.keys(cached).length} blueprints`);
      return res.json({ blueprints: cached });
    }

    logger.info('⟳ Loading blueprints from database...');
    
    // Get all blueprints (no JOINs - names resolved client-side)
    const bpRows = await dbAll(`
      SELECT blueprint_id, product_id, build_time
      FROM blueprints
    `);

    const blueprints = {};
    
    for (const bp of bpRows) {
      // Get materials for this blueprint
      const matRows = await dbAll(`
        SELECT material_id, quantity
        FROM blueprint_materials
        WHERE blueprint_id = ?
      `, [bp.blueprint_id]);

      blueprints[bp.blueprint_id] = {
        blueprintId: bp.blueprint_id,
        productId: bp.product_id,
        buildTime: bp.build_time,
        materials: matRows.map(m => ({
          typeId: m.material_id,
          quantity: m.quantity
        }))
      };
    }

    setCached('blueprint_db', blueprints, 86400000); // 24h
    logger.info(`✓ Blueprint database loaded — ${Object.keys(blueprints).length} blueprints`);
    res.json({ blueprints });

  } catch (err) {
    logger.error('Blueprint database error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), blueprints: {} });
  }
});

// DIAGNOSE T2 BLUEPRINTS — checks session BPCs against the database
router.get('/api/diagnose-t2/:characterId', security.apiLimiter, security.verifyEveToken, security.verifyCharacterOwnership, async (req, res) => {
  try {
    const { characterId } = req.params;
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);

    if (!sessionData) {
      return res.status(400).json({ error: 'No session found — refresh the page first' });
    }

    const { blueprints } = sessionData;
    const report = { total: blueprints.length, bpc: 0, bpo: 0, inDb: [], notInDb: [], t2InDb: [], t2NotInDb: [] };

    for (const bp of blueprints) {
      const isBpc = bp.quantity > 0;
      if (isBpc) report.bpc++; else report.bpo++;

      // Look up blueprint item name; resolve product via name strip
      const bpItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [bp.type_id]);
      const bpName = bpItem?.name || `#${bp.type_id}`;
      const productName = bpName.replace(/ Blueprint$/i, '').trim();

      // Single product lookup — gives us meta_level (T2 check) AND type_id (fallback DB lookup)
      const productItem = bpName.toLowerCase().includes('blueprint')
        ? await dbGet('SELECT type_id, meta_level FROM items WHERE name = ? COLLATE NOCASE', [productName])
        : null;
      const bpIsT2 = (productItem?.meta_level ?? 0) === 1;

      // Check if it's in blueprints table (by blueprint_id, then by product_id)
      const inDb = await dbGet('SELECT blueprint_id FROM blueprints WHERE blueprint_id = ?', [bp.type_id]);
      let inDbFallback = null;
      if (!inDb && productItem?.type_id) {
        inDbFallback = await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [productItem.type_id]);
      }

      const found = !!(inDb || inDbFallback);
      const entry = { type_id: bp.type_id, name: bpName, is_t2: bpIsT2, is_bpc: isBpc, found_via: inDb ? 'blueprint_id' : inDbFallback ? 'product_id' : null };

      if (found) {
        report.inDb.push(entry);
        if (bpIsT2) report.t2InDb.push(entry);
      } else {
        report.notInDb.push(entry);
        if (bpIsT2) report.t2NotInDb.push(entry);
      }
    }

    report.summary = `${report.inDb.length}/${report.total} blueprints found in DB. T2: ${report.t2InDb.length} found, ${report.t2NotInDb.length} missing.`;
    logger.info(`🔍 T2 Diagnose for ${characterId}: ${report.summary}`);
    res.json(report);
  } catch (err) {
    logger.error('❌ T2 diagnose error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

// GET BLUEPRINT METADATA (meta_level per blueprint type_id)
router.post('/api/blueprint-metadata', security.apiLimiter, async (req, res) => {
  try {
    const { blueprintTypeIds } = req.body;
    if (!Array.isArray(blueprintTypeIds) || blueprintTypeIds.length === 0) {
      return res.json({});
    }

    const limited = blueprintTypeIds.slice(0, 500);
    const placeholders = limited.map(() => '?').join(',');

    // Run both queries in parallel
    const [itemRows, bpRows] = await Promise.all([
      dbAll(`SELECT type_id, meta_level FROM items WHERE type_id IN (${placeholders})`, limited),
      dbAll(`SELECT blueprint_id, product_id FROM blueprints WHERE blueprint_id IN (${placeholders})`, limited),
    ]);

    const metadata = {};
    limited.forEach(id => { metadata[id] = { metaLevel: 0, productTypeId: null }; });
    itemRows.forEach(r => { metadata[r.type_id].metaLevel = r.meta_level ?? 0; });
    bpRows.forEach(r => { if (metadata[r.blueprint_id]) metadata[r.blueprint_id].productTypeId = r.product_id; });

    res.json(metadata);
  } catch (err) {
    logger.error('❌ Blueprint metadata error:', err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
