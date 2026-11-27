// The standalone b2-simulator the SDK's tests run against, and where a test
// process finds it. One pinned commit, fetched once into a gitignored cache
// (`pnpm run simulator:fetch`), or a local checkout named by B2SIM_DIR.
// See CONTRIBUTING.md, "Tests against the standalone simulator".
//
// Run as a script (`node scripts/b2-simulator/pin.mjs`) it prints the pinned
// commit; CI checks out that commit.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The pinned simulator. Bump `commit` (a full 40-hex SHA) to move the pin; the
 * fetch script refuses a checkout whose HEAD is not exactly this commit.
 */
export const SIMULATOR_PIN = Object.freeze({
  repository: 'https://github.com/backblaze-labs/b2-simulator.git',
  // b2-simulator v0.6.0 (Partner capability lists in POST /reset config).
  commit: '4052c6f8f45350486460d19bc796866cbdcdd3bc',
})

const SERVE = join('bin', 'simulator', 'serve.mjs')

/**
 * Directory the pinned commit is fetched into.
 *
 * @param {string} repoRoot - The SDK checkout's root directory.
 * @returns {string} The cache directory for the pinned commit.
 */
export function pinnedCacheDir(repoRoot) {
  return join(repoRoot, 'node_modules', '.cache', 'b2-simulator', SIMULATOR_PIN.commit)
}

/**
 * Path of the simulator's serve.mjs: under B2SIM_DIR when that is set (a
 * local b2-simulator checkout; nothing is fetched or checked), otherwise in
 * the pinned cache.
 *
 * @param {{ repoRoot: string, env: Record<string, string | undefined> }} options
 * @returns {string} Absolute path of serve.mjs.
 * @throws {Error} When the chosen location holds no serve.mjs.
 */
export function resolveServeScript({ repoRoot, env }) {
  const override = env.B2SIM_DIR?.trim()
  if (override) {
    const serve = join(override, SERVE)
    if (!existsSync(serve)) {
      throw new Error(
        `B2SIM_DIR is ${override}, but ${serve} does not exist; point B2SIM_DIR at a b2-simulator checkout (it must contain bin/simulator/serve.mjs) or unset it to use the pinned commit`,
      )
    }
    return serve
  }
  const serve = join(pinnedCacheDir(repoRoot), SERVE)
  if (!existsSync(serve)) {
    throw new Error(
      `the pinned b2-simulator (${SIMULATOR_PIN.commit.slice(0, 7)}) is not in ${pinnedCacheDir(repoRoot)}; run \`pnpm run simulator:fetch\` once, or set B2SIM_DIR to a local b2-simulator checkout`,
    )
  }
  return serve
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(SIMULATOR_PIN.commit)
}
