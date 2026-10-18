// Vitest global setup: boots ONE real server for all integration tests and tears it down afterwards.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bootServer } = require('./boot.cjs');

let server;

export async function setup({ provide }) {
  server = await bootServer();
  provide('baseUrl', server.baseUrl);
  // Tests read this file to assert which upstream calls the server made (and that nothing leaked).
  provide('callLogFile', server.callLogFile);
}

export async function teardown() {
  if (server) await server.stop();
}
