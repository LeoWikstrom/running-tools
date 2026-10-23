import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Beam-search tests run the full pipeline twice and exceed the 5 s default.
    testTimeout: 30_000,
  },
});
