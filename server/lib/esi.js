'use strict';
// The one place outbound EVE ESI requests are made: sends the User-Agent and compatibility date CCP requires
// and waits out a 429 rate-limit once.

const fetch = require('node-fetch');
const logger = require('./logger');

// ── ESI HTTP helper ───────────────────────────────────────────────────────────
// EVE ESI policy requires a descriptive User-Agent on every outbound request.
const ESI_USER_AGENT  = 'FORGE Manufacturing Intelligence/1.5 (forge-ukc.com)';

const ESI_COMPAT_DATE = '2025-07-10'; // required for all ESI routes added after July 2025

async function esiFetch(url, opts = {}) {
  const headers = Object.assign(
    { 'X-Compatibility-Date': ESI_COMPAT_DATE }, // default — callers may override for specific dates
    opts.headers || {},
    { 'User-Agent': ESI_USER_AGENT }              // always last — callers cannot override this
  );
  const res = await fetch(url, Object.assign({}, opts, { headers }));

  // ESI rate-limit back-off: wait Retry-After seconds then retry once.
  // Caller receives the retry response and handles any further failure.
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '5', 10);
    logger.warn(`⚠ ESI 429 rate-limit on ${url} — waiting ${wait}s then retrying`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return fetch(url, Object.assign({}, opts, { headers }));
  }

  return res;
}

module.exports = { esiFetch, ESI_USER_AGENT };
