'use strict';
// Express 4 does not pass a rejected promise from an async handler to the error handler, so an error thrown
// outside a handler's own try/catch would otherwise leave the request hanging (and surface only as an
// "unhandled rejection"). These helpers close that gap in one place and give every error the same JSON shape.

const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Wraps a handler so a rejected promise is forwarded to next(err). Error handlers (4 args) pass through untouched. */
function forwardRejections(handler) {
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  return function forwarded(req, res, next) {
    const result = handler.call(this, req, res, next);
    if (result && typeof result.catch === 'function') result.catch(next); // Express ignores the return value
  };
}

/** Makes every route added through `target[get|post|put|patch|delete](path, ...handlers)` forward async rejections. */
function forwardRejectionsOn(target) {
  for (const method of ROUTE_METHODS) {
    const original = target[method];
    target[method] = function patched(path, ...handlers) {
      // app.get('setting') with no handlers is Express's settings getter, not a route
      if (handlers.length === 0) return original.call(this, path);
      return original.call(this, path, ...handlers.flat(Infinity).map(forwardRejections));
    };
  }
}

/**
 * The last middleware: always JSON `{ error }`, never a stack trace. Client errors (e.g. malformed JSON, body too
 * large) keep their 4xx status and Express's own safe message; anything else is a 500 with paths stripped.
 */
function createErrorHandler({ logger, clientErrMsg }) {
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) logger.error(`❌ ${req.method} ${String(req.originalUrl || req.url).split('?')[0]} failed:`, err && err.message);
    const message = status >= 500 ? clientErrMsg(err || {}) : (err.expose ? err.message : 'Bad request');
    res.status(status).json({ error: message });
  };
}

module.exports = { forwardRejections, forwardRejectionsOn, createErrorHandler };
