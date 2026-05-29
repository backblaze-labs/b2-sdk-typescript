/**
 * Encrypted local-folder-to-B2 backup CLI.
 *
 * Subcommands:
 *   snapshot <local-dir> <b2-uri> [--since <date>] [--concurrency N]
 *   restore  <b2-uri> <local-dir> [--concurrency N]
 *
 * `b2-uri` is `b2://<bucket>/<prefix>`. Env vars:
 *   B2_APPLICATION_KEY_ID
 *   B2_APPLICATION_KEY
 *   B2_BACKUP_PASSPHRASE
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import { B2Client } from '@backblaze-labs/b2-sdk'
import { BufferSource } from '@backblaze-labs/b2-sdk/streams'
import { smokeTransport } from '../_smoke/transport.ts'
import { decryptFile, deriveKek, encryptFile, generateSalt, type WrappedKey } from './crypto.ts'
import {
  diff,
  type Manifest,
  manifestSalt,
  newManifest,
  readManifest,
  recordRemove,
  recordUpload,
  scan,
  writeManifest,
} from './manifest.ts'
import { pool } from './worker.ts'

interface ParsedUri {
  readonly bucket: string
  readonly prefix: string
}

/** Parse `b2://bucket/prefix` into bucket + prefix. The prefix is normalised. */
function parseB2Uri(uri: string): ParsedUri {
  const match = /^b2:\/\/([^/]+)(?:\/(.*))?$/.exec(uri)
  if (!match) throw new Error(`invalid b2 URI: ${uri}`)
  const bucket = match[1]
  if (!bucket) throw new Error(`invalid b2 URI: ${uri}`)
  const prefix = (match[2] ?? '').replace(/^\/+|\/+$/g, '')
  return { bucket, prefix }
}

interface CliOptions {
  readonly concurrency: number
  readonly since: Date | null
}

function parseFlags(args: string[]): CliOptions {
  let concurrency = 8
  let since: Date | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--concurrency') {
      const next = args[++i]
      if (!next) throw new Error('--concurrency requires a value')
      concurrency = Number.parseInt(next, 10)
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new Error(`invalid --concurrency: ${next}`)
      }
    } else if (args[i] === '--since') {
      const next = args[++i]
      if (!next) throw new Error('--since requires a value')
      const parsed = new Date(next)
      if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --since: ${next}`)
      since = parsed
    }
  }
  return { concurrency, since }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required`)
    process.exit(1)
  }
  return value
}

const MANIFEST_KEY = '.b2-backup.json'

/**
 * Fetch the manifest from B2 (snapshot resume on a fresh machine), or null if
 * it doesn't exist yet.
 *
 * @param bucket - The Bucket facade.
 * @param prefix - The backup root prefix in the bucket.
 *
 * @returns The parsed remote manifest, or null when there's nothing there.
 */
async function downloadRemoteManifest(bucket: Bucket, prefix: string): Promise<Manifest | null> {
  const key = prefix ? `${prefix}/${MANIFEST_KEY}` : MANIFEST_KEY
  try {
    const result = await bucket.download(key)
    const reader = result.body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const combined = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      combined.set(c, offset)
      offset += c.byteLength
    }
    return JSON.parse(new TextDecoder().decode(combined)) as Manifest
  } catch {
    return null
  }
}

async function uploadManifest(bucket: Bucket, prefix: string, manifest: Manifest): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  const key = prefix ? `${prefix}/${MANIFEST_KEY}` : MANIFEST_KEY
  await bucket.upload({
    fileName: key,
    source: new BufferSource(bytes),
    contentType: 'application/json',
  })
}

async function snapshot(localDir: string, uriString: string, options: CliOptions): Promise<void> {
  const keyId = requireEnv('B2_APPLICATION_KEY_ID')
  const key = requireEnv('B2_APPLICATION_KEY')
  const passphrase = requireEnv('B2_BACKUP_PASSPHRASE')

  const { bucket: bucketName, prefix } = parseB2Uri(uriString)

  const transport = await smokeTransport()
  const client = new B2Client({
    applicationKeyId: keyId,
    applicationKey: key,
    ...(transport !== undefined ? { transport } : {}),
  })
  await client.authorize()
  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`bucket "${bucketName}" not found`)
    process.exit(1)
  }

  // Use the local manifest if present; otherwise pull the remote one (lets a
  // fresh machine resume against an existing prefix); otherwise start fresh.
  let manifest =
    (await readManifest(localDir)) ??
    (await downloadRemoteManifest(bucket, prefix)) ??
    newManifest(generateSalt())

  const kek = await deriveKek(passphrase, manifestSalt(manifest))

  console.log(`scanning ${localDir}...`)
  const scanned = await scan(localDir)
  const planned = diff(scanned, manifest)

  let toUpload = planned.toUpload
  if (options.since) {
    const cutoff = options.since.getTime()
    toUpload = toUpload.filter((f) => new Date(f.mtime).getTime() >= cutoff)
  }

  console.log(
    `plan: ${toUpload.length} to upload · ${planned.unchanged.length} unchanged · ${planned.toRemove.length} stale`,
  )

  let uploaded = 0
  const tasks = toUpload.map((file) => async () => {
    const plaintext = new Uint8Array(await readFile(file.absPath))
    const { ciphertext, wrapped } = await encryptFile(plaintext, kek)

    const remoteKey = prefix ? `${prefix}/${file.path}` : file.path
    const result = await bucket.upload({
      fileName: remoteKey,
      source: new BufferSource(ciphertext),
      contentType: 'application/octet-stream',
      fileInfo: wrappedKeyToFileInfo(wrapped),
    })

    manifest = recordUpload(manifest, file, result.fileId)
    uploaded++
    process.stdout.write(`\r  uploaded ${uploaded}/${toUpload.length}`)
  })

  try {
    await pool(tasks, options.concurrency)
  } finally {
    // Persist whatever progress we made, even on crash. The next run will
    // resume from this manifest and skip files already uploaded.
    if (toUpload.length > 0) process.stdout.write('\n')
    await writeManifest(localDir, manifest)
  }

  for (const stale of planned.toRemove) {
    manifest = recordRemove(manifest, stale)
  }

  await writeManifest(localDir, manifest)
  await uploadManifest(bucket, prefix, manifest)
  console.log(`done. manifest written to ${join(localDir, '.b2-backup.json')}`)
}

async function restore(uriString: string, localDir: string, options: CliOptions): Promise<void> {
  const keyId = requireEnv('B2_APPLICATION_KEY_ID')
  const key = requireEnv('B2_APPLICATION_KEY')
  const passphrase = requireEnv('B2_BACKUP_PASSPHRASE')

  const { bucket: bucketName, prefix } = parseB2Uri(uriString)

  const transport = await smokeTransport()
  const client = new B2Client({
    applicationKeyId: keyId,
    applicationKey: key,
    ...(transport !== undefined ? { transport } : {}),
  })
  await client.authorize()
  const bucket = await client.getBucket(bucketName)
  if (!bucket) {
    console.error(`bucket "${bucketName}" not found`)
    process.exit(1)
  }

  const manifest = await downloadRemoteManifest(bucket, prefix)
  if (!manifest) {
    console.error(`no manifest found at ${uriString}/${MANIFEST_KEY}`)
    process.exit(1)
  }

  const kek = await deriveKek(passphrase, manifestSalt(manifest))
  const entries = Object.values(manifest.files)
  console.log(`restoring ${entries.length} files to ${localDir}...`)

  let restored = 0
  const tasks = entries.map((entry) => async () => {
    const remoteKey = prefix ? `${prefix}/${entry.path}` : entry.path
    const result = await bucket.download(remoteKey)

    const reader = result.body.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    let total = 0
    for (const c of chunks) total += c.byteLength
    const ciphertext = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      ciphertext.set(c, offset)
      offset += c.byteLength
    }

    const wrapped = fileInfoToWrappedKey(result.headers.fileInfo)
    const plaintext = await decryptFile(ciphertext, wrapped, kek)
    const destPath = join(localDir, entry.path)
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, plaintext)
    restored++
    process.stdout.write(`\r  restored ${restored}/${entries.length}`)
  })

  await pool(tasks, options.concurrency)
  if (entries.length > 0) process.stdout.write('\n')
  console.log('done.')
}

function wrappedKeyToFileInfo(wrapped: WrappedKey): Record<string, string> {
  return {
    b2backup_dek: wrapped.wrappedDek,
    b2backup_wrap_iv: wrapped.wrapIv,
    b2backup_iv: wrapped.fileIv,
  }
}

function fileInfoToWrappedKey(info: Record<string, string> | undefined): WrappedKey {
  const wrappedDek = info?.['b2backup_dek']
  const wrapIv = info?.['b2backup_wrap_iv']
  const fileIv = info?.['b2backup_iv']
  if (!wrappedDek || !wrapIv || !fileIv) {
    throw new Error('missing wrapped-key fileInfo; was this file uploaded by b2-backup?')
  }
  return { wrappedDek, wrapIv, fileIv }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv
  if (command === 'snapshot') {
    const [localDir, uri, ...flags] = rest
    if (!localDir || !uri) {
      console.error('usage: backup snapshot <local-dir> b2://<bucket>/<prefix> [flags]')
      process.exit(1)
    }
    await snapshot(localDir, uri, parseFlags(flags))
  } else if (command === 'restore') {
    const [uri, localDir, ...flags] = rest
    if (!uri || !localDir) {
      console.error('usage: backup restore b2://<bucket>/<prefix> <local-dir> [flags]')
      process.exit(1)
    }
    await restore(uri, localDir, parseFlags(flags))
  } else {
    console.error('usage: backup <snapshot|restore> ...')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
