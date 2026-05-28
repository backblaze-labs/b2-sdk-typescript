/**
 * Sync a local directory to a B2 bucket.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx tsx examples/node-sync-cli.ts <local-dir> <bucket-name> [prefix]
 *
 * Options via env:
 *   SYNC_MODE=modtime|size|none     (default: modtime)
 *   SYNC_DELETE=true|false           (default: false, no-delete)
 *   SYNC_CONCURRENCY=N              (default: 4)
 *   SYNC_DRY_RUN=true|false         (default: false)
 */

import { B2Client } from '@backblaze-labs/b2-sdk'
import { B2Folder, LocalFolder, synchronize } from '@backblaze-labs/b2-sdk/sync'
import type { CompareMode, KeepMode, SynchronizerUpConfig } from '@backblaze-labs/b2-sdk/sync'

async function main() {
  const localDir = process.argv[2]
  const bucketName = process.argv[3]
  const prefix = process.argv[4] ?? ''

  if (!localDir || !bucketName) {
    console.error('Usage: npx tsx examples/node-sync-cli.ts <local-dir> <bucket-name> [prefix]')
    process.exit(1)
  }

  const keyId = process.env.B2_APPLICATION_KEY_ID
  const key = process.env.B2_APPLICATION_KEY
  if (!keyId || !key) {
    console.error('Set B2_APPLICATION_KEY_ID and B2_APPLICATION_KEY environment variables')
    process.exit(1)
  }

  const client = new B2Client({ applicationKeyId: keyId, applicationKey: key })
  await client.authorize()

  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`Bucket "${bucketName}" not found`)
    process.exit(1)
  }

  const compareMode = (process.env.SYNC_MODE ?? 'modtime') as CompareMode
  const keepMode: KeepMode = process.env.SYNC_DELETE === 'true' ? 'delete' : 'no-delete'
  const concurrency = Number.parseInt(process.env.SYNC_CONCURRENCY ?? '4', 10)
  const dryRun = process.env.SYNC_DRY_RUN === 'true'

  if (dryRun) console.log('DRY RUN: no changes will be made\n')

  const source = new LocalFolder(localDir)
  const dest = new B2Folder(bucket, prefix)

  let uploaded = 0
  let skipped = 0
  let errors = 0

  const config: SynchronizerUpConfig = {
    source,
    dest,
    bucket,
    prefix,
    options: {
      compareMode,
      keepMode,
      concurrency,
      dryRun,
    },
  }
  for await (const event of synchronize(config)) {
    switch (event.type) {
      case 'upload-start':
        console.log(`  uploading ${event.path} (${event.size} bytes)`)
        break
      case 'upload-done':
        uploaded++
        break
      case 'skip':
        skipped++
        break
      case 'error':
        errors++
        console.error(`  ERROR: ${event.path}: ${event.message}`)
        break
      case 'compare':
        break
      default:
        console.log(`  ${event.type}: ${event.path}`)
    }
  }

  console.log(`\nDone. Uploaded: ${uploaded}, Skipped: ${skipped}, Errors: ${errors}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
