import { defineConfig } from 'vitest/config'

/**
 * Coverage runs the *union* of fast + slow tiers (`*.test.ts` + `*.slow.test.ts`)
 * under the slow tier's constraints (single worker, generous timeout). This is
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
    include: ['src/**/*.test.ts', 'examples/**/*.node.test.ts'],
    // No `.slow.test.ts` exclude — `*.slow.test.ts` matches `*.test.ts` so the
    // glob above already picks both up.
    exclude: ['node_modules/**', 'dist/**'],
    // Slow tier's constraints: a single worker (no CPU contention between the
    // CPU-bound multipart tests) and a generous wall-clock budget.
    //
    // `fileParallelism: false` keeps every test file running in one long-lived
    // worker (vitest 4 replaced `pool: 'forks'` + `poolOptions.forks.singleFork`
    // with this top-level option). vitest's IPC (tinypool's `onTaskUpdate` RPC)
    // has a hard-coded ~60 s timeout that fires when an individual test runs
    // >60 s — and v8 coverage instrumentation 3-4×'s the wall clock of the
    // multipart SHA-1 tests, pushing several over 60 s. A single shared worker
    // keeps the RPC connection warm across file boundaries and avoids the timeout.
    fileParallelism: false,
    // Disable per-file isolation so the single worker can actually run all
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
        // Test files are not shipped runtime.
        'src/**/*.test.ts',
        'src/**/*.slow.test.ts',
        // Type-only contracts emit no runtime statements, so excluding them
        // keeps the report focused on code that can execute.
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
      // as coverage improves; never adjust downward to paper over a real drop.
      //
      // Shipped index modules, including src/simulator/index.ts, are included
      // in the denominator. Keep this gate aligned with the documented project
      // policy; add targeted tests instead of lowering it for denominator moves.
      thresholds: {
        statements: 97,
        lines: 98,
        functions: 97,
        branches: 91,
      },
    },
  },
})
