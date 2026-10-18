'use strict';
// Region market prices (the cached order-book collapse the manufacturing maths use) and the Jita price list.

const express = require('express');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { clientErrMsg } = require('../lib/http-errors');
const { CACHE_TTL_MS } = require('../lib/cache');
const { VALID_REGIONS } = require('../lib/hubs');
const market = require('../lib/market-cache');
const { regionPriceCache, setRegionPriceCache, fetchRegionPrices } = market;

const router = express.Router();

router.get('/api/jita-prices', security.apiLimiter, async (req, res) => {
  try {
    if (jitaPricesCache && Date.now() < market.jitaPricesCacheExpiry) {
      logger.info(`✓ Jita prices (cached) — ${Object.keys(jitaPricesCache).length} items`);
      return res.json({ prices: jitaPricesCache });
    }

    const prices = await fetchRegionPrices(10000002); // The Forge (Jita)
    jitaPricesCache = prices;
    market.jitaPricesCacheExpiry = Date.now() + CACHE_TTL_MS;
    res.json({ prices });

  } catch (err) {
    logger.error('Jita prices error:', err.message);
    if (jitaPricesCache) {
      return res.json({ prices: jitaPricesCache, stale: true });
    }
    res.status(500).json({ error: clientErrMsg(err), prices: {} });
  }
});

router.get('/api/prices/:regionId', security.apiLimiter, async (req, res) => {
  try {
    const regionId = parseInt(req.params.regionId);

    if (!VALID_REGIONS.includes(regionId)) {
      return res.status(400).json({ error: 'Invalid region ID' });
    }

    const entry = regionPriceCache.get(regionId);
    if (entry && Date.now() < entry.expiry) {
      logger.info(`✓ Region ${regionId} prices (cached) — ${Object.keys(entry.prices).length} items`);
      return res.json({ regionId, prices: entry.prices });
    }

    logger.info(`⟳ Fetching region ${regionId} prices from ESI...`);
    const prices = await fetchRegionPrices(regionId);
    setRegionPriceCache(regionId, prices);
    res.json({ regionId, prices });

  } catch (err) {
    logger.error(`Region ${req.params.regionId} prices error:`, err.message);
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
