import { describe, it, expect, vi, afterEach } from 'vitest';
import { esiGet, esiErrorStatus } from '../client';

// The re-auth banner ("FORGE needs one additional permission...") must only appear when ESI really
// answers 403. These checks run the real esiGet so a change to its error text is caught here too.
const failWith = (status: number) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }));

const errorFrom = async (path: string) => {
  try {
    await esiGet(path, 'token');
  } catch (e) {
    return e;
  }
  throw new Error('esiGet did not reject');
};

describe('esiErrorStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a real 403 as 403', async () => {
    failWith(403);
    expect(esiErrorStatus(await errorFrom('/characters/90000001/standings/'))).toBe(403);
  });

  it('does not mistake a character id containing "403" for a 403', async () => {
    failWith(502);
    expect(esiErrorStatus(await errorFrom('/characters/2114033403/standings/'))).toBe(502);
  });

  it('reads a rate limit as 429, not as a missing permission', async () => {
    failWith(429);
    expect(esiErrorStatus(await errorFrom('/characters/90000001/standings/'))).toBe(429);
  });

  it('returns null for a network error (no response at all)', () => {
    expect(esiErrorStatus(new TypeError('Failed to fetch'))).toBeNull();
    expect(esiErrorStatus('not an error')).toBeNull();
  });
});
