// Job notifications by browser push and Discord webhook: URL validation, encrypted storage, and the background checker
// (who gets told, how often, and what happens when a channel is gone or failing). Real lib/discord + routes/push code
// on an in-memory database; Discord (node-fetch) and the push service are stubbed, so nothing leaves the machine.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const hook = (id) => `https://discord.com/api/webhooks/${id}/${'a'.repeat(30)}${id}`;
const HOOK_OK = hook(111111111111), HOOK_GONE = hook(222222222222), HOOK_DOWN = hook(333333333333);
const discordPosts = [];                 // { url, body }
const discordStatus = new Map([[HOOK_OK, 204], [HOOK_GONE, 404], [HOOK_DOWN, 500]]);
const pushSent = [];                     // { endpoint, payload }
const pushFails = new Map();             // endpoint -> statusCode
const webpush = {
  sendNotification: async (sub, payload) => {
    if (pushFails.has(sub.endpoint)) throw Object.assign(new Error('push failed'), { statusCode: pushFails.get(sub.endpoint) });
    pushSent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  },
};

let db, discord, check;
// Finished an hour ago (rows older than 7 days are cleaned up after the run, so keep "finished" recent)
const past = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z'), future = '2999-01-01T00:00:00Z';

beforeAll(async () => {
  process.env.FORGE_REMEMBER_KEY = 'unit-test-remember-key';
  const fakeFetch = async (url, opts) => {
    discordPosts.push({ url, body: JSON.parse(opts.body), redirect: opts.redirect });
    const status = discordStatus.get(url) ?? 404;
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => ({}) };
  };
  const fetchPath = require.resolve('node-fetch');
  require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };

  db = require('../../lib/db');
  await db.initDatabase(':memory:');
  await require('../../lib/migrations').runMigrations();
  discord = require('../../lib/discord');
  const { checkJobCompletions } = require('../../routes/push');
  check = (wp = webpush) => checkJobCompletions({ dbRun: db.dbRun, dbAll: db.dbAll, webpush: wp });
});

beforeEach(async () => {
  discordPosts.length = 0; pushSent.length = 0; pushFails.clear();
  for (const t of ['push_job_watch', 'push_subscriptions', 'discord_webhooks']) await db.dbRun(`DELETE FROM ${t}`);
});

const watch = (characterId, key, product, endDate) => db.dbRun(
  `INSERT INTO push_job_watch (character_id, job_key, product_name, end_date, notified) VALUES (?, ?, ?, ?, 0)`,
  [characterId, key, product, endDate]);
const subscribe = (characterId, endpoint) => db.dbRun(
  `INSERT INTO push_subscriptions (character_id, endpoint, p256dh, auth) VALUES (?, ?, 'k', 'a')`, [characterId, endpoint]);
const notified = async (key) => (await db.dbGet('SELECT notified FROM push_job_watch WHERE job_key = ?', [key])).notified;

describe('Discord webhook URLs', () => {
  it('accepts real webhook URLs only', () => {
    expect(discord.isDiscordWebhookUrl(HOOK_OK)).toBe(true);
    expect(discord.isDiscordWebhookUrl(`https://discordapp.com/api/webhooks/123456789/${'b'.repeat(40)}`)).toBe(true);
    expect(discord.isDiscordWebhookUrl(`https://ptb.discord.com/api/v10/webhooks/123456789/${'b'.repeat(40)}`)).toBe(true);
    for (const bad of [
      HOOK_OK.replace('https', 'http'),
      HOOK_OK.replace('discord.com', 'discord.com.evil.example'),
      HOOK_OK.replace('discord.com', 'evil.example'),
      `${HOOK_OK}?x=1`,
      `${HOOK_OK}/../../other`,
      'https://discord.com/api/webhooks/123/short',
      'http://127.0.0.1:3000/api/webhooks/123456789/' + 'c'.repeat(30),
      '', null, 42,
    ]) expect(discord.isDiscordWebhookUrl(bad), String(bad)).toBe(false);
  });

  it('stores the URL encrypted and never returns it in the status', async () => {
    await discord.saveWebhook(1, HOOK_OK);
    const row = await db.dbGet('SELECT enc_url FROM discord_webhooks WHERE character_id = 1');
    expect(row.enc_url).not.toContain('discord.com');
    expect(await discord.getWebhookUrl(1)).toBe(HOOK_OK);
    const status = await discord.getStatus(1);
    expect(status).toMatchObject({ connected: true, active: true, lastError: null });
    expect(JSON.stringify(status)).not.toContain('webhooks');
  });

  it('refuses redirects and disables mentions and Markdown in product names', async () => {
    await discord.postWebhook(HOOK_OK, discord.jobsCompleteMessage(['@everyone **Raven** [click](http://x)']));
    const sent = discordPosts.at(-1);
    expect(sent.redirect).toBe('error');
    expect(sent.body.allowed_mentions).toEqual({ parse: [] });
    expect(sent.body.embeds[0].description).toBe('• everyone Raven clickhttp://x');
  });
});

describe('checkJobCompletions', () => {
  it('sends a Discord-only player one message for all finished jobs, and leaves unfinished ones', async () => {
    await discord.saveWebhook(10, HOOK_OK);
    await watch(10, 'a', 'Raven', past);
    await watch(10, 'b', 'Drake', past);
    await watch(10, 'c', 'Titan', future);
    await check(null); // also works with browser push not set up on the server
    expect(discordPosts).toHaveLength(1);
    expect(discordPosts[0].body.embeds[0].title).toBe('2 industry jobs complete');
    expect(discordPosts[0].body.embeds[0].description).toBe('• Raven\n• Drake');
    expect([await notified('a'), await notified('b'), await notified('c')]).toEqual([1, 1, 0]);

    await check(null); // already told: nothing is sent twice
    expect(discordPosts).toHaveLength(1);
  });

  it('uses both channels when a player has both', async () => {
    await discord.saveWebhook(20, HOOK_OK);
    await subscribe(20, 'https://push.example/20');
    await watch(20, 'd', 'Rifter', past);
    await check();
    expect(pushSent).toEqual([{ endpoint: 'https://push.example/20',
      payload: expect.objectContaining({ body: 'Rifter has finished!' }) }]);
    expect(discordPosts).toHaveLength(1);
    expect(await notified('d')).toBe(1);
  });

  it('switches off a webhook Discord says was deleted, and does not keep retrying the job', async () => {
    await discord.saveWebhook(30, HOOK_GONE);
    await watch(30, 'e', 'Orca', past);
    await check(null);
    const status = await discord.getStatus(30);
    expect(status.active).toBe(false);
    expect(status.lastError).toMatch(/deleted/);
    expect(await notified('e')).toBe(1);
    expect(await discord.getWebhookUrl(30)).toBeNull();
  });

  it('keeps the job for the next run when Discord fails temporarily and nothing else delivered', async () => {
    await discord.saveWebhook(40, HOOK_DOWN);
    await watch(40, 'f', 'Hulk', past);
    await check(null);
    expect(await notified('f')).toBe(0);
    expect((await discord.getStatus(40)).lastError).toMatch(/retry/);
  });

  it('removes a browser subscription the push service says is gone', async () => {
    await subscribe(50, 'https://push.example/gone');
    pushFails.set('https://push.example/gone', 410);
    await watch(50, 'g', 'Venture', past);
    await check();
    expect(await db.dbGet('SELECT 1 AS x FROM push_subscriptions WHERE character_id = 50')).toBeUndefined();
    expect(await notified('g')).toBe(1);
  });

  it('marks jobs handled for a player with no channel left, so they do not pile up', async () => {
    await watch(60, 'h', 'Procurer', past);
    await check();
    expect(await notified('h')).toBe(1);
    expect(discordPosts).toHaveLength(0);
    expect(pushSent).toHaveLength(0);
  });
});
