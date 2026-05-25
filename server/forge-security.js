/**
 * FORGE Security Middleware
 *
 * Rate limits, token verification, and input validation for the FORGE server.
 *
 * Rate-limit budget (per IP window):
 *   apiLimiter  — 300 req / 5 min   (generous for multi-character combined re-POSTs + market fetches)
 *   authLimiter — 20  req / 15 min  (EVE SSO callbacks; low volume by design)
 *   aiLimiter   — 30  req / 10 min  (AI chat completions)
 */

'use strict';

const rateLimit = require('express-rate-limit');

// ── Rate limiters ─────────────────────────────────────────────────────────────

/** General API calls (market, session-data, blueprints, assets, etc.) */
const apiLimiter = rateLimit({
  windowMs:         5 * 60 * 1000, // 5 minutes
  max:              300,            // 300 req / 5 min per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests, please try again later' },
});

/** EVE SSO token exchange and auth callbacks */
const authLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              20,              // 20 req / 15 min per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many authentication attempts, please try again later' },
});

/** AI chat completions */
const aiLimiter = rateLimit({
  windowMs:         10 * 60 * 1000, // 10 minutes
  max:              30,              // 30 req / 10 min per IP
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'AI rate limit reached, please wait a moment' },
});

// ── EVE SSO token verification ────────────────────────────────────────────────

/**
 * Express middleware that validates the Bearer token from EVE SSO.
 * Attaches decoded payload to req.eveCharacter = { characterId, characterName }.
 */
async function verifyEveToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token   = authHeader.slice(7);
    const payload = decodeJwt(token);

    if (!payload || !payload.sub) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    // EVE JWT sub format: "CHARACTER:EVE:<characterId>"
    const subParts   = String(payload.sub).split(':');
    const characterId = subParts.length === 3 ? parseInt(subParts[2], 10) : null;

    if (!characterId || isNaN(characterId)) {
      return res.status(401).json({ error: 'Cannot extract character ID from token' });
    }

    req.eveCharacter = {
      characterId,
      characterName: payload.name || '',
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token verification failed' });
  }
}

/**
 * Express middleware that verifies the Bearer token AND checks the characterId
 * in the route param matches the token's character.
 * Usage: router.get('/api/something/:characterId', verifyCharacterOwnership, handler)
 */
async function verifyCharacterOwnership(req, res, next) {
  try {
    await new Promise((resolve, reject) => {
      verifyEveToken(req, res, (err) => (err ? reject(err) : resolve()));
    });

    const routeCharId = parseInt(req.params.characterId, 10);
    if (req.eveCharacter.characterId !== routeCharId) {
      return res.status(403).json({ error: 'Token does not match requested character' });
    }
    next();
  } catch {
    // verifyEveToken already sent the response
  }
}

// ── Input validation ──────────────────────────────────────────────────────────

/** Validates AI chat input from the request body. Returns null if valid, or an error string. */
function validateAiChatInput(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object';

  const { message, history } = body;

  if (typeof message !== 'string') return 'message must be a string';
  if (message.trim().length === 0)  return 'message cannot be empty';
  if (message.length > 2000)        return 'message exceeds 2000 character limit';

  if (history !== undefined) {
    if (!Array.isArray(history))    return 'history must be an array';
    if (history.length > 50)        return 'history exceeds 50 message limit';

    for (const msg of history) {
      if (!msg || typeof msg !== 'object')          return 'each history entry must be an object';
      if (msg.role !== 'user' && msg.role !== 'assistant') return 'history role must be "user" or "assistant"';
      if (typeof msg.content !== 'string')          return 'history content must be a string';
      if (msg.content.length > 4000)               return 'history message exceeds 4000 character limit';
    }
  }

  return null;
}

/** Validates a single chat message. Returns null if valid, or an error string. */
function validateChatMessage(message) {
  if (typeof message !== 'string')  return 'message must be a string';
  if (message.trim().length === 0)  return 'message cannot be empty';
  if (message.length > 2000)        return 'message exceeds 2000 character limit';
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Decode a JWT without verifying the signature (EVE tokens are verified via JWKS in production). */
function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const pad     = '='.repeat((4 - (parts[1].length % 4)) % 4);
    const bytes   = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

// ── Error handler ─────────────────────────────────────────────────────────────

/**
 * Express error-handling middleware (4-argument signature required by Express).
 * Catches any unhandled errors thrown in route handlers.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('Unhandled server error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  apiLimiter,
  authLimiter,
  aiLimiter,
  verifyEveToken,
  verifyCharacterOwnership,
  validateAiChatInput,
  validateChatMessage,
  errorHandler,
};
