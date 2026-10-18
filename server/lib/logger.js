'use strict';
// The one logger for the server. Same output streams as plain console (so PM2's out/error logs are unchanged):
// info/debug -> stdout, warn/error -> stderr. LOG_LEVEL (debug | info | warn | error | silent) filters;
// the default is `info`, which prints everything the server printed before this module existed.
// Never pass secrets (tokens, keys, passwords) to any of these.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const DEFAULT_LEVEL = 'info';

const threshold = () => LEVELS[String(process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase()] ?? LEVELS[DEFAULT_LEVEL];
const enabled = (level) => LEVELS[level] >= threshold();

module.exports = {
  debug: (...args) => { if (enabled('debug')) console.log(...args); },
  info:  (...args) => { if (enabled('info'))  console.log(...args); },
  warn:  (...args) => { if (enabled('warn'))  console.warn(...args); },
  error: (...args) => { if (enabled('error')) console.error(...args); },
};
