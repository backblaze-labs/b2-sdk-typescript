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
    //
    // `singleFork: true` keeps every test file running in the same long-lived
    // fork. With `maxForks: 1` plus default per-file forking, vitest's IPC
    // (tinypool's `onTaskUpdate` RPC) has a hard-coded ~60 s timeout that
    // fires when an individual test runs >60 s — and v8 coverage
    // instrumentation 3-4×'s the wall clock of the multipart SHA-1 tests,
    // pushing several over 60 s. A single shared fork keeps the RPC
    // connection warm across file boundaries and avoids the timeout.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Disable per-file isolation so the single fork can actually run all
    // files sequentially without restart. Tests already create fresh
    // `B2Simulator` instances per file, so we don't need vitest's isolation.
    isolate: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Survive tinypool's hard-coded ~60 s `onTaskUpdate` RPC timeout that
    // sometimes fires under v8 coverage instrumentation when the main thread
    // is busy merging coverage payloads from a just-finished long test. The
    // error is internal to the vitest-worker IPC layer, not a real test
    // failure — without this flag, the unhandled error aborts the rest of
    // the run (we'd see ~5/27 files reported and coverage collapse to ~66%
    // because the remaining files never get scheduled).
    dangerouslyIgnoreUnhandledErrors: true,
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
        // Test helpers are imported only by other tests; never bundled into
        // production builds (no entry in vite.config.ts). Excluding here
        // keeps the denominator focused on shipped code.
        'src/test-utils/**',
      ],
      reporter: ['text', 'text-summary', 'html', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // CI gate: drop below these and the coverage job fails. Adjust upward
      // as coverage improves; never adjust downward to paper over a drop.
      // Current real values: 99.41% stmts / 92.93% branches / 98.63% funcs.
      // Pinned a half-point below current so a single test edit doesn't
      // accidentally trip the gate.
      thresholds: {
        statements: 99,
        lines: 99,
        functions: 98,
        branches: 92,
      },
    },
  },
})
