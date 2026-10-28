// Run the pinned changie devDependency through Node, so release and check scripts
// do not depend on how `pnpm` itself is installed or on a shell.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function launcherPath() {
  const require = createRequire(join(repoRoot, 'package.json'))
  const pkgPath = require.resolve('changie/package.json')
  const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.changie)
}

/**
 * Run changie with `args` from the repo root.
 *
 * @param {string[]} args - changie arguments.
 * @param {{ capture?: boolean }} [options] - capture stdout instead of inheriting it.
 * @returns {{ status: number, stdout: string, stderr: string }} the process result.
 */
export function runChangie(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [launcherPath(), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
