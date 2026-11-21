import { describe, it, expect } from 'vitest';
import { readJsonReply } from '../client';

// Regression (Nov 2026): when Cloudflare timed out a long AI answer it sent its own HTML page, and the chat showed
// "Unexpected token '<', "<!DOCTYPE "... is not valid JSON". readJsonReply must turn that into plain English.
const html = '<!DOCTYPE html><html><body>Error 524</body></html>';

describe('readJsonReply', () => {
  it('returns the parsed JSON for a normal reply', async () => {
    await expect(readJsonReply(new Response('{"content":[{"type":"text","text":"hi"}]}', { status: 200 })))
      .resolves.toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });

  it('explains a Cloudflare timeout instead of a JSON parse error', async () => {
    await expect(readJsonReply(new Response(html, { status: 524 }))).rejects.toThrow(/took too long/);
  });

  it('explains a server that is down or restarting', async () => {
    await expect(readJsonReply(new Response(html, { status: 502 }))).rejects.toThrow(/could not be reached/);
  });

  it('never surfaces the raw parse error', async () => {
    await expect(readJsonReply(new Response(html, { status: 500 }))).rejects.toThrow('FORGE sent an unexpected reply (HTTP 500). Please try again.');
  });
});
