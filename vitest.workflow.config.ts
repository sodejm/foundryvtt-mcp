import { defineConfig } from 'vitest/config';

// Exercises the built CLI over real stdio and a local REST fixture. Live Foundry
// compatibility remains a separate required integration tier.
export default defineConfig({
  test: {
    include: ['tests/workflows/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    maxWorkers: 1,
  },
});
