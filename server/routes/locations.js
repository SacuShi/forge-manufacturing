'use strict';
// Station / structure name lookups for assets and jobs.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const fetch = require('node-fetch');
const { clientErrMsg } = require('../lib/http-errors');
const { getCached } = require('../lib/cache');
const { HUB_CONFIG } = require('../lib/hubs');

const router = express.Router();

// Resolve EVE location IDs to display names.
// GET /api/location-names?ids=60003760,1049588174021,...
// Optional header: Authorization: Bearer <token>  — used to resolve player structures
// the user has docking access to (requires esi-universe.read_structures.v1 scope on
// their token; ignored gracefully if the scope is missing).
//   → { "60003760": "Jita · Caldari Navy Assembly Plant", "1049588174021": "C-J6MT Keepstar" }
router.get('/api/location-names',
  security.apiLimiter,
  async (req, res) => {
    try {
      const raw = (req.query.ids || '').split(',').map(s => Number(s.trim())).filter(n => n > 0);
      if (raw.length === 0) return res.json({});

      // Build reverse map: stationId → display name from HUB_CONFIG
      const knownStructures = {};
      for (const hub of Object.values(HUB_CONFIG)) {
        if (hub.isStructure && hub.stationId) {
          knownStructures[hub.stationId] = hub.name;
        }
      }

      const result = {};
      const afterKnown = [];

      for (const id of raw) {
        if (knownStructures[id]) {
          result[id] = knownStructures[id];
        } else {
          afterKnown.push(id);
        }
      }

      // ── Phase 1: bulk public names (NPC stations, solar systems, etc.) ─────
      // ESI /universe/names/ only accepts recognised entity IDs; any unknown ID
      // (e.g. an old 32-bit item instance ID from a corp container) returns 400
      // for the ENTIRE batch.  Filter to known EVE public-entity ranges only:
      //   Regions 10M-14M, Constellations 20M-22M, Solar systems 30M-34M,
      //   NPC stations 60M-70M.  Everything else (large = player structure, or
      //   outside ranges = unresolvable item/corp ID) bypasses this step.
      const isPublicEntityId = (id) =>
        (id >= 10_000_000 && id < 14_000_000) ||   // regions
        (id >= 20_000_000 && id < 22_000_000) ||   // constellations
        (id >= 30_000_000 && id < 34_000_000) ||   // solar systems
        (id >= 60_000_000 && id < 70_000_000);     // NPC stations

      const npcIds    = afterKnown.filter(id => id < 1_000_000_000 && isPublicEntityId(id));
      const largeIds  = afterKnown.filter(id => id >= 1_000_000_000);
      const afterBulk = [...largeIds]; // large IDs go straight to structure lookup

      if (npcIds.length > 0) {
        try {
          const r = await fetch(
            'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
            {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify(npcIds),
            }
          );
          const resolved = new Set();
          if (r.ok) {
            const entries = await r.json();
            for (const { id, name, category } of entries) {
              if (category === 'solar_system') {
                result[id] = `${name} · System`;
              } else if (category === 'station') {
                const parts = name.split(' - ');
                result[id] = parts.length >= 3
                  ? `${parts[0]} · ${parts[parts.length - 1]}`
                  : name;
              } else {
                result[id] = name;
              }
              resolved.add(id);
            }
          } else {
            const errText = await r.text().catch(() => '');
            logger.error(`[location-names] ESI /universe/names/ ${r.status}: ${errText} — ids: ${JSON.stringify(npcIds)}`);
          }
          for (const id of npcIds) {
            if (!resolved.has(id)) afterBulk.push(id);
          }
        } catch (esiErr) {
          logger.error('[location-names] ESI fetch error:', esiErr.message);
          afterBulk.push(...npcIds);
        }
      }

      // ── Phase 2: player structures — try with the user's auth token ─────────
      // Requires esi-universe.read_structures.v1 scope on the token.
      // If the scope is missing ESI returns 403 — we skip silently.
      const userToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (afterBulk.length > 0 && userToken) {
        await Promise.allSettled(afterBulk.map(async (id) => {
          try {
            const r = await fetch(
              `https://esi.evetech.net/latest/universe/structures/${id}/?datasource=tranquility`,
              { headers: { Authorization: `Bearer ${userToken}` } }
            );
            if (r.ok) {
              const data = await r.json();
              // Format: "C-J6MT - Quam Singulari" → "C-J6MT · Quam Singulari"
              const parts = (data.name || '').split(' - ');
              result[id] = parts.length >= 2
                ? `${parts[0]} · ${parts.slice(1).join(' - ')}`
                : (data.name || `Structure #${id}`);
            }
            // 403/404 = no scope or no access; leave unresolved
          } catch (_) { /* ignore */ }
        }));
      }

      res.json(result);
    } catch (err) {
      logger.error('location-names error:', err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

// Fetch raw character assets from ESI and find the location_id for a specific type.
// Bypasses the aggregated session data which strips location info.
// GET /api/find-structure?typeId=28352  →  unique structure IDs where that type lives
router.get('/api/find-structure',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const token = req.headers.authorization?.replace('Bearer ', '');
      const typeId = parseInt(req.query.typeId, 10);
      if (!typeId) return res.status(400).json({ error: 'typeId query param required' });

      // Fetch all character assets from ESI (paginated)
      const INT32_MAX = 2147483647;
      let page = 1, allAssets = [];
      while (true) {
        const r = await fetch(
          `https://esi.evetech.net/latest/characters/${characterId}/assets/?datasource=tranquility&page=${page}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!r.ok) return res.status(r.status).json({ error: `ESI assets fetch failed (${r.status})` });
        const page_data = await r.json();
        allAssets = allAssets.concat(page_data);
        const totalPages = parseInt(r.headers.get('x-pages') || '1', 10);
        if (page >= totalPages) break;
        page++;
      }

      // Find assets of the requested type and collect unique structure location_ids
      const matches = allAssets.filter(a => a.type_id === typeId);
      const structureIds = [...new Set(
        matches
          .map(a => a.location_id)
          .filter(id => id && id > INT32_MAX)
      )];

      // Resolve each structure ID to a name
      const resolved = await Promise.all(structureIds.map(async (id) => {
        try {
          const r = await fetch(`https://esi.evetech.net/latest/universe/structures/${id}/?datasource=tranquility`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!r.ok) return { id, error: r.status };
          const d = await r.json();
          return { id, name: d.name, type_id: d.type_id, solar_system_id: d.solar_system_id };
        } catch { return { id, error: 'unreachable' }; }
      }));

      res.json({ typeId, totalAssets: allAssets.length, matches: matches.length, structures: resolved });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

// Find where a specific ship/item type is located in the character's cached assets
// GET /api/asset-location?typeId=28352  →  [{type_id, location_id, quantity}]
router.get('/api/asset-location',
  security.apiLimiter,
  security.verifyEveToken,
  (req, res) => {
    const characterId = req.characterId;
    const typeId = parseInt(req.query.typeId, 10);
    if (!typeId) return res.status(400).json({ error: 'typeId query param required' });
    const sessionData = getCached(`session:${characterId}`);
    if (!sessionData) return res.status(400).json({ error: 'No session — refresh the page first' });
    const matches = (sessionData.assets || []).filter(a => a.type_id === typeId);
    res.json({ typeId, matches });
  }
);

// Resolve accessible structure names from session cache (temporary lookup helper)
// Used to find structure IDs for known structure names (e.g. Keepstars for hub integration)
router.get('/api/resolve-structures',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const characterId = req.characterId;
      const token = req.headers.authorization?.replace('Bearer ', '');
      const sessionData = getCached(`session:${characterId}`);
      if (!sessionData) return res.status(400).json({ error: 'No session — refresh the page first' });

      const ids = sessionData.accessibleStructures || [];
      const results = [];
      // Resolve in batches of 5 with 200ms gaps to avoid ESI rate limits
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        await Promise.all(batch.map(async (id) => {
          try {
            const r = await fetch(`https://esi.evetech.net/latest/universe/structures/${id}/?datasource=tranquility`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (r.ok) {
              const d = await r.json();
              results.push({ id, name: d.name, type_id: d.type_id, system_id: d.solar_system_id });
            }
          } catch { /* skip unreachable structures */ }
        }));
        if (i + 5 < ids.length) await new Promise(r => setTimeout(r, 200));
      }
      res.json({ count: results.length, structures: results });
    } catch (err) {
      res.status(500).json({ error: clientErrMsg(err) });
    }
  }
);

module.exports = router;
