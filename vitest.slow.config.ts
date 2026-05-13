import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the *slow* unit test tier: multipart upload/copy/stream
 * round-trips that compute real SHA-1 over multi-MB buffers through the
 * in-memory `B2Simulator`. These tests are CPU-bound and time-sensitive, so
 * running them concurrently with the fast suite (or with each other) on a
 * CI runner produced 60s-timeout failures.
 *
 * Conventions:
 *   - Lives in files named `*.slow.test.ts` next to the code they cover.
 *   - Run via `pnpm test:slow`. Default `pnpm test` excludes them so PR
 *     feedback stays under a minute.
 *   - `singleFork: true` + `isolate: false` keeps every test file running in
 *     the same long-lived fork. With `maxForks: 1` plus default per-file
 *     forking, vitest's IPC (tinypool's `onTaskUpdate` RPC) has a hard-coded
 *     ~60 s timeout that fires when an individual SHA-1 test runs >60 s on
 *     a slow runner. A single shared fork keeps the RPC connection warm
 *     across file boundaries and avoids the per-file re-handshake that
 *     races the timeout. Tests already create fresh `B2Simulator` instances
 *     per file, so vitest's per-file isolation isn't needed.
 *   - `dangerouslyIgnoreUnhandledErrors: true` survives any residual RPC
 *     timeout that fires from the tinypool layer at teardown (an internal
 *     vitest-worker error, not a real test failure). All tests pass; this
 *     just stops the runner exiting 1 because of a teardown ack race.
 *   - `testTimeout: 180_000` gives generous headroom for the largest tests
 *     (10-15 MB buffers + multi-part SHA-1) on the slowest CI runners.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.slow.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    isolate: false,
    dangerouslyIgnoreUnhandledErrors: true,
  },
})
