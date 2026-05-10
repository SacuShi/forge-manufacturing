// F.O.R.G.E. Server v2.3.2.1 (v0.9.2.1) - 4-Tier Filtering (Severity Fix)
// All blueprint/item data from SQLite, not APIs
// Pre-computed profitability + 4-tier filtering with severity levels (CRITICAL vs WARNING)
// + Comprehensive security: auth, rate limiting, input validation

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const helmet = require('helmet');
const security = require('./forge-security');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Trust Cloudflared proxy
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "https://login.eveonline.com", "https://esi.evetech.net", "https://evetycoon.com"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: ["'self'", "data:"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

// CORS - restrict to your domain only
app.use(cors({
  origin: ['https://forge-ukc.com', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '5mb' })); // Allows session data upload (assets/blueprints)
app.use(express.static('public'));

// SQLite Database
const DB_PATH = path.join(__dirname, '../forge-db/forge.db');
let db;

function initDatabase() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('❌ Database not found. Run seed script first:');
        console.log('   mkdir -p ../forge-db');
        console.log('   cd ../forge-db && node seed.js');
        reject(err);
      } else {
        console.log('✓ Connected to SQLite database');
        resolve();
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

// ═══════════════════════════════════════════════════════════════════════
// DATABASE MIGRATION (v0.9.0)
// ═══════════════════════════════════════════════════════════════════════
async function runMigrations() {
  console.log('⟳ Running database migrations...');

  // Pre-computed profitability table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS precomputed_profits (
      blueprint_id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL,
      product_name TEXT,
      material_cost REAL DEFAULT 0,
      sell_price REAL DEFAULT 0,
      buy_price REAL DEFAULT 0,
      profit REAL DEFAULT 0,
      profit_margin REAL DEFAULT 0,
      isk_per_hour REAL DEFAULT 0,
      build_time INTEGER DEFAULT 0,
      material_count INTEGER DEFAULT 0,
      computed_at TEXT NOT NULL,
      price_source TEXT DEFAULT 'jita',
      avg_daily_volume REAL DEFAULT NULL,
      market_group_id INTEGER DEFAULT NULL,
      liquidity_risk TEXT DEFAULT NULL
    )
  `);

  // Index for common queries
  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_profit
    ON precomputed_profits (profit DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_margin
    ON precomputed_profits (profit_margin DESC)
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_precomputed_isk_hr
    ON precomputed_profits (isk_per_hour DESC)
  `);

  // AI usage tracking table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      character_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost REAL DEFAULT 0,
      query_type TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_ai_usage_date
    ON ai_usage (created_at)
  `);

  // Pre-compute metadata table (tracks job runs)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS precompute_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      blueprints_processed INTEGER DEFAULT 0,
      duration_seconds REAL DEFAULT 0,
      status TEXT DEFAULT 'running',
      error TEXT
    )
  `);

  // v0.9.1 migration: Add volume/market columns to existing tables
  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN avg_daily_volume REAL DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN market_group_id INTEGER DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  try {
    await dbRun(`ALTER TABLE precomputed_profits ADD COLUMN liquidity_risk TEXT DEFAULT NULL`);
  } catch (_) { /* column already exists */ }

  console.log('✓ Database migrations complete');
}

// Simple cache
const cache = new Map();
const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCached = (key, data, ttl = 3600000) => {
  cache.set(key, { data, expiry: Date.now() + ttl });
};

// ═══════════════════════════════════════════════════════════════════════
// EVE OAUTH
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/eve-token', security.authLimiter, async (req, res) => {
  try {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: "Missing code or redirect_uri" });
    }

    const clientId = process.env.EVE_CLIENT_ID;
    const clientSecret = process.env.EVE_CLIENT_SECRET;

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://login.eveonline.com/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': 'login.eveonline.com'
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirect_uri)}`
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("EVE OAuth error:", tokenData);
      return res.status(400).json({ error: tokenData.error_description || "Token exchange failed" });
    }

    console.log("✓ EVE OAuth successful");
    res.json(tokenData);

  } catch (err) {
    console.error("OAuth error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// JITA PRICES (Buy/Sell/Median) - Hourly Cache
// ═══════════════════════════════════════════════════════════════════════
let jitaPricesCache = null;
let jitaPricesCacheExpiry = 0;

app.get('/api/jita-prices', security.apiLimiter, async (req, res) => {
  try {
    if (jitaPricesCache && Date.now() < jitaPricesCacheExpiry) {
      console.log(`✓ Jita prices (cached) — ${Object.keys(jitaPricesCache).length} items`);
      return res.json({ prices: jitaPricesCache });
    }

    console.log('⟳ Fetching Jita market data...');
    const JITA_REGION = 10000002;
    const prices = {};
    let totalOrders = 0;

    // Fetch sell orders
    for (let page = 1; page <= 50; page++) {
      const res = await fetch(
        `https://esi.evetech.net/latest/markets/${JITA_REGION}/orders/?datasource=tranquility&order_type=sell&page=${page}`
      );
      if (!res.ok) break;
      const orders = await res.json();
      if (!orders || orders.length === 0) break;

      orders.forEach(o => {
        if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
        if (o.price < prices[o.type_id].sell) prices[o.type_id].sell = o.price;
      });

      totalOrders += orders.length;
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Fetch buy orders
    for (let page = 1; page <= 50; page++) {
      const res = await fetch(
        `https://esi.evetech.net/latest/markets/${JITA_REGION}/orders/?datasource=tranquility&order_type=buy&page=${page}`
      );
      if (!res.ok) break;
      const orders = await res.json();
      if (!orders || orders.length === 0) break;

      orders.forEach(o => {
        if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
        if (o.price > prices[o.type_id].buy) prices[o.type_id].buy = o.price;
      });

      totalOrders += orders.length;
      const xPages = res.headers.get('x-pages');
      if (!xPages || page >= parseInt(xPages)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Calculate median with outlier filtering
    Object.keys(prices).forEach(typeId => {
      const p = prices[typeId];
      
      // Step 1: Handle items with no sell orders (prevents Infinity in calculations)
      if (p.sell === Infinity) {
        p.sell = 0;
      }
      
      // Step 2: Outlier filtering
      // Case A: Standard outlier (has buy orders) - use 5x rule (500% margin max)
      // Based on Adam4EVE research: Real margins rarely exceed 500% except mutaplasmids
      if (p.buy > 0 && p.sell > p.buy * 5) {
        const marginPercent = ((p.sell / p.buy) - 1) * 100;
        console.warn(`⚠ Outlier filtered: typeId ${typeId} margin=${marginPercent.toFixed(0)}% (max 500%)`);
        p.median = p.buy;
      }
      // Case B: No buy orders but suspiciously high sell price (>100M)
      // Likely scam listing - use heavily discounted price
      else if (p.buy === 0 && p.sell > 100000000) {
        console.warn(`⚠ No-bid outlier: typeId ${typeId} sell=${p.sell} (no buy orders, likely scam)`);
        p.median = p.sell * 0.1; // 90% discount for suspicious no-bid items
      }
      // Step 3: Normal median calculation
      else {
        p.median = (p.sell + p.buy) / 2;
      }
    });

    jitaPricesCache = prices;
    jitaPricesCacheExpiry = Date.now() + 3600000;

    console.log(`✓ Jita prices cached — ${Object.keys(prices).length} items (${totalOrders} orders)`);
    res.json({ prices });

  } catch (err) {
    console.error('Jita prices error:', err.message);
    if (jitaPricesCache) {
      return res.json({ prices: jitaPricesCache, stale: true });
    }
    res.status(500).json({ error: err.message, prices: {} });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ITEM NAMES DATABASE - From SQLite
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/item-names', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('item_names');
    if (cached) {
      console.log(`✓ Item names (cached) — ${Object.keys(cached).length} items`);
      return res.json({ items: cached });
    }

    console.log('⟳ Loading item names from database...');
    const rows = await dbAll('SELECT type_id, name FROM items WHERE published = 1');
    
    const items = {};
    rows.forEach(row => {
      items[row.type_id] = row.name;
    });

    setCached('item_names', items, 86400000); // 24h
    console.log(`✓ Item names loaded — ${Object.keys(items).length} items`);
    res.json({ items });

  } catch (err) {
    console.error('Item names error:', err.message);
    res.status(500).json({ error: err.message, items: {} });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// BLUEPRINT DATABASE - From SQLite with Materials
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/blueprint-database', security.apiLimiter, async (req, res) => {
  try {
    const cached = getCached('blueprint_db');
    if (cached) {
      console.log(`✓ Blueprint database (cached) — ${Object.keys(cached).length} blueprints`);
      return res.json({ blueprints: cached });
    }

    console.log('⟳ Loading blueprints from database...');
    
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
    console.log(`✓ Blueprint database loaded — ${Object.keys(blueprints).length} blueprints`);
    res.json({ blueprints });

  } catch (err) {
    console.error('Blueprint database error:', err.message);
    res.status(500).json({ error: err.message, blueprints: {} });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// CALCULATE PROFITABILITY - Server-side pre-calculation
// Returns only top N profitable items
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/calculate-profitability', async (req, res) => {
  try {
    const { ownedBlueprints, topN = 20 } = req.body;
    
    if (!ownedBlueprints || !Array.isArray(ownedBlueprints)) {
      return res.status(400).json({ error: "ownedBlueprints array required" });
    }

    console.log(`⟳ Calculating profitability for ${ownedBlueprints.length} blueprints...`);

    const blueprintIds = ownedBlueprints.map(bp => bp.type_id);
    const results = [];
    const prices = jitaPricesCache || {};

    for (const bpId of blueprintIds) {
      const bp = await dbGet(`
        SELECT b.blueprint_id, b.product_id, b.build_time, i.name as product_name
        FROM blueprints b
        JOIN items i ON i.type_id = b.product_id
        WHERE b.blueprint_id = ?
      `, [bpId]);

      if (!bp) continue;

      // Get materials
      const materials = await dbAll(`
        SELECT bm.material_id, bm.quantity, i.name as material_name
        FROM blueprint_materials bm
        JOIN items i ON i.type_id = bm.material_id
        WHERE bm.blueprint_id = ?
      `, [bpId]);

      // Calculate material cost (with recursive manufacturing check)
      let totalMatCost = 0;
      const matDetails = [];

      for (const mat of materials) {
        const cost = await calculateMaterialCost(mat.material_id, mat.quantity, prices);
        totalMatCost += cost;
        matDetails.push({
          name: mat.material_name,
          quantity: mat.quantity,
          cost: cost
        });
      }

      const sellPrice = prices[bp.product_id]?.sell || 0;
      const profit = sellPrice - totalMatCost;
      const profitMargin = sellPrice > 0 ? (profit / sellPrice) * 100 : 0;

      results.push({
        blueprintId: bpId,
        productId: bp.product_id,
        productName: bp.product_name,
        sellPrice: sellPrice,
        materialCost: totalMatCost,
        profit: profit,
        profitMargin: profitMargin,
        buildTime: bp.build_time,
        materials: matDetails
      });
    }

    results.sort((a, b) => b.profit - a.profit);
    const topResults = results.slice(0, topN);

    console.log(`✓ Top ${topResults.length} most profitable calculated`);
    res.json({ profitable: topResults, total: results.length });

  } catch (err) {
    console.error('Profitability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: Calculate material cost (checks if it can be manufactured)
async function calculateMaterialCost(materialId, quantity, prices) {
  const bp = await dbGet('SELECT blueprint_id FROM blueprints WHERE product_id = ?', [materialId]);
  
  if (bp) {
    const subMats = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [bp.blueprint_id]
    );
    
    let mfgCost = 0;
    for (const sub of subMats) {
      const subCost = await calculateMaterialCost(sub.material_id, sub.quantity, prices);
      mfgCost += subCost;
    }
    
    const buyCost = (prices[materialId]?.buy || 0) * quantity;
    return Math.min(mfgCost * quantity, buyCost);
  } else {
    return (prices[materialId]?.buy || 0) * quantity;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PRODUCTION CHAIN - Full recursive build tree
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/production-chain', async (req, res) => {
  try {
    const { itemName, ownedBlueprints } = req.body;

    if (!itemName) {
      return res.status(400).json({ error: "itemName required" });
    }

    console.log(`⟳ Building production chain for: ${itemName}`);

    const item = await dbGet('SELECT type_id, name FROM items WHERE name LIKE ? LIMIT 1', [`%${itemName}%`]);
    if (!item) {
      return res.json({ error: `Item "${itemName}" not found`, chain: null });
    }

    const bp = await dbGet('SELECT blueprint_id, build_time FROM blueprints WHERE product_id = ?', [item.type_id]);
    if (!bp) {
      return res.json({ error: `No blueprint produces "${itemName}"`, chain: null });
    }

    const ownedBpIds = ownedBlueprints ? ownedBlueprints.map(b => b.type_id) : [];
    const userOwns = ownedBpIds.includes(bp.blueprint_id);

    const materials = await dbAll(`
      SELECT bm.material_id, bm.quantity, i.name
      FROM blueprint_materials bm
      JOIN items i ON i.type_id = bm.material_id
      WHERE bm.blueprint_id = ?
    `, [bp.blueprint_id]);

    const prices = jitaPricesCache || {};
    const chain = {
      item: item.name,
      itemId: item.type_id,
      blueprintId: bp.blueprint_id,
      owned: userOwns,
      buildTime: bp.build_time,
      materials: []
    };

    for (const mat of materials) {
      const matChain = await buildMaterialChain(mat, prices, ownedBpIds);
      chain.materials.push(matChain);
    }

    chain.totalCost = chain.materials.reduce((sum, m) => sum + m.cost, 0);
    chain.sellPrice = prices[item.type_id]?.sell || 0;
    chain.profit = chain.sellPrice - chain.totalCost;

    console.log(`✓ Production chain built for ${item.name}`);
    res.json({ chain });

  } catch (err) {
    console.error('Production chain error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function buildMaterialChain(material, prices, ownedBpIds) {
  const matId = material.material_id;
  const quantity = material.quantity;
  const name = material.name;

  const bp = await dbGet('SELECT blueprint_id, build_time FROM blueprints WHERE product_id = ?', [matId]);

  if (bp) {
    const userOwns = ownedBpIds.includes(bp.blueprint_id);
    
    const subMats = await dbAll(`
      SELECT bm.material_id, bm.quantity, i.name
      FROM blueprint_materials bm
      JOIN items i ON i.type_id = bm.material_id
      WHERE bm.blueprint_id = ?
    `, [bp.blueprint_id]);

    let mfgCost = 0;
    const subChain = [];
    
    for (const subMat of subMats) {
      const sub = await buildMaterialChain(subMat, prices, ownedBpIds);
      mfgCost += sub.cost;
      subChain.push(sub);
    }

    mfgCost *= quantity;
    const buyCost = (prices[matId]?.buy || 0) * quantity;
    const cheaper = mfgCost < buyCost ? 'manufacture' : 'buy';
    const cost = Math.min(mfgCost, buyCost);

    return {
      materialId: matId,
      name: name,
      quantity: quantity,
      canManufacture: true,
      blueprintOwned: userOwns,
      manufactureCost: mfgCost,
      buyCost: buyCost,
      recommendation: cheaper,
      cost: cost,
      subMaterials: subChain
    };
  } else {
    const buyCost = (prices[matId]?.buy || 0) * quantity;
    return {
      materialId: matId,
      name: name,
      quantity: quantity,
      canManufacture: false,
      buyCost: buyCost,
      cost: buyCost
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GET JITA PRICE - Single item price lookup from cache
// Used by AI tool to query prices on-demand
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/get-price', async (req, res) => {
  try {
    const { itemName, typeId } = req.body;
    
    if (!itemName && !typeId) {
      return res.status(400).json({ error: "itemName or typeId required" });
    }
    
    let targetTypeId = typeId;
    
    // If item name provided, find type_id
    if (itemName && !typeId) {
      const item = await dbGet(
        'SELECT type_id FROM items WHERE name LIKE ? LIMIT 1',
        [`%${itemName}%`]
      );
      
      if (!item) {
        return res.json({ error: `Item "${itemName}" not found`, price: null });
      }
      
      targetTypeId = item.type_id;
    }
    
    // Get price from cache
    const prices = jitaPricesCache || {};
    const priceData = prices[targetTypeId];
    
    if (!priceData) {
      return res.json({ 
        error: "Price not available in cache",
        itemName: itemName,
        typeId: targetTypeId,
        price: null 
      });
    }
    
    console.log(`✓ Price lookup: ${itemName || targetTypeId} → ${priceData.sell} ISK`);
    
    res.json({
      itemName: itemName,
      typeId: targetTypeId,
      sell: priceData.sell,
      buy: priceData.buy,
      median: priceData.median
    });
    
  } catch (err) {
    console.error('Price lookup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET BLUEPRINT - Query any blueprint from database
// Used by AI to get materials for any item
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/get-blueprint', async (req, res) => {
  // Ensure JSON response even on catastrophic failure
  try {
    const { itemName, productId } = req.body;
    
    if (!itemName && !productId) {
      return res.json({ error: "itemName or productId required", blueprint: null });
    }
    
    let targetProductId = productId;
    
    // If item name provided, find product_id
    if (itemName && !productId) {
      const item = await dbGet(
        'SELECT type_id FROM items WHERE name LIKE ? LIMIT 1',
        [`%${itemName}%`]
      );
      
      if (!item) {
        return res.json({ 
          error: `Item "${itemName}" not found in database`,
          blueprint: null 
        });
      }
      
      targetProductId = item.type_id;
    }
    
    // Get blueprint for this product
    const blueprint = await dbGet(
      'SELECT blueprint_id, product_id, build_time FROM blueprints WHERE product_id = ?',
      [targetProductId]
    );
    
    if (!blueprint) {
      return res.json({
        error: `No blueprint found for this item`,
        itemName: itemName,
        productId: targetProductId,
        blueprint: null
      });
    }
    
    // Get materials
    const materials = await dbAll(
      'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
      [blueprint.blueprint_id]
    );
    
    // Get item names and prices for materials
    const materialsWithDetails = await Promise.all(
      materials.map(async (mat) => {
        let matItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [mat.material_id]);
        let matName;
        
        // If not in database, try to fetch from ESI
        if (!matItem) {
          try {
            const esiRes = await fetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
            if (esiRes.ok) {
              const esiData = await esiRes.json();
              matName = esiData.name || `Unknown Item ${mat.material_id}`;
              
              // Optionally cache it in database for next time
              await dbRun(
                'INSERT OR IGNORE INTO items (type_id, name) VALUES (?, ?)',
                [mat.material_id, matName]
              );
            } else {
              matName = `Unknown Item ${mat.material_id}`;
            }
          } catch (err) {
            matName = `Item ID ${mat.material_id}`;
          }
        } else {
          matName = matItem.name;
        }
        
        const matPrice = jitaPricesCache ? jitaPricesCache[mat.material_id] : null;
        
        return {
          materialId: mat.material_id,
          name: matName,
          quantity: mat.quantity,
          unitCost: matPrice ? matPrice.buy : 0,
          totalCost: matPrice ? matPrice.buy * mat.quantity : 0
        };
      })
    );
    
    const totalCost = materialsWithDetails.reduce((sum, m) => sum + m.totalCost, 0);
    const productPrice = jitaPricesCache ? jitaPricesCache[targetProductId] : null;
    const sellPrice = productPrice ? productPrice.median : 0;
    const profit = sellPrice - totalCost;
    
    console.log(`✓ Blueprint lookup: ${itemName || targetProductId} → ${materials.length} materials`);
    
    res.json({
      blueprintId: blueprint.blueprint_id,
      productId: blueprint.product_id,
      buildTime: blueprint.build_time,
      materials: materialsWithDetails,
      totalCost: totalCost,
      sellPrice: sellPrice,
      profit: profit,
      profitMargin: sellPrice > 0 ? (profit / sellPrice) * 100 : 0
    });
    
  } catch (err) {
    console.error('Blueprint lookup error:', err.message);
    res.json({ error: err.message, blueprint: null });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ITEM DETAILS - For right panel with build analysis
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/item-details', async (req, res) => {
  try {
    const { typeId, assets, ownedBlueprints } = req.body;
    if (!typeId) {
      return res.status(400).json({ error: "Missing typeId" });
    }

    // Get from database first
    const item = await dbGet('SELECT name, description, icon_url, volume, mass FROM items WHERE type_id = ?', [typeId]);
    
    const itemDetails = item ? {
      name: item.name,
      description: item.description,
      iconUrl: item.icon_url,
      volume: item.volume,
      mass: item.mass
    } : {};

    // Get market history from ESI (not cached per-item to save memory)
    const JITA_REGION = 10000002;
    const historyRes = await fetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${typeId}`
    );

    if (historyRes.ok) {
      const historyData = await historyRes.json();
      if (Array.isArray(historyData) && historyData.length > 0) {
        const sorted = historyData
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 90)
          .reverse();
        
        itemDetails.priceHistory = sorted.map(day => ({
          date: day.date,
          average: day.average,
          highest: day.highest,
          lowest: day.lowest,
          volume: day.volume,
          orderCount: day.order_count
        }));
      }
    }

    // Add current Jita prices from cache
    const prices = jitaPricesCache || {};
    if (prices[typeId]) {
      itemDetails.currentPrice = {
        sell: prices[typeId].sell,
        buy: prices[typeId].buy,
        median: prices[typeId].median
      };
    }

    // BUILD ANALYSIS (if assets and blueprints provided)
    if (assets && ownedBlueprints) {
      // Check if blueprint exists for this item
      const blueprint = await dbGet(
        'SELECT blueprint_id, build_time FROM blueprints WHERE product_id = ?',
        [typeId]
      );

      if (blueprint) {
        // User owns this blueprint?
        const userOwnsBlueprint = ownedBlueprints.some(bp => bp.type_id === blueprint.blueprint_id);

        // Get materials needed
        const materials = await dbAll(
          `SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?`,
          [blueprint.blueprint_id]
        );

        // Group user assets by type_id for quick lookup
        const assetQuantities = {};
        assets.forEach(asset => {
          assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
        });

        // Compare materials with assets
        const materialAnalysis = [];
        let totalCost = 0;
        let canBuild = true;

        for (const mat of materials) {
          const userHas = assetQuantities[mat.material_id] || 0;
          const needed = mat.quantity;
          const shortage = Math.max(0, needed - userHas);
          
          // Get material name
          const matItem = await dbGet('SELECT name FROM items WHERE type_id = ?', [mat.material_id]);
          let matName;
          
          if (!matItem) {
            // Try to fetch from ESI
            try {
              const esiRes = await fetch(`https://esi.evetech.net/latest/universe/types/${mat.material_id}/?datasource=tranquility`);
              if (esiRes.ok) {
                const esiData = await esiRes.json();
                matName = esiData.name || `Unknown Material ${mat.material_id}`;
                
                // Cache it in database for next time
                await dbRun(
                  'INSERT OR IGNORE INTO items (type_id, name) VALUES (?, ?)',
                  [mat.material_id, matName]
                );
              } else {
                matName = `Unknown Material ${mat.material_id}`;
              }
            } catch (err) {
              matName = `ID:${mat.material_id}`;
            }
          } else {
            matName = matItem.name;
          }

          // Get material price
          const matPrice = prices[mat.material_id];
          const unitCost = matPrice ? matPrice.buy : 0;
          const itemCost = unitCost * needed;
          totalCost += itemCost;

          materialAnalysis.push({
            materialId: mat.material_id,
            name: matName,
            needed: needed,
            have: userHas,
            shortage: shortage,
            unitCost: unitCost,
            totalCost: itemCost,
            shortfallCost: unitCost * shortage
          });

          if (shortage > 0) canBuild = false;
        }

        // Calculate potential profit
        const sellPrice = itemDetails.currentPrice ? itemDetails.currentPrice.sell : 0;
        const profit = sellPrice - totalCost;
        const profitMargin = sellPrice > 0 ? (profit / sellPrice) * 100 : 0;

        itemDetails.buildInfo = {
          canBuild: userOwnsBlueprint && canBuild,
          blueprintOwned: userOwnsBlueprint,
          blueprintId: blueprint.blueprint_id,
          buildTime: blueprint.build_time,
          materials: materialAnalysis,
          totalCost: totalCost,
          sellPrice: sellPrice,
          profit: profit,
          profitMargin: profitMargin
        };
      }
    }

    console.log(`✓ Item details fetched — ${itemDetails.name || typeId}${itemDetails.buildInfo ? ' (with build analysis)' : ''}`);
    res.json(itemDetails);

  } catch (err) {
    console.error("Item details error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ANALYZE BLUEPRINTS - Calculate profitability/buildability for all user BPs
// Used by AI to get top profitable/buildable items
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/analyze-blueprints', async (req, res) => {
  try {
    const { ownedBlueprints, assets, sortBy = 'profit', limit = 20, buildableOnly = false } = req.body;
    
    if (!ownedBlueprints || !Array.isArray(ownedBlueprints)) {
      return res.status(400).json({ error: "ownedBlueprints array required" });
    }
    
    if (!assets || !Array.isArray(assets)) {
      return res.status(400).json({ error: "assets array required" });
    }
    
    // WAIT FOR PRICE CACHE TO LOAD (if not already loaded)
    // This ensures we always return real prices, never 0 ISK
    if (!jitaPricesCache || Date.now() >= jitaPricesCacheExpiry) {
      console.log('⟳ Loading Jita prices for analysis...');
      
      // Load prices from ESI
      try {
        const buyRes = await fetch('https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=buy');
        const sellRes = await fetch('https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=sell');
        
        if (buyRes.ok && sellRes.ok) {
          const buyOrders = await buyRes.json();
          const sellOrders = await sellRes.json();
          
          const prices = {};
          
          // Process sell orders (lowest sell = what you pay to buy)
          sellOrders.forEach(o => {
            if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
            if (o.price < prices[o.type_id].sell) prices[o.type_id].sell = o.price;
          });
          
          // Process buy orders (highest buy = what you get when selling)
          buyOrders.forEach(o => {
            if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
            if (o.price > prices[o.type_id].buy) prices[o.type_id].buy = o.price;
          });
          
          // Calculate median
          Object.keys(prices).forEach(typeId => {
            const p = prices[typeId];
            if (p.sell === Infinity) p.sell = p.buy;
            if (p.buy === 0) p.buy = p.sell;
            p.median = (p.sell + p.buy) / 2;
          });
          
          jitaPricesCache = prices;
          jitaPricesCacheExpiry = Date.now() + (60 * 60 * 1000); // 1 hour
          
          console.log(`✓ Jita prices loaded — ${Object.keys(prices).length} items`);
        }
      } catch (err) {
        console.error('⚠ Failed to load prices, proceeding with cached/zero prices:', err.message);
      }
    }
    
    console.log(`⟳ Analyzing ${ownedBlueprints.length} blueprints...`);
    
    // Group assets by type_id for quick lookup
    const assetQuantities = {};
    assets.forEach(asset => {
      assetQuantities[asset.type_id] = (assetQuantities[asset.type_id] || 0) + asset.quantity;
    });
    
    // Analyze each blueprint
    const results = [];
    
    for (const bp of ownedBlueprints) {
      // Get blueprint data from database
      const blueprint = await dbGet(
        'SELECT blueprint_id, product_id, build_time FROM blueprints WHERE blueprint_id = ?',
        [bp.type_id]
      );
      
      if (!blueprint) continue; // Skip if not in database
      
      // Get product name (skip ESI for bulk operations - too slow)
      let product = await dbGet('SELECT name FROM items WHERE type_id = ?', [blueprint.product_id]);
      let productName = product ? product.name : null; // Return null if not found, don't fetch from ESI
      
      // Get materials
      const materials = await dbAll(
        'SELECT material_id, quantity FROM blueprint_materials WHERE blueprint_id = ?',
        [blueprint.blueprint_id]
      );
      
      // Calculate costs and buildability
      let totalCost = 0;
      let canBuild = true;
      const materialDetails = [];
      
      for (const mat of materials) {
        const userHas = assetQuantities[mat.material_id] || 0;
        const needed = mat.quantity;
        const shortage = Math.max(0, needed - userHas);
        
        const matPrice = jitaPricesCache ? jitaPricesCache[mat.material_id] : null;
        const unitCost = matPrice ? matPrice.buy : 0;
        totalCost += unitCost * needed;
        
        if (shortage > 0) canBuild = false;
        
        materialDetails.push({
          materialId: mat.material_id,
          needed: needed,
          have: userHas,
          shortage: shortage
        });
      }
      
      // Get sell price - use MEDIAN instead of sell for more realistic pricing
      const productPrice = jitaPricesCache ? jitaPricesCache[blueprint.product_id] : null;
      const sellPrice = productPrice ? productPrice.median : 0;
      const profit = sellPrice - totalCost;
      const profitMargin = sellPrice > 0 ? (profit / sellPrice) * 100 : 0;
      
      results.push({
        blueprintId: blueprint.blueprint_id,
        productId: blueprint.product_id,
        productName: productName,
        buildTime: blueprint.build_time,
        totalCost: totalCost,
        sellPrice: sellPrice,
        profit: profit,
        profitMargin: profitMargin,
        canBuild: canBuild,
        materialCount: materials.length,
        materials: materialDetails
      });
    }
    
    // Filter buildable only if requested
    let filtered = buildableOnly ? results.filter(r => r.canBuild) : results;
    
    // Sort by requested criteria
    switch (sortBy) {
      case 'profit':
        filtered.sort((a, b) => b.profit - a.profit);
        break;
      case 'cost':
        filtered.sort((a, b) => b.totalCost - a.totalCost);
        break;
      case 'time':
        filtered.sort((a, b) => b.buildTime - a.buildTime);
        break;
      case 'materials':
        filtered.sort((a, b) => b.materialCount - a.materialCount);
        break;
      case 'margin':
        filtered.sort((a, b) => b.profitMargin - a.profitMargin);
        break;
      default:
        filtered.sort((a, b) => b.profit - a.profit);
    }
    
    // Return top N results
    const topResults = filtered.slice(0, limit);
    
    console.log(`✓ Blueprint analysis complete — Top ${topResults.length} results (sorted by ${sortBy})`);
    
    res.json({
      total: results.length,
      buildable: results.filter(r => r.canBuild).length,
      results: topResults
    });
    
  } catch (err) {
    console.error('Blueprint analysis error:', err.message);
    console.error('Stack:', err.stack); // More detailed error logging
    res.json({ 
      error: err.message,
      total: 0,
      buildable: 0,
      results: []
    });
  }
});


// ═══════════════════════════════════════════════════════════════════════
// AI CHAT - Anthropic proxy with function calling
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/ai-chat',
  security.aiLimiter,
  security.verifyEveToken,
  security.validateAiChatInput,
  async (req, res) => {
  try {
    const { messages, system, maxTokens = 2000 } = req.body;
    const characterId = req.characterId;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Load session data from cache
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);
    
    console.log(`🔍 AI Chat - Character: ${characterId}, Session Key: ${sessionKey}, Cache Hit: ${!!sessionData}`);
    
    if (!sessionData) {
      console.error(`❌ No session data found for character ${characterId}`);
      return res.status(400).json({ 
        error: "No session data found. Please refresh the page to reload your character data.",
        code: "SESSION_EXPIRED"
      });
    }

    console.log(`✓ Session data loaded: ${sessionData.assets?.length || 0} assets, ${sessionData.blueprints?.length || 0} blueprints`);

    const { assets, blueprints, prices, wallet, jobs } = sessionData;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    // Tool definitions for AI
    const tools = [
      {
        name: "get_blueprint",
        description: "Get blueprint materials and costs for any EVE item. Use when user asks about building a specific item or wants to know materials/costs. Can also resolve item names from IDs.",
        input_schema: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Name of the item to get blueprint for (e.g., 'Drake', 'Vulture')"
            },
            productId: {
              type: "number",
              description: "Type ID of the item (use when productName is null in analyze_blueprints results)"
            }
          }
        }
      },
      {
        name: "analyze_blueprints",
        description: "Analyze ALL user's blueprints for profitability, buildability, costs. Use when user asks 'what's most profitable', 'what can I build', 'best items to make', etc.",
        input_schema: {
          type: "object",
          properties: {
            sortBy: {
              type: "string",
              enum: ["profit", "cost", "time", "materials", "margin"],
              description: "How to sort results: profit (most profitable), cost (most expensive), time (longest build), materials (most materials), margin (best profit %)"
            },
            limit: {
              type: "number",
              description: "How many results to return (default 20, max 50)"
            },
            buildableOnly: {
              type: "boolean",
              description: "Only show items user can build right now with current assets"
            }
          },
          required: ["sortBy"]
        }
      },
      {
        name: "get_price",
        description: "Get current Jita market price for any item. Use when you need price for an item not in your context.",
        input_schema: {
          type: "object",
          properties: {
            itemName: {
              type: "string",
              description: "Name of the item to get price for"
            }
          },
          required: ["itemName"]
        }
      },
      {
        name: "get_precomputed",
        description: "PREFERRED: Get pre-computed profitability data from the database with volume filtering. Use this FIRST for questions about 'what is profitable', 'top items to build', 'best ISK/hour', 'most profitable blueprints'. Automatically excludes low-volume items, Titans, and other contract-only items by default. Much faster than analyze_blueprints and costs zero AI tokens. Only fall back to analyze_blueprints if user needs buildability checks against their specific assets.",
        input_schema: {
          type: "object",
          properties: {
            sort: {
              type: "string",
              enum: ["profit", "margin", "isk_per_hour"],
              description: "How to sort: profit (highest ISK profit), margin (best % margin), isk_per_hour (best time efficiency)"
            },
            limit: {
              type: "number",
              description: "How many results (default 20, max 100)"
            },
            search: {
              type: "string",
              description: "Optional: search for a specific item by name (e.g., 'Drake', 'Raven')"
            },
            minProfit: {
              type: "number",
              description: "Minimum profit threshold in ISK (default 0)"
            },
            includeRisky: {
              type: "boolean",
              description: "Include low-volume/contract-only items (default false)"
            }
          },
          required: ["sort"]
        }
      }
    ];

    // Trim history to last 40 messages
    let conversationMessages = messages.slice(-40);

    // Max 5 tool-use iterations to prevent infinite loops
    const maxIterations = 5;
    let iteration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    while (iteration < maxIterations) {
      iteration++;

      const requestBody = {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: conversationMessages,
        tools: tools
      };

      // Add system parameter if provided
      if (system) {
        requestBody.system = system;
      }

      console.log(`🤖 AI request (iteration ${iteration})`);

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(requestBody)
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        console.error("AI error:", data.error?.message);
        return res.json({ 
          content: [{ type: "text", text: `[API Error: ${data.error?.message || "AI request failed"}]` }],
          error: data.error?.message || "AI request failed"
        });
      }

      // Accumulate token usage across iterations (v0.9.0)
      if (data.usage) {
        totalInputTokens += data.usage.input_tokens || 0;
        totalOutputTokens += data.usage.output_tokens || 0;
      }

      // Check if AI used tools
      const toolUses = data.content.filter(block => block.type === "tool_use");

      if (toolUses.length === 0) {
        // No tools used - final answer
        console.log("✓ AI response generated (no tools)");

        // Track cumulative AI usage (v0.9.0)
        trackAiUsage(characterId, requestBody.model, totalInputTokens, totalOutputTokens);

        return res.json(data);
      }

      // AI used tools - execute them
      console.log(`🔧 AI used ${toolUses.length} tool(s)`);

      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)}...)`);

        let toolResult;

        try {
          switch (toolUse.name) {
            case "get_blueprint":
              const bpRes = await fetch(`http://localhost:${PORT}/api/get-blueprint`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemName: toolUse.input.itemName })
              });
              toolResult = await bpRes.json();
              break;

            case "analyze_blueprints":
              const analyzeRes = await fetch(`http://localhost:${PORT}/api/analyze-blueprints`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  ownedBlueprints: blueprints || [],  // Fixed: use blueprints from session cache
                  assets: assets || [],
                  sortBy: toolUse.input.sortBy || "profit",
                  limit: toolUse.input.limit || 20,
                  buildableOnly: toolUse.input.buildableOnly || false
                })
              });
              toolResult = await analyzeRes.json();
              break;

            case "get_price":
              const priceRes = await fetch(`http://localhost:${PORT}/api/get-price`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ itemName: toolUse.input.itemName })
              });
              toolResult = await priceRes.json();
              break;

            case "get_precomputed":
              try {
                const pcSort = toolUse.input.sort || 'profit';
                const pcLimit = Math.min(toolUse.input.limit || 20, 100);
                const pcMinProfit = toolUse.input.minProfit || 0;
                const pcSearch = toolUse.input.search;
                const pcIncludeRisky = toolUse.input.includeRisky || false;

                const allowedSorts = {
                  profit: 'profit DESC',
                  margin: 'profit_margin DESC',
                  isk_per_hour: 'isk_per_hour DESC'
                };
                const pcOrder = allowedSorts[pcSort] || allowedSorts.profit;

                let pcResults;
                if (pcSearch) {
                  const sanitised = pcSearch.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50);
                  
                  let whereConditions = ['product_name LIKE ?', 'profit > ?'];
                  const params = [`%${sanitised}%`, pcMinProfit];
                  
                  // Exclude CRITICAL risks only (not low_volume)
                  if (!pcIncludeRisky) {
                    whereConditions.push(`(
                      liquidity_risk IS NULL 
                      OR liquidity_risk = ""
                      OR liquidity_risk = "low_volume"
                    )`);
                  }
                  
                  const whereClause = whereConditions.join(' AND ');
                  
                  pcResults = await dbAll(`
                    SELECT product_name, material_cost, sell_price, profit,
                           profit_margin, isk_per_hour, build_time, computed_at,
                           avg_daily_volume, liquidity_risk
                    FROM precomputed_profits
                    WHERE ${whereClause}
                    ORDER BY ${pcOrder} LIMIT ?
                  `, [...params, pcLimit]);
                } else {
                  let whereConditions = ['profit > ?', 'sell_price > 0'];
                  const params = [pcMinProfit];
                  
                  // Exclude CRITICAL risks only (not low_volume)
                  if (!pcIncludeRisky) {
                    whereConditions.push(`(
                      liquidity_risk IS NULL 
                      OR liquidity_risk = ""
                      OR liquidity_risk = "low_volume"
                    )`);
                  }
                  
                  const whereClause = whereConditions.join(' AND ');
                  
                  pcResults = await dbAll(`
                    SELECT product_name, material_cost, sell_price, profit,
                           profit_margin, isk_per_hour, build_time, computed_at,
                           avg_daily_volume, liquidity_risk
                    FROM precomputed_profits
                    WHERE ${whereClause}
                    ORDER BY ${pcOrder} LIMIT ?
                  `, [...params, pcLimit]);
                }

                toolResult = {
                  results: pcResults,
                  count: pcResults.length,
                  sort: pcSort,
                  includeRisky: pcIncludeRisky,
                  source: 'precomputed'
                };
              } catch (pcErr) {
                toolResult = { error: pcErr.message, results: [] };
              }
              break;

            default:
              toolResult = { error: `Unknown tool: ${toolUse.name}` };
          }
        } catch (err) {
          toolResult = { error: err.message };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Add assistant's tool use and tool results to conversation
      conversationMessages.push({
        role: "assistant",
        content: data.content
      });

      conversationMessages.push({
        role: "user",
        content: toolResults
      });

      // Loop back to call AI again with tool results
    }

    // If we hit max iterations, return what we have
    console.warn("⚠ Max tool iterations reached");
    trackAiUsage(characterId, 'claude-sonnet-4-6', totalInputTokens, totalOutputTokens);
    return res.json({ 
      content: [{ type: "text", text: "I encountered an issue processing your request. Please try again." }] 
    });

  } catch (err) {
    console.error("AI chat error:", err.message);
    res.json({ 
      content: [{ type: "text", text: `[System Error: ${err.message}]` }],
      error: err.message 
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SESSION DATA CACHING
// ═══════════════════════════════════════════════════════════════════════

// Store character session data (assets, blueprints, prices, etc.)
// This avoids sending 2-3MB with every AI request
app.post('/api/session-data',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const { assets, blueprints, prices, wallet, jobs } = req.body;

      // Validate data exists
      if (!assets || !blueprints) {
        return res.status(400).json({ error: 'Missing required session data' });
      }

      // Store in cache with 2-hour expiry
      const sessionKey = `session:${characterId}`;
      
      console.log(`💾 Caching session data - Character: ${characterId}, Key: ${sessionKey}`);
      console.log(`   Assets: ${assets.length}, Blueprints: ${blueprints.length}, Prices: ${Object.keys(prices || {}).length}`);
      
      setCached(sessionKey, {
        assets,
        blueprints,
        prices: prices || {},
        wallet: wallet || 0,
        jobs: jobs || [],
        cachedAt: new Date().toISOString()
      }, 7200000); // 2 hours

      console.log(`✓ Session data cached successfully for character ${characterId}`);
      
      // Verify it was cached
      const verify = getCached(sessionKey);
      if (!verify) {
        console.error(`❌ CACHE VERIFICATION FAILED - Data not retrievable immediately after caching!`);
      } else {
        console.log(`✓ Cache verification passed - ${verify.assets.length} assets retrievable`);
      }
      
      res.json({ success: true, expiresIn: 7200 });
    } catch (error) {
      console.error('Session data error:', error);
      res.status(500).json({ error: 'Failed to cache session data' });
    }
  }
);

// Get cached session data (for debugging)
app.get('/api/session-data/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const sessionKey = `session:${characterId}`;
      const sessionData = getCached(sessionKey);

      if (!sessionData) {
        return res.status(404).json({ error: 'No cached session data found' });
      }

      res.json({
        cached: true,
        cachedAt: sessionData.cachedAt,
        assets: sessionData.assets?.length || 0,
        blueprints: sessionData.blueprints?.length || 0
      });
    } catch (error) {
      console.error('Get session error:', error);
      res.status(500).json({ error: 'Failed to retrieve session data' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// CHAT HISTORY (Authenticated)
// ═══════════════════════════════════════════════════════════════════════

// Save chat message (authenticated)
app.post('/api/save-message',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  security.validateChatMessage,
  async (req, res) => {
    try {
      const { role, content, conversationId } = req.body;
      const characterId = req.characterId; // From verified token
      
      await dbRun(
        'INSERT INTO chat_history (character_id, role, content, conversation_id) VALUES (?, ?, ?, ?)',
        [characterId, role, content, conversationId || 'default']
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error('Save message error:', error);
      res.status(500).json({ error: 'Failed to save message' });
    }
  }
);

// Get chat history (authenticated, character must match token)
app.get('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId; // From verified token
      
      const messages = await dbAll(
        `SELECT role, content, timestamp 
         FROM chat_history 
         WHERE character_id = ? 
         ORDER BY timestamp DESC 
         LIMIT 200`,
        [characterId]
      );
      
      res.json(messages.reverse());
    } catch (error) {
      console.error('Get history error:', error);
      res.status(500).json({ error: 'Failed to load history' });
    }
  }
);

// Clear chat history (authenticated)
app.delete('/api/chat-history/:characterId',
  security.apiLimiter,
  security.verifyEveToken,
  security.verifyCharacterOwnership,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      
      await dbRun(
        'DELETE FROM chat_history WHERE character_id = ?',
        [characterId]
      );
      
      res.json({ success: true, message: 'Chat history cleared' });
    } catch (error) {
      console.error('Clear history error:', error);
      res.status(500).json({ error: 'Failed to clear history' });
    }
  }
);

// Invalidate session cache (call when user's data changes)
app.post('/api/invalidate-session',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const sessionKey = `session:${characterId}`;
      
      cache.delete(sessionKey);
      console.log(`✓ Session cache invalidated for character ${characterId}`);
      
      res.json({ 
        success: true, 
        message: 'Session cache cleared - will reload on next AI request' 
      });
    } catch (error) {
      console.error('Invalidate session error:', error);
      res.status(500).json({ error: 'Failed to invalidate session' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// PRE-COMPUTATION ENGINE (v0.9.0)
// Calculates profitability for ALL blueprints, stores in DB
// Replaces real-time AI calculations for common queries
// ═══════════════════════════════════════════════════════════════════════

let preComputeRunning = false;

async function ensureJitaPrices() {
  if (jitaPricesCache && Date.now() < jitaPricesCacheExpiry) {
    return jitaPricesCache;
  }

  console.log('⟳ Fetching Jita prices for pre-computation...');
  const JITA_REGION = 10000002;
  const prices = {};

  // Fetch sell orders (all pages)
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/orders/?datasource=tranquility&order_type=sell&page=${page}`
    );
    if (!res.ok) {
      console.error(`❌ ESI sell orders fetch failed (page ${page}): ${res.status} ${res.statusText}`);
      break;
    }
    const orders = await res.json();
    if (!orders || orders.length === 0) break;

    for (const o of orders) {
      if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
      if (o.price < prices[o.type_id].sell) prices[o.type_id].sell = o.price;
    }

    const xPages = res.headers.get('x-pages');
    if (!xPages || page >= parseInt(xPages)) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Fetch buy orders (all pages)
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(
      `https://esi.evetech.net/latest/markets/${JITA_REGION}/orders/?datasource=tranquility&order_type=buy&page=${page}`
    );
    if (!res.ok) {
      console.error(`❌ ESI buy orders fetch failed (page ${page}): ${res.status} ${res.statusText}`);
      break;
    }
    const orders = await res.json();
    if (!orders || orders.length === 0) break;

    for (const o of orders) {
      if (!prices[o.type_id]) prices[o.type_id] = { sell: Infinity, buy: 0 };
      if (o.price > prices[o.type_id].buy) prices[o.type_id].buy = o.price;
    }

    const xPages = res.headers.get('x-pages');
    if (!xPages || page >= parseInt(xPages)) break;
    await new Promise(r => setTimeout(r, 100));
  }

  // Apply outlier filtering (same logic as /api/jita-prices)
  for (const typeId of Object.keys(prices)) {
    const p = prices[typeId];
    if (p.sell === Infinity) p.sell = 0;

    if (p.buy > 0 && p.sell > p.buy * 5) {
      p.median = p.buy;
    } else if (p.buy === 0 && p.sell > 100000000) {
      p.median = p.sell * 0.1;
    } else {
      p.median = (p.sell + p.buy) / 2;
    }
  }

  // Update the shared cache so other endpoints benefit too
  jitaPricesCache = prices;
  jitaPricesCacheExpiry = Date.now() + 3600000;

  console.log(`✓ Jita prices loaded — ${Object.keys(prices).length} items`);
  return prices;
}

async function runPreCompute() {
  if (preComputeRunning) {
    console.log('⚠ Pre-compute already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  preComputeRunning = true;
  const startTime = Date.now();

  // Log the run
  const run = await dbRun(
    `INSERT INTO precompute_runs (started_at, status) VALUES (datetime('now'), 'running')`
  );
  const runId = run.lastID;

  try {
    console.log('═══════════════════════════════════════════');
    console.log('⟳ PRE-COMPUTE JOB STARTING');
    console.log('═══════════════════════════════════════════');

    // Step 1: Ensure fresh prices
    const prices = await ensureJitaPrices();

    // Step 2: Load all blueprints and materials into memory (batch, not per-item)
    const allBlueprints = await dbAll(`
      SELECT b.blueprint_id, b.product_id, b.build_time, i.name AS product_name
      FROM blueprints b
      LEFT JOIN items i ON i.type_id = b.product_id
    `);

    const allMaterials = await dbAll(`
      SELECT blueprint_id, material_id, quantity
      FROM blueprint_materials
    `);

    // Group materials by blueprint_id for O(1) lookup
    const materialsByBp = {};
    for (const mat of allMaterials) {
      if (!materialsByBp[mat.blueprint_id]) materialsByBp[mat.blueprint_id] = [];
      materialsByBp[mat.blueprint_id].push(mat);
    }

    // Build a product_id → blueprint_id map for recursive cost checks
    const bpByProduct = {};
    for (const bp of allBlueprints) {
      bpByProduct[bp.product_id] = bp.blueprint_id;
    }

    // Step 3: Calculate profitability for each blueprint
    console.log(`⟳ Processing ${allBlueprints.length} blueprints...`);

    // Begin transaction for bulk insert
    await dbRun('BEGIN TRANSACTION');

    // Clear old data
    await dbRun('DELETE FROM precomputed_profits');

    let processed = 0;
    const computedAt = new Date().toISOString();

    for (const bp of allBlueprints) {
      const materials = materialsByBp[bp.blueprint_id] || [];
      let totalMatCost = 0;

      for (const mat of materials) {
        totalMatCost += calculateMaterialCostSync(
          mat.material_id, mat.quantity, prices, materialsByBp, bpByProduct
        );
      }

      const sellPrice = prices[bp.product_id]?.sell || 0;
      const buyPrice = prices[bp.product_id]?.buy || 0;
      const profit = sellPrice - totalMatCost;
      const profitMargin = sellPrice > 0 ? (profit / sellPrice) * 100 : 0;

      // ISK per hour (build_time is in seconds)
      const buildTimeHours = (bp.build_time || 1) / 3600;
      const iskPerHour = buildTimeHours > 0 ? profit / buildTimeHours : 0;

      await dbRun(`
        INSERT INTO precomputed_profits
          (blueprint_id, product_id, product_name, material_cost, sell_price,
           buy_price, profit, profit_margin, isk_per_hour, build_time,
           material_count, computed_at, price_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jita')
      `, [
        bp.blueprint_id, bp.product_id, bp.product_name || null,
        totalMatCost, sellPrice, buyPrice, profit, profitMargin,
        iskPerHour, bp.build_time || 0, materials.length, computedAt
      ]);

      processed++;
    }

    await dbRun('COMMIT');

    const durationSec = (Date.now() - startTime) / 1000;

    // Update run record
    await dbRun(`
      UPDATE precompute_runs
      SET completed_at = datetime('now'),
          blueprints_processed = ?,
          duration_seconds = ?,
          status = 'completed'
      WHERE id = ?
    `, [processed, durationSec, runId]);

    console.log('═══════════════════════════════════════════');
    console.log(`✓ PRE-COMPUTE COMPLETE`);
    console.log(`  Blueprints: ${processed}`);
    console.log(`  Duration: ${durationSec.toFixed(1)}s`);
    console.log('═══════════════════════════════════════════');

    preComputeRunning = false;
    return { status: 'completed', processed, durationSec };

  } catch (err) {
    // Rollback on failure
    try { await dbRun('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }

    await dbRun(`
      UPDATE precompute_runs
      SET completed_at = datetime('now'),
          status = 'failed',
          error = ?
      WHERE id = ?
    `, [err.message, runId]);

    console.error('❌ Pre-compute failed:', err.message);
    preComputeRunning = false;
    return { status: 'failed', error: err.message };
  }
}

// Synchronous material cost calculation using in-memory data
// Avoids per-item DB queries during pre-compute (performance critical)
function calculateMaterialCostSync(materialId, quantity, prices, materialsByBp, bpByProduct, depth = 0) {
  // Prevent infinite recursion on circular references
  if (depth > 10) {
    return (prices[materialId]?.buy || 0) * quantity;
  }

  const subBpId = bpByProduct[materialId];
  if (subBpId) {
    const subMats = materialsByBp[subBpId] || [];
    let mfgCost = 0;
    for (const sub of subMats) {
      mfgCost += calculateMaterialCostSync(
        sub.material_id, sub.quantity, prices, materialsByBp, bpByProduct, depth + 1
      );
    }
    const buyCost = (prices[materialId]?.buy || 0) * quantity;
    return Math.min(mfgCost * quantity, buyCost);
  }

  return (prices[materialId]?.buy || 0) * quantity;
}

// ═══════════════════════════════════════════════════════════════════════
// VOLUME ENRICHMENT JOB (v0.9.1)
// Fetches market history + market_group_id for top profitable items
// Runs incrementally to respect ESI rate limits
// ═══════════════════════════════════════════════════════════════════════

let volumeEnrichmentRunning = false;

async function runVolumeEnrichment() {
  if (volumeEnrichmentRunning) {
    console.log('⚠ Volume enrichment already running, skipping');
    return { status: 'skipped', reason: 'already_running' };
  }

  volumeEnrichmentRunning = true;
  const startTime = Date.now();

  try {
    console.log('═══════════════════════════════════════════');
    console.log('⟳ VOLUME ENRICHMENT STARTING');
    console.log('═══════════════════════════════════════════');

    const JITA_REGION = 10000002;
    
    // Get top 500 items that don't have volume data yet (or need refresh)
    const itemsToEnrich = await dbAll(`
      SELECT product_id, product_name, sell_price, buy_price, material_cost
      FROM precomputed_profits
      WHERE profit > 0 AND sell_price > 0
        AND (avg_daily_volume IS NULL OR avg_daily_volume = 0)
      ORDER BY profit DESC
      LIMIT 2000
    `);

    if (itemsToEnrich.length === 0) {
      console.log('✓ No items need enrichment');
      volumeEnrichmentRunning = false;
      return { status: 'completed', enriched: 0, message: 'All items already enriched' };
    }

    console.log(`⟳ Enriching ${itemsToEnrich.length} items...`);

    let enriched = 0;
    let errors = 0;
    let contractOnlyCount = 0;
    let extremeMarginCount = 0;
    let lowVolumeCount = 0;
    let suspiciousSpreadCount = 0;
    let noBuyOrdersCount = 0;

    for (const item of itemsToEnrich) {
      try {
        // Fetch market history for volume data
        const historyRes = await fetch(
          `https://esi.evetech.net/latest/markets/${JITA_REGION}/history/?datasource=tranquility&type_id=${item.product_id}`
        );

        let avgVolume = 0;
        if (historyRes.ok) {
          const history = await historyRes.json();
          if (Array.isArray(history) && history.length > 0) {
            // Calculate 30-day average (or less if not enough data)
            const recentHistory = history.slice(-30);
            const totalVolume = recentHistory.reduce((sum, day) => sum + (day.volume || 0), 0);
            avgVolume = recentHistory.length > 0 ? totalVolume / recentHistory.length : 0;
          }
        }

        // Fetch market_group_id to detect non-marketable items
        const typeRes = await fetch(
          `https://esi.evetech.net/latest/universe/types/${item.product_id}/?datasource=tranquility`
        );

        let marketGroupId = null;
        if (typeRes.ok) {
          const typeData = await typeRes.json();
          marketGroupId = typeData.market_group_id || null;
        }

        // Determine liquidity risk using 4-tier system
        let liquidityRisk = null;
        
        // TIER 1: Contract-only items (cannot be sold on market)
        if (marketGroupId === null) {
          liquidityRisk = 'contract_only';
        }
        // TIER 2: Margin cap (500% maximum - anything beyond is likely scam/phantom)
        else if (item.material_cost > 0 && (item.sell_price / item.material_cost) > 5.0) {
          liquidityRisk = 'extreme_margin';
        }
        // TIER 3: Volume requirements (tiered by price)
        else if (item.sell_price < 100000000 && avgVolume < 10) {
          liquidityRisk = 'low_volume'; // <100M ISK needs 10+ units/day
        } else if (item.sell_price >= 100000000 && item.sell_price < 1000000000 && avgVolume < 5) {
          liquidityRisk = 'low_volume'; // 100M-1B ISK needs 5+ units/day
        } else if (item.sell_price >= 1000000000 && avgVolume < 2) {
          liquidityRisk = 'low_volume'; // >1B ISK needs 2+ units/day
        }
        // TIER 4: Spread sanity check
        else if (item.buy_price === 0 && item.sell_price > 10000000) {
          liquidityRisk = 'no_buy_orders'; // >10M ISK with no buy orders = suspicious
        } else if (item.material_cost > 0 && ((item.sell_price - item.material_cost) / item.sell_price) > 0.9) {
          liquidityRisk = 'suspicious_spread'; // >90% spread is unusual
        }

        // Update the record
        await dbRun(`
          UPDATE precomputed_profits
          SET avg_daily_volume = ?,
              market_group_id = ?,
              liquidity_risk = ?
          WHERE product_id = ?
        `, [avgVolume, marketGroupId, liquidityRisk, item.product_id]);

        enriched++;

        // Count risk types (summary logging)
        if (liquidityRisk === 'contract_only') contractOnlyCount++;
        else if (liquidityRisk === 'extreme_margin') extremeMarginCount++;
        else if (liquidityRisk === 'low_volume') lowVolumeCount++;
        else if (liquidityRisk === 'no_buy_orders') noBuyOrdersCount++;
        else if (liquidityRisk === 'suspicious_spread') suspiciousSpreadCount++;

        // ESI rate limit: 150 requests/sec burst, sustained ~20/sec
        // Conservative: 1 request per 100ms = 10/sec sustained
        await new Promise(r => setTimeout(r, 100));

      } catch (err) {
        console.error(`  ✗ Error enriching ${item.product_name}:`, err.message);
        errors++;
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;

    console.log('═══════════════════════════════════════════');
    console.log(`✓ VOLUME ENRICHMENT COMPLETE`);
    console.log(`  Enriched: ${enriched} items`);
    console.log(`  Errors: ${errors}`);
    console.log(`  Filtered: ${contractOnlyCount + extremeMarginCount + lowVolumeCount + suspiciousSpreadCount + noBuyOrdersCount} total`);
    console.log(`    - Contract-only: ${contractOnlyCount}`);
    console.log(`    - Extreme margin (>500%): ${extremeMarginCount}`);
    console.log(`    - Low volume: ${lowVolumeCount}`);
    console.log(`    - No buy orders: ${noBuyOrdersCount}`);
    console.log(`    - Suspicious spread: ${suspiciousSpreadCount}`);
    console.log(`  Duration: ${durationSec.toFixed(1)}s`);
    console.log('═══════════════════════════════════════════');

    volumeEnrichmentRunning = false;
    return { status: 'completed', enriched, errors, durationSec };

  } catch (err) {
    console.error('❌ Volume enrichment failed:', err.message);
    volumeEnrichmentRunning = false;
    return { status: 'failed', error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PRE-COMPUTED PROFITABILITY API (v0.9.0)
// Serves data from DB — zero AI tokens
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/top-profitable', security.apiLimiter, async (req, res) => {
  try {
    const sort = req.query.sort || 'profit';
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const minProfit = parseFloat(req.query.minProfit) || 0;
    const minVolume = parseFloat(req.query.minVolume) !== undefined ? parseFloat(req.query.minVolume) : 5;
    const includeRisky = req.query.includeRisky === 'true';

    // Validate sort column to prevent SQL injection
    const allowedSorts = {
      profit: 'profit DESC',
      margin: 'profit_margin DESC',
      isk_per_hour: 'isk_per_hour DESC',
      cost: 'material_cost ASC',
      sell_price: 'sell_price DESC'
    };

    const orderClause = allowedSorts[sort] || allowedSorts.profit;

    // Build WHERE clause with CRITICAL risk filtering only
    // low_volume is a WARNING (shown to user), not CRITICAL (excluded)
    let whereConditions = ['profit > ?', 'sell_price > 0'];
    const params = [minProfit];

    // Apply volume filter (skip if volume data not available yet)
    if (minVolume > 0) {
      whereConditions.push('(avg_daily_volume >= ? OR avg_daily_volume IS NULL)');
      params.push(minVolume);
    }

    // Exclude CRITICAL risks only (not low_volume)
    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL 
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    const results = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ?
    `, [...params, limit]);

    // Get last run info
    const lastRun = await dbGet(`
      SELECT completed_at, blueprints_processed, duration_seconds, status
      FROM precompute_runs
      ORDER BY id DESC LIMIT 1
    `);

    // Count items by risk category (4-tier system)
    const riskCounts = await dbGet(`
      SELECT 
        COUNT(CASE WHEN liquidity_risk IS NULL OR liquidity_risk = '' THEN 1 END) as safe,
        COUNT(CASE WHEN liquidity_risk = 'contract_only' THEN 1 END) as tier1_contract_only,
        COUNT(CASE WHEN liquidity_risk = 'extreme_margin' THEN 1 END) as tier2_extreme_margin,
        COUNT(CASE WHEN liquidity_risk = 'low_volume' THEN 1 END) as tier3_low_volume,
        COUNT(CASE WHEN liquidity_risk = 'no_buy_orders' THEN 1 END) as tier4_no_buy_orders,
        COUNT(CASE WHEN liquidity_risk = 'suspicious_spread' THEN 1 END) as tier4_suspicious_spread
      FROM precomputed_profits WHERE profit > 0
    `);

    res.json({
      results,
      meta: {
        count: results.length,
        sort,
        minProfit,
        minVolume,
        includeRisky,
        lastComputed: lastRun?.completed_at || null,
        lastRunStatus: lastRun?.status || 'never',
        riskBreakdown: riskCounts
      }
    });

  } catch (err) {
    console.error('Top profitable error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

// Search pre-computed data by item name
app.get('/api/search-profitable', security.apiLimiter, async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || query.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const includeRisky = req.query.includeRisky === 'true';

    // Sanitise: only allow alphanumeric, spaces, hyphens, apostrophes
    const sanitised = query.replace(/[^a-zA-Z0-9 '\-]/g, '').substring(0, 50);

    // Build WHERE clause
    let whereConditions = ['product_name LIKE ?'];
    const params = [`%${sanitised}%`];

    // Exclude CRITICAL risks only (not low_volume)
    if (!includeRisky) {
      whereConditions.push(`(
        liquidity_risk IS NULL 
        OR liquidity_risk = ""
        OR liquidity_risk = "low_volume"
      )`);
    }

    const whereClause = whereConditions.join(' AND ');

    const results = await dbAll(`
      SELECT blueprint_id, product_id, product_name, material_cost,
             sell_price, buy_price, profit, profit_margin, isk_per_hour,
             build_time, material_count, computed_at,
             avg_daily_volume, market_group_id, liquidity_risk
      FROM precomputed_profits
      WHERE ${whereClause}
      ORDER BY profit DESC
      LIMIT 20
    `, params);

    res.json({ results, query: sanitised, includeRisky });

  } catch (err) {
    console.error('Search profitable error:', err.message);
    res.status(500).json({ error: err.message, results: [] });
  }
});

// Admin: Manually trigger pre-compute
app.post('/api/admin/precompute', async (req, res) => {
  // Simple API key auth for admin endpoints
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runPreCompute();

  if (preComputeRunning) {
    res.json({ message: 'Pre-compute job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});

// Admin: View pre-compute run history
app.get('/api/admin/precompute-status', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const runs = await dbAll(`
      SELECT * FROM precompute_runs
      ORDER BY id DESC LIMIT 10
    `);

    const totalBlueprints = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits'
    );

    const profitable = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE profit > 0'
    );

    const enriched = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE avg_daily_volume IS NOT NULL'
    );

    const risky = await dbGet(
      'SELECT COUNT(*) as count FROM precomputed_profits WHERE liquidity_risk IS NOT NULL AND liquidity_risk != ""'
    );

    res.json({
      runs,
      summary: {
        totalPrecomputed: totalBlueprints?.count || 0,
        profitable: profitable?.count || 0,
        enriched: enriched?.count || 0,
        risky: risky?.count || 0,
        isRunning: preComputeRunning
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Manually trigger volume enrichment (v0.9.1)
app.post('/api/admin/volume-enrichment', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Run async — don't block the response
  const result = runVolumeEnrichment();

  if (volumeEnrichmentRunning) {
    res.json({ message: 'Volume enrichment job started', status: 'running' });
  } else {
    const outcome = await result;
    res.json(outcome);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// AI COST TRACKING (v0.9.0)
// ═══════════════════════════════════════════════════════════════════════

// Sonnet 4.6 pricing (per million tokens, as of 2026)
const AI_PRICING = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 }
};

async function trackAiUsage(characterId, model, inputTokens, outputTokens) {
  try {
    const pricing = AI_PRICING[model] || { input: 3.00, output: 15.00 };
    const estimatedCost = (inputTokens * pricing.input / 1_000_000)
                        + (outputTokens * pricing.output / 1_000_000);

    await dbRun(`
      INSERT INTO ai_usage (character_id, model, input_tokens, output_tokens, estimated_cost)
      VALUES (?, ?, ?, ?, ?)
    `, [characterId, model, inputTokens, outputTokens, estimatedCost]);
  } catch (err) {
    console.error('AI usage tracking error:', err.message);
    // Non-fatal — don't break the response
  }
}

// Admin: View AI costs
app.get('/api/admin/ai-costs', async (req, res) => {
  const adminKey = process.env.FORGE_ADMIN_KEY;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Today
    const today = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now')
    `);

    // Last 7 days
    const week = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
    `);

    // Last 30 days
    const month = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-30 days')
    `);

    // Daily breakdown (last 7 days)
    const daily = await dbAll(`
      SELECT date(created_at) as date,
             COUNT(*) as requests,
             SUM(estimated_cost) as cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
      GROUP BY date(created_at)
      ORDER BY date DESC
    `);

    res.json({ today, week, month, daily });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
  let lastPrecompute = null;
  try {
    lastPrecompute = await dbGet(
      `SELECT completed_at, status, blueprints_processed
       FROM precompute_runs ORDER BY id DESC LIMIT 1`
    );
  } catch (_) { /* table may not exist yet */ }

  let enrichmentStats = null;
  try {
    enrichmentStats = await dbGet(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN avg_daily_volume IS NOT NULL THEN 1 END) as enriched,
        COUNT(CASE WHEN liquidity_risk IS NOT NULL AND liquidity_risk != "" THEN 1 END) as risky
      FROM precomputed_profits WHERE profit > 0
    `);
  } catch (_) { /* column may not exist yet */ }

  res.json({ 
    status: "ok",
    version: "0.9.2.1",
    uptime: process.uptime(),
    database: db ? "connected" : "disconnected",
    precompute: {
      lastRun: lastPrecompute?.completed_at || null,
      lastStatus: lastPrecompute?.status || 'never',
      blueprintsProcessed: lastPrecompute?.blueprints_processed || 0,
      isRunning: preComputeRunning
    },
    volumeEnrichment: {
      total: enrichmentStats?.total || 0,
      enriched: enrichmentStats?.enriched || 0,
      risky: enrichmentStats?.risky || 0,
      isRunning: volumeEnrichmentRunning
    },
    priceCache: {
      loaded: !!jitaPricesCache,
      items: jitaPricesCache ? Object.keys(jitaPricesCache).length : 0
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════
initDatabase().then(async () => {
  // Run v0.9.0 migrations
  await runMigrations();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔════════════════════════════════════════════╗
║F.O.R.G.E. Server v2.3.2.1 (v0.9.2.1) Running║
║     http://localhost:${PORT}               ║
║     Database: SQLite                        ║
║     Security: ENABLED ✓                     ║
║     Pre-Compute: ENABLED ✓                  ║
║     4-Tier + Severity: ENABLED ✓            ║
║     AI Tracking: ENABLED ✓                  ║
╚════════════════════════════════════════════╝
`);

    // Run pre-compute on startup (delayed 10s to let ESI warm up)
    setTimeout(() => {
      console.log('⟳ Running initial pre-compute...');
      runPreCompute().then(result => {
        console.log('✓ Initial pre-compute:', result.status);
        
        // After pre-compute completes, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            console.log('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              console.log('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              console.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000); // 5 second delay after pre-compute
        }
      }).catch(err => {
        console.error('⚠ Initial pre-compute failed:', err.message);
      });
    }, 10000);

    // Schedule pre-compute every 6 hours
    // (Daily would be fine, but 6-hourly keeps prices fresher without ESI abuse)
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    setInterval(() => {
      console.log('⟳ Scheduled pre-compute starting...');
      runPreCompute().then(result => {
        console.log('✓ Scheduled pre-compute:', result.status);
        
        // After scheduled pre-compute, run volume enrichment
        if (result.status === 'completed') {
          setTimeout(() => {
            console.log('⟳ Running volume enrichment...');
            runVolumeEnrichment().then(enrichResult => {
              console.log('✓ Volume enrichment:', enrichResult.status);
            }).catch(err => {
              console.error('⚠ Volume enrichment failed:', err.message);
            });
          }, 5000);
        }
      }).catch(err => {
        console.error('⚠ Scheduled pre-compute failed:', err.message);
      });
    }, SIX_HOURS);
  });

  // Error handler must be after all routes
  app.use(security.errorHandler);
  
}).catch(err => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
