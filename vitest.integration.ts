import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Real-B2 setup authorizes, lists buckets, sweeps stale test buckets, and
    // creates a fresh bucket before tests run. Keep hook timeout aligned with
    // the live network budget instead of Vitest's 10s default.
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
})
