/**
 * Upload a file to Backblaze B2 from Node.js.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy npx tsx examples/node-upload.ts <bucket-name> <local-file-path>
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { BufferSource } from '@backblaze-labs/b2-sdk/streams'
import { setupClient } from './_smoke/cli.ts'

async function main() {
  const bucketName = process.argv[2]
  const filePath = process.argv[3]

  if (!bucketName || !filePath) {
    console.error('Usage: npx tsx examples/node-upload.ts <bucket-name> <local-file-path>')
    process.exit(1)
  }

  const client = await setupClient()
  console.log(`Authorized as ${client.accountInfo.getAccountId()}`)

  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`Bucket "${bucketName}" not found`)
    process.exit(1)
  }

  const data = await readFile(filePath)
  const fileName = basename(filePath)
  const source = new BufferSource(new Uint8Array(data))

  console.log(`Uploading ${fileName} (${data.byteLength} bytes) to ${bucketName}...`)

  const file = await bucket.upload({
    fileName,
    source,
    onProgress: (progress) => {
      if (progress.totalBytes === null) return
      const pct = Math.round((progress.bytesTransferred / progress.totalBytes) * 100)
      process.stdout.write(`\r  ${pct}%`)
    },
  })

  console.log(`\nUploaded: ${file.fileName} (${file.fileId})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
