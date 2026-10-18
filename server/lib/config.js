'use strict';
// The one place that reads the environment. Values are read when accessed (not frozen at load), so behaviour is
// identical to reading process.env directly; dotenv must already have been loaded by server.js.
// Add a new setting here rather than reading process.env elsewhere.

const env = () => process.env;

module.exports = {
  /** HTTP port (kept as the raw env string when set, exactly as the server always has). */
  get port() { return env().PORT || 3000; },

  /** Secret for the /api/admin/* endpoints. */
  get adminKey() { return env().FORGE_ADMIN_KEY; },

  /** EVE developer-portal application credentials (SSO login and token refresh). */
  eve: {
    get clientId() { return env().EVE_CLIENT_ID; },
    get clientSecret() { return env().EVE_CLIENT_SECRET; },
  },

  /** Claude API key for the AI advisor. */
  get anthropicApiKey() { return env().ANTHROPIC_API_KEY; },

  /** Web Push (VAPID) keys; push is disabled when either is missing. */
  vapid: {
    get publicKey() { return env().VAPID_PUBLIC_KEY; },
    get privateKey() { return env().VAPID_PRIVATE_KEY; },
  },

  /** 32-byte hex keys that encrypt stored refresh tokens (corp director tokens / "remember my characters"). */
  get corpKey() { return env().FORGE_CORP_KEY || ''; },
  get rememberKey() { return env().FORGE_REMEMBER_KEY || ''; },

  /** Set DISABLE_TRADING_POLLER=1 to stop the background Station Trading poller. */
  get disableTradingPoller() { return env().DISABLE_TRADING_POLLER === '1'; },
};

/**
 * Names of settings the app needs for full functionality but can start without (it answers the affected
 * routes with an error instead). Returns the missing ones so the caller can log a single clear warning.
 */
module.exports.missingRecommended = function missingRecommended() {
  const checks = [
    ['EVE_CLIENT_ID', module.exports.eve.clientId], ['EVE_CLIENT_SECRET', module.exports.eve.clientSecret],
    ['ANTHROPIC_API_KEY', module.exports.anthropicApiKey], ['FORGE_ADMIN_KEY', module.exports.adminKey],
  ];
  return checks.filter(([, v]) => !v).map(([name]) => name);
};
