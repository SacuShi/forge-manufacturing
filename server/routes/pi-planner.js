'use strict';
/**
 * PI Planner — recommends which system/planet in a region to use for a target
 * PI chain (P0-P4, or an item manufactured from PI like Fuel Blocks).
 *
 * BUILDING RESTRICTIONS (EVE University wiki — Planetary Buildings)
 * ─────────────────────────────────────────────────────────────────
 *   Basic Industrial Facility    → P0→P1   — any planet type
 *   Advanced Industrial Facility → P1→P2,  — any planet type
 *                                  P2→P3
 *   High-Tech Production Plant   → P3→P4   — Barren or Temperate ONLY (CCP hard rule)
 *
 * EFFICIENT SETUP MODELLED HERE
 * ──────────────────────────────
 * 1. Extraction planets: extractor(s) harvest P0 + Basic Industrial Facility
 *    produces P1 on-site — no haulage for P1.
 *
 * 2. Co-located planets: when both P0 inputs for a P2 product are available on
 *    the same planet type, one planet handles both extractions, both P1 productions,
 *    and the P2 Advanced Industrial Facility — eliminating the dedicated factory planet
 *    and reducing haulage to zero for that P2.
 *
 * 3. Factory planets: dedicated to P2/P3/P4 that could not be co-located.
 *    One planet per tier group; a single planet runs multiple schematics simultaneously.
 *    P4 is hard-restricted to Barren or Temperate.
 *
 * FACTORY PLANET TYPE PREFERENCE (EVE University — Identifying valuable planets)
 * ────────────────────────────────────────────────────────────────────────────────
 * Smaller planet radius → shorter links → less CPU/Power consumed by links →
 * more factories fit. Typical size ranking smallest→largest:
 *   Barren (best; P4 capable) → Lava → Plasma/Storm/Ice/Oceanic → Temperate → Gas (avoid)
 *
 * ENDPOINTS (all public — no EVE token required)
 * ───────────────────────────────────────────────
 *   GET  /api/pi-planner/regions
 *   GET  /api/pi-planner/targets?q=...
 *   POST /api/pi-planner/plan
 */

const router = require('express').Router();

const CHUNK = 500;

// Authoritative PI tier map — mirrors sde-import.js PI_TIER_NAMES.
// Used to classify schematic products without relying on items.pi_tier being populated.
const PI_TIER_BY_NAME = {
  // P0 — Raw Materials
  'Aqueous Liquids':0,'Autotrophs':0,'Base Metals':0,'Carbon Compounds':0,
  'Complex Organisms':0,'Felsic Magma':0,'Heavy Metals':0,'Ionic Solutions':0,
  'Microorganisms':0,'Noble Gas':0,'Noble Metals':0,'Non-CS Crystals':0,
  'Planktic Colonies':0,'Reactive Gas':0,'Suspended Plasma':0,
  // P1 — Basic Commodities
  'Bacteria':1,'Biofuels':1,'Biomass':1,'Chiral Structures':1,
  'Electrolytes':1,'Industrial Fibers':1,'Oxidizing Compound':1,
  'Oxygen':1,'Plasmoids':1,'Precious Metals':1,'Proteins':1,
  'Reactive Metals':1,'Silicon':1,'Toxic Metals':1,'Water':1,
  // P2 — Refined Commodities
  'Biocells':2,'Construction Blocks':2,'Consumer Electronics':2,
  'Coolant':2,'Enriched Uranium':2,'Fertilizer':2,
  'Genetically Enhanced Livestock':2,'Livestock':2,'Mechanical Parts':2,
  'Microfiber Shielding':2,'Miniature Electronics':2,'Nanites':2,
  'Oxides':2,'Polyaramids':2,'Polytextiles':2,'Rocket Fuel':2,
  'Silicate Glass':2,'Superconductors':2,'Supertensile Plastics':2,
  'Synthetic Oil':2,'Test Cultures':2,
  'Transmitter':2,'Viral Agent':2,'Water-Cooled CPU':2,
  // P3 — Specialized Commodities
  'Biotech Research Reports':3,'Camera Drones':3,'Condensates':3,
  'Cryoprotectant Solution':3,'Data Chips':3,'Gel-Matrix Biopaste':3,
  'Guidance Systems':3,'Hazmat Detection Systems':3,'Hermetic Membranes':3,
  'High-Tech Transmitters':3,'Industrial Explosives':3,'Neocoms':3,
  'Nuclear Reactors':3,'Planetary Vehicles':3,'Robotics':3,
  'Smartfab Units':3,'Supercomputers':3,'Synthetic Synapses':3,
  'Transcranial Microcontrollers':3,'Ukomi Superconductors':3,'Vaccines':3,
  // P4 — Advanced Commodities
  'Broadcast Node':4,'Integrity Response Drones':4,'Nano-Factory':4,
  'Organic Mortar Applicators':4,'Recursive Computing Module':4,
  'Self-Harmonizing Power Core':4,'Sterile Conduits':4,'Wetware Mainframe':4,
};

// Hard CCP rule: High-Tech Production Plant (P3→P4) can only be built on these types.
const P4_PLANET_TYPES = new Set(['Barren', 'Temperate']);

// Factory planet suitability rank (lower = better). Based on typical planet radius
// per type: smaller radius → cheaper links → more CPU/Power headroom.
// Source: EVE University "Identifying valuable planets" wiki.
const FACTORY_PLANET_RANK = new Map([
  ['Barren',    0],  // typically smallest habitable type; P4 capable
  ['Lava',      1],  // often very small; not P4 capable
  ['Plasma',    2],
  ['Storm',     2],
  ['Ice',       3],
  ['Oceanic',   3],
  ['Temperate', 4],  // P4 capable but larger than Barren; higher link costs
  ['Gas',       9],  // typically huge; worst link costs — avoid for factories
]);

const factoryPlanetRank = (typeName) => FACTORY_PLANET_RANK.get(typeName) ?? 5;

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Walks a target item's production chain down to its P0 raw materials.
 * Returns:
 *   requiredRaw     — P0 resources to extract
 *   requiredFactory — P2/P3/P4 products needing a factory planet (P1 is co-located)
 *   p0ToP1          — P0 typeId → P1 typeId (produced on-site at extraction planet)
 *   p2ToP0s         — P2 typeId → [P0 typeId, ...] (transitive P0 prerequisites of each P2)
 *   productTiers    — typeId → pi_tier
 */
async function resolveRequiredCommodities(targetTypeIds, { dbAll, dbGet, piTierOf }) {
  const requiredRaw     = new Set();
  const requiredFactory = new Set();
  const productTiers    = new Map();
  const p0ToP1          = new Map();
  const visited          = new Set();

  async function resolve(typeId) {
    if (visited.has(typeId)) return;
    visited.add(typeId);

    // Use authoritative tier map — does NOT rely on items.pi_tier being populated in DB.
    const knownTier = piTierOf(typeId);

    const schematic = await dbGet(
      `SELECT schematic_id FROM pi_schematics WHERE product_type_id = ?`, [typeId]
    );
    if (schematic) {
      const tier = knownTier ?? 0;
      productTiers.set(typeId, tier);
      if (tier >= 2) requiredFactory.add(typeId); // P1 stays on extraction planet
      const materials = await dbAll(
        `SELECT material_type_id FROM pi_schematic_materials WHERE schematic_id = ?`,
        [schematic.schematic_id]
      );
      await Promise.all(materials.map(m => resolve(m.material_type_id)));
      return;
    }

    if (knownTier === 0) {
      // P0 raw resource — find which P1 schematic consumes it
      requiredRaw.add(typeId);
      if (!p0ToP1.has(typeId)) {
        // Find the schematic that takes this P0 as input and produces a P1 product.
        // Avoid JOIN on items.pi_tier (may be NULL in deployed DB) — filter via piTierOf instead.
        const candidates = await dbAll(
          `SELECT ps.product_type_id
           FROM pi_schematic_materials psm
           JOIN pi_schematics ps ON ps.schematic_id = psm.schematic_id
           WHERE psm.material_type_id = ?`,
          [typeId]
        );
        for (const row of candidates) {
          if (piTierOf(row.product_type_id) === 1) {
            p0ToP1.set(typeId, row.product_type_id);
            productTiers.set(row.product_type_id, 1);
            break;
          }
        }
      }
      return;
    }

    // Not a PI item — recurse into manufacturing blueprint's PI-tier materials only.
    // Use our tier map for filtering so items.pi_tier NULL doesn't break the JOIN.
    const bpMaterials = await dbAll(
      `SELECT bm.material_id FROM blueprint_materials bm
       JOIN blueprints b ON b.blueprint_id = bm.blueprint_id
       WHERE b.product_id = ? AND (b.activity_id = 1 OR b.activity_id IS NULL)`,
      [typeId]
    );
    for (const m of bpMaterials) {
      if (piTierOf(m.material_id) !== null) await resolve(m.material_id);
    }
  }

  for (const typeId of targetTypeIds) await resolve(typeId);

  // Build p2ToP0s: the transitive P0 prerequisites for each P2 product.
  // Used to detect co-location opportunities (both P0s on one planet type → P2 on same planet).
  const p1ToP0 = new Map([...p0ToP1.entries()].map(([p0, p1]) => [p1, p0]));
  const p2ToP0s = new Map();
  for (const typeId of requiredFactory) {
    if ((productTiers.get(typeId) ?? 0) !== 2) continue;
    const sch = await dbGet(`SELECT schematic_id FROM pi_schematics WHERE product_type_id = ?`, [typeId]);
    if (!sch) continue;
    const p1Inputs = await dbAll(
      `SELECT material_type_id FROM pi_schematic_materials WHERE schematic_id = ?`, [sch.schematic_id]
    );
    const p0Set = new Set();
    for (const row of p1Inputs) {
      const p0 = p1ToP0.get(row.material_type_id);
      if (p0 != null) p0Set.add(p0);
    }
    if (p0Set.size > 0) p2ToP0s.set(typeId, [...p0Set]);
  }

  return {
    requiredRaw:     [...requiredRaw],
    requiredFactory: [...requiredFactory],
    p0ToP1,
    p2ToP0s,
    productTiers,
  };
}

/**
 * Greedy planet assignment. Steps in order:
 *
 * 0. Co-located planets: for each P2 where all required P0s exist on one planet type,
 *    assign one planet that extracts all P0s, produces all P1s, and runs the P2 AIF.
 *    Eliminates both the separate extraction planets AND the factory planet for that P2.
 *
 * 1. Extraction planets: one planet per remaining P0 resource (not handled by co-location).
 *    Each also runs a Basic Industrial Facility for P1 production on-site.
 *
 * 2. Factory planets: one planet per remaining tier group (P2 not co-located, P3, P4).
 *    P4 is hard-restricted to Barren/Temperate. All factory tiers sorted by
 *    FACTORY_PLANET_RANK (Barren best → Gas worst).
 */
function assignPlanets(planets, requiredRaw, requiredFactory, resourcesByType, productTiers, p0ToP1, colocations, mode = 'efficient') {
  const usedPlanetIdx = new Set();
  const usedSystemIds = new Set();
  const assignment     = [];

  const sortByAffinity = (candidates) => {
    candidates.sort((a, b) => {
      const aUsed = usedSystemIds.has(planets[a].system_id) ? 0 : 1;
      const bUsed = usedSystemIds.has(planets[b].system_id) ? 0 : 1;
      if (aUsed !== bUsed) return aUsed - bUsed;
      return factoryPlanetRank(planets[a].planet_type_name) - factoryPlanetRank(planets[b].planet_type_name);
    });
  };

  // Step 0: Co-located P2 planets (skipped in 'volume' mode — every product gets its own planet)
  const colocatedP0s = new Set();
  const colocatedP2s = new Set();

  if (mode !== 'volume') for (const col of colocations) {
    // Find an available planet whose type supplies ALL required P0s for this P2.
    const candidates = planets.map((_, i) => i).filter(i => {
      if (usedPlanetIdx.has(i)) return false;
      const resources = resourcesByType.get(planets[i].planet_type_name);
      if (!resources) return false;
      return col.p0TypeIds.every(p0 => resources.has(p0));
    });
    if (!candidates.length) continue; // cannot co-locate this P2; falls back to regular

    sortByAffinity(candidates);
    const chosen = candidates[0];
    usedPlanetIdx.add(chosen);
    usedSystemIds.add(planets[chosen].system_id);

    for (const p0 of col.p0TypeIds) colocatedP0s.add(p0);
    colocatedP2s.add(col.p2TypeId);

    assignment.push({
      planet:    planets[chosen],
      kind:      'colocate',
      p0TypeIds: col.p0TypeIds,
      p1TypeIds: col.p0TypeIds.map(p0 => p0ToP1.get(p0)).filter(Boolean),
      p2TypeId:  col.p2TypeId,
    });
  }

  // Step 1: Remaining extraction planets (P0s not covered by co-location)
  const remainingRaw = requiredRaw.filter(p0 => !colocatedP0s.has(p0));

  // Build supply map for remaining P0s only
  const supplyMap = new Map();
  planets.forEach((p, i) => {
    const resources = resourcesByType.get(p.planet_type_name);
    if (!resources) return;
    for (const rid of remainingRaw) {
      if (resources.has(rid)) {
        if (!supplyMap.has(rid)) supplyMap.set(rid, []);
        supplyMap.get(rid).push(i);
      }
    }
  });
  for (const rid of remainingRaw) {
    if (!supplyMap.get(rid)?.length) return null; // region cannot supply this P0
  }

  const resourceOrder = [...remainingRaw].sort((a, b) => supplyMap.get(a).length - supplyMap.get(b).length);
  for (const rid of resourceOrder) {
    const candidates = supplyMap.get(rid).filter(i => !usedPlanetIdx.has(i));
    if (!candidates.length) return null;
    // Extraction planets: prefer system clustering, then factory rank (smaller planets
    // leave more headroom for the Basic Industrial Facility).
    sortByAffinity(candidates);
    const chosen = candidates[0];
    usedPlanetIdx.add(chosen);
    usedSystemIds.add(planets[chosen].system_id);
    assignment.push({
      planet:   planets[chosen],
      kind:     'extract',
      typeId:   rid,
      p1TypeId: p0ToP1.get(rid) ?? null,
    });
  }

  // Step 2: Factory planets for remaining P2/P3/P4
  const remainingFactory = requiredFactory.filter(id => !colocatedP2s.has(id));

  if (mode === 'efficient') {
    // Group by tier — one shared factory planet per tier level (minimum colony slots)
    const tierGroups = new Map();
    for (const typeId of remainingFactory) {
      const tier = productTiers.get(typeId) ?? 0;
      if (!tierGroups.has(tier)) tierGroups.set(tier, []);
      tierGroups.get(tier).push(typeId);
    }
    const groupOrder = [...tierGroups.keys()].sort((a, b) => {
      if (a === 4) return -1;
      if (b === 4) return 1;
      return b - a;
    });
    for (const tier of groupOrder) {
      const typeIds = tierGroups.get(tier);
      const isP4 = tier === 4;
      let candidates = planets.map((_, i) => i).filter(i => !usedPlanetIdx.has(i));
      if (isP4) candidates = candidates.filter(i => P4_PLANET_TYPES.has(planets[i].planet_type_name));
      if (!candidates.length) return null;
      sortByAffinity(candidates);
      const chosen = candidates[0];
      usedPlanetIdx.add(chosen);
      usedSystemIds.add(planets[chosen].system_id);
      assignment.push({ planet: planets[chosen], typeIds, factoryTier: tier, kind: 'factory' });
    }
  } else {
    // balanced / volume — one dedicated factory planet per unique product (max throughput per schematic)
    // P4 first (most constrained — Barren/Temperate only), then descending tier
    const sorted = [...remainingFactory].sort((a, b) => {
      const ta = productTiers.get(a) ?? 0;
      const tb = productTiers.get(b) ?? 0;
      if (ta === 4) return -1;
      if (tb === 4) return 1;
      return tb - ta;
    });
    for (const typeId of sorted) {
      const tier = productTiers.get(typeId) ?? 0;
      const isP4 = tier === 4;
      let candidates = planets.map((_, i) => i).filter(i => !usedPlanetIdx.has(i));
      if (isP4) candidates = candidates.filter(i => P4_PLANET_TYPES.has(planets[i].planet_type_name));
      if (!candidates.length) return null;
      sortByAffinity(candidates);
      const chosen = candidates[0];
      usedPlanetIdx.add(chosen);
      usedSystemIds.add(planets[chosen].system_id);
      assignment.push({ planet: planets[chosen], typeIds: [typeId], factoryTier: tier, kind: 'factory' });
    }
  }

  return assignment;
}

/**
 * Finds the best system (or minimal cluster) to cover the PI chain.
 * Preference: single system → constellation → region.
 */
async function planProduction({ regionId, requiredRaw, requiredFactory, productTiers, p0ToP1, p2ToP0s, colonySlots, dbAll, mode = 'efficient' }) {
  const systems = await dbAll(
    `SELECT system_id, name, constellation_id, security_status FROM sde_systems WHERE region_id = ?`,
    [regionId]
  );
  if (!systems.length) return { candidates: [], reason: 'No systems found for this region' };

  const resourceRows = await dbAll(`SELECT planet_type_name, resource_type_id FROM pi_planet_resources`);
  const resourcesByType = new Map();
  for (const r of resourceRows) {
    if (!resourcesByType.has(r.planet_type_name)) resourcesByType.set(r.planet_type_name, new Set());
    resourcesByType.get(r.planet_type_name).add(r.resource_type_id);
  }

  // Determine which P2 products can be co-located (both P0 prerequisites on one planet type).
  // A co-located P2 eliminates both its extraction planets AND its factory planet (saves 2 slots).
  const colocations = [];
  for (const [p2TypeId, p0TypeIds] of p2ToP0s) {
    const eligible = [];
    for (const [planetType, resources] of resourcesByType) {
      if (p0TypeIds.every(p0 => resources.has(p0))) eligible.push(planetType);
    }
    if (eligible.length > 0) {
      eligible.sort((a, b) => factoryPlanetRank(a) - factoryPlanetRank(b));
      colocations.push({ p2TypeId, p0TypeIds, eligiblePlanetTypes: eligible });
    }
  }
  // Most constrained co-locations first (fewest eligible planet types)
  colocations.sort((a, b) => a.eligiblePlanetTypes.length - b.eligiblePlanetTypes.length);

  const systemIds = systems.map(s => s.system_id);
  const planetRows = [];
  for (const chunk of chunks(systemIds, CHUNK)) {
    const rows = await dbAll(
      `SELECT planet_id, system_id, planet_index, type_id, planet_type_name FROM sde_planets WHERE system_id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    planetRows.push(...rows);
  }

  const systemById      = new Map(systems.map(s => [s.system_id, s]));
  const planetsBySystem = new Map();
  for (const p of planetRows) {
    if (!planetsBySystem.has(p.system_id)) planetsBySystem.set(p.system_id, []);
    planetsBySystem.get(p.system_id).push(p);
  }

  // Minimum planet count varies by mode.
  const colocatableP2s = new Set(colocations.map(c => c.p2TypeId));
  const remainingRawForMin = requiredRaw.filter(p0 => {
    for (const col of colocations) { if (col.p0TypeIds.includes(p0)) return false; }
    return true;
  });
  const remainingFactoryForMin = requiredFactory.filter(id => !colocatableP2s.has(id));
  const factoryTierCount = new Set(remainingFactoryForMin.map(id => productTiers.get(id) ?? 0)).size;
  let minPlanetsNeeded;
  if (mode === 'efficient') {
    minPlanetsNeeded = colocations.length + remainingRawForMin.length + factoryTierCount;
  } else if (mode === 'balanced') {
    minPlanetsNeeded = colocations.length + remainingRawForMin.length + remainingFactoryForMin.length;
  } else { // volume
    minPlanetsNeeded = requiredRaw.length + requiredFactory.length;
  }

  const yieldEvery = async (i, n = 50) => { if (i % n === 0) await new Promise(r => setImmediate(r)); };
  const assign = (pool) => assignPlanets(pool, requiredRaw, requiredFactory, resourcesByType, productTiers, p0ToP1, colocations, mode);

  // 1. Single system
  const singleResults = [];
  let si = 0;
  for (const sys of systems) {
    await yieldEvery(si++);
    const planets = planetsBySystem.get(sys.system_id) || [];
    if (planets.length < minPlanetsNeeded) continue;
    const result = assign(planets);
    if (result) singleResults.push({ systems: [sys], planets: result });
  }
  singleResults.sort((a, b) => a.planets.length - b.planets.length);
  const singleOk = singleResults.filter(r => r.planets.length <= colonySlots);
  if (singleOk.length) return { candidates: singleOk.slice(0, 3), spansMultipleSystems: false };

  // 2. Constellation pool
  const constellations = new Map();
  for (const sys of systems) {
    if (!constellations.has(sys.constellation_id)) constellations.set(sys.constellation_id, []);
    constellations.get(sys.constellation_id).push(sys);
  }
  const constResults = [];
  let ci = 0;
  for (const constSystems of constellations.values()) {
    await yieldEvery(ci++);
    const pooled = constSystems.flatMap(s => planetsBySystem.get(s.system_id) || []);
    const result = assign(pooled);
    if (result) {
      const usedSysIds = [...new Set(result.map(a => a.planet.system_id))];
      constResults.push({ systems: usedSysIds.map(id => systemById.get(id)), planets: result });
    }
  }
  constResults.sort((a, b) => (a.systems.length - b.systems.length) || (a.planets.length - b.planets.length));
  const constOk = constResults.filter(r => r.planets.length <= colonySlots);
  if (constOk.length) return { candidates: constOk.slice(0, 3), spansMultipleSystems: true, clusteredBy: 'constellation' };

  // 3. Entire region
  const result = assign(planetRows);
  if (result && result.length <= colonySlots) {
    const usedSysIds = [...new Set(result.map(a => a.planet.system_id))];
    return { candidates: [{ systems: usedSysIds.map(id => systemById.get(id)), planets: result }], spansMultipleSystems: true, clusteredBy: 'region' };
  }

  return {
    candidates: [],
    reason: result
      ? `This region can supply the full chain but needs at least ${result.length} colony slots`
      : 'This region cannot supply all the required raw materials for this target',
  };
}

// Cache: built lazily on first /plan request, persists for process lifetime.
let _tierByTypeId = null;
async function getTierByTypeId(dbAll) {
  if (_tierByTypeId) return _tierByTypeId;
  const allPiNames = Object.keys(PI_TIER_BY_NAME);
  const placeholders = allPiNames.map(() => '?').join(',');
  const rows = await dbAll(
    `SELECT type_id, name FROM items WHERE name IN (${placeholders})`,
    allPiNames
  );
  const map = new Map();
  for (const r of rows) {
    const t = PI_TIER_BY_NAME[r.name];
    if (t !== undefined) map.set(r.type_id, t);
  }
  _tierByTypeId = map;
  return map;
}

module.exports = function piPlannerRoutes({ dbAll, dbGet, security }) {

  router.get('/api/pi-planner/regions', security.apiLimiter, async (req, res) => {
    try {
      const regions = await dbAll(`SELECT region_id, name FROM sde_regions WHERE region_id < 11000000 ORDER BY name`);
      res.json({ regions });
    } catch (err) {
      console.error('PI planner /regions error:', err);
      res.status(500).json({ error: 'Failed to load regions' });
    }
  });

  router.get('/api/pi-planner/targets', security.apiLimiter, async (req, res) => {
    try {
      const q = `%${(req.query.q || '').trim().slice(0, 100)}%`;
      // Search PI items (by name from our authoritative tier map) + non-PI items made from PI.
      const tierByTypeId = await getTierByTypeId(dbAll);
      const piTypeIds = [...tierByTypeId.keys()];
      const piPlaceholders = piTypeIds.map(() => '?').join(',');
      const [piRows, bpRows] = await Promise.all([
        piTypeIds.length
          ? dbAll(`SELECT type_id, name FROM items WHERE type_id IN (${piPlaceholders}) AND name LIKE ? ORDER BY name LIMIT 50`, [...piTypeIds, q])
          : Promise.resolve([]),
        dbAll(
          `SELECT DISTINCT i.type_id, i.name
           FROM items i
           JOIN blueprints b           ON b.product_id = i.type_id AND (b.activity_id = 1 OR b.activity_id IS NULL)
           JOIN blueprint_materials bm ON bm.blueprint_id = b.blueprint_id
           WHERE bm.material_id IN (${piPlaceholders}) AND i.name LIKE ?
           ORDER BY i.name LIMIT 50`,
          [...piTypeIds, q]
        ),
      ]);
      const seen = new Set();
      const rows = [];
      for (const r of piRows) {
        if (seen.has(r.type_id)) continue;
        seen.add(r.type_id);
        rows.push({ type_id: r.type_id, name: r.name, pi_tier: tierByTypeId.get(r.type_id) ?? null });
      }
      for (const r of bpRows) {
        if (seen.has(r.type_id) || tierByTypeId.has(r.type_id)) continue;
        seen.add(r.type_id);
        rows.push({ type_id: r.type_id, name: r.name, pi_tier: null });
      }
      rows.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ targets: rows.slice(0, 50) });
    } catch (err) {
      console.error('PI planner /targets error:', err);
      res.status(500).json({ error: 'Failed to search targets' });
    }
  });

  router.post('/api/pi-planner/plan', security.apiLimiter, async (req, res) => {
    try {
      const regionId = parseInt(req.body?.regionId, 10);
      const targetTypeIds = Array.isArray(req.body?.targetTypeIds)
        ? [...new Set(req.body.targetTypeIds.map(id => parseInt(id, 10)).filter(Boolean))]
        : [];
      const colonySlots = Math.max(1, Math.min(200, parseInt(req.body?.colonySlots, 10) || 36));
      const mode = ['efficient', 'balanced', 'volume'].includes(req.body?.mode) ? req.body.mode : 'efficient';

      if (!regionId)          return res.status(400).json({ error: 'regionId is required' });
      if (!targetTypeIds.length) return res.status(400).json({ error: 'At least one target is required' });

      const tierByTypeId = await getTierByTypeId(dbAll);
      const piTierOf = (id) => {
        const t = tierByTypeId.get(id);
        return t !== undefined ? t : null;
      };

      const { requiredRaw, requiredFactory, p0ToP1, p2ToP0s, productTiers } =
        await resolveRequiredCommodities(targetTypeIds, { dbAll, dbGet, piTierOf });

      if (!requiredRaw.length && !requiredFactory.length)
        return res.status(400).json({ error: 'Could not resolve a PI production chain for the selected target(s)' });

      const result = await planProduction({
        regionId, requiredRaw, requiredFactory, productTiers, p0ToP1, p2ToP0s, colonySlots, dbAll, mode,
      });

      // Collect all type IDs needed for name lookup
      const allTypeIds = [...new Set([
        ...requiredRaw,
        ...[...p0ToP1.values()],
        ...requiredFactory,
        ...result.candidates.flatMap(c => c.planets.flatMap(p => {
          if (p.kind === 'extract')  return [p.typeId, p.p1TypeId].filter(Boolean);
          if (p.kind === 'colocate') return [...p.p0TypeIds, ...p.p1TypeIds, p.p2TypeId];
          return p.typeIds; // factory
        })),
      ])];

      const nameRows = allTypeIds.length
        ? await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE type_id IN (${allTypeIds.map(() => '?').join(',')})`, allTypeIds)
        : [];
      const namesById = new Map(nameRows.map(r => [r.type_id, r]));
      const nameOf = (id) => namesById.get(id)?.name || `Item #${id}`;

      const candidates = result.candidates.map(c => ({
        systems: c.systems.map(s => ({ systemId: s.system_id, name: s.name, securityStatus: s.security_status })),
        planets: c.planets.map(p => {
          const base = {
            planetId:       p.planet.planet_id,
            planetIndex:    p.planet.planet_index,
            planetTypeName: p.planet.planet_type_name,
            systemId:       p.planet.system_id,
          };

          if (p.kind === 'extract') {
            return { ...base, assignment: {
              kind:          'extract',
              extractTypeId: p.typeId,
              extractName:   nameOf(p.typeId),
              p1TypeId:      p.p1TypeId ?? null,
              p1Name:        p.p1TypeId ? nameOf(p.p1TypeId) : null,
            }};
          }

          if (p.kind === 'colocate') {
            return { ...base, assignment: {
              kind:      'colocate',
              p0s:       p.p0TypeIds.map(id => ({ typeId: id, name: nameOf(id) })),
              p1s:       p.p1TypeIds.map(id => ({ typeId: id, name: nameOf(id) })),
              p2:        { typeId: p.p2TypeId, name: nameOf(p.p2TypeId) },
            }};
          }

          // factory
          return { ...base, assignment: {
            kind:        'factory',
            factoryTier: p.factoryTier,
            products:    p.typeIds.map(id => ({
              typeId: id, name: nameOf(id), tier: piTierOf(id) ?? namesById.get(id)?.pi_tier ?? null,
            })),
          }};
        }),
      }));

      const p1Products = [...new Set([...p0ToP1.values()])].map(id => ({
        typeId: id, name: nameOf(id), tier: 1, note: 'produced on extraction planet',
      }));

      res.json({
        requiredRaw:     requiredRaw.map(id => ({ typeId: id, name: nameOf(id) })),
        requiredP1:      p1Products,
        requiredFactory: requiredFactory.map(id => ({ typeId: id, name: nameOf(id), tier: piTierOf(id) ?? namesById.get(id)?.pi_tier ?? null })),
        candidates,
        spansMultipleSystems: !!result.spansMultipleSystems,
        clusteredBy: result.clusteredBy || null,
        reason:      result.reason || null,
        note: mode === 'efficient'
          ? 'Efficient: fewest colony slots — P2s are co-located on extraction planets where both P0 inputs exist on the same planet type, and remaining P2/P3/P4 share a single factory planet per tier. P1 produced on-site at all extraction planets. P4 requires Barren or Temperate. Factory preference: Barren > Lava > Plasma/Storm/Ice/Oceanic > Temperate > Gas. CPU/Power and extractor yield not modeled — verify in-game.'
          : mode === 'balanced'
          ? 'Balanced: co-locates P2s where planet types allow (saves colony slots for those products), but each remaining factory product gets its own dedicated planet for better per-schematic CPU/Power headroom. P1 produced on-site. P4 requires Barren or Temperate. Factory preference: Barren > Lava > Plasma/Storm/Ice/Oceanic > Temperate > Gas. CPU/Power and extractor yield not modeled — verify in-game.'
          : 'Volume / Max ISK/hr: every PI product on its own dedicated planet — no co-location, no tier-sharing. Maximum CPU/Power per schematic = maximum throughput = maximum ISK/hr potential. Uses the most colony slots. P4 requires Barren or Temperate. Factory preference: Barren > Lava > Plasma/Storm/Ice/Oceanic > Temperate > Gas. CPU/Power and extractor yield not modeled — verify in-game.',
      });
    } catch (err) {
      console.error('PI planner /plan error:', err);
      res.status(500).json({ error: 'Failed to compute PI plan' });
    }
  });

  return router;
};

module.exports.resolveRequiredCommodities = resolveRequiredCommodities;
