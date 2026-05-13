import { defineConfig } from 'vitest/config'

/**
 * Vitest browser-mode configuration.
 *
 * Runs the test suite (minus `*.node.test.ts` files) inside real Chromium,
 * Firefox, and WebKit instances via Playwright. Files ending in
 * `*.node.test.ts` test Node-only APIs (fs, os, path, util.inspect, OS
 * keychain, etc.) and are skipped in browser mode.
 *
 * Run with: `pnpm test:browser`.
 *
 * Note: requires Playwright browser binaries. After `pnpm install`, run
 * `pnpm exec playwright install chromium firefox webkit` once locally; CI
 * caches them between runs.
 *
 * Set `VITEST_BROWSER_INSTANCE=chromium|firefox|webkit` to restrict the run
 * to a single engine (used by the CI matrix to parallelize per browser).
 */
type Engine = 'chromium' | 'firefox' | 'webkit'
const ALL_ENGINES: Engine[] = ['chromium', 'firefox', 'webkit']
const selected = process.env['VITEST_BROWSER_INSTANCE']?.toLowerCase() as Engine | undefined
const engines: Engine[] =
  selected && (ALL_ENGINES as string[]).includes(selected) ? [selected] : ALL_ENGINES

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.node.test.ts', 'node_modules/**'],
    // Browser mode picks up `*.slow.test.ts` too — those are multipart
    // round-trips through the simulator's per-part SHA-1. The Node slow
    // tier owns `vitest.slow.config.ts`, but browser mode uses this single
    // config, so we widen the timeout here. Browsers also need more wall
    // clock than Node for the same SHA-1 work: WebCrypto's `subtle.digest`
    // dispatches each part to a worker thread, and the harness adds
    // round-trip overhead between the page and the test runner.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    browser: {
      enabled: true,
      provider: 'playwright',
      // Headless in CI; toggle via VITEST_BROWSER_HEADLESS=false for local debugging.
      headless: process.env['VITEST_BROWSER_HEADLESS'] !== 'false',
      instances: engines.map((browser) => ({ browser })),
    },
  },
})
