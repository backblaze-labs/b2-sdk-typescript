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
 *   - `maxForks: 1` guarantees no CPU contention between heavy tests — the
 *     simulator's per-part SHA-1 dominates wall clock, and two parallel forks
 *     hashing simultaneously slow each other down enough to push individual
 *     tests over the timeout budget.
 *   - `testTimeout: 180_000` gives generous headroom for the largest tests
 *     (10-15 MB buffers + multi-part SHA-1) on the slowest CI runners.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.slow.test.ts'],
    testTimeout: 180_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
  },
})
