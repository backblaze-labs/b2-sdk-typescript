// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Behavioural tests for the example programs.
 *
 * Each example is spawned as a real Node process against an in-memory
 * B2Simulator that `tests/known-defects/helpers/fetch-simulator-preload.mjs` wires in by
 * replacing `fetch`. Requires `pnpm build` first (the examples import the
 * package by name, which resolves to `dist/`), exactly like examples.yml.
 */

const repoRoot = resolve(import.meta.dirname, '../..')
const preload = join(repoRoot, 'tests/known-defects/helpers/fetch-simulator-preload.mjs')

interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function run(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--import', preload, join(repoRoot, script), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

const exampleCredentials = {
  B2_APPLICATION_KEY_ID: 'example-key',
  B2_APPLICATION_KEY: 'example-secret',
}

beforeAll(() => {
  if (!existsSync(join(repoRoot, 'dist/index.js'))) {
    throw new Error(
      'dist/ is missing: run `pnpm test:known-defects` (it builds first), not bare vitest',
    )
  }
})

describe('node-sync-cli', () => {
  it('exits non-zero when a sync action reports an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c31-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const result = await run('examples/node-sync-cli.ts', [dir, 'sync-bucket'], {
        ...exampleCredentials,
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'sync-bucket' }], failUploads: true }),
      })
      expect(result.stderr).toContain('ERROR')
      expect(result.code, 'the CLI must exit normally rather than terminate by signal').toBeTypeOf(
        'number',
      )
      expect(
        result.code,
        `expected a non-zero exit code, but the CLI exited 0 after reporting errors; stdout tail: ${result.stdout.slice(-200)}`,
      ).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
