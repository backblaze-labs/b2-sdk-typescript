/**
 * Runs the documented cookbook examples against a real Backblaze B2 account
 * end-to-end. Each example is `spawn`-ed exactly as a user would invoke it
 * from the README, so a renamed flag or swapped arg order fails CI.
 *
 * Driven by the `real-examples` job in `.github/workflows/integration.yml`.
 *
 * Required env:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 *
 * Creates a fresh `sdk-rex-n<major>-<run>-<attempt>-<timestamp>` bucket,
 * runs the examples against it, and tears down on success OR failure. A
 * defensive age-gated sweep at startup removes stale real-example buckets
 * from previously crashed runs without touching buckets from live runs.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { BadBucketIdError } from '../../src/errors/index.ts'
import type { Bucket } from '../../src/index.ts'
import { B2Client } from '../../src/index.ts'

const NODE_MAJOR = (process.versions.node ?? '').split('.')[0] ?? 'unknown'
const currentBucketPrefix = 'sdk-rex-'
const legacyBucketPrefix = 'sdk-examples-'
// Keep above the workflow's 60-minute job timeout so overlapping startup
// sweeps cannot delete another live run's active bucket.
const staleBucketAgeMs = 2 * 60 * 60 * 1000

function makeBucketName(): string {
  const runId = process.env.GITHUB_RUN_ID
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'
  const now = Date.now()
  const node = `n${NODE_MAJOR}`
  if (runId !== undefined && runId !== '') {
    return `${currentBucketPrefix}${node}-${runId}-${runAttempt}-${now}`
  }
  return `${currentBucketPrefix}${node}-${now}`
}

function isRealExampleBucketName(name: string): boolean {
  return name.startsWith(currentBucketPrefix) || name.startsWith(legacyBucketPrefix)
}

function bucketTimestamp(name: string): number | null {
  const matches = [...name.matchAll(/\d{13}/g)]
  const last = matches.at(-1)?.[0]
  if (last === undefined) return null
  const timestamp = Number(last)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

function isStaleRealExampleBucket(name: string, now = Date.now()): boolean {
  if (!isRealExampleBucketName(name)) return false
  const createdAt = bucketTimestamp(name)
  return createdAt !== null && now - createdAt > staleBucketAgeMs
}

function isUnparseableRealExampleBucket(name: string): boolean {
  return isRealExampleBucketName(name) && bucketTimestamp(name) === null
}

/**
 * Run a child process inheriting stdout/stderr. Resolves on exit code 0,
 * rejects otherwise. Used to invoke each example.
 *
 * @param argv - Command and arguments (e.g. `['npx', 'tsx', 'examples/...']`).
 * @param env - Environment for the child process.
 *
 * @returns A promise that resolves when the child exits cleanly.
 */
async function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runOnce(argv, env)
      return
    } catch (err) {
      if (attempt === maxAttempts) throw err
      console.warn(
        `${argv.join(' ')} failed on attempt ${attempt}/${maxAttempts}; retrying in ${attempt}s`,
      )
      await sleep(attempt * 1_000)
    }
  }
}

function runOnce(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [cmd, ...args] = argv
    if (!cmd) {
      reject(new Error('empty argv'))
      return
    }
    console.log(`\n$ ${argv.join(' ')}`)
    const child = spawn(cmd, args, { stdio: 'inherit', env })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${argv.join(' ')} exited with code ${code}`)),
    )
  })
}

async function emptyAndDeleteBucket(b: Bucket): Promise<void> {
  for await (const file of b.paginateFileNames()) {
    await b.deleteFileVersion(file.fileName, file.fileId)
  }
  // Listing all files returns only the latest version; clean up the rest too.
  const versions = await b.listFileVersions()
  for (const fv of versions.files) {
    await b.deleteFileVersion(fv.fileName, fv.fileId)
  }
  await b.delete()
}

async function deleteBucketIfPresent(bucket: Bucket): Promise<void> {
  try {
    await emptyAndDeleteBucket(bucket)
  } catch (err) {
    if (err instanceof BadBucketIdError) return
    throw err
  }
}

async function waitForBucketVisible(client: B2Client, bucketName: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const bucket = await client.getBucket(bucketName)
    if (bucket !== null) return
    await sleep(1_000)
  }
  throw new Error(`Bucket "${bucketName}" was not visible after creation`)
}

async function main(): Promise<void> {
  const keyId = process.env['B2_APPLICATION_KEY_ID']
  const appKey = process.env['B2_APPLICATION_KEY']
  if (!keyId || !appKey) {
    console.error('B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required')
    process.exit(2)
  }
  const bucketName = makeBucketName()

  const client = new B2Client({ applicationKeyId: keyId, applicationKey: appKey })
  await client.authorize()

  // Sweep only stale buckets from crashed runs. Other branches and older
  // workflow attempts may still be using the same B2 account concurrently.
  for (const b of await client.listBuckets()) {
    if (!isStaleRealExampleBucket(b.name)) {
      if (isUnparseableRealExampleBucket(b.name)) {
        console.warn(`skipping example bucket with unparseable timestamp: ${b.name}`)
      }
      continue
    }
    try {
      await deleteBucketIfPresent(b)
    } catch (err) {
      console.warn(`could not clean up stale bucket ${b.name}: ${String(err)}`)
    }
  }

  const bucket = await client.createBucket({ bucketName, bucketType: 'allPrivate' })
  await waitForBucketVisible(client, bucket.name)
  const workDir = await mkdtemp(join(tmpdir(), 'sdk-examples-'))

  console.log(`\nUsing bucket: ${bucket.name}`)
  console.log(`Working dir:  ${workDir}\n`)

  try {
    // Fixtures.
    const samplePath = join(workDir, 'sample.txt')
    const sampleBody = `hello from real-examples CI on Node ${process.versions.node}\n`
    await writeFile(samplePath, sampleBody)

    const backupSrc = join(workDir, 'backup-src')
    await mkdir(backupSrc)
    await writeFile(join(backupSrc, 'a.txt'), 'alpha\n')
    await writeFile(join(backupSrc, 'b.txt'), 'beta\n')
    await mkdir(join(backupSrc, 'nested'))
    await writeFile(join(backupSrc, 'nested', 'c.txt'), 'gamma\n')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      B2_APPLICATION_KEY_ID: keyId,
      B2_APPLICATION_KEY: appKey,
      B2_BACKUP_PASSPHRASE: `real-examples-${Date.now()}`,
    }

    // 1. List buckets (read-only).
    await run(['npx', 'tsx', 'examples/node-list-buckets.ts'], env)

    // 2. Upload a single file.
    await run(['npx', 'tsx', 'examples/node-upload.ts', bucket.name, samplePath], env)

    // 3. Download it back and verify the round-trip.
    const downloadPath = join(workDir, 'downloaded.txt')
    await run(
      ['npx', 'tsx', 'examples/node-download.ts', bucket.name, 'sample.txt', downloadPath],
      env,
    )
    const downloaded = await readFile(downloadPath, 'utf8')
    if (downloaded !== sampleBody) {
      throw new Error(
        `node-download round-trip mismatch.\nExpected: ${JSON.stringify(sampleBody)}\nActual:   ${JSON.stringify(downloaded)}`,
      )
    }

    // 4. Upload with a progress bar (proves the SDK's onProgress wiring works
    //    against real B2; the bar will spin to 100% near-instantly for a tiny
    //    file but the assertion is "the script exits 0", not the bar shape).
    await run(['npx', 'tsx', 'examples/node-with-progress.ts', bucket.name, samplePath], env)

    // 5. Encrypted backup snapshot.
    await run(
      [
        'npx',
        'tsx',
        'examples/node-backup-cli/backup.ts',
        'snapshot',
        backupSrc,
        `b2://${bucket.name}/backups`,
      ],
      env,
    )

    // 6. Restore the snapshot into a fresh directory and verify the contents
    //    decrypt and match. (Restore on a fresh machine = different process,
    //    no local manifest, must download the remote manifest first. That's
    //    the path most likely to silently regress.)
    const restoreDir = join(workDir, 'restored')
    await run(
      [
        'npx',
        'tsx',
        'examples/node-backup-cli/backup.ts',
        'restore',
        `b2://${bucket.name}/backups`,
        restoreDir,
      ],
      env,
    )
    for (const [rel, want] of [
      ['a.txt', 'alpha\n'],
      ['b.txt', 'beta\n'],
      ['nested/c.txt', 'gamma\n'],
    ] as const) {
      const got = await readFile(join(restoreDir, rel), 'utf8')
      if (got !== want) {
        throw new Error(
          `backup-cli round-trip mismatch for ${rel}.\nExpected: ${JSON.stringify(want)}\nActual:   ${JSON.stringify(got)}`,
        )
      }
    }

    console.log('\n✓ All 6 examples completed against real B2; round-trips verified.\n')
  } finally {
    console.log(`\nTearing down bucket ${bucket.name}...`)
    try {
      await deleteBucketIfPresent(bucket)
    } catch (err) {
      console.error(`teardown failed: ${String(err)}`)
    }
    try {
      await rm(workDir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`could not clean up ${workDir}: ${String(err)}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
