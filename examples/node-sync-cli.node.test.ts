import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')
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
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', preload, join(repoRoot, script), ...args],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env['PATH'] ?? '',
          TSX_TSCONFIG_PATH: join(repoRoot, 'examples/tsconfig.json'),
          EXAMPLE_SIM_SOURCE: '1',
          ...env,
        },
      },
    )
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

describe('node-sync-cli', () => {
  it('exits zero when all sync actions succeed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c31-success-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const result = await run('examples/node-sync-cli.ts', [dir, 'sync-bucket'], {
        ...exampleCredentials,
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'sync-bucket' }] }),
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('Errors: 0')
      expect(result.stderr).not.toContain('ERROR')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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
