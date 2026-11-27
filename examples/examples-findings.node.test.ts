import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resetRemoteSimulator } from '../src/test-utils/remote-simulator.ts'
import { deriveKek, encryptFile, saltFromString } from './node-backup-cli/crypto.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const preload = pathToFileURL(
  join(repoRoot, 'tests/known-defects/helpers/fetch-simulator-preload.mjs'),
).href

interface RunResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

async function run(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
  preloadModule = preload,
): Promise<RunResult> {
  // Each example process starts from an empty simulator, as it did when the
  // preload built an in-memory one.
  const sim = await resetRemoteSimulator()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', preloadModule, join(repoRoot, script), ...args],
      {
        cwd: repoRoot,
        env: {
          PATH: process.env['PATH'] ?? '',
          TSX_TSCONFIG_PATH: join(repoRoot, 'examples/tsconfig.json'),
          EXAMPLE_SIM_SOURCE: '1',
          B2SIM_API_URL: sim.realm,
          B2SIM_CONTROL_URL: sim.controlUrl,
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

async function encryptedSeed(name: string, salt: string, plaintext = 'alpha') {
  const kek = await deriveKek('pass', saltFromString(salt))
  const { ciphertext, wrapped } = await encryptFile(new TextEncoder().encode(plaintext), kek)
  return {
    name,
    base64: Buffer.from(ciphertext).toString('base64'),
    fileInfo: {
      b2backup_dek: wrapped.wrappedDek,
      b2backup_wrap_iv: wrapped.wrapIv,
      b2backup_iv: wrapped.fileIv,
    },
  }
}

const exampleCredentials = {
  B2_APPLICATION_KEY_ID: 'example-key',
  B2_APPLICATION_KEY: 'example-secret',
}

describe('node-backup-cli', () => {
  it('rejects restore manifest paths that escape the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c28-'))
    try {
      const dest = join(root, 'restore')
      const salt = 'AAECAwQFBgcICQoLDA0ODw'
      const entry = { path: '../outside.txt', size: 5, mtime: '2020-01-01T00:00:00Z', sha1: 'test' }
      const manifest = {
        version: 1,
        salt,
        updatedAt: entry.mtime,
        files: { '../outside.txt': entry },
      }
      const result = await run(
        'examples/node-backup-cli/backup.ts',
        ['restore', 'b2://dest-bucket/one', dest],
        {
          ...exampleCredentials,
          B2_BACKUP_PASSPHRASE: 'pass',
          EXAMPLE_SIM_SEED: JSON.stringify({
            buckets: [
              {
                name: 'dest-bucket',
                files: [
                  { name: 'one/.b2-backup.json', text: JSON.stringify(manifest) },
                  await encryptedSeed('outside.txt', salt),
                ],
              },
            ],
          }),
        },
      )
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/outside|escape|invalid.*path/i)
      await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('passes the preload to Node as a file URL', () => {
    expect(new URL(preload).protocol).toBe('file:')
  })

  it('keeps a local backup when its API endpoint changes and the remote lookup is forbidden', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-api-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
      }
      const uri = 'b2://dest-bucket/one'
      const first = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], env)
      expect(first.code, first.stderr).toBe(0)
      const path = join(dir, '.b2-backup.json')
      const before = JSON.parse(await readFile(path, 'utf8')) as { salt: string; files: unknown }
      const second = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], {
        ...env,
        EXAMPLE_SIM_API_URL: 'https://api001.backblazeb2.com',
        EXAMPLE_SIM_MANIFEST_FAILURE: '1',
      })
      expect(second.code, second.stderr).toBe(0)
      expect(second.stdout).toContain('plan: 0 to upload')
      const after = JSON.parse(await readFile(path, 'utf8')) as {
        salt: string
        files: unknown
        destination: object
      }
      expect(after.salt).toBe(before.salt)
      expect(after.files).toEqual(before.files)
      expect(after.destination).not.toHaveProperty('apiUrl')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each(['matching', 'different'] as const)(
    'preserves a %s destination remote manifest on a fresh local folder',
    async (identity) => {
      const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-remote-identity-'))
      const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
      try {
        await writeFile(join(dir, 'a.txt'), 'alpha')
        const env = {
          ...exampleCredentials,
          B2_BACKUP_PASSPHRASE: 'pass',
          EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
        }
        const uri = 'b2://dest-bucket/one'
        const first = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], env)
        expect(first.code, first.stderr).toBe(0)
        const path = join(dir, '.b2-backup.json')
        const remote = JSON.parse(await readFile(path, 'utf8')) as {
          destination: { bucketId: string; prefix: string; apiUrl?: string }
          salt: string
          files: unknown
        }
        if (identity === 'different') remote.destination.bucketId = 'other-bucket-id'
        await rm(path)
        const trace = join(traceDir, 'remote.jsonl')
        const second = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], {
          ...env,
          EXAMPLE_SIM_SEED: JSON.stringify({
            buckets: [
              {
                name: 'dest-bucket',
                files: [
                  { name: 'one/.b2-backup.json', text: JSON.stringify(remote) },
                  await encryptedSeed('one/a.txt', remote.salt),
                ],
              },
            ],
          }),
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        })
        expect(second.code, second.stderr).toBe(0)
        expect(second.stdout).toContain('plan: 0 to upload')
        expect(await readUploadTrace(trace)).not.toContainEqual({
          fileName: 'one/a.txt',
          status: 200,
        })
        const after = JSON.parse(await readFile(path, 'utf8')) as typeof remote
        expect(after.salt).toBe(remote.salt)
        expect(after.files).toEqual(remote.files)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(traceDir, { recursive: true, force: true })
      }
    },
  )

  it.each(['legacy', 'different'] as const)(
    'uploads missing objects when a %s remote manifest is present',
    async (identity) => {
      const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-missing-'))
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
        const remote = JSON.parse(await readFile(path, 'utf8')) as {
          destination?: object
          salt: string
        }
        if (identity === 'legacy') delete remote.destination
        await rm(path)
        const trace = join(traceDir, 'missing.jsonl')
        const second = await run(
          'examples/node-backup-cli/backup.ts',
          ['snapshot', dir, 'b2://dest-bucket/two'],
          {
            ...env,
            EXAMPLE_SIM_SEED: JSON.stringify({
              buckets: [
                {
                  name: 'dest-bucket',
                  files: [{ name: 'two/.b2-backup.json', text: JSON.stringify(remote) }],
                },
              ],
            }),
            EXAMPLE_SIM_UPLOAD_TRACE: trace,
          },
        )
        expect(second.code, second.stderr).toBe(0)
        expect(second.stdout).toContain('plan: 1 to upload')
        expect(await readUploadTrace(trace)).toContainEqual({ fileName: 'two/a.txt', status: 200 })
        const after = JSON.parse(await readFile(path, 'utf8')) as { salt: string }
        expect(after.salt).toBe(remote.salt)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(traceDir, { recursive: true, force: true })
      }
    },
  )

  it('rejects an unreadable copied remote object without overwriting the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-invalid-'))
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
      const trace = join(traceDir, 'invalid.jsonl')
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
                  { name: 'two/.b2-backup.json', text: before },
                  { name: 'two/a.txt', text: 'not encrypted' },
                ],
              },
            ],
          }),
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code).not.toBe(0)
      expect(second.stderr).toContain('missing wrapped-key')
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(await readUploadTrace(trace)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('rejects a copied manifest whose entry path differs from its map key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-key-path-'))
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
      const remote = JSON.parse(before) as { salt: string; files: Record<string, { path: string }> }
      const entry = remote.files['a.txt']
      if (!entry) throw new Error('missing fixture entry')
      entry.path = 'b.txt'
      const trace = join(traceDir, 'invalid.jsonl')
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
                  await encryptedSeed('two/b.txt', remote.salt),
                ],
              },
            ],
          }),
          EXAMPLE_SIM_UPLOAD_TRACE: trace,
        },
      )
      expect(second.code).not.toBe(0)
      expect(second.stderr).toMatch(/manifest.*(?:key|path)/i)
      expect(await readFile(path, 'utf8')).toBe(before)
      expect(await readUploadTrace(trace)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('resumes a legacy backup when the remote object is newer than its manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-stale-'))
    const traceDir = await mkdtemp(join(tmpdir(), 'b2sdk-c27-trace-'))
    try {
      await writeFile(join(dir, 'a.txt'), 'alpha')
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        EXAMPLE_SIM_SEED: JSON.stringify({ buckets: [{ name: 'dest-bucket' }] }),
      }
      const uri = 'b2://dest-bucket/one'
      const first = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], env)
      expect(first.code, first.stderr).toBe(0)
      const path = join(dir, '.b2-backup.json')
      const legacy = JSON.parse(await readFile(path, 'utf8')) as {
        destination?: object
        salt: string
        files: Record<string, { sha1: string }>
      }
      delete legacy.destination
      await writeFile(path, JSON.stringify(legacy))
      await writeFile(join(dir, 'a.txt'), 'bravo')
      const trace = join(traceDir, 'resumed.jsonl')
      const second = await run('examples/node-backup-cli/backup.ts', ['snapshot', dir, uri], {
        ...env,
        EXAMPLE_SIM_SEED: JSON.stringify({
          buckets: [
            {
              name: 'dest-bucket',
              files: [
                { name: 'one/.b2-backup.json', text: JSON.stringify(legacy) },
                await encryptedSeed('one/a.txt', legacy.salt, 'bravo'),
              ],
            },
          ],
        }),
        EXAMPLE_SIM_UPLOAD_TRACE: trace,
      })
      expect(second.code, second.stderr).toBe(0)
      expect(second.stdout).toContain('plan: 1 to upload')
      expect(await readUploadTrace(trace)).toContainEqual({ fileName: 'one/a.txt', status: 200 })
      const after = JSON.parse(await readFile(path, 'utf8')) as typeof legacy
      expect(after.salt).toBe(legacy.salt)
      expect(after.files['a.txt']?.sha1).toBe(createHash('sha1').update('bravo').digest('hex'))
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(traceDir, { recursive: true, force: true })
    }
  })

  it('preserves both encrypted files across destination switches and API changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c27-roundtrip-'))
    try {
      const dir = join(root, 'source')
      const restored = join(root, 'restored')
      await mkdir(dir)
      await writeFile(join(dir, 'a.txt'), 'alpha')
      await writeFile(join(dir, 'b.txt'), 'bravo')
      await utimes(join(dir, 'a.txt'), 1_600_000_000, 1_600_000_000)
      await utimes(join(dir, 'b.txt'), 1_700_000_000, 1_700_000_000)
      const env = {
        ...exampleCredentials,
        B2_BACKUP_PASSPHRASE: 'pass',
        REVIEW_STATE: join(root, 'state.json'),
      }
      const persistentPreload = pathToFileURL(
        join(repoRoot, 'examples/_smoke/backup-state-preload.mjs'),
      ).href
      const invoke = (args: string[], extra: Record<string, string> = {}) =>
        run('examples/node-backup-cli/backup.ts', args, { ...env, ...extra }, persistentPreload)
      const first = await invoke(['snapshot', dir, 'b2://review-bucket/one'])
      expect(first.code, first.stderr).toBe(0)
      const second = await invoke(['snapshot', dir, 'b2://review-bucket/two'])
      expect(second.code, second.stderr).toBe(0)
      // Model a remote manifest copied from another bucket while keeping its encrypted objects.
      const statePath = join(root, 'state.json')
      const storedObjects = JSON.parse(await readFile(statePath, 'utf8')) as {
        name: string
        base64: string
      }[]
      const remoteManifest = storedObjects.find((object) => object.name === 'one/.b2-backup.json')
      expect(remoteManifest).toBeDefined()
      if (!remoteManifest) throw new Error('missing remote manifest')
      const movedManifest = JSON.parse(Buffer.from(remoteManifest.base64, 'base64').toString()) as {
        destination: { bucketId: string }
      }
      movedManifest.destination.bucketId = 'copied-from-another-bucket'
      remoteManifest.base64 = Buffer.from(JSON.stringify(movedManifest)).toString('base64')
      await writeFile(statePath, JSON.stringify(storedObjects))
      const back = await invoke(['snapshot', dir, 'b2://review-bucket/one'])
      expect(back.code, back.stderr).toBe(0)
      expect(back.stdout).toContain('plan: 0 to upload')
      const rotated = await invoke(
        ['snapshot', dir, 'b2://review-bucket/one', '--since', '2023-01-01'],
        { REVIEW_API_HOST: 'https://api001.backblazeb2.com' },
      )
      expect(rotated.code, rotated.stderr).toBe(0)
      expect(rotated.stdout).toContain('plan: 0 to upload')
      const manifest = JSON.parse(await readFile(join(dir, '.b2-backup.json'), 'utf8')) as {
        files: Record<string, unknown>
      }
      expect(Object.keys(manifest.files).sort()).toEqual(['a.txt', 'b.txt'])
      const restore = await invoke(['restore', 'b2://review-bucket/one', restored], {
        REVIEW_API_HOST: 'https://api001.backblazeb2.com',
      })
      expect(restore.code, restore.stderr).toBe(0)
      expect(await readFile(join(restored, 'a.txt'), 'utf8')).toBe('alpha')
      expect(await readFile(join(restored, 'b.txt'), 'utf8')).toBe('bravo')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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
                  await encryptedSeed('two/a.txt', String(remote['salt'])),
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
