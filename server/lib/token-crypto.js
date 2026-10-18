'use strict';
// Encryption of the refresh tokens kept in the database (AES-256-GCM). Two separate keys on purpose, see below.

const crypto = require('crypto'); // built-in
const config = require('./config');
const logger = require('./logger');

// ── CORP CRYPTO HELPERS (v1.4.0) ────────────────────────────────────────────
//
// Token encryption: AES-256-GCM with a 32-byte key derived from FORGE_CORP_KEY
// (which must be at least 32 hex chars / 16 bytes raw; padded/hashed here).
// The 32-byte key is derived once at startup and reused — never sent over the wire.

const CORP_ENCRYPTION_KEY = (() => {
  // Derive a fixed 32-byte key from FORGE_CORP_KEY (env var) via SHA-256.
  // If the env var is not set, the server still boots but corp setup will fail
  // loudly — this is intentional (don't silently use a predictable key).
  const raw = config.corpKey;
  if (!raw) {
    logger.warn('⚠ FORGE_CORP_KEY not set — corp token encryption disabled. Set this env var before using corp features.');
    return null;
  }
  return crypto.createHash('sha256').update(raw).digest(); // 32-byte Buffer
})();

// Separate key for "Remember my characters" alt refresh tokens — deliberately
// NOT the same key as CORP_ENCRYPTION_KEY, so a leak of one doesn't also
// decrypt the other (corp director tokens vs. individual players' alt tokens
// are very different blast radii). Same derivation pattern as above.
const REMEMBER_ENCRYPTION_KEY = (() => {
  const raw = config.rememberKey;
  if (!raw) {
    logger.warn('⚠ FORGE_REMEMBER_KEY not set — "Remember my characters" disabled. Set this env var to enable it.');
    return null;
  }
  return crypto.createHash('sha256').update(raw).digest();
})();

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns { ciphertext (base64), iv (hex), tag (hex) }.
 * `key` defaults to CORP_ENCRYPTION_KEY for backward compat with existing callers.
 */
function encryptToken(plaintext, key = CORP_ENCRYPTION_KEY) {
  if (!key) throw new Error('Encryption key not configured');
  const iv = crypto.randomBytes(12);   // 96-bit IV — recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: encrypted.toString('base64'),
    iv:         iv.toString('hex'),
    tag:        cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt a ciphertext string encrypted by encryptToken().
 * Throws if the auth tag doesn't match (tampered/corrupted data).
 * `key` defaults to CORP_ENCRYPTION_KEY for backward compat with existing callers.
 */
function decryptToken(ciphertext, ivHex, tagHex, key = CORP_ENCRYPTION_KEY) {
  if (!key) throw new Error('Encryption key not configured');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = { CORP_ENCRYPTION_KEY, REMEMBER_ENCRYPTION_KEY, encryptToken, decryptToken };
