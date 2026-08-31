'use strict';
/**
 * PI Planner — recommends which system/planet in a region to use for a target
 * PI chain (P0-P4, or an item manufactured from PI like Fuel Blocks).
 *
 * WHAT IS PLANETARY INDUSTRY (PI)?
 * ──────────────────────────────────
 * In EVE Online, players can place colonies on planets to extract raw resources
 * (P0) and process them through up to four manufacturing tiers (P1 → P2 → P3 → P4).
 * The problem: each planet only produces certain raw materials, and the factories
 * that process them can go on any planet — but P4 factories are restricted to
 * Barren or Temperate planets specifically. A full production chain often requires
 * multiple planets across multiple systems.
 *
 * WHAT THIS PLANNER SOLVES
 * ──────────────────────────
 * Given a target item (e.g. Fuel Blocks, an implant, or a raw P2 product) and a
 * region of space, the planner:
 *   1. Walks the production chain recursively to find every raw resource (P0) needed.
 *   2. Finds which planet types supply those raw resources.
 *   3. Greedily assigns planets to minimise the number of systems used (clustering).
 *   4. Returns up to 3 candidate solutions, preferring single-system setups over
 *      multi-system, and multi-system within a constellation over region-wide.
 *
 * SCOPE (confirmed with Andy — deliberately narrow)
 * ──────────────────────────────────────────────────
 * This planner answers WHICH system/planet gets WHICH assignment. It does NOT
 * model: extractor yield, factory output quantities, cycle times, CPU/Power
 * capacity, or Command Center Upgrade skill level. Those are all quantity/skill
 * questions the player must verify in-game after placing the topology.
 *
 * ENDPOINTS (all public — no EVE token required, no user data returned)
 * ───────────────────────────────────────────────────────────────────────
 *   GET  /api/pi-planner/regions         — all k-space regions (for the region picker)
 *   GET  /api/pi-planner/targets?q=...   — search for plannable targets by name
 *   POST /api/pi-planner/plan            — compute a plan for a given region + target(s)
 */

const router = require('express').Router();

const CHUNK = 500; // SQLite bind-variable safety margin, matches sde-import.js convention

// P4 factories (High-Tech Production Plants) can ONLY be built on Barren or Temperate
// planets — a hard CCP game rule (EVE University's Planetary Buildings page), not a
// skill/quantity question, so it's in scope even though yield/cycle times aren't.
const P4_PLANET_TYPES = new Set(['Barren', 'Temperate']);

// Community convention: Barren/Temperate are also generally preferred for factory duty
// at ANY tier (smaller planet radius → cheaper links → more CPU/Power headroom for
// processors). This is a soft tie-break, not a verified numeric bonus — it only decides
// between otherwise-equal candidates, never overrides system-clustering or the hard P4 rule.
const FACTORY_PREFERRED_TYPES = P4_PLANET_TYPES;

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Walks a target item's production chain down to its P0 raw materials.
 *
 * - If the target is a PI schematic product (P1-P4), recurse into its schematic materials.
 * - Otherwise, if it's a manufactured item (e.g. Fuel Block), look up its manufacturing
 *   blueprint and recurse only into materials that are themselves PI items — non-PI
 *   inputs (minerals, etc.) are out of scope.
 * - Base case: pi_tier = 0 (a raw material) — leaf node, no further recursion.
 *
 * @returns {{ requiredRaw: number[], requiredProducts: number[], productTiers: Map<number,number> }}
 */
async function resolveRequiredCommodities(targetTypeIds, { dbAll, dbGet }) {
  const requiredRaw      = new Set();
  const requiredProducts = new Set();
  const productTiers     = new Map(); // typeId -> pi_tier (1-4), for the P4-planet-type rule
  const visited           = new Set();

  async function resolve(typeId) {
    if (visited.has(typeId)) return;
    visited.add(typeId);

    const schematic = await dbGet(
      `SELECT schematic_id FROM pi_schematics WHERE product_type_id = ?`, [typeId]
    );
    if (schematic) {
      const item = await dbGet(`SELECT pi_tier FROM items WHERE type_id = ?`, [typeId]);
      if (item?.pi_tier >= 1) { requiredProducts.add(typeId); productTiers.set(typeId, item.pi_tier); }
      const materials = await dbAll(
        `SELECT material_type_id FROM pi_schematic_materials WHERE schematic_id = ?`, [schematic.schematic_id]
      );
      await Promise.all(materials.map(m => resolve(m.material_type_id)));
      return;
    }

    const item = await dbGet(`SELECT pi_tier FROM items WHERE type_id = ?`, [typeId]);
    if (item?.pi_tier === 0) {
      requiredRaw.add(typeId);
      return;
    }

    // Not a PI item at all — check for a manufacturing blueprint and pull in its
    // PI-tier materials only (mirrors the join used in GET /api/pi/market).
    const bpMaterials = await dbAll(
      `SELECT bm.material_id FROM blueprint_materials bm
       JOIN blueprints b ON b.blueprint_id = bm.blueprint_id
       JOIN items im     ON im.type_id     = bm.material_id
       WHERE b.product_id = ? AND (b.activity_id = 1 OR b.activity_id IS NULL) AND im.pi_tier IS NOT NULL`,
      [typeId]
    );
    for (const m of bpMaterials) await resolve(m.material_id);
  }

  for (const typeId of targetTypeIds) await resolve(typeId);
  return { requiredRaw: [...requiredRaw], requiredProducts: [...requiredProducts], productTiers };
}

/**
 * Greedily assigns planets in `planets` to cover every required raw resource
 * (matched by planet type) plus one planet per required schematic product (any
 * planet type). Returns null if this planet pool cannot cover all requirements.
 *
 * Scarcest raw resource (fewest supplying planets) is assigned first. When choosing
 * among multiple candidate planets for a resource, planets in an already-used system
 * are preferred — this clusters multi-system solutions onto as few systems as possible.
 *
 * Schematic (factory) assignment: P4 is hard-restricted to Barren/Temperate planets
 * (see P4_PLANET_TYPES); all tiers softly prefer Barren/Temperate as a tie-break after
 * system-clustering (see FACTORY_PREFERRED_TYPES). P4s are placed first since they're
 * the most constrained.
 */
function assignPlanets(planets, requiredRaw, requiredProducts, resourcesByType, productTiers) {
  const supplyMap = new Map(); // resourceTypeId -> [planetIndex, ...]
  planets.forEach((p, i) => {
    const resources = resourcesByType.get(p.planet_type_name);
    if (!resources) return;
    for (const rid of requiredRaw) {
      if (resources.has(rid)) {
        if (!supplyMap.has(rid)) supplyMap.set(rid, []);
        supplyMap.get(rid).push(i);
      }
    }
  });

  for (const rid of requiredRaw) {
    if (!supplyMap.get(rid)?.length) return null; // no planet in this pool can ever supply this resource
  }

  const resourceOrder = [...requiredRaw].sort((a, b) => supplyMap.get(a).length - supplyMap.get(b).length);
  const usedPlanetIdx = new Set();
  const usedSystemIds = new Set();
  const assignment     = [];

  const byAffinity = (a, b) => {
    const aUsed = usedSystemIds.has(planets[a].system_id) ? 0 : 1;
    const bUsed = usedSystemIds.has(planets[b].system_id) ? 0 : 1;
    return aUsed - bUsed;
  };

  for (const rid of resourceOrder) {
    const candidates = supplyMap.get(rid).filter(i => !usedPlanetIdx.has(i));
    if (!candidates.length) return null; // scarcer resources already claimed this planet's slot
    candidates.sort(byAffinity);
    const chosen = candidates[0];
    usedPlanetIdx.add(chosen);
    usedSystemIds.add(planets[chosen].system_id);
    assignment.push({ planet: planets[chosen], typeId: rid, kind: 'extract' });
  }

  // P4s first — they're the most constrained (Barren/Temperate only).
  const productOrder = [...requiredProducts].sort(
    (a, b) => (productTiers.get(b) === 4 ? 1 : 0) - (productTiers.get(a) === 4 ? 1 : 0)
  );

  for (const typeId of productOrder) {
    const isP4 = productTiers.get(typeId) === 4;
    let candidates = planets.map((_, i) => i).filter(i => !usedPlanetIdx.has(i));
    if (isP4) candidates = candidates.filter(i => P4_PLANET_TYPES.has(planets[i].planet_type_name));
    if (!candidates.length) return null; // no eligible planet left (e.g. no spare Barren/Temperate for a P4)

    candidates.sort((a, b) => {
      const aUsed = usedSystemIds.has(planets[a].system_id) ? 0 : 1;
      const bUsed = usedSystemIds.has(planets[b].system_id) ? 0 : 1;
      if (aUsed !== bUsed) return aUsed - bUsed;
      const aPreferred = FACTORY_PREFERRED_TYPES.has(planets[a].planet_type_name) ? 0 : 1;
      const bPreferred = FACTORY_PREFERRED_TYPES.has(planets[b].planet_type_name) ? 0 : 1;
      return aPreferred - bPreferred;
    });

    const chosen = candidates[0];
    usedPlanetIdx.add(chosen);
    usedSystemIds.add(planets[chosen].system_id);
    assignment.push({ planet: planets[chosen], typeId, kind: 'produce' });
  }

  return assignment;
}

/**
 * Finds the best system (or smallest cluster of systems) in a region to cover the
 * required PI chain within a colony-slot budget.
 *
 * Preference order: single system → systems within the same constellation (a cheap
 * "these are close together" proxy — no stargate-jump pathfinding in v1) → the whole
 * region pooled together, whichever is reached first within budget.
 */
async function planProduction({ regionId, requiredRaw, requiredProducts, productTiers, colonySlots, dbAll }) {
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

  const systemIds = systems.map(s => s.system_id);
  const planetRows = [];
  for (const chunk of chunks(systemIds, CHUNK)) {
    const rows = await dbAll(
      `SELECT planet_id, system_id, planet_index, type_id, planet_type_name FROM sde_planets WHERE system_id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    planetRows.push(...rows);
  }

  const systemById = new Map(systems.map(s => [s.system_id, s]));
  const planetsBySystem = new Map();
  for (const p of planetRows) {
    if (!planetsBySystem.has(p.system_id)) planetsBySystem.set(p.system_id, []);
    planetsBySystem.get(p.system_id).push(p);
  }

  const minPlanetsNeeded = requiredRaw.length + requiredProducts.length;

  // Yield the event loop every N iterations so concurrent requests aren't starved
  // during the CPU-bound greedy search across hundreds of systems.
  const yieldEvery = async (i, n = 50) => { if (i % n === 0) await new Promise(r => setImmediate(r)); };

  // 1. Prefer a single system covering everything.
  const singleResults = [];
  let si = 0;
  for (const sys of systems) {
    await yieldEvery(si++);
    const planets = planetsBySystem.get(sys.system_id) || [];
    if (planets.length < minPlanetsNeeded) continue; // quick reject
    const assignment = assignPlanets(planets, requiredRaw, requiredProducts, resourcesByType, productTiers);
    if (assignment) singleResults.push({ systems: [sys], planets: assignment });
  }
  singleResults.sort((a, b) => a.planets.length - b.planets.length);
  const singleWithinBudget = singleResults.filter(r => r.planets.length <= colonySlots);
  if (singleWithinBudget.length) {
    return { candidates: singleWithinBudget.slice(0, 3), spansMultipleSystems: false };
  }

  // 2. Fall back to pooling systems within the same constellation.
  const constellations = new Map();
  for (const sys of systems) {
    if (!constellations.has(sys.constellation_id)) constellations.set(sys.constellation_id, []);
    constellations.get(sys.constellation_id).push(sys);
  }
  const constellationResults = [];
  let ci = 0;
  for (const constSystems of constellations.values()) {
    await yieldEvery(ci++);
    const pooled = constSystems.flatMap(s => planetsBySystem.get(s.system_id) || []);
    const assignment = assignPlanets(pooled, requiredRaw, requiredProducts, resourcesByType, productTiers);
    if (assignment) {
      const usedSystemIds = [...new Set(assignment.map(a => a.planet.system_id))];
      constellationResults.push({ systems: usedSystemIds.map(id => systemById.get(id)), planets: assignment });
    }
  }
  constellationResults.sort((a, b) => (a.systems.length - b.systems.length) || (a.planets.length - b.planets.length));
  const constellationWithinBudget = constellationResults.filter(r => r.planets.length <= colonySlots);
  if (constellationWithinBudget.length) {
    return { candidates: constellationWithinBudget.slice(0, 3), spansMultipleSystems: true, clusteredBy: 'constellation' };
  }

  // 3. Last resort — pool the entire region.
  const assignment = assignPlanets(planetRows, requiredRaw, requiredProducts, resourcesByType, productTiers);
  if (assignment && assignment.length <= colonySlots) {
    const usedSystemIds = [...new Set(assignment.map(a => a.planet.system_id))];
    return {
      candidates: [{ systems: usedSystemIds.map(id => systemById.get(id)), planets: assignment }],
      spansMultipleSystems: true, clusteredBy: 'region',
    };
  }

  return {
    candidates: [],
    reason: assignment
      ? `This region can supply the full chain but needs at least ${assignment.length} colony slots`
      : 'This region cannot supply all the required raw materials for this target',
  };
}

module.exports = function piPlannerRoutes({ dbAll, dbGet, security }) {

  router.get('/api/pi-planner/regions', security.apiLimiter, async (req, res) => {
    try {
      // Region IDs >= 11000000 are wormhole/Anoikis pseudo-regions — k-space only for v1.
      const regions = await dbAll(`SELECT region_id, name FROM sde_regions WHERE region_id < 11000000 ORDER BY name`);
      res.json({ regions });
    } catch (err) {
      console.error('PI planner /regions error:', err);
      res.status(500).json({ error: 'Failed to load regions' });
    }
  });

  router.get('/api/pi-planner/targets', security.apiLimiter, async (req, res) => {
    try {
      // Truncate before building the LIKE pattern — prevents a very long query
      // string from causing excessive SQLite processing.
      const q = `%${(req.query.q || '').trim().slice(0, 100)}%`;
      const rows = await dbAll(
        `SELECT type_id, name, pi_tier FROM items WHERE pi_tier BETWEEN 0 AND 4 AND name LIKE ?
         UNION
         SELECT DISTINCT i.type_id, i.name, NULL as pi_tier
         FROM items i
         JOIN blueprints b           ON b.product_id = i.type_id AND (b.activity_id = 1 OR b.activity_id IS NULL)
         JOIN blueprint_materials bm ON bm.blueprint_id = b.blueprint_id
         JOIN items im               ON im.type_id = bm.material_id
         WHERE im.pi_tier IS NOT NULL AND i.name LIKE ?
         ORDER BY name LIMIT 50`,
        [q, q]
      );
      res.json({ targets: rows });
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

      if (!regionId) return res.status(400).json({ error: 'regionId is required' });
      if (!targetTypeIds.length) return res.status(400).json({ error: 'At least one target is required' });

      const { requiredRaw, requiredProducts, productTiers } = await resolveRequiredCommodities(targetTypeIds, { dbAll, dbGet });
      if (!requiredRaw.length && !requiredProducts.length) {
        return res.status(400).json({ error: 'Could not resolve a PI production chain for the selected target(s)' });
      }

      const result = await planProduction({ regionId, requiredRaw, requiredProducts, productTiers, colonySlots, dbAll });

      const allTypeIds = [...new Set([
        ...requiredRaw, ...requiredProducts,
        ...result.candidates.flatMap(c => c.planets.map(p => p.typeId)),
      ])];
      const nameRows = allTypeIds.length
        ? await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE type_id IN (${allTypeIds.map(() => '?').join(',')})`, allTypeIds)
        : [];
      const namesById = new Map(nameRows.map(r => [r.type_id, r]));
      const nameOf = (id) => namesById.get(id)?.name || `Item #${id}`;

      const candidates = result.candidates.map(c => ({
        systems: c.systems.map(s => ({ systemId: s.system_id, name: s.name, securityStatus: s.security_status })),
        planets: c.planets.map(p => ({
          planetId: p.planet.planet_id,
          planetIndex: p.planet.planet_index,
          planetTypeName: p.planet.planet_type_name,
          systemId: p.planet.system_id,
          assignment: {
            typeId: p.typeId,
            name: nameOf(p.typeId),
            tier: namesById.get(p.typeId)?.pi_tier ?? null,
            kind: p.kind, // 'extract' (raw P0) | 'produce' (schematic P1-P4)
          },
        })),
      }));

      res.json({
        requiredRaw:      requiredRaw.map(id => ({ typeId: id, name: nameOf(id) })),
        requiredProducts: requiredProducts.map(id => ({ typeId: id, name: nameOf(id), tier: namesById.get(id)?.pi_tier ?? null })),
        candidates,
        spansMultipleSystems: !!result.spansMultipleSystems,
        clusteredBy: result.clusteredBy || null,
        reason: result.reason || null,
        note: 'Planet richness, extractor yield, factory cycle output, and CPU/Power capacity are not modeled — P4 is placed on Barren/Temperate (a hard game rule) and other tiers softly prefer Barren/Temperate too (community convention), but actual colony layout and slot budgets are yours to verify in-game.',
      });
    } catch (err) {
      console.error('PI planner /plan error:', err);
      res.status(500).json({ error: 'Failed to compute PI plan' });
    }
  });

  return router;
};

module.exports.resolveRequiredCommodities = resolveRequiredCommodities;
