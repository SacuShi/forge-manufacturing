/**
 * FORGE Security Middleware — v1.5.4
 *
 * Rate limits, token verification (with JWKS), and input validation.
 *
 * Rate-limit budget (per IP window):
 *   apiLimiter   — 300 req / 5 min   (generous for multi-char combined re-POSTs)
 *   authLimiter  — 20  req / 15 min  (EVE SSO callbacks)
 *   adminLimiter — 10  req / 15 min  (admin key endpoints — brute-force protection)
 *   aiLimiter    — 30  req / 10 min  (AI chat completions)
 */

'use strict';

const rateLimit = require('express-rate-limit');

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** General API calls (market, session-data, blueprints, assets, etc.) */
const apiLimiter = rateLimit({
  windowMs:        5 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please try again later' },
});

/** EVE SSO token exchange and auth callbacks */
const authLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many authentication attempts, please try again later' },
});

/** Admin key endpoints — tight to prevent brute-force of FORGE_ADMIN_KEY */
const adminLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many admin requests, please try again later' },
});

/** AI chat completions */
const aiLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'AI rate limit reached, please wait a moment' },
});

// ── EVE JWKS Verification ─────────────────────────────────────────────────────
//
// EVE SSO issues RS256-signed JWTs.  We verify the signature against CCP's public
// JWKS before trusting any claim in the token.  The JWKS is cached for 1 hour and
// auto-refreshed if a key is not found (handles key rotation).

const EVE_JWKS_URI = 'https://login.eveonline.com/oauth/jwks';
const JWKS_TTL_MS  = 60 * 60 * 1000; // 1 hour

// All JWKS state in one object — prevents the three vars from drifting out of sync
const _jwks = { data: null, fetchedAt: 0, inFlight: null };

async function fetchJwks(force = false) {
  if (!force && _jwks.data && (Date.now() - _jwks.fetchedAt) < JWKS_TTL_MS) {
    return _jwks.data;
  }
  // Deduplicate concurrent fetches — thundering-herd guard on cold start
  if (!force && _jwks.inFlight) return _jwks.inFlight;

  _jwks.inFlight = (async () => {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 5000); // 5s hard deadline
    try {
      const res = await fetch(EVE_JWKS_URI, {
        signal:  controller.signal,
        headers: { 'User-Agent': 'FORGE Manufacturing Intelligence / forge-ukc.com' },
      });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      _jwks.data      = await res.json();
      _jwks.fetchedAt = Date.now();
      return _jwks.data;
    } finally {
      clearTimeout(timeout);
      _jwks.inFlight = null;
    }
  })();

  return _jwks.inFlight;
}

/**
 * Verify an EVE SSO JWT and return its decoded payload.
 * Throws if the signature is invalid, the token is expired, or JWKS is unavailable.
 */
async function verifyEveJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  let header, payload;
  try {
    header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid JWT encoding');
  }

  // Check expiry first — fast rejection before any network call
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expired');

  // Find matching JWK; retry once with a forced refresh to handle key rotation
  let jwk;
  for (const force of [false, true]) {
    const jwks = await fetchJwks(force);
    jwk = jwks.keys.find(k => !header.kid || k.kid === header.kid);
    if (jwk) break;
  }
  if (!jwk) throw new Error(`No matching JWK for kid: ${header.kid}`);

  // Verify RS256 signature using Node 18+ Web Crypto API
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto unavailable — requires Node 18+');

  const publicKey = await subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature    = Buffer.from(parts[2], 'base64url');
  const valid        = await subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signingInput);
  if (!valid) throw new Error('JWT signature verification failed');

  return payload;
}

/**
 * Decode JWT payload without signature verification.
 * Used ONLY as a fallback when JWKS is temporarily unreachable.
 */
function _decodeJwtUnsafe(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// ── Shared token extraction ───────────────────────────────────────────────────

/**
 * Extract and verify the EVE character from an Authorization header.
 * Pure function — does not touch req/res, so it can be called from any middleware.
 * Returns { characterId, characterName, payload } or throws with a `.status` property.
 *
 * Falls back to unsigned decode if JWKS is temporarily unreachable (logs a warning).
 * Hard-rejects on any other failure (bad signature, expired, wrong Node version).
 */
async function extractCharacterFromToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw Object.assign(new Error('Missing or invalid Authorization header'), { status: 401 });
  }

  const token = authHeader.slice(7);
  let payload;

  try {
    payload = await verifyEveJwt(token);
  } catch (verifyErr) {
    // Only transient JWKS network failures use the decode-only fallback;
    // local errors (bad sig, expired, wrong Node) are hard rejects.
    if (verifyErr.message.startsWith('JWKS fetch failed')) {
      console.warn('⚠ JWKS unavailable — using decode-only fallback:', verifyErr.message);
      payload = _decodeJwtUnsafe(token);
    } else {
      throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
    }
  }

  if (!payload?.sub) {
    throw Object.assign(new Error('Invalid token payload'), { status: 401 });
  }

  // EVE JWT sub: "CHARACTER:EVE:<characterId>"
  const subParts    = String(payload.sub).split(':');
  const characterId = subParts.length === 3 ? parseInt(subParts[2], 10) : null;
  if (!characterId || isNaN(characterId)) {
    throw Object.assign(new Error('Cannot extract character ID from token'), { status: 401 });
  }

  return { characterId, characterName: payload.name || '', payload };
}

// ── EVE SSO token verification ────────────────────────────────────────────────

/**
 * Express middleware: verifies the Bearer token from EVE SSO.
 *
 * On success sets:
 *   req.characterId    — numeric EVE character ID (flat for route handler compat)
 *   req.eveCharacter   — { characterId, characterName }
 *   req._evePayload    — full JWT payload (cached so verifyCharacterOwnership
 *                        can skip re-verification on the same request)
 */
async function verifyEveToken(req, res, next) {
  try {
    const { characterId, characterName, payload } =
      await extractCharacterFromToken(req.headers.authorization);

    req.characterId  = characterId;
    req.eveCharacter = { characterId, characterName };
    req._evePayload  = payload; // short-circuit verifyCharacterOwnership on same request
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

/**
 * Express middleware: verifies EVE token AND checks that the characterId in the
 * route param (:characterId) matches the token's character.
 *
 * Short-circuits RS256 verification when verifyEveToken already ran (req._evePayload set),
 * avoiding a second importKey + verify per request on ownership-checked routes.
 */
async function verifyCharacterOwnership(req, res, next) {
  try {
    // Reuse the already-verified identity from verifyEveToken if present
    if (!req.characterId) {
      const { characterId, characterName, payload } =
        await extractCharacterFromToken(req.headers.authorization);
      req.characterId  = characterId;
      req.eveCharacter = { characterId, characterName };
      req._evePayload  = payload;
    }

    const routeCharId = parseInt(req.params.characterId, 10);
    if (req.characterId !== routeCharId) {
      return res.status(403).json({ error: 'Token does not match requested character' });
    }
    next();
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
}

// ── Input validation middleware ───────────────────────────────────────────────

/**
 * Express middleware: validates the AI chat request body.
 * Expects { message: string, history?: ChatMessage[] }
 */
function validateAiChatInput(req, res, next) {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  const { message, history } = body;

  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message must be a non-empty string' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message exceeds 2000 character limit' });
  }

  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return res.status(400).json({ error: 'history must be an array' });
    }
    if (history.length > 50) {
      return res.status(400).json({ error: 'history exceeds 50 message limit' });
    }
    for (const msg of history) {
      if (!msg || typeof msg !== 'object') {
        return res.status(400).json({ error: 'each history entry must be an object' });
      }
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        return res.status(400).json({ error: 'history role must be "user" or "assistant"' });
      }
      if (typeof msg.content !== 'string') {
        return res.status(400).json({ error: 'history content must be a string' });
      }
      if (msg.content.length > 4000) {
        return res.status(400).json({ error: 'history message exceeds 4000 character limit' });
      }
    }
  }
  next();
}

/**
 * Express middleware: validates a single message string in req.body.message.
 */
function validateChatMessage(req, res, next) {
  const { message } = req.body || {};
  if (typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message must be a non-empty string' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message exceeds 2000 character limit' });
  }
  next();
}

// ── Error handler ─────────────────────────────────────────────────────────────

/**
 * Express 4-argument error-handling middleware.
 * Registered last (after all routes) via app.use(security.errorHandler).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('Unhandled server error:', err);
  const status = typeof err.status === 'number' ? err.status :
                 typeof err.statusCode === 'number' ? err.statusCode : 500;
  const message = (err.message || 'Internal server error')
    .replace(/\/[^\s"']+\.(db|js|json|sqlite)/gi, '[file]')
    .replace(/\/home\/[^\s"']+/gi, '[path]');
  res.status(status).json({ error: message });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  apiLimiter,
  authLimiter,
  adminLimiter,
  aiLimiter,
  verifyEveToken,
  verifyCharacterOwnership,
  validateAiChatInput,
  validateChatMessage,
  errorHandler,
};
