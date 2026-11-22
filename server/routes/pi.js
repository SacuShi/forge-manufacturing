'use strict';
// Planetary Interaction: the character's colonies (what they make and its value) and the PI market overview.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, SQL_VARIABLE_LIMIT } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { getCached } = require('../lib/cache');
const { ensureJitaPrices } = require('../lib/market-cache');
const { normalisePins, pinSchematicId, planetDisplayName, rankPiRecipes } = require('../lib/pi-colony');

const router = express.Router();

// PI colony detail cache: characterId -> { data, fetchedAt } — 10-minute TTL
const piDetailCache  = new Map();

// PI market rankings cache: characterId -> { data, fetchedAt } — 5-minute TTL
const piMarketCache  = new Map();

// PI schematic lookup cache: schematicId -> resolved schematic object
const schematicMemo  = new Map();

// POCO tax base value per unit by tier (CCP's customs values); export tax = base × rate, import tax = half that.
const PI_POCO_BASE_VALUE    = { 0: 5, 1: 400, 2: 7200, 3: 60000, 4: 1200000 }; // ISK/unit

// Fallbacks ONLY for a schematic missing from the SDE tables (pi_schematics / pi_schematic_materials), which are
// the source of truth. CCP's data (checked Nov 2026): P1 = 20 per 30 min; P2 = 5, P3 = 3, P4 = 1 per HOUR.
// (P4 was wrongly 86400 s here, so P4 factories were ranked at 1/24th of their real output.)
const PI_FACTORY_OUTPUT_QTY = { 1: 20, 2: 5, 3: 3, 4: 1 };                      // units/cycle
const PI_FACTORY_CYCLE_TIME = { 1: 1800, 2: 3600, 3: 3600, 4: 3600 };            // seconds/cycle

/**
 * Fetches the name and cycle time for a PI schematic from ESI and caches the result.
 *
 * In EVE Online, factories on a planet run a "schematic" — a recipe that converts
 * input materials into an output product.  The ESI endpoint returns the schematic
 * name (which equals the output product name) and cycle time in seconds.
 *
 * Only successful responses are cached.  If ESI is temporarily unreachable the
 * function returns a placeholder and the next call will retry ESI again.
 *
 * @param {number} schematicId  — the EVE schematic ID from ESI planet layout data
 * @returns {{ name: string, cycleTime: number }}
 */
async function resolveSchematic(schematicId) {
  // Return immediately if we've already fetched this schematic successfully.
  if (schematicMemo.has(schematicId)) return schematicMemo.get(schematicId);
  try {
    const r = await esiFetch(
      `https://esi.evetech.net/latest/universe/schematics/${schematicId}/?datasource=tranquility`
    );
    if (r.ok) {
      const d   = await r.json();
      const val = { name: d.schematic_name, cycleTime: d.cycle_time };
      schematicMemo.set(schematicId, val); // cache only on success
      return val;
    }
  } catch (_) {
    // Network error or JSON parse failure — fall through to placeholder below.
    // Do NOT cache this failure; the next request will retry ESI.
  }
  // ESI was unreachable or returned an error.  Return a temporary placeholder
  // without caching it, so the next request tries ESI again.
  return { name: `Schematic #${schematicId}`, cycleTime: 3600 };
}

/**
 * Returns the deduplicated list of blueprint type_ids owned by a character.
 * A character may own multiple copies (BPO + several BPCs) of the same blueprint;
 * the type_id is the same for all of them, so we deduplicate with a Set.
 *
 * @param {object|null} sessionData  — character session from getCached()
 * @returns {number[]}  unique blueprint type_ids, capped at SQL_VARIABLE_LIMIT
 */
function ownedBlueprintTypeIds(sessionData) {
  const ids = [...new Set((sessionData?.blueprints || []).map(bp => bp.type_id))];
  // Guard against exceeding SQLite's bind-variable limit on accounts with huge
  // blueprint libraries (e.g. corp director alts with thousands of BPCs).
  return ids.slice(0, SQL_VARIABLE_LIMIT);
}

// GET /api/pi/colonies — per-planet layout, valuation, and blueprint cross-reference
// Phase 1: colony layout + product/schematic/system names
// Phase 2: + Jita prices, factory output type_ids, owned-blueprint cross-reference
// Primary characters have a server-side session with the planets list already stored.
// Alt characters (added via the sidebar) do NOT get their own server session, so we
// fall back to fetching their planets list directly from ESI using the bearer token.
async function fetchPiPlanetList({ characterId, eveToken }) {
  const sessionData = getCached(`session:${characterId}`);
  if (sessionData?.planets?.length > 0) {
    return { planets: sessionData.planets, sessionBlueprints: sessionData.blueprints || [] };
  }

  logger.info(`🌍 PI colonies — char ${characterId} has no server session; fetching planet list from ESI`);
  let planets;
  try {
    const r = await esiFetch(
      `https://esi.evetech.net/latest/characters/${characterId}/planets/?datasource=tranquility`,
      { headers: { Authorization: `Bearer ${eveToken}` } }
    );
    planets = r.ok ? await r.json() : [];
  } catch (e) {
    planets = [];
    logger.warn(`PI planet list ESI fetch failed for char ${characterId}:`, e.message);
  }
  // Blueprint cross-reference data lives in the primary's combined session and is not
  // available here — cross-ref simply won't show for characters without a session.
  return { planets, sessionBlueprints: [] };
}

async function fetchPiColonyLayouts({ characterId, eveToken, planets }) {
  const colonies         = [];
  const schematicIds     = new Set();
  const extractorProdIds = new Set(); // P0 raw resources being extracted
  const contentTypeIds   = new Set(); // everything sitting in storage / launchpads / factory buffers

  await Promise.allSettled(planets.map(async (planet) => {
    try {
      const r = await esiFetch(
        `https://esi.evetech.net/latest/characters/${characterId}/planets/${planet.planet_id}/?datasource=tranquility`,
        { headers: { Authorization: `Bearer ${eveToken}` } }
      );
      const detail = r.ok ? await r.json() : { pins: [] };
      // ESI puts a factory's schematic id at the pin's top level, not in factory_details.
      // normalisePins copies it into factory_details so the PI tab and the AI advisor see every factory.
      const pins = normalisePins(detail.pins);
      for (const pin of pins) {
        if (pin.extractor_details?.product_type_id) extractorProdIds.add(pin.extractor_details.product_type_id);
        const sid = pinSchematicId(pin);
        if (sid) schematicIds.add(sid);
        for (const c of (pin.contents || [])) if (c?.type_id) contentTypeIds.add(c.type_id);
      }
      colonies.push({ ...planet, pins });
    } catch (e) {
      colonies.push({ ...planet, pins: [], error: e.message });
    }
  }));

  return { colonies, schematicIds, extractorProdIds, contentTypeIds };
}

// Planet names as the game shows them ("Tanoo I"), from the SDE planet table + solar system names.
async function resolvePiPlanetNames({ planets, systemNames }) {
  const planetNames = {};
  const ids = planets.map(p => p.planet_id).filter(Number.isInteger).slice(0, SQL_VARIABLE_LIMIT);
  if (!ids.length) return planetNames;
  try {
    const rows = await dbAll(
      `SELECT planet_id, system_id, planet_index FROM sde_planets WHERE planet_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const r of rows) {
      const name = planetDisplayName(systemNames[r.system_id], r.planet_index);
      if (name) planetNames[r.planet_id] = name;
    }
  } catch (e) {
    logger.warn('PI planet name lookup failed:', e.message);
  }
  return planetNames;
}

async function resolvePiSchematicsAndOutputs({ schematicIds, extractorProdIds }) {
  // Resolve schematics: name + cycle_time from ESI
  const schematics = {};
  await Promise.all([...schematicIds].map(async id => {
    schematics[id] = await resolveSchematic(id);
  }));

  // Resolve factory output type_ids. First from the SDE schematic table (pi_schematics, CCP data);
  // any schematic not found there falls back to a name match, since EVE names each PI schematic after
  // its output product (e.g. "Coolant" → Coolant item).
  const factoryOutputs = {}; // schematicId → output type_id
  // schematicId → { outputTypeId, outputQty, cycleTime, inputs: [{ typeId, qty }] } — CCP's recipe, for the daily maths
  const schematicInfo  = {};
  const inputTypeIds   = new Set();
  const allPiTypeIds   = new Set(extractorProdIds);
  const sids = [...schematicIds].filter(Number.isInteger).slice(0, SQL_VARIABLE_LIMIT);
  if (sids.length) {
    try {
      const ph = sids.map(() => '?').join(',');
      const sdeRows = await dbAll(
        `SELECT schematic_id, product_type_id, product_quantity, cycle_time FROM pi_schematics WHERE schematic_id IN (${ph})`,
        sids
      );
      const matRows = await dbAll(
        `SELECT schematic_id, material_type_id, quantity FROM pi_schematic_materials WHERE schematic_id IN (${ph})`,
        sids
      );
      for (const r of sdeRows) {
        if (!r.product_type_id) continue;
        factoryOutputs[r.schematic_id] = r.product_type_id;
        allPiTypeIds.add(r.product_type_id);
        if (r.product_quantity > 0 && r.cycle_time > 0) {
          schematicInfo[r.schematic_id] = { outputTypeId: r.product_type_id, outputQty: r.product_quantity, cycleTime: r.cycle_time, inputs: [] };
        }
      }
      for (const m of matRows) {
        const s = schematicInfo[m.schematic_id];
        if (!s || !m.material_type_id || !(m.quantity > 0)) continue;
        s.inputs.push({ typeId: m.material_type_id, qty: m.quantity });
        inputTypeIds.add(m.material_type_id);
      }
    } catch (e) {
      logger.warn('PI schematic SDE lookup failed, using name match:', e.message);
    }
  }
  const schematicEntries = Object.entries(schematics).filter(([id]) => !factoryOutputs[id]); // [[id, {name,cycleTime}], ...]
  if (schematicEntries.length) {
    const names = schematicEntries.map(([, s]) => s.name);
    const ph    = names.map(() => '?').join(',');
    const rows  = await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE name IN (${ph})`, names);
    const byName = {};
    rows.forEach(r => { byName[r.name] = r; });
    for (const [id, { name }] of schematicEntries) {
      const row = byName[name];
      if (row) { factoryOutputs[id] = row.type_id; allPiTypeIds.add(row.type_id); }
    }
  }

  return { schematics, factoryOutputs, schematicInfo, inputTypeIds, allPiTypeIds };
}

// Resolves product names for ALL PI type_ids (extractor + factory).
async function resolvePiProductNames({ allPiTypeIds }) {
  const productNames = {};
  if (allPiTypeIds.size) {
    const ids = [...allPiTypeIds];
    const ph  = ids.map(() => '?').join(',');
    const rows = await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE type_id IN (${ph})`, ids);
    rows.forEach(r => { productNames[r.type_id] = { name: r.name, piTier: r.pi_tier }; });
  }
  return productNames;
}

// PI commodities are primarily traded in Jita — use The Forge (10000002) as baseline.
// `jita` is the Jita price map from ensureJitaPrices() (null when unavailable).
function resolvePiPrices({ allPiTypeIds, jita }) {
  jita = jita || {};
  const prices = {};
  for (const typeId of allPiTypeIds) {
    const p = jita[typeId];
    if (p) prices[typeId] = { sell: p.sell || 0, buy: p.buy || 0 };
  }
  return prices;
}

// Which of the user's owned blueprints consume these PI materials directly?
// The combined IN clause must not exceed SQLite's 999-variable bind limit.
async function resolvePiBlueprintCrossRef({ sessionBlueprints, allPiTypeIds }) {
  const bpCrossRef = {}; // piTypeId → [{ bpTypeId, productName, productTypeId }]
  // ownedBlueprintTypeIds() deduplicates and caps at SQL_VARIABLE_LIMIT.
  const ownedBpTypeIds = ownedBlueprintTypeIds({ blueprints: sessionBlueprints });
  if (ownedBpTypeIds.length && allPiTypeIds.size) {
    // PI products in EVE total ~100; combined with blueprints this easily fits within
    // SQL_VARIABLE_LIMIT, but we cap piIds defensively for future-proofing.
    const piIds = [...allPiTypeIds].slice(0, SQL_VARIABLE_LIMIT - ownedBpTypeIds.length);
    const crossRows = await dbAll(
      `SELECT bm.material_id, b.blueprint_id, b.product_id,
              COALESCE(i.name, 'Item #' || b.product_id) AS product_name
       FROM blueprint_materials bm
       JOIN blueprints b ON b.blueprint_id = bm.blueprint_id
       JOIN items i ON i.type_id = b.product_id
       WHERE bm.material_id IN (${piIds.map(() => '?').join(',')})
         AND b.blueprint_id IN (${ownedBpTypeIds.map(() => '?').join(',')})`,
      [...piIds, ...ownedBpTypeIds]
    );
    for (const row of crossRows) {
      if (!bpCrossRef[row.material_id]) bpCrossRef[row.material_id] = [];
      if (!bpCrossRef[row.material_id].some(e => e.bpTypeId === row.blueprint_id)) {
        bpCrossRef[row.material_id].push({
          bpTypeId:      row.blueprint_id,
          productName:   row.product_name,
          productTypeId: row.product_id,
        });
      }
    }
  }
  return bpCrossRef;
}

// Resolve solar system names via a batch ESI public call.
async function resolvePiSystemNames({ planets }) {
  const systemNames = {};
  const sysIds = [...new Set(planets.map(p => p.solar_system_id).filter(Boolean))];
  if (sysIds.length) {
    try {
      const r = await esiFetch(
        'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sysIds) }
      );
      if (r.ok) { const ns = await r.json(); ns.forEach(n => { systemNames[n.id] = n.name; }); }
    } catch (_) {}
  }
  return systemNames;
}

router.get('/api/pi/colonies', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const eveToken    = (req.headers.authorization || '').slice(7);

    // Serve from the 10-minute detail cache when available (avoids ESI round-trips).
    const hit = piDetailCache.get(characterId);
    if (hit && (Date.now() - hit.fetchedAt) < 600_000) return res.json(hit.data);

    const { planets, sessionBlueprints } = await fetchPiPlanetList({ characterId, eveToken });

    if (!planets?.length) {
      return res.json({ colonies: [], productNames: {}, schematics: {}, schematicInfo: {}, systemNames: {}, planetNames: {}, prices: {}, factoryOutputs: {}, bpCrossRef: {} });
    }

    // Jita prices load alongside the colony layouts. Just after a restart the price cache can still be empty; this
    // fetches it rather than returning every product as "no price". null = prices really unavailable right now.
    const jitaPromise = ensureJitaPrices().catch(err => {
      logger.warn('PI colonies: Jita prices unavailable —', err.message);
      return null;
    });
    const { colonies, schematicIds, extractorProdIds, contentTypeIds } = await fetchPiColonyLayouts({ characterId, eveToken, planets });
    const { schematics, factoryOutputs, schematicInfo, inputTypeIds, allPiTypeIds } =
      await resolvePiSchematicsAndOutputs({ schematicIds, extractorProdIds });
    // Stored items and factory inputs need names and prices too, but are kept out of allPiTypeIds so the
    // blueprint cross-reference is unchanged.
    const namedTypeIds  = new Set([...allPiTypeIds, ...contentTypeIds, ...inputTypeIds]);
    const productNames = await resolvePiProductNames({ allPiTypeIds: namedTypeIds });
    const jita          = await jitaPromise;
    const prices        = resolvePiPrices({ allPiTypeIds: namedTypeIds, jita });
    // A schematic missing from the SDE tables: output per cycle by tier (CCP's fixed amounts) and ESI's cycle time.
    // Its inputs are unknown, so they can't be subtracted.
    for (const [sid, outTid] of Object.entries(factoryOutputs)) {
      const tier = productNames[outTid]?.piTier;
      if (schematicInfo[sid] || !PI_FACTORY_OUTPUT_QTY[tier]) continue;
      schematicInfo[sid] = { outputTypeId: outTid, outputQty: PI_FACTORY_OUTPUT_QTY[tier], cycleTime: schematics[sid]?.cycleTime || PI_FACTORY_CYCLE_TIME[tier], inputs: [], inputsUnknown: true };
    }
    const bpCrossRef    = await resolvePiBlueprintCrossRef({ sessionBlueprints, allPiTypeIds });
    const systemNames   = await resolvePiSystemNames({ planets });
    const planetNames   = await resolvePiPlanetNames({ planets, systemNames });

    colonies.sort((a, b) => a.planet_id - b.planet_id);
    const data = { colonies, productNames, schematics, schematicInfo, systemNames, planetNames, prices, factoryOutputs, bpCrossRef };

    // Cache result with simple eviction: drop oldest entry when map exceeds 200 characters.
    // A result without prices is not cached, so the next visit tries again instead of showing "no price" for 10 min.
    if (jita) {
      if (piDetailCache.size >= 200) {
        piDetailCache.delete(piDetailCache.keys().next().value);
      }
      piDetailCache.set(characterId, { data, fetchedAt: Date.now() });
    }
    logger.info(`🌍 PI loaded for ${characterId}: ${colonies.length} planets, ${Object.keys(bpCrossRef).length} PI materials in owned BPs`);
    res.json(data);
  } catch (err) {
    // Log full error internally (includes stack trace) but return generic message to client.
    logger.error('PI colonies error:', err);
    res.status(500).json({ error: 'Failed to load PI data' });
  }
});

// ── PI schematic market rankings + blueprint PI material requirements ─────────
// This endpoint serves two things at once:
//   1. Rankings — every PI factory output in the game ranked by net ISK/day
//      per single factory slot (gross Jita sell revenue minus 10% POCO export tax).
//   2. BP PI Costs — for each blueprint the user owns that needs PI materials,
//      a breakdown of which PI items are required per run and what they cost.
//
// Results are cached per-character for 5 minutes (rankings change as Jita prices
// update, which happens roughly every 5 minutes in ESI anyway).
router.get('/api/pi/market', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;

    // POCO tax varies by structure/owner and isn't available live — the user enters
    // their actual rate; default to the flat 10% assumption when not provided.
    const parsedTaxRate = parseFloat(req.query.pocoTaxRate);
    const pocoTaxRate = Number.isFinite(parsedTaxRate) ? Math.min(Math.max(parsedTaxRate, 0), 1) : 0.10;

    // Cache key includes the tax rate so different rates don't collide.
    const cacheKey = `${characterId}:${pocoTaxRate}`;

    // Return cached result if still fresh (5-minute TTL matches Jita price cadence).
    const cached = piMarketCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < 300_000) {
      return res.json(cached.data);
    }

    // ── Step 1: Rank every PI factory recipe by net ISK/day for ONE factory running full time ────
    // Recipes come from CCP's schematic tables (output quantity, cycle time and inputs). Net = output value minus
    // what the inputs are worth (Jita sell — the price to buy them, or what you give up by not selling your own),
    // minus export tax on the output and import tax on the inputs.
    // Jita price map { [typeId]: { sell, buy } }, loaded if the cache is still empty (e.g. just after a restart).
    const jitaMap = await ensureJitaPrices().catch(err => {
      logger.warn('PI market: Jita prices unavailable —', err.message);
      return null;
    });
    const jita = jitaMap || {};

    const recipeRows = await dbAll(
      `SELECT s.schematic_id, s.product_type_id, s.product_quantity, s.cycle_time, i.name, i.pi_tier
         FROM pi_schematics s JOIN items i ON i.type_id = s.product_type_id
        WHERE i.pi_tier IN (1, 2, 3, 4)`
    );
    let recipes;
    if (recipeRows.length) {
      const matRows = await dbAll(
        `SELECT m.schematic_id, m.material_type_id, m.quantity, i.pi_tier
           FROM pi_schematic_materials m LEFT JOIN items i ON i.type_id = m.material_type_id`
      );
      const inputsBySchematic = new Map();
      for (const m of matRows) {
        if (!inputsBySchematic.has(m.schematic_id)) inputsBySchematic.set(m.schematic_id, []);
        inputsBySchematic.get(m.schematic_id).push({ typeId: m.material_type_id, qty: m.quantity, tier: m.pi_tier ?? 0 });
      }
      recipes = recipeRows.map(r => ({
        typeId: r.product_type_id, name: r.name, tier: r.pi_tier,
        outputQty: r.product_quantity, cycleTime: r.cycle_time,
        inputs: inputsBySchematic.get(r.schematic_id) || [],
      }));
    } else {
      // SDE tables not imported: CCP's fixed amounts per tier; inputs unknown, so no input cost can be taken off.
      logger.warn('PI market: pi_schematics is empty — ranking without input costs (run the SDE import)');
      const piProducts = await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE pi_tier IN (1, 2, 3, 4)`);
      recipes = piProducts.map(p => ({
        typeId: p.type_id, name: p.name, tier: p.pi_tier,
        outputQty: PI_FACTORY_OUTPUT_QTY[p.pi_tier] ?? 0, cycleTime: PI_FACTORY_CYCLE_TIME[p.pi_tier] ?? 3600,
        inputs: null,
      }));
    }

    const rankings = rankPiRecipes({ recipes, prices: jita, baseValue: PI_POCO_BASE_VALUE, taxRate: pocoTaxRate });

    // ── Step 2: PI material costs for the user's owned blueprints ─────────────
    // For each blueprint the user has that consumes PI items (e.g. most T2 and
    // capital components), show which PI products are needed per run and the Jita
    // buy cost.  This helps the user decide whether to farm or buy PI materials.

    const sessionData    = getCached(`session:${characterId}`);
    // ownedBlueprintTypeIds deduplicates and caps at SQL_VARIABLE_LIMIT to avoid
    // exceeding SQLite's 999 bind-variable ceiling.
    const ownedBpTypeIds = ownedBlueprintTypeIds(sessionData);
    let bpPiReqs         = [];

    if (ownedBpTypeIds.length > 0) {
      // Join blueprint_materials → blueprints → item names, keeping only rows where
      // the material is a PI item (im.pi_tier IS NOT NULL).
      const bpRows = await dbAll(
        `SELECT b.blueprint_id AS bp_type_id, b.product_id,
                ip.name        AS product_name,
                bm.material_id, bm.quantity AS qty_per_run,
                im.name        AS material_name,
                im.pi_tier     AS mat_tier
         FROM blueprint_materials bm
         JOIN blueprints b ON b.blueprint_id = bm.blueprint_id
         JOIN items ip     ON ip.type_id      = b.product_id
         JOIN items im     ON im.type_id      = bm.material_id
         WHERE im.pi_tier IS NOT NULL
           AND b.blueprint_id IN (${ownedBpTypeIds.map(() => '?').join(',')})
         ORDER BY ip.name, im.pi_tier DESC`,
        ownedBpTypeIds
      );

      // Group rows by blueprint, collecting PI materials into an array.
      const bpMap = new Map();
      for (const row of bpRows) {
        if (!bpMap.has(row.bp_type_id)) {
          bpMap.set(row.bp_type_id, {
            bpTypeId: row.bp_type_id, productId: row.product_id,
            productName: row.product_name, piMaterials: [],
          });
        }
        const sell = jita[row.material_id]?.sell ?? 0;
        bpMap.get(row.bp_type_id).piMaterials.push({
          typeId: row.material_id, name: row.material_name,
          tier: row.mat_tier, qtyPerRun: row.qty_per_run,
          sell, buy: jita[row.material_id]?.buy ?? 0,
          iskPerRun: row.qty_per_run * sell, // total cost for this material per single run
        });
      }

      // Sort blueprints by total PI cost per run, highest first.
      bpPiReqs = [...bpMap.values()].sort((a, b) => {
        const ca = a.piMaterials.reduce((s, m) => s + m.iskPerRun, 0);
        const cb = b.piMaterials.reduce((s, m) => s + m.iskPerRun, 0);
        return cb - ca;
      });
    }

    const result = { rankings, bpPiReqs };

    // Store in per-character+tax-rate cache (evict oldest entry if cache grows beyond 200 entries).
    // Not when prices were unavailable, so the next visit tries again.
    if (jitaMap) {
      if (piMarketCache.size >= 200) {
        piMarketCache.delete(piMarketCache.keys().next().value);
      }
      piMarketCache.set(cacheKey, { data: result, fetchedAt: Date.now() });
    }

    res.json(result);
  } catch (err) {
    // Log full error on server but return a generic message to the client.
    // Returning err.message would leak internal DB schema details.
    logger.error('PI market error:', err);
    res.status(500).json({ error: 'Failed to load PI market data' });
  }
});

module.exports = router;
