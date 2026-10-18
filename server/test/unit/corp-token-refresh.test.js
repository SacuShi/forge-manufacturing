// Regression: refreshCorpAccessToken once read the EVE client id from the corp_config database row (which shadowed the
// config module) and threw, so a stored corp token could never be refreshed. This runs the real function against an
// in-memory database and a stubbed CCP token endpoint.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CORP = 98000001;
const requests = [];

beforeAll(async () => {
  process.env.FORGE_CORP_KEY = 'unit-test-corp-key';
  process.env.EVE_CLIENT_ID = 'client-id';
  process.env.EVE_CLIENT_SECRET = 'client-secret';
  // Replace node-fetch BEFORE the library loads it, so nothing leaves the machine.
  const fakeFetch = async (url, opts) => {
    requests.push({ url, opts });
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ access_token: 'new-access', refresh_token: 'rotated-refresh' }) };
  };
  const fetchPath = require.resolve('node-fetch');
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };

  const { initDatabase, dbRun } = require('../../lib/db');
  await initDatabase(':memory:');
  await require('../../lib/migrations').runMigrations();
  const { encryptToken } = require('../../lib/token-crypto');
  const enc = encryptToken('old-refresh');
  await dbRun(
    'INSERT INTO corp_config (corp_id, director_char_id, enc_refresh_token, token_iv, token_tag) VALUES (?, ?, ?, ?, ?)',
    [CORP, 1, enc.ciphertext, enc.iv, enc.tag],
  );
});

describe('refreshCorpAccessToken', () => {
  it('exchanges the stored refresh token with the app credentials and stores the rotated one', async () => {
    const { refreshCorpAccessToken } = require('../../lib/corp');
    const { dbGet } = require('../../lib/db');
    const { decryptToken } = require('../../lib/token-crypto');

    const access = await refreshCorpAccessToken(CORP);

    expect(access).toBe('new-access');
    const [req] = requests;
    expect(req.opts.headers.Authorization).toBe('Basic ' + Buffer.from('client-id:client-secret').toString('base64'));
    expect(req.opts.body).toContain('refresh_token=old-refresh');
    const row = await dbGet('SELECT enc_refresh_token, token_iv, token_tag FROM corp_config WHERE corp_id = ?', [CORP]);
    expect(decryptToken(row.enc_refresh_token, row.token_iv, row.token_tag)).toBe('rotated-refresh');
  });
});
