/**
 * Upload progress with a TUI bar.
 *
 * Demonstrates `bucket.upload`'s `onProgress` callback rendered as a
 * single-line progress bar with bytes / parts / throughput / ETA. Throttled
 * to 10 Hz so the terminal doesn't flicker.
 *
 * Usage:
 *   B2_APPLICATION_KEY_ID=xxx B2_APPLICATION_KEY=yyy \
 *     npx tsx examples/node-with-progress.ts <bucket-name> <local-file>
 */

import { basename } from 'node:path'
import type { ProgressListener } from '@backblaze-labs/b2-sdk/streams'
import { FileSource } from '@backblaze-labs/b2-sdk/streams'
import { setupClient } from './_smoke/cli.ts'

/**
 * Wraps a {@link ProgressListener} so it fires at most every `everyMs`
 * milliseconds. The final event (after the last byte) always fires.
 *
 * Why this isn't built into the SDK: throttling policy is userland. Some
 * callers want every event for analytics; some want one update per second
 * for a UI; some want logarithmic spacing. Keep the SDK callback raw and
 * throttle here.
 */
function throttle<T extends ProgressListener>(fn: T, everyMs: number): ProgressListener {
  let last = 0
  return (e) => {
    const now = Date.now()
    const isFinal = e.totalBytes !== null && e.bytesTransferred >= e.totalBytes
    if (!isFinal && now - last < everyMs) return
    last = now
    fn(e)
  }
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '∞'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

function renderBar(transferred: number, total: number, width = 30): string {
  const ratio = total > 0 ? Math.min(transferred / total, 1) : 0
  const filled = Math.round(width * ratio)
  return `[${'█'.repeat(filled)}${'·'.repeat(width - filled)}]`
}

async function main() {
  const [, , bucketName, filePath] = process.argv
  if (!bucketName || !filePath) {
    console.error('Usage: npx tsx examples/node-with-progress.ts <bucket-name> <local-file>')
    process.exit(1)
  }

  const client = await setupClient()

  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`Bucket "${bucketName}" not found`)
    process.exit(1)
  }

  const fileName = basename(filePath)
  const source = await FileSource.fromPath(filePath)
  const totalBytes = source.size
  const startedAt = Date.now()

  const onProgress = throttle((e) => {
    const total = e.totalBytes ?? totalBytes
    const elapsedMs = Date.now() - startedAt
    const bytesPerSec = elapsedMs > 0 ? (e.bytesTransferred / elapsedMs) * 1000 : 0
    const remainingBytes = total - e.bytesTransferred
    const etaMs = bytesPerSec > 0 ? (remainingBytes / bytesPerSec) * 1000 : Number.POSITIVE_INFINITY
    const parts = e.totalParts !== null ? ` · ${e.partsCompleted}/${e.totalParts} parts` : ''
    const pct = ((e.bytesTransferred / total) * 100).toFixed(1)
    const line =
      `${renderBar(e.bytesTransferred, total)} ${pct.padStart(5)}% · ` +
      `${fmtBytes(e.bytesTransferred)}/${fmtBytes(total)}${parts} · ` +
      `${fmtBytes(bytesPerSec)}/s · ETA ${fmtDuration(etaMs)}`
    process.stdout.write(`\r${line}`.padEnd(120))
  }, 100)

  console.log(`Uploading ${fileName} (${fmtBytes(totalBytes)}) to ${bucketName}…`)

  const result = await bucket.upload({
    fileName,
    source,
    onProgress,
  })

  process.stdout.write('\n')
  const totalMs = Date.now() - startedAt
  console.log(
    `✓ ${result.fileName} (${result.fileId}) in ${fmtDuration(totalMs)} ` +
      `· ${fmtBytes((totalBytes / totalMs) * 1000)}/s avg`,
  )
}

main().catch((err) => {
  console.error('\n✗', err)
  process.exit(1)
})
