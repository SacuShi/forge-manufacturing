'use strict';
// The price ticker: each character's saved pins and groups, and the live prices for them.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbGet, dbRun } = require('../lib/db');
const { HUB_CONFIG } = require('../lib/hubs');
const { regionPriceCache } = require('../lib/market-cache');
const { hubBooks } = require('../lib/hub-pollers');

const router = express.Router();

// ── Ticker config — persisted per character, survives sessions ───────────────

router.get('/api/ticker-config',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const row = await dbGet(
        'SELECT config_json FROM character_ticker_config WHERE character_id = ?',
        [req.characterId]
      );
      const DEFAULT_GROUP = { id: 'default', name: 'Default', color: '#00ff88' };
      if (!row) {
        return res.json({ pins: [], groups: [DEFAULT_GROUP], activeGroupId: 'default', dualRow: false });
      }
      let stored;
      try { stored = JSON.parse(row.config_json); } catch { stored = []; }
      // Migrate old format (plain pins array → wrapped config)
      if (Array.isArray(stored)) {
        return res.json({
          pins: stored.map(p => ({ ...p, groupId: p.groupId || 'default' })),
          groups: [DEFAULT_GROUP],
          activeGroupId: 'default',
          dualRow: false,
        });
      }
      const groups = stored.groups?.length ? stored.groups : [DEFAULT_GROUP];
      const pins   = (stored.pins || []).map(p => ({ ...p, groupId: p.groupId || 'default' }));
      res.json({ pins, groups, activeGroupId: stored.activeGroupId || 'default', dualRow: stored.dualRow === true });
    } catch (err) {
      logger.error('ticker-config GET error:', err.message);
      res.status(500).json({ error: 'Failed to load ticker config' });
    }
  }
);

router.post('/api/ticker-config',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const { pins, groups, activeGroupId, dualRow } = req.body || {};
      if (!Array.isArray(pins)) return res.status(400).json({ error: 'pins array required' });
      const safeGroups = (Array.isArray(groups) ? groups : [{ id: 'default', name: 'Default', color: '#00ff88' }])
        .slice(0, 10)
        .map(g => ({
          id:    String(g.id    || 'default').slice(0, 40),
          name:  String(g.name  || 'Default').slice(0, 40),
          color: String(g.color || '#00ff88').slice(0, 12),
        }));
      const safe = pins.slice(0, 100).map(p => ({
        id:            String(p.id    || '').slice(0, 40),
        type:          String(p.type  || '').slice(0, 40),
        label:         String(p.label || '').slice(0, 60),
        groupId:       String(p.groupId || 'default').slice(0, 40),
        regionId:      p.regionId      ? Number(p.regionId)                     : undefined,
        hubName:       p.hubName       ? String(p.hubName).slice(0, 40)         : undefined,
        typeId:        p.typeId        ? Number(p.typeId)                        : undefined,
        itemName:      p.itemName      ? String(p.itemName).slice(0, 80)        : undefined,
        baseline:      p.baseline      != null ? Number(p.baseline)             : undefined,
        baselineDate:  p.baselineDate  ? Number(p.baselineDate)                 : undefined,
        expiryTime:    p.expiryTime    ? String(p.expiryTime).slice(0, 30)      : undefined,
        snapshotValue: p.snapshotValue != null ? Number(p.snapshotValue)        : undefined,
        addedAt:       Number(p.addedAt || Date.now()),
        order:         Number(p.order || 0),
      }));
      const config = { pins: safe, groups: safeGroups, activeGroupId: String(activeGroupId || 'default').slice(0, 40), dualRow: dualRow === true };
      await dbRun(
        `INSERT INTO character_ticker_config (character_id, config_json, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(character_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at  = excluded.updated_at`,
        [req.characterId, JSON.stringify(config)]
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error('ticker-config POST error:', err.message);
      res.status(500).json({ error: 'Failed to save ticker config' });
    }
  }
);

// ── Ticker prices — batch price/profit lookup for all pinned items ────────────
// Body: { items: [{ pinId, pinType, regionId, typeId? }] }
// Returns live data for each pin from the in-memory caches + DB.

router.post('/api/ticker-prices',
  security.apiLimiter,
  security.verifyEveToken,
  async (req, res) => {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });

      const results = [];
      for (const item of items) {
        const { pinId, pinType, regionId, typeId } = item;
        try {
          if (['price_sell', 'price_buy', 'price_spread'].includes(pinType)) {
            const cached = regionPriceCache.get(Number(regionId));
            const p = cached?.prices?.[Number(typeId)];
            results.push({ pinId, sell: p?.sell ?? null, buy: p?.buy ?? null });
          }
          else if (['mfg_profit', 'mfg_margin', 'mfg_isk_hour'].includes(pinType)) {
            const row = await dbGet(
              `SELECT profit, profit_margin, isk_per_hour
               FROM precomputed_profits WHERE region_id = ? AND product_id = ?
               ORDER BY computed_at DESC LIMIT 1`,
              [Number(regionId), Number(typeId)]
            );
            results.push({ pinId, profit: row?.profit ?? null, margin: row?.profit_margin ?? null, iskPerHour: row?.isk_per_hour ?? null });
          }
          else if (pinType === 'mfg_top_hub') {
            const row = await dbGet(
              `SELECT product_name, product_id, profit, profit_margin, isk_per_hour
               FROM precomputed_profits WHERE region_id = ?
               ORDER BY profit DESC LIMIT 1`,
              [Number(regionId)]
            );
            results.push({ pinId, itemName: row?.product_name ?? null, topTypeId: row?.product_id ?? null, profit: row?.profit ?? null, margin: row?.profit_margin ?? null });
          }
          else if (pinType === 'trade_spread') {
            const hubKey = Object.entries(HUB_CONFIG).find(([, v]) => v.regionId === Number(regionId))?.[0];
            const entry = hubKey ? hubBooks[hubKey]?.get(Number(typeId)) : null;
            results.push({ pinId, sell: entry?.sell ?? null, buy: entry?.buy ?? null, spreadPct: entry?.spreadPct ?? null });
          }
          else if (pinType === 'trade_top_hub') {
            const hubKey = Object.entries(HUB_CONFIG).find(([, v]) => v.regionId === Number(regionId))?.[0];
            let topTypeId = null, topSpread = -Infinity, topSell = null, topBuy = null;
            for (const [tid, e] of (hubKey ? (hubBooks[hubKey] || new Map()) : [])) {
              if ((e.spreadPct ?? -Infinity) > topSpread) {
                topSpread = e.spreadPct;
                topTypeId = tid;
                topSell = e.sell;
                topBuy = e.buy;
              }
            }
            results.push({ pinId, topTypeId, spreadPct: topSpread > -Infinity ? topSpread : null, sell: topSell, buy: topBuy });
          }
          else {
            results.push({ pinId }); // character-state pins handled client-side
          }
        } catch (innerErr) {
          logger.error(`ticker-prices inner error pin ${pinId}:`, innerErr.message);
          results.push({ pinId, error: 'fetch failed' });
        }
      }
      res.json({ results });
    } catch (err) {
      logger.error('ticker-prices error:', err.message);
      res.status(500).json({ error: 'Failed to fetch ticker prices' });
    }
  }
);

module.exports = router;
