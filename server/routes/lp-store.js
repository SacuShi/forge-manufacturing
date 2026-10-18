'use strict';
// Loyalty-point store: a character's LP balance, the NPC corporations' offers and their market value.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { clientErrMsg } = require('../lib/http-errors');
const { HUB_STANDINGS, HUB_STRUCTURE_FEES, REGIONS, REGION_TO_HUB } = require('../lib/hubs');
const { getCharacterSession, calcSalesFeeRates } = require('../lib/character-session');
const { hubBooks, ensureHubPollerRunning } = require('../lib/hub-pollers');

const router = express.Router();

// ── LP Store endpoints (v1.36.0) ─────────────────────────────────────────

// Character LP balances — requires esi-characters.read_loyalty.v1
router.get('/api/lp-balance', security.apiLimiter, security.verifyEveToken, async (req, res) => {
  try {
    const characterId = req.characterId;
    const eveToken    = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const esiRes = await esiFetch(
      `https://esi.evetech.net/v1/characters/${characterId}/loyalty/points/`,
      { headers: { Authorization: `Bearer ${eveToken}` } }
    );
    if (!esiRes.ok) {
      const text = await esiRes.text();
      if (esiRes.status === 403 && text.includes('scope')) {
        return res.json({ balances: [], scope_missing: true });
      }
      return res.status(esiRes.status).json({ error: `ESI ${esiRes.status}`, balances: [] });
    }
    const points = await esiRes.json(); // [{corporation_id, loyalty_points}]

    // Enrich with corp/faction names from our DB
    const corpIds = points.map(p => p.corporation_id);
    let corpRows = [];
    if (corpIds.length) {
      corpRows = await dbAll(
        `SELECT corp_id, corp_name, faction_id, faction_name
           FROM npc_corporations
          WHERE corp_id IN (${corpIds.map(() => '?').join(',')})`,
        corpIds
      );
    }
    const corpMap = new Map(corpRows.map(r => [r.corp_id, r]));

    const balances = points
      .map(p => {
        const info = corpMap.get(p.corporation_id) || {};
        return {
          corp_id:      p.corporation_id,
          corp_name:    info.corp_name  || `Corp ${p.corporation_id}`,
          faction_id:   info.faction_id || null,
          faction_name: info.faction_name || null,
          lp:           p.loyalty_points,
        };
      })
      .filter(b => b.lp > 0)
      .sort((a, b) => b.lp - a.lp);

    res.json({ balances, scope_missing: false });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err), balances: [] });
  }
});

// Factions that have LP store offers (for the faction picker dropdown)
router.get('/api/lp-store/factions', security.apiLimiter, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT nc.faction_id, nc.faction_name, COUNT(DISTINCT nc.corp_id) AS corp_count
        FROM npc_corporations nc
       WHERE nc.faction_id IS NOT NULL AND nc.faction_name IS NOT NULL
         AND nc.corp_id IN (SELECT DISTINCT corp_id FROM lp_offers)
       GROUP BY nc.faction_id, nc.faction_name
       ORDER BY nc.faction_name
    `);
    res.json({ factions: rows });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err), factions: [] });
  }
});

// Corps within a faction (for the corp sub-filter)
router.get('/api/lp-store/corps', security.apiLimiter, async (req, res) => {
  try {
    const factionId = parseInt(req.query.factionId, 10) || 0;
    const rows = await dbAll(`
      SELECT nc.corp_id, nc.corp_name, COUNT(lo.offer_id) AS offer_count
        FROM npc_corporations nc
        JOIN lp_offers lo ON lo.corp_id = nc.corp_id
       ${factionId ? 'WHERE nc.faction_id = ?' : ''}
       GROUP BY nc.corp_id, nc.corp_name
       ORDER BY nc.corp_name
    `, factionId ? [factionId] : []);
    res.json({ corps: rows });
  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err), corps: [] });
  }
});

// LP store offers — computes ISK/LP using live Jita order book
router.get('/api/lp-store', security.apiLimiter, async (req, res) => {
  try {
    ensureHubPollerRunning('jita');

    const factionId  = parseInt(req.query.factionId, 10) || 0;
    const corpId     = parseInt(req.query.corpId,    10) || 0;
    const limit      = Math.min(1000, parseInt(req.query.limit  || '500', 10));
    const offset     = Math.max(0,    parseInt(req.query.offset || '0',   10));
    const sellRegion = parseInt(req.query.regionId,  10) || 10000002;
    const hubKey     = REGION_TO_HUB[sellRegion] || 'jita';

    const wheres = [];
    const params = [];
    if (corpId) {
      wheres.push('lo.corp_id = ?');        params.push(corpId);
    } else if (factionId) {
      wheres.push('nc.faction_id = ?');     params.push(factionId);
    }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const offers = await dbAll(`
      SELECT lo.corp_id, lo.offer_id, lo.type_id, lo.quantity, lo.lp_cost, lo.isk_cost,
             i.name  AS item_name, i.category_name,
             nc.corp_name, nc.faction_id, nc.faction_name,
             ihp.avg_30d_volume AS volume
        FROM lp_offers lo
        JOIN npc_corporations nc ON nc.corp_id = lo.corp_id
        LEFT JOIN items i ON i.type_id = lo.type_id
        LEFT JOIN item_history_prices ihp ON ihp.type_id = lo.type_id
        ${where}
    `, params);

    if (offers.length === 0) return res.json({ offers: [], total: 0, prices_live: false });

    // Required items for these offers (chunked to stay under SQLite param limit)
    const offerIds = [...new Set(offers.map(o => o.offer_id))];
    let reqRows = [];
    for (let i = 0; i < offerIds.length; i += 900) {
      const chunk = offerIds.slice(i, i + 900);
      const rows = await dbAll(`
        SELECT lori.offer_id, lori.corp_id, lori.req_type_id, lori.quantity,
               i.name AS req_name
          FROM lp_offer_required_items lori
          LEFT JOIN items i ON i.type_id = lori.req_type_id
         WHERE lori.offer_id IN (${chunk.map(() => '?').join(',')})
      `, chunk);
      reqRows.push(...rows);
    }

    // Index required items by "corpId:offerId"
    const reqMap = new Map();
    for (const r of reqRows) {
      const key = `${r.corp_id}:${r.offer_id}`;
      if (!reqMap.has(key)) reqMap.set(key, []);
      reqMap.get(key).push(r);
    }

    // Live prices from the selected sell hub's order book
    const hubBook    = hubBooks[hubKey];
    const pricesLive = !!(hubBook && hubBook.size > 0);
    const getPrice   = (typeId) => {
      const entry = hubBook?.get(typeId);
      return { sell: entry?.sell || 0, buy: entry?.buy || 0 };
    };
    const hubName    = REGIONS[sellRegion]?.hub || 'Jita';

    // Sales Tax — character-specific if token provided, else worst-case default
    let transactionTaxRate = 0.075; // Accounting 0 = 7.5%
    let sessionCached = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const { characterId } = await security.extractCharacterFromToken(authHeader);
        const { skillMap, standings } = getCharacterSession(characterId);
        if (Object.keys(skillMap).length > 0) {
          const rates = calcSalesFeeRates(skillMap, standings, HUB_STANDINGS[sellRegion], HUB_STRUCTURE_FEES[sellRegion] ?? null);
          transactionTaxRate = rates.transactionTaxRate;
          sessionCached = true;
        }
      } catch { /* invalid/expired token — fall back to defaults */ }
    }

    const results = [];
    for (const offer of offers) {
      const reqs     = reqMap.get(`${offer.corp_id}:${offer.offer_id}`) || [];
      const outPrice = getPrice(offer.type_id);
      const revenue  = outPrice.buy * offer.quantity * (1 - transactionTaxRate);

      let reqCost = 0;
      const reqDetails = reqs.map(r => {
        const p    = getPrice(r.req_type_id);
        const cost = p.sell * r.quantity;
        reqCost += cost;
        return { type_id: r.req_type_id, name: r.req_name || `Item ${r.req_type_id}`,
                 quantity: r.quantity, unit_price: p.sell, total_cost: cost };
      });

      const netIsk   = revenue - offer.isk_cost - reqCost;
      const iskPerLp = offer.lp_cost > 0 ? netIsk / offer.lp_cost : 0;

      results.push({
        offer_id:       offer.offer_id,
        corp_id:        offer.corp_id,
        corp_name:      offer.corp_name,
        faction_id:     offer.faction_id,
        faction_name:   offer.faction_name,
        type_id:        offer.type_id,
        item_name:      offer.item_name || `Item ${offer.type_id}`,
        quantity:       offer.quantity,
        lp_cost:        offer.lp_cost,
        isk_cost:       offer.isk_cost,
        required_items: reqDetails,
        jita_buy:       outPrice.buy,
        revenue,
        req_cost:       reqCost,
        net_isk:        netIsk,
        isk_per_lp:     iskPerLp,
        volume:         offer.volume || null,
        category_name:  offer.category_name || null,
      });
    }

    results.sort((a, b) => b.isk_per_lp - a.isk_per_lp);

    res.json({ offers: results.slice(offset, offset + limit), total: results.length, prices_live: pricesLive, hub_name: hubName, transaction_tax_rate: transactionTaxRate, session_cached: sessionCached });
  } catch (err) {
    logger.error('LP store error:', err.message);
    res.status(500).json({ error: clientErrMsg(err), offers: [] });
  }
});

module.exports = router;
