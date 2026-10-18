'use strict';
// Blueprint icon pre-warmer. Called fire-and-forget after the session upload (and as soon as the browser has its
// blueprint list). Fetches the bp/bpc variant icons from CCP's CDN and saves them to the icon-cache directory so the
// first visit to the Blueprints tab serves from disk (~0ms) instead of hammering CCP in parallel for every blueprint.

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const logger = require('./logger');

const ICON_CACHE    = path.join(__dirname, '..', 'icon-cache'); // same folder routes/icons.js serves from
const CCP_CDN_ICONS = 'https://images.evetech.net';
fs.mkdirSync(ICON_CACHE, { recursive: true });

// Fetch one icon; resolve regardless of success so pool continues.
async function fetchOneIcon(typeId, variant) {
  const filename  = `${typeId}_32_${variant}.png`;
  const cachePath = path.join(ICON_CACHE, filename);
  if (fs.existsSync(cachePath)) return; // already cached
  try {
    const ctrl    = new AbortController();
    const timer   = setTimeout(() => ctrl.abort(), 8000);
    const res     = await fetch(`${CCP_CDN_ICONS}/types/${typeId}/${variant}?size=32`, {
      signal:  ctrl.signal,
      headers: { 'User-Agent': 'FORGE Manufacturing Intelligence / forge-ukc.com' },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFile(cachePath, buf, () => {});
  } catch (_) { /* timeout or network — skip silently */ }
}

// Warm icons for all unique blueprint typeIds, both bp and bpc variants.
// Concurrency-limited to 16 parallel fetches — high enough to clear a large
// blueprint collection quickly, low enough to stay polite to CCP's CDN.
async function warmBlueprintIcons(blueprints) {
  if (!Array.isArray(blueprints) || blueprints.length === 0) return;
  const typeIds = [...new Set(blueprints.map(b => b.type_id).filter(Boolean))];
  const CONCURRENCY = 16;
  // Build work list: prefer the correct variant per typeId but always warm both
  // since the Blueprints tab can show BPO and BPC copies of the same typeId.
  const tasks = typeIds.flatMap(id => [
    () => fetchOneIcon(id, 'bp'),
    () => fetchOneIcon(id, 'bpc'),
  ]);
  // Run in fixed-size sliding window
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const task = tasks[i++];
      await task();
    }
  }
  const pool = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker);
  await Promise.all(pool);
  logger.info(`[icon-warm] Warmed ${typeIds.length} blueprint types (${tasks.length} variants)`);
}

module.exports = { warmBlueprintIcons };
