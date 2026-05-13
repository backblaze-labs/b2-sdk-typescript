import { defineConfig } from 'vitest/config'

/**
 * Coverage runs the *union* of fast + slow tiers (`*.test.ts` + `*.slow.test.ts`)
 * under the slow tier's constraints (single fork, generous timeout). This is
 * the only config that loads every test in the suite, so it's the only one
 * whose coverage numbers reflect the SDK's true exercised surface.
 *
 * Locally and in CI:
 *   - `pnpm test` (vite.config.ts)        → fast only, <60 s feedback
 *   - `pnpm test:slow` (vitest.slow.config.ts) → slow only, ~3 min
 *   - `pnpm test:coverage` (this file)    → both, with coverage instrumentation
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // No `.slow.test.ts` exclude — `*.slow.test.ts` matches `*.test.ts` so the
    // glob above already picks both up.
    exclude: ['node_modules/**', 'dist/**'],
    // Slow tier's constraints: serialized forks (no CPU contention between
    // CPU-bound multipart tests) and generous wall-clock budget.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
    testTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.slow.test.ts',
        'src/**/index.ts',
        'src/types/**',
        'src/version.ts',
        'src/auth/account-info.ts',
        'src/sync/types.ts',
      ],
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // CI gate: drop below these and the coverage job fails. Adjust upward
      // as coverage improves; never adjust downward to paper over a drop.
      // Current real values: 98.5% stmts / 90.95% branches / 98.47% funcs.
      // Pinned a half-point below current so a single test edit doesn't
      // accidentally trip the gate.
      thresholds: {
        statements: 97,
        lines: 97,
        functions: 97,
        branches: 89,
      },
    },
  },
})
