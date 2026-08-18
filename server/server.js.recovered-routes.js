// These are used in /api/pi/market to estimate how much a factory produces per day.
const PI_FACTORY_CYCLE_TIME = { 1: 1800, 2: 3600, 3: 3600, 4: 86400 }; // seconds/cycle

// Maximum number of SQL bind variables per query (SQLite default limit is 999).
// We leave headroom for other parameters in the same query (e.g. piIds + bpIds).
const SQL_VARIABLE_LIMIT = 950;

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
app.get('/api/pi/colonies', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const eveToken    = (req.headers.authorization || '').slice(7);

    // Serve from the 10-minute detail cache when available (avoids ESI round-trips).
    const hit = piDetailCache.get(characterId);
    if (hit && (Date.now() - hit.fetchedAt) < 600_000) return res.json(hit.data);

    // Primary characters have a server-side session with the planets list already stored.
    // Alt characters (added via the sidebar) do NOT get their own server session, so we
    // fall back to fetching their planets list directly from ESI using the bearer token.
    const sessionData = getCached(`session:${characterId}`);
    let planets, sessionBlueprints;
    if (sessionData?.planets?.length > 0) {
      planets           = sessionData.planets;
      sessionBlueprints = sessionData.blueprints || [];
    } else {
      console.log(`🌍 PI colonies — char ${characterId} has no server session; fetching planet list from ESI`);
      try {
        const r = await esiFetch(
          `https://esi.evetech.net/latest/characters/${characterId}/planets/?datasource=tranquility`,
          { headers: { Authorization: `Bearer ${eveToken}` } }
        );
        planets = r.ok ? await r.json() : [];
      } catch (e) {
        planets = [];
        console.warn(`PI planet list ESI fetch failed for char ${characterId}:`, e.message);
      }
      // Blueprint cross-reference data lives in the primary's combined session and is not
      // available here — cross-ref simply won't show for characters without a session.
      sessionBlueprints = [];
    }

    if (!planets?.length) {
      return res.json({ colonies: [], productNames: {}, schematics: {}, systemNames: {}, prices: {}, factoryOutputs: {}, bpCrossRef: {} });
    }
    const colonies          = [];
    const schematicIds      = new Set();
    const extractorProdIds  = new Set(); // P0 raw resources being extracted

    // ── 1. Fetch per-planet layouts in parallel ───────────────────────────────
    await Promise.allSettled(planets.map(async (planet) => {
      try {
        const r = await esiFetch(
          `https://esi.evetech.net/latest/characters/${characterId}/planets/${planet.planet_id}/?datasource=tranquility`,
          { headers: { Authorization: `Bearer ${eveToken}` } }
        );
        const detail = r.ok ? await r.json() : { pins: [] };
        for (const pin of (detail.pins || [])) {
          if (pin.extractor_details?.product_type_id) extractorProdIds.add(pin.extractor_details.product_type_id);
          if (pin.factory_details?.schematic_id)      schematicIds.add(pin.factory_details.schematic_id);
        }
        colonies.push({ ...planet, pins: detail.pins || [] });
      } catch (e) {
        colonies.push({ ...planet, pins: [], error: e.message });
      }
    }));

    // ── 2. Resolve schematics: name + cycle_time from ESI ────────────────────
    const schematics = {};
    await Promise.all([...schematicIds].map(async id => {
      schematics[id] = await resolveSchematic(id);
    }));

    // ── 3. Resolve factory output type_ids ───────────────────────────────────
    // EVE PI schematic name === output product name (e.g. "Coolant" → Coolant item).
    // Lookup by name in items table to get type_id without needing SDE planetSchematics import.
    const factoryOutputs = {}; // schematicId → output type_id
    const allPiTypeIds   = new Set(extractorProdIds);
    const schematicEntries = Object.entries(schematics); // [[id, {name,cycleTime}], ...]
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

    // ── 4. Resolve product names for ALL PI type_ids (extractor + factory) ───
    const productNames = {};
    if (allPiTypeIds.size) {
      const ids = [...allPiTypeIds];
      const ph  = ids.map(() => '?').join(',');
      const rows = await dbAll(`SELECT type_id, name, pi_tier FROM items WHERE type_id IN (${ph})`, ids);
      rows.forEach(r => { productNames[r.type_id] = { name: r.name, piTier: r.pi_tier }; });
    }

    // ── 5. Look up Jita sell prices for all PI type_ids ──────────────────────
    // PI commodities are primarily traded in Jita — use The Forge (10000002) as baseline.
    // jitaPricesCache is a module-level alias for regionPriceCache.get(10000002)?.prices
    const jita   = jitaPricesCache || {};
    const prices = {};
    for (const typeId of allPiTypeIds) {
      const p = jita[typeId];
      if (p) prices[typeId] = { sell: p.sell || 0, buy: p.buy || 0 };
    }

    // ── 6. Blueprint cross-reference ─────────────────────────────────────────
    // Which of the user's owned blueprints consume these PI materials directly?
    // The combined IN clause must not exceed SQLite's 999-variable bind limit.
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

    // ── 7. Resolve solar system names (batch ESI public call) ────────────────
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

    colonies.sort((a, b) => a.planet_id - b.planet_id);
    const data = { colonies, productNames, schematics, systemNames, prices, factoryOutputs, bpCrossRef };

    // Cache result with simple eviction: drop oldest entry when map exceeds 200 characters.
    if (piDetailCache.size >= 200) {
      piDetailCache.delete(piDetailCache.keys().next().value);
    }
    piDetailCache.set(characterId, { data, fetchedAt: Date.now() });
    console.log(`🌍 PI loaded for ${characterId}: ${colonies.length} planets, ${Object.keys(bpCrossRef).length} PI materials in owned BPs`);
    res.json(data);
  } catch (err) {
    // Log full error internally (includes stack trace) but return generic message to client.
    console.error('PI colonies error:', err);
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
app.get('/api/pi/market', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;

    // Return cached result if still fresh (5-minute TTL matches Jita price cadence).
    const cached = piMarketCache.get(characterId);
    if (cached && (Date.now() - cached.fetchedAt) < 300_000) {
      return res.json(cached.data);
    }

    // ── Step 1: Rank all PI factory outputs by net ISK/day per factory slot ────
    // We pull every item that EVE classifies as a PI product (pi_tier 1–4) from our
    // local database, then apply the fixed CCP game mechanics to estimate how much
    // ISK a single factory running 24/7 would earn in a day.

    const piProducts = await dbAll(
      `SELECT type_id, name, pi_tier FROM items WHERE pi_tier IN (1, 2, 3, 4) ORDER BY pi_tier, name`
    );

    // jitaPricesCache is a module-level alias for the Jita region price map.
    // It's a flat object: { [typeId]: { sell, buy } } — or empty if not loaded yet.
    const jita = jitaPricesCache || {};

    const rankings = piProducts.map(p => {
      const tier = p.pi_tier;
      // outputQty: units produced per factory cycle (set by CCP, see PI_FACTORY_OUTPUT_QTY)
      const outputQty   = PI_FACTORY_OUTPUT_QTY[tier] ?? 0;
      // cycleTime: seconds per cycle (set by CCP, see PI_FACTORY_CYCLE_TIME)
      const cycleTime   = PI_FACTORY_CYCLE_TIME[tier] ?? 3600;
      // Units the factory produces in a 24-hour day assuming perfect uptime
      const unitsPerDay = outputQty * (86400 / cycleTime);
      const sell        = jita[p.type_id]?.sell ?? 0;
      const buy         = jita[p.type_id]?.buy  ?? 0;
      const grossPerDay = unitsPerDay * sell;
      // POCO export tax: CCP defines a base ISK value per unit; player POCO owners
      // add their own % on top, but we model a flat 10% of base value here.
      const taxPerDay   = unitsPerDay * (PI_POCO_BASE_VALUE[tier] ?? 400) * 0.10;
      return {
        typeId: p.type_id, name: p.name, tier,
        unitsPerDay: Math.round(unitsPerDay),
        sell, buy, grossPerDay,
        taxPerDay,
        netPerDay: grossPerDay - taxPerDay,
      };
    }).sort((a, b) => b.netPerDay - a.netPerDay); // highest earner first

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

    // Store in per-character cache (evict oldest entry if cache grows beyond 200 characters).
    if (piMarketCache.size >= 200) {
      piMarketCache.delete(piMarketCache.keys().next().value);
    }
    piMarketCache.set(characterId, { data: result, fetchedAt: Date.now() });

    res.json(result);
  } catch (err) {
    // Log full error on server but return a generic message to the client.
    // Returning err.message would leak internal DB schema details.
    console.error('PI market error:', err);
    res.status(500).json({ error: 'Failed to load PI market data' });
  }
});

// ── Queue Planner ─────────────────────────────────────────────────────────────
//
// Given available factory slots and a planning horizon, recommends the optimal
// build queue that maximises ISK/hr across all free slots.
//
// Algorithm:
//   1. Derive free slots  = (1 + Mass Production + Advanced Mass Production) − active jobs
//   2. Score every owned buildable BP by ISK/hr (precomputed_profits baseline,
//      adjusted for the character's actual ME bonus and sales fee rates)
//   3. Greedy fill: highest ISK/hr first — one BP per slot — capped by:
//        • market liquidity  (avg_daily_volume × horizon_days → max runs)
//        • remaining budget  (deducted as each slot is assigned)
//        • planning horizon  (build_time × runs ≤ horizon)
//   4. Aggregate material shortfall across all planned builds for a single shopping trip
//
// No ESI calls at request time — everything comes from session cache + local DB.
//
app.post('/api/queue-planner', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const {
      regionId       = 10000002,
      horizonHours   = 72,          // planning window; clipped to 6–168 h
      budgetCap      = null,        // null = full wallet
      includeCorpBps = false,
      activityFilter = 'all',       // 'all' | 'manufacturing' | 'reactions'
      characters     = [],          // [{characterId, name, totalSlots, freeSlots}] — multi-char mode
    } = req.body;

    const safeRegionId = VALID_REGIONS.includes(parseInt(regionId)) ? parseInt(regionId) : 10000002;
    const safeHorizon  = Math.min(168, Math.max(6, parseInt(horizonHours) || 72));
    const horizonDays  = safeHorizon / 24;

    // ── Session ───────────────────────────────────────────────────────────────
    const session = getCached(`session:${characterId}`);
    if (!session) {
      return res.status(400).json({ error: 'No session data — refresh the page to reload character data.' });
    }
    const { skillMap, standings, implants } = getCharacterSession(characterId);
    const ownedBlueprints = session.blueprints || [];
    const assets          = session.assets     || [];
    const walletBalance   = session.wallet     || 0;
    const activeJobs      = session.jobs       || [];
    // Honour budget cap but never exceed actual wallet balance.
    const effectiveBudget = (budgetCap != null && budgetCap > 0)
      ? Math.min(Number(budgetCap), walletBalance)
      : walletBalance;

    // ── Industry settings ─────────────────────────────────────────────────────
    const settings = await dbGet(
      'SELECT * FROM character_industry_settings WHERE character_id = ?',
      [characterId]
    );
    const rigIds             = JSON.parse(settings?.rig_ids || '[]');
    // Structure gives +1% ME to all material quantities.
    const structureMeBonus   = settings?.structure_type_id ? 1 : 0;
    const rigMeBonus         = rigIds.reduce((sum, id) => sum + (RIG_ME_BONUSES[id] || 0), 0);
    // Structure TE bonus reduces build time (Raitaru 15%, Azbel 20%, Sotiyo 25%).
    const structureTeBonus   = settings?.structure_type_id
      ? (STRUCTURE_TE_BONUS[settings.structure_type_id] || 0) : 0;

    // ── Manufacturing slot count ──────────────────────────────────────────────
    // In multi-character mode (characters array supplied by the frontend), use the
    // per-character slot counts which the frontend computed from each character's
    // Mass Production / Advanced Mass Production skill levels.
    // In single-character mode, derive from this character's session skillMap.
    const multiCharMode = Array.isArray(characters) && characters.length > 0;

    let totalMfgSlots, occupiedSlots, freeSlots, charSlotPool, charSkillMaps, charFreeSlots;

    if (multiCharMode) {
      // Sum across all characters.
      totalMfgSlots  = characters.reduce((s, c) => s + (c.totalSlots || 0), 0);
      freeSlots      = characters.reduce((s, c) => s + (c.freeSlots  || 0), 0);
      occupiedSlots  = totalMfgSlots - freeSlots;

      // charSlotPool is set to the characters array as a non-null sentinel so the
      // greedy loop below knows to use per-character skill-aware assignment.
      // The actual Maps (charSkillMaps / charFreeSlots) are built just before the loop.
      charSlotPool = characters;
    } else {
      // Base 1 slot. Mass Production (3387) +1/level. Advanced Mass Production (24625) +1/level.
      // Maximum possible = 1 + 5 + 5 = 11 personal manufacturing slots.
      const massProduction    = skillMap[3387]  || 0;
      const advMassProduction = skillMap[24625] || 0;
      totalMfgSlots  = 1 + massProduction + advMassProduction;
      const activeMfgJobs = activeJobs.filter(j => j.activity_id === 1 || j.activity_id === 9);
      occupiedSlots  = Math.min(activeMfgJobs.length, totalMfgSlots);
      freeSlots      = Math.max(0, totalMfgSlots - occupiedSlots);
      charSlotPool   = null; // single-char: no per-character assignment needed
    }

    // ── Global time-efficiency factor (applied to every blueprint) ───────────
    // Industry (3380) −4%/level; Advanced Industry (3388) −3%/level.
    // Structure TE bonus varies by structure type.
    // Best Zainou BX implant (if plugged in) gives −1/2/4%.
    // All factors multiply (EVE-accurate stacking for TE).
    const industryLvl       = skillMap[3380]  || 0;
    const advIndustryLvl    = skillMap[3388]  || 0;
    const industryFactor    = 1 - 0.04 * industryLvl;
    const advIndustryFactor = 1 - 0.03 * advIndustryLvl;
    const structureTeFactor = 1 - structureTeBonus / 100;
    const mfgImplant = (Array.isArray(implants) ? implants : [])
      .map(id => INDUSTRY_IMPLANTS[id])
      .filter(imp => imp && imp.kind === 'mfg_time')
      .sort((a, b) => b.pct - a.pct)[0] || null;
    const implantFactor  = mfgImplant ? (1 - mfgImplant.pct / 100) : 1;
    const globalTeFactor = industryFactor * advIndustryFactor * structureTeFactor * implantFactor;

    // ── Jita prices for material cost re-scoring and shortfall valuation ─────
    const prices = jitaPricesCache || {};

    // ── Activity filter ───────────────────────────────────────────────────────
    const allowedActivities = activityFilter === 'manufacturing' ? [1]
      : activityFilter === 'reactions' ? [9]
      : [1, 9];

    // ── Owned blueprints — best ME per type ──────────────────────────────────
    // A character may own multiple copies of the same blueprint (BPO + BPCs).
    // Keep the one with the highest ME so the cost estimate is most favourable.
    const bpByType = new Map(); // blueprint_type_id → { me, te, runs }
    for (const bp of ownedBlueprints) {
      if (!bp) continue;
      const me      = bp.material_efficiency ?? 0;
      const existing = bpByType.get(bp.type_id);
      if (!existing || me > existing.me) {
        bpByType.set(bp.type_id, { me, te: bp.time_efficiency ?? 0, runs: bp.runs });
      }
    }

    // Optionally merge corp BPs (Director only — graceful skip if not a director).
    if (includeCorpBps) {
      try {
        const eveToken   = (req.headers.authorization || '').slice(7);
        const corpAccess = await resolveViewerCorpAccess(characterId, eveToken);
        if (corpAccess.isDirector && corpAccess.corpId) {
          await ensureCorpDataFresh(corpAccess.corpId, eveToken);
          const corpBps = await dbAll(
            `SELECT type_id, material_efficiency, time_efficiency, runs
             FROM corp_blueprints WHERE corp_id = ?`,
            [corpAccess.corpId]
          );
          for (const bp of corpBps) {
            const me       = bp.material_efficiency ?? 0;
            const existing = bpByType.get(bp.type_id);
            if (!existing || me > existing.me) {
              bpByType.set(bp.type_id, { me, te: bp.time_efficiency ?? 0, runs: bp.runs });
            }
          }
        }
      } catch (_) { /* not a director or corp data unavailable — proceed without */ }
    }

    if (bpByType.size === 0) {
      return res.json({
        recommendations: [], aggregateMaterials: [],
        summaryProfit: 0, summaryIskPerDay: 0, totalMatSpend: 0, totalShortageISK: 0,
        walletBalance, effectiveBudget, horizonHours: safeHorizon, regionId: safeRegionId,
        message: 'No blueprints found.',
      });
    }

    const bpTypeIds = [...bpByType.keys()].slice(0, SQL_VARIABLE_LIMIT);

    // ── Fetch precomputed profit + blueprint metadata in one join ─────────────
    // Filters: positive ISK/hr and profit (dead items excluded), matching activity.
    // Sorted by ISK/hr descending so the greedy loop allocates best slots first.
    const ph = bpTypeIds.map(() => '?').join(',');
    const candidates = await dbAll(
      `SELECT b.blueprint_id,
              b.product_id,
              b.product_quantity,
              b.build_time,
              COALESCE(b.activity_id, 1)  AS activity_id,
              pp.isk_per_hour,
              pp.profit                   AS profit_per_run,
              pp.material_cost            AS mat_cost_per_run,
              pp.sell_price               AS sell_per_unit,
              pp.avg_daily_volume,
              pp.liquidity_risk,
              i.name                      AS product_name
       FROM   blueprints b
       JOIN   precomputed_profits pp
                ON  pp.blueprint_id = b.blueprint_id
                AND pp.region_id    = ?
       JOIN   items i ON i.type_id  = b.product_id
       WHERE  b.blueprint_id IN (${ph})
         AND  pp.isk_per_hour > 0
         AND  pp.profit        > 0
         AND  COALESCE(b.activity_id, 1) IN (${allowedActivities.map(() => '?').join(',')})
       ORDER  BY pp.isk_per_hour DESC`,
      [safeRegionId, ...bpTypeIds, ...allowedActivities]
    );

    // ── Bulk skill check — one query for all candidates ───────────────────────
    // Avoids N round-trips to blueprint_skills for each candidate.
    const candidateBpIds = candidates.map(c => c.blueprint_id);
    const reqsByBp = new Map(); // blueprint_id → [{ skill_id, skill_level }]
    if (candidateBpIds.length > 0) {
      const phS  = candidateBpIds.slice(0, SQL_VARIABLE_LIMIT).map(() => '?').join(',');
      const reqs = await dbAll(
        `SELECT blueprint_id, skill_id, skill_level
         FROM blueprint_skills
         WHERE blueprint_id IN (${phS}) AND activity_id IN (1, 9)`,
        candidateBpIds.slice(0, SQL_VARIABLE_LIMIT)
      );
      for (const r of reqs) {
        if (!reqsByBp.has(r.blueprint_id)) reqsByBp.set(r.blueprint_id, []);
        reqsByBp.get(r.blueprint_id).push(r);
      }
    }
    const meetsSkills = bpId => {
      const reqs = reqsByBp.get(bpId) || [];
      return reqs.every(r => (skillMap[r.skill_id] || 0) >= r.skill_level);
    };

    // ── Character's personal sales fee rates at the selected hub ─────────────
    const { brokerFeeRate, transactionTaxRate } = calcSalesFeeRates(
      skillMap, standings, HUB_STANDINGS[safeRegionId]
    );
    const totalSalesFeeRate = brokerFeeRate + transactionTaxRate;

    // ── Greedy slot allocation ────────────────────────────────────────────────

    // In multi-char mode, build per-character skill maps and remaining free-slot counts
    // so the loop can find the first character who BOTH has a free slot AND meets the
    // blueprint's skill requirements (skill checks are per-character, not combined).
    if (multiCharMode) {
      charSkillMaps = new Map();
      charFreeSlots = new Map();
      for (const c of characters) {
        charSkillMaps.set(c.characterId, c.skills || {});
        charFreeSlots.set(c.characterId, c.freeSlots || 0);
      }
    }

    // Per-character skill check: does a specific character meet all blueprint requirements?
    const meetsSkillsForChar = (bpId, charId) => {
      const reqs = reqsByBp.get(bpId) || [];
      const sm   = charSkillMaps ? (charSkillMaps.get(charId) || {}) : skillMap;
      return reqs.every(r => (sm[r.skill_id] || 0) >= r.skill_level);
    };

    const recommendations = [];
    let remainingBudget   = effectiveBudget;
    let slotsToFill       = freeSlots; // total free slots; decremented on each assignment

    for (const c of candidates) {
      if (slotsToFill <= 0) break;
      // Combined pre-filter: if no character can theoretically meet the requirements
      // (using the combined/best-of-all skillMap), skip immediately.
      if (!meetsSkills(c.blueprint_id)) continue;

      const ownedBp = bpByType.get(c.blueprint_id);
      if (!ownedBp) continue;

      // Effective ME: owned-blueprint ME + structure bonus + rig bonus.
      const effectiveME  = ownedBp.me + structureMeBonus + rigMeBonus;
      const meFactor     = Math.max(0, 1 - effectiveME / 100);

      // Effective build time per single run (seconds).
      // Owned blueprint TE stacks with global factor (skills + structure + implant).
      const blueprintTeFactor   = Math.max(0, 1 - (ownedBp.te || 0) / 100);
      const effectiveBuildSec   = Math.max(1, (c.build_time || 3600) * blueprintTeFactor * globalTeFactor);
      const buildHoursPerRun    = effectiveBuildSec / 3600;

      // How many sequential runs fit within the planning horizon for a single slot?
      const maxRunsByTime   = Math.max(1, Math.floor(safeHorizon / buildHoursPerRun));

      // Liquidity cap: don't produce more units than the market trades per day×horizon.
      // avgDailyVolume is in product units; convert to runs (ceiling division).
      const dailyVol        = c.avg_daily_volume || 0;
      const productQty      = c.product_quantity || 1;
      const liquidityRunCap = dailyVol > 0
        ? Math.max(1, Math.ceil((dailyVol * horizonDays) / productQty))
        : maxRunsByTime;

      // Adjusted material cost per run — ME reduces required quantities (ceil rounding).
      const matCostPerRun  = (c.mat_cost_per_run || 0) * meFactor;

      // Re-derive profit per run using:
      //   • character's actual sales fees (not the precompute average)
      //   • ME-adjusted material cost
      const totalSellValue  = (c.sell_per_unit || 0) * productQty;
      const salesFees       = totalSellValue * totalSalesFeeRate;
      const profitPerRun    = totalSellValue - salesFees - matCostPerRun;
      if (profitPerRun <= 0) continue; // character's fees make this unprofitable

      const iskPerHour = buildHoursPerRun > 0 ? profitPerRun / buildHoursPerRun : 0;

      // Budget check: skip if we can't afford even one run.
      if (matCostPerRun > 0 && remainingBudget < matCostPerRun) continue;
      const maxRunsByBudget = matCostPerRun > 0
        ? Math.floor(remainingBudget / matCostPerRun)
        : maxRunsByTime;

      const recommendedRuns = Math.max(1, Math.min(maxRunsByTime, liquidityRunCap, maxRunsByBudget));
      const totalMatCost    = matCostPerRun * recommendedRuns;
      const totalProfit     = profitPerRun  * recommendedRuns;
      const totalBuildSec   = effectiveBuildSec * recommendedRuns;

      // In multi-char mode: find the first character who has a free slot AND meets
      // this blueprint's skill requirements (per-character check, not combined).
      // In single-char mode: no character assignment needed.
      let assignedChar = null;
      if (charSlotPool) {
        for (const char of charSlotPool) {
          if ((charFreeSlots.get(char.characterId) || 0) <= 0) continue;
          if (meetsSkillsForChar(c.blueprint_id, char.characterId)) {
            assignedChar = char;
            break;
          }
        }
        // No character has both free slots and the required skills — skip this blueprint.
        if (!assignedChar) continue;
      }

      recommendations.push({
        blueprintId:            c.blueprint_id,
        productId:              c.product_id,
        productName:            c.product_name,
        productUnits:           productQty * recommendedRuns,
        activityId:             c.activity_id,
        runs:                   recommendedRuns,
        buildTimeSec:           Math.round(totalBuildSec),
        buildTimePerRunSec:     Math.round(effectiveBuildSec),
        materialCost:           totalMatCost,
        estimatedProfit:        totalProfit,
        iskPerHour,
        liquidityRisk:          c.liquidity_risk || null,
        avgDailyVolume:         dailyVol,
        ownedBpME:              ownedBp.me,
        effectiveME,
        assignedCharacterId:    assignedChar?.characterId ?? null,
        assignedCharacterName:  assignedChar?.name       ?? null,
      });

      remainingBudget -= totalMatCost;
      if (assignedChar) {
        charFreeSlots.set(assignedChar.characterId, charFreeSlots.get(assignedChar.characterId) - 1);
      }
      slotsToFill--;
    }

    // ── Aggregate material shortfall for one combined shopping trip ───────────
    const assetMap = new Map(); // typeId → total held quantity
    for (const a of assets) {
      assetMap.set(a.type_id, (assetMap.get(a.type_id) || 0) + (a.quantity || 0));
    }

    const recBpIds = recommendations.map(r => r.blueprintId);
    let allMaterials = [];
    if (recBpIds.length > 0) {
      const phM = recBpIds.map(() => '?').join(',');
      allMaterials = await dbAll(
        `SELECT bm.blueprint_id, bm.material_id, bm.quantity AS base_qty, i.name AS material_name
         FROM blueprint_materials bm
         JOIN items i ON i.type_id = bm.material_id
         WHERE bm.blueprint_id IN (${phM})`,
        recBpIds
      );
    }

    const matTotals = new Map(); // typeId → aggregated totals
    for (const mat of allMaterials) {
      const rec = recommendations.find(r => r.blueprintId === mat.blueprint_id);
      if (!rec) continue;
      const ownedBp  = bpByType.get(mat.blueprint_id);
      const me       = ownedBp ? (ownedBp.me + structureMeBonus + rigMeBonus) : 0;
      const adjQty   = Math.max(1, Math.ceil(mat.base_qty * Math.max(0, 1 - me / 100))) * rec.runs;

      if (!matTotals.has(mat.material_id)) {
        matTotals.set(mat.material_id, {
          typeId:   mat.material_id,
          name:     mat.material_name,
          needed:   0,
          have:     assetMap.get(mat.material_id) || 0,
          jitaSell: prices[mat.material_id]?.sell || 0,
        });
      }
      matTotals.get(mat.material_id).needed += adjQty;
    }

    const aggregateMaterials = [...matTotals.values()]
      .map(m => ({
        ...m,
        shortage:    Math.max(0, m.needed - m.have),
        shortageISK: Math.max(0, m.needed - m.have) * m.jitaSell,
      }))
      .filter(m => m.shortage > 0)
      .sort((a, b) => b.shortageISK - a.shortageISK);

    // ── Summary ───────────────────────────────────────────────────────────────
    const summaryProfit    = recommendations.reduce((s, r) => s + r.estimatedProfit, 0);
    const summaryIskPerDay = horizonDays > 0 ? summaryProfit / horizonDays : 0;
    const totalMatSpend    = recommendations.reduce((s, r) => s + r.materialCost,    0);
    const totalShortageISK = aggregateMaterials.reduce((s, m) => s + m.shortageISK,  0);

    res.json({
      recommendations,
      aggregateMaterials,
      summaryProfit,
      summaryIskPerDay,
      totalMatSpend,
      totalShortageISK,
      walletBalance,
      effectiveBudget,
      horizonHours: safeHorizon,
      regionId:     safeRegionId,
    });
  } catch (err) {
    console.error('Queue planner error:', err);
    res.status(500).json({ error: 'Failed to generate queue plan' });
  }
});

// CHAT HISTORY (Authenticated)

// Save chat message (authenticated)
// Note: verifyCharacterOwnership is intentionally omitted here — there is no :characterId
// route param, so it would always resolve NaN and return 403.  verifyEveToken is sufficient:
// the handler reads req.characterId from the token, not from the request body.