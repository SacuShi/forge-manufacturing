'use strict';
/**
 * Icon proxy — serves EVE item type icons from FORGE's own server.
 *
 * WHY THIS EXISTS
 * ────────────────
 * EVE item icons live at https://images.evetech.net/types/{typeId}/icon?size=32
 * (CCP's CDN). Loading them directly from the browser means:
 *   - Each icon is a separate cross-origin request (no keep-alive benefit)
 *   - CCP's CDN latency varies — can be 200-800ms on a cold browser cache
 *   - Every tab-switch re-requests the same icons if the browser evicted them
 *
 * This route proxies those requests through the local FORGE server and saves
 * icons to disk after the first fetch. Subsequent requests are served from
 * disk (~0-1ms) with a 1-year cache header so the browser never asks again.
 *
 * ICON SIZES SUPPORTED: 22, 32, 64 (the only sizes used across the app).
 * Character portraits and corporation logos stay on CCP's CDN (they can change).
 *
 * CACHE DIRECTORY: /server/icon-cache/{typeId}_{size}.png
 * Typical icon: 1–4 KB. 10,000 unique icons ≈ 10–40 MB total disk use.
 */

const logger = require('../lib/logger');
const router   = require('express').Router();
const path     = require('path');
const fs       = require('fs');

const CACHE_DIR    = path.join(__dirname, '..', 'icon-cache');
const ALLOWED_SIZES = new Set([22, 32, 64]);
const CCP_CDN      = 'https://images.evetech.net';

// Ensure the cache directory exists when this module is first loaded.
fs.mkdirSync(CACHE_DIR, { recursive: true });

module.exports = function iconRoutes() {

  // No rate limiter — icons are public EVE CDN images, not user data.
  // Cached icons are plain disk reads so there is no meaningful resource to protect.
  // The apiLimiter budget must stay available for real API endpoints.
  router.get('/api/icon/:typeId', async (req, res) => {
    const typeId  = parseInt(req.params.typeId, 10);
    const size    = parseInt(req.query.size || '32', 10);
    // 'icon' = normal item, 'bp' = blueprint original, 'bpc' = blueprint copy
    const ALLOWED_VARIANTS = new Set(['icon', 'bp', 'bpc']);
    const variant = ALLOWED_VARIANTS.has(req.query.variant) ? req.query.variant : 'icon';

    // Validate inputs — only numeric typeIds and known sizes are allowed
    if (!typeId || typeId <= 0 || isNaN(typeId)) return res.status(400).end();
    if (!ALLOWED_SIZES.has(size))                 return res.status(400).end();

    const filename  = `${typeId}_${size}_${variant}.png`;
    const cachePath = path.join(CACHE_DIR, filename);

    // Fast path: serve from disk without touching CCP's CDN
    if (fs.existsSync(cachePath)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Type', 'image/png');
      return res.sendFile(cachePath);
    }

    // Slow path: fetch from CCP, save to disk, then serve
    try {
      const controller = new AbortController();
      const timeout    = setTimeout(() => controller.abort(), 8000);

      const upstream = await fetch(
        `${CCP_CDN}/types/${typeId}/${variant}?size=${size}`,
        {
          signal:  controller.signal,
          headers: { 'User-Agent': 'FORGE Manufacturing Intelligence / forge-ukc.com' },
        }
      );
      clearTimeout(timeout);

      if (!upstream.ok) {
        // CCP doesn't have this icon — pass the status through, don't cache
        return res.status(upstream.status).end();
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());

      // Write to disk asynchronously — don't block the response on disk I/O
      fs.writeFile(cachePath, buffer, (err) => {
        if (err) logger.error(`Icon cache write failed (${filename}):`, err.message);
      });

      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Type', 'image/png');
      res.send(buffer);

    } catch (err) {
      // Timeout or network error — degrade gracefully (browser shows onError fallback)
      logger.error(`Icon fetch failed typeId=${typeId} size=${size}:`, err.message);
      res.status(502).end();
    }
  });

  return router;
};
