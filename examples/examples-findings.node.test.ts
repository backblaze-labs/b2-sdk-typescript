import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
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
    child.stdout.on('data', (data) => {
      stdout += String(data)
    })
    child.stderr.on('data', (data) => {
      stderr += String(data)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Reads the upload trace the preload wrote: one `{ fileName, status }` per b2_upload_file request. */
async function readUploadTrace(path: string): Promise<{ fileName: string; status: number }[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { fileName: string; status: number })
}

const exampleCredentials = {
  B2_APPLICATION_KEY_ID: 'example-key',
  B2_APPLICATION_KEY: 'example-secret',
}

describe('node-backup-cli', () => {
  it('Finding C27: snapshot to a different destination uploads the files instead of trusting the local manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-'))
    // Traces live outside the snapshotted directory so they are never backed up themselves.
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
      }
      const firstTrace = join(traceDir, 'first-uploads.jsonl')
      const secondTrace = join(traceDir, 'second-uploads.jsonl')
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        { ...env, EXAMPLE_SIM_UPLOAD_TRACE: firstTrace },
      )
      expect(first.code, first.stderr).toBe(0)
      expect(first.stdout).toContain('plan: 1 to upload')
      // Control: the trace records the first snapshot's real upload.
      expect(await readUploadTrace(firstTrace)).toContainEqual({
        fileName: 'one/a.txt',
        status: 200,
      })

      // Different destination (a fresh, empty simulator and a different prefix).
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/two'],
        { ...env, EXAMPLE_SIM_UPLOAD_TRACE: secondTrace },
      )
      expect(second.code, second.stderr).toBe(0)
      expect(
        second.stdout,
        'second destination is empty; the file must be planned for upload',
      ).toContain('plan: 1 to upload')
      // Planning is not enough: the file must actually reach the second destination.
      const secondUploads = await readUploadTrace(secondTrace)
      expect(
        secondUploads,
        `the second snapshot planned an upload but never uploaded two/a.txt; uploads: ${JSON.stringify(secondUploads)}`,
      ).toContainEqual({ fileName: 'two/a.txt', status: 200 })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })
  it('uploads to a different bucket even when the prefix is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-bucket-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({
          buckets: [{ name: 'first-bucket' }, { name: 'second-bucket' }],
        }),
      }
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://first-bucket/backup'],
        env,
      )
      expect(first.code, first.stderr).toBe(0)
      const trace = join(traceDir, 'bucket.jsonl')
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://second-bucket/backup'],
        {
          ...env,
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code, second.stderr).toBe(0)
      expect(await readUploadTrace(trace)).toContainEqual({ fileName: 'backup/a.txt', status: 200 })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('uploads when a legacy local manifest has no destination identity', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-legacy-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
      }
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        env,
      )
      expect(first.code, first.stderr).toBe(0)
      const path = join(dir, '.b2-backup.json')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      delete manifest['destination']
      await writeFile(path, JSON.stringify(manifest))
      const trace = join(traceDir, 'legacy.jsonl')
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        {
          ...env,
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code, second.stderr).toBe(0)
      expect(await readUploadTrace(trace)).toContainEqual({ fileName: 'one/a.txt', status: 200 })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('resumes the same destination without uploading an unchanged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-resume-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = { ...exampleCredentials, B2_BACKUP_PASSPHRASE: 'pass' }
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        {
          ...env,
          EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
        },
      )
      expect(first.code, first.stderr).toBe(0)
      const trace = join(traceDir, 'resume.jsonl')
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        {
          ...env,
          EXAMPLE_SIM_SEED: JSON.stringify({
            buckets: [
              { name: 'dest-bucket', files: [{ name: 'one/a.txt', text: 'existing backup' }] },
            ],
          }),
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code, second.stderr).toBe(0)
      expect(second.stdout).toContain('plan: 0 to upload')
      expect(await readUploadTrace(trace)).not.toContainEqual({
        fileName: 'one/a.txt',
        status: 200,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('loads the other destination remote manifest and its salt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-remote-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = { ...exampleCredentials, B2_BACKUP_PASSPHRASE: 'pass' }
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        {
          ...env,
          EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
        },
      )
      expect(first.code, first.stderr).toBe(0)
      const path = join(dir, '.b2-backup.json')
      const remote = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      delete remote['destination']
      const local = { ...remote, salt: 'AAAAAAAAAAAAAAAAAAAAAA', files: {} }
      await writeFile(path, JSON.stringify(local))
      const trace = join(traceDir, 'remote.jsonl')
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/two'],
        {
          ...env,
          EXAMPLE_SIM_SEED: JSON.stringify({
            buckets: [
              {
                name: 'dest-bucket',
                files: [
                  { name: 'two/.b2-backup.json', text: JSON.stringify(remote) },
                  { name: 'two/a.txt', text: 'existing backup' },
                ],
              },
            ],
          }),
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code, second.stderr).toBe(0)
      expect(second.stdout).toContain('plan: 0 to upload')
      expect(await readUploadTrace(trace)).not.toContainEqual({
        fileName: 'two/a.txt',
        status: 200,
      })
      const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      expect(stored['salt']).toBe(remote['salt'])
      expect(stored['files']).toEqual(remote['files'])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('does not overwrite the local manifest when remote manifest lookup fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-failure-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
      }
      const first = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/one'],
        env,
      )
      expect(first.code, first.stderr).toBe(0)
      const path = join(dir, '.b2-backup.json')
      const before = await readFile(path, 'utf8')
      const trace = join(traceDir, 'failure.jsonl')
      const second = await run(
        'examples/node-backup-cli/backup.ts',
        ['snapshot', dir, 'b2://dest-bucket/two'],
        {
          ...env,
          EXAMPLE_SIM_MANIFEST_FAILURE: '1',
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code).not.toBe(0)
      expect(second.stderr).toContain('manifest access denied')
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(await readUploadTrace(trace)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })
})
