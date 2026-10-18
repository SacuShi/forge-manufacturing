'use strict';
// The browser's session: after login it uploads the character's assets, blueprints, skills and jobs, which the server
// keeps for two hours and builds profit, fee and advisor answers from.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { clientErrMsg } = require('../lib/http-errors');
const { cache, getCached, setCached } = require('../lib/cache');
const { sanitizeSkills, sanitizeStandings, saveSkillSnapshot } = require('../lib/character-session');
const { learnStructureFit } = require('../lib/structures');
const { warmBlueprintIcons } = require('../lib/icon-warmer');

/** @param {{ cacheStructureToken: (token: string) => void }} deps */
module.exports = function sessionRoutes({ cacheStructureToken }) {
  const router = express.Router();

  // Store character session data (assets, blueprints, prices, etc.)
  // This avoids sending 2-3MB with every AI request
  router.post('/api/session-data',
    security.apiLimiter,
    security.verifyEveToken,
    async (req, res) => {
      try {
        const characterId = req.characterId;
        const { assets, blueprints, prices, wallet, jobs, skills, own_skills, total_sp, standings, planets, implants } = req.body;

        // Refresh structure market token pool so precompute can poll the Keepstar
        const rawToken = req.headers.authorization?.replace('Bearer ', '');
        if (rawToken) cacheStructureToken(rawToken);

        // Validate data exists
        if (!assets || !blueprints) {
          return res.status(400).json({ error: 'Missing required session data' });
        }

        // Store in cache with 2-hour expiry
        const sessionKey = `session:${characterId}`;

        logger.info(`💾 Caching session data - Character: ${characterId}, Key: ${sessionKey}`);
        logger.info(`   Assets: ${assets.length}, Blueprints: ${blueprints.length}, Prices: ${Object.keys(prices || {}).length}, SP: ${(total_sp || 0).toLocaleString()}`);

        // v0.9.4: Discover player-owned structures from asset locations
        // Structure IDs are int64 (> 2^31-1), NPC stations are int32
        const INT32_MAX = 2147483647;
        const structureIds = new Set();

        if (assets && Array.isArray(assets)) {
          assets.forEach(asset => {
            if (asset.location_id && asset.location_id > INT32_MAX) {
              structureIds.add(asset.location_id);
            }
          });
        }

        if (jobs && Array.isArray(jobs)) {
          jobs.forEach(job => {
            if (job.facility_id && job.facility_id > INT32_MAX) {
              structureIds.add(job.facility_id);
            }
          });
        }

        logger.info(`✓ Discovered ${structureIds.size} accessible structures`);

        setCached(sessionKey, {
          assets,
          blueprints,
          prices:     prices || {},
          wallet:     wallet || 0,
          jobs:       jobs || [],
          skills:     skills || [],     // best level of each skill across ALL the user's loaded characters (build-eligibility filters)
          // This character's OWN skills, when the client says so. Fees and build time for a character must use
          // its own levels, not the best across the account, so getCharacterSession prefers this.
          own_skills: Array.isArray(own_skills) ? sanitizeSkills(own_skills) : null,
          total_sp:   total_sp || 0,
          standings:  standings ? sanitizeStandings(standings) : { factions: {}, corps: {} },
          planets:    planets || [],
          implants:   Array.isArray(implants) ? implants : [],  // active implant type_ids (v1.17.0)
          accessibleStructures: Array.from(structureIds),
          cachedAt: new Date().toISOString()
        }, 7200000); // 2 hours

        logger.info(`✓ Session data cached successfully for character ${characterId}`);
        
        // Verify it was cached
        const verify = getCached(sessionKey);
        if (!verify) {
          logger.error(`❌ CACHE VERIFICATION FAILED - Data not retrievable immediately after caching!`);
        } else {
          logger.info(`✓ Cache verification passed - ${verify.assets.length} assets retrievable`);
        }
        
        res.json({ success: true, expiresIn: 7200 });

        // Fire-and-forget: warm the blueprint icon cache so the first
        // visit to the Blueprints tab serves icons from disk, not CCP CDN.
        warmBlueprintIcons(blueprints).catch(() => {});

        // Persist skills so a later restart/expiry doesn't drop this character to level-0 fees/times.
        // own_skills present (even empty) = a current client: its own levels are what count, never the account-wide best list
        saveSkillSnapshot(characterId, Array.isArray(own_skills) ? own_skills : skills, standings, implants)
          .catch(e => logger.error('Skill snapshot save failed:', e.message));
        // Learn which structure this character builds in and what rigs it runs (throttled).
        learnStructureFit(characterId, rawToken, jobs).catch(() => {});

      } catch (error) {
        logger.error('Session data error:', error);
        res.status(500).json({ error: 'Failed to cache session data' });
      }
    }
  );

  // Get cached session data (for debugging)
  // Skills/standings for a character that has no server session of its own (an alt chosen as the "fee
  // character" in the item panel). The full session POST also runs structure discovery and caches assets,
  // which is far too heavy to do for every alt, so this stores only the snapshot fees and build time need.
  router.post('/api/skill-snapshot',
    security.apiLimiter,
    security.verifyEveToken,
    async (req, res) => {
      try {
        const { skills, standings, implants } = req.body || {};
        if (!Array.isArray(skills) || skills.length === 0) {
          return res.status(400).json({ error: 'skills required' });
        }
        await saveSkillSnapshot(req.characterId, skills, standings, implants);
        res.json({ success: true });
      } catch (e) {
        logger.error('Skill snapshot error:', e.message);
        res.status(500).json({ error: clientErrMsg(e) });
      }
    }
  );

  router.get('/api/session-data/:characterId',
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
        logger.error('Get session error:', error);
        res.status(500).json({ error: 'Failed to retrieve session data' });
      }
    }
  );

  // Invalidate session cache (call when user's data changes)
  router.post('/api/invalidate-session',
    security.apiLimiter,
    security.verifyEveToken,
    async (req, res) => {
      try {
        const characterId = req.characterId;
        const sessionKey = `session:${characterId}`;
        
        cache.delete(sessionKey);
        logger.info(`✓ Session cache invalidated for character ${characterId}`);
        
        res.json({ 
          success: true, 
          message: 'Session cache cleared - will reload on next AI request' 
        });
      } catch (error) {
        logger.error('Invalidate session error:', error);
        res.status(500).json({ error: 'Failed to invalidate session' });
      }
    }
  );

  return router;
};
