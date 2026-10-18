import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { forwardRejections, forwardRejectionsOn, createErrorHandler } = require('../../lib/http-errors.js');

const fakeRes = () => {
  const res = { headersSent: false, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

describe('forwardRejections', () => {
  it('passes a rejected promise to next()', async () => {
    const boom = new Error('boom');
    const next = vi.fn();
    forwardRejections(async () => { throw boom; })({}, {}, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('leaves a handler that completes alone', async () => {
    const next = vi.fn();
    forwardRejections(async (req, res) => { res.done = true; })({}, {}, next);
    await new Promise((r) => setTimeout(r, 0));
    expect(next).not.toHaveBeenCalled();
  });

  it('does not wrap error-handling middleware or non-functions', () => {
    const errorHandler = (err, req, res, next) => {};
    expect(forwardRejections(errorHandler)).toBe(errorHandler);
    expect(forwardRejections('x')).toBe('x');
  });
});

describe('forwardRejectionsOn', () => {
  it('wraps route handlers (including arrays) but not the settings getter', () => {
    const seen = [];
    const target = { get(path, ...handlers) { seen.push([path, handlers]); return 'ok'; } };
    forwardRejectionsOn(target);
    expect(target.get('trust proxy')).toBe('ok');
    expect(seen[0]).toEqual(['trust proxy', []]);
    const h1 = async () => {}, h2 = async () => {};
    target.get('/x', [h1], h2);
    expect(seen[1][1]).toHaveLength(2);
    expect(seen[1][1].every((h) => h !== h1 && h !== h2)).toBe(true); // wrapped
  });
});

describe('error handler', () => {
  const logger = { error: vi.fn() };
  const clientErrMsg = (e) => String(e.message || 'Internal server error').replace(/\/home\/\S+/g, '[path]');
  const handle = createErrorHandler({ logger, clientErrMsg });

  it('answers server errors as JSON 500 with paths stripped and no stack', () => {
    const res = fakeRes();
    handle(new Error('failed reading /home/someone/forge-db/forge.db'), { method: 'GET', originalUrl: '/api/x?token=secret' }, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'failed reading [path]' });
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    expect(logger.error.mock.calls.at(-1)[0]).not.toMatch(/secret/); // query strings are never logged
  });

  it('keeps client errors as 4xx with the safe message, and hides unsafe ones', () => {
    const exposed = fakeRes();
    handle(Object.assign(new Error('request entity too large'), { status: 413, expose: true }), { method: 'POST', url: '/' }, exposed, vi.fn());
    expect(exposed.statusCode).toBe(413);
    expect(exposed.body.error).toBe('request entity too large');
    const hidden = fakeRes();
    handle(Object.assign(new Error('internal detail'), { status: 400 }), { method: 'POST', url: '/' }, hidden, vi.fn());
    expect(hidden.body.error).toBe('Bad request');
  });

  it('defers to Express when the response has already started', () => {
    const res = fakeRes(); res.headersSent = true;
    const next = vi.fn();
    const err = new Error('late');
    handle(err, { method: 'GET', url: '/' }, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
