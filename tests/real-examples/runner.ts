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
 * Creates a fresh `sdk-examples-node<major>-<timestamp>` bucket, runs the
 * examples against it, and tears down on success OR failure. A defensive
 * sweep at startup removes any `sdk-examples-*` bucket from previously
 * crashed runs (safe because the workflow serializes matrix entries with
 * max-parallel: 1).
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { B2Client } from '../../src/index.ts'
import type { Bucket } from '../../src/index.ts'

const NODE_MAJOR = (process.versions.node ?? '').split('.')[0] ?? 'unknown'
const BUCKET_PREFIX = `sdk-examples-node${NODE_MAJOR}-`

/**
 * Run a child process inheriting stdout/stderr. Resolves on exit code 0,
 * rejects otherwise. Used to invoke each example.
 *
 * @param argv - Command and arguments (e.g. `['npx', 'tsx', 'examples/...']`).
 * @param env - Environment for the child process.
 *
 * @returns A promise that resolves when the child exits cleanly.
 */
function run(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
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

async function main(): Promise<void> {
  const keyId = process.env['B2_APPLICATION_KEY_ID']
  const appKey = process.env['B2_APPLICATION_KEY']
  if (!keyId || !appKey) {
    console.error('B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY are required')
    process.exit(2)
  }
  const bucketName = `${BUCKET_PREFIX}${Date.now()}`

  const client = new B2Client({ applicationKeyId: keyId, applicationKey: appKey })
  await client.authorize()

  // Sweep leftover sdk-examples-* buckets from any previously-crashed run.
  // Safe with max-parallel: 1 in the workflow.
  for (const b of await client.listBuckets()) {
    if (!b.name.startsWith('sdk-examples-')) continue
    try {
      await emptyAndDeleteBucket(b)
    } catch (err) {
      console.warn(`could not clean up stale bucket ${b.name}: ${String(err)}`)
    }
  }

  const bucket = await client.createBucket({ bucketName, bucketType: 'allPrivate' })
  const workDir = await mkdtemp(join(tmpdir(), 'sdk-examples-'))

  console.log(`\nUsing bucket: ${bucketName}`)
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
    await run(['npx', 'tsx', 'examples/node-upload.ts', bucketName, samplePath], env)

    // 3. Download it back and verify the round-trip.
    const downloadPath = join(workDir, 'downloaded.txt')
    await run(
      ['npx', 'tsx', 'examples/node-download.ts', bucketName, 'sample.txt', downloadPath],
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
    await run(['npx', 'tsx', 'examples/node-with-progress.ts', bucketName, samplePath], env)

    // 5. Encrypted backup snapshot.
    await run(
      [
        'npx',
        'tsx',
        'examples/node-backup-cli/backup.ts',
        'snapshot',
        backupSrc,
        `b2://${bucketName}/backups`,
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
        `b2://${bucketName}/backups`,
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
    console.log(`\nTearing down bucket ${bucketName}...`)
    try {
      await emptyAndDeleteBucket(bucket)
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
