import { defineConfig } from 'vitest/config';

// Pure-logic tests run in node; component/hook tests opt in to jsdom with a
// `// @vitest-environment jsdom` comment at the top of the file.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
  },
});
