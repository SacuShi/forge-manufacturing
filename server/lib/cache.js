'use strict';
// In-memory TTL cache shared by the routes, plus the two TTLs everything else derives its expiry from.

// ── Cache TTL ─────────────────────────────────────────────────────────────────
// Defined once so every expiry calculation stays in sync.
const CACHE_TTL_MS     = 60 * 60 * 1000;      // 1 hour

const CACHE_TTL_ADJ_MS = 6 * CACHE_TTL_MS;    // 6 hours — for ESI adjusted prices

// Simple cache with periodic sweep to prevent unbounded growth
const cache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) { if (v.expiry < now) cache.delete(k); }
}, 15 * 60 * 1000).unref(); // .unref() so the timer doesn't prevent clean process exit

const getCached = (key) => {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
};

const setCached = (key, data, ttl = CACHE_TTL_MS) => {
  cache.set(key, { data, expiry: Date.now() + ttl });
};

module.exports = { CACHE_TTL_MS, CACHE_TTL_ADJ_MS, cache, getCached, setCached };
