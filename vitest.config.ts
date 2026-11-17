import { defineConfig } from 'vitest/config';

// The game rules are pure TypeScript (no WebGL or DOM), so tests run in plain
// Node. Anything that needs a renderer is covered by the in-browser checks.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000
  }
});
