import { afterEach } from 'vitest';

// Component tests only (jsdom): extend matchers and unmount between tests. Node-environment tests skip this.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  await import('@testing-library/jest-dom/vitest');
  afterEach(() => cleanup());
}
