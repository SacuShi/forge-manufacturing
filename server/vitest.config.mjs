import { defineConfig } from 'vitest/config';

// Integration tests boot the real server once (global setup) and talk to it over HTTP with supertest.
// Everything else (unit tests) runs without a server.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globalSetup: ['./test/harness/global-setup.mjs'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
