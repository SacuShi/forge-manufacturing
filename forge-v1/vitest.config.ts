import { defineConfig } from 'vitest/config';

// Pure-logic tests only (utils, mapping, maths); no DOM needed.
export default defineConfig({
  test: { include: ['src/**/__tests__/**/*.test.ts'], environment: 'node' },
});
