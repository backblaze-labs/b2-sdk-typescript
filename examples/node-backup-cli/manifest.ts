/**
 * Manifest reader/writer and diff computation.
 *
 * The manifest is a JSON document recording, for every file in the backup,
 * its relative path, size, mtime, and SHA-1 of the plaintext. On each snapshot
 * run, the local tree is walked and compared against the manifest: files
 * whose plaintext SHA-1 still matches are skipped.
 *
 * The manifest also stores the per-repository salt used to derive the master
 * KEK, so a fresh machine can restore against the same prefix with only the
 * passphrase.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { saltFromString, saltToString } from './crypto.ts'

/** Per-file record in the manifest. */
export interface FileEntry {
  /** Path relative to the backup root, using forward slashes. */
  readonly path: string
  /** Plaintext size in bytes. */
  readonly size: number
  /** Modification time as ISO 8601. */
  readonly mtime: string
  /** Lowercase-hex SHA-1 of the plaintext. */
  readonly sha1: string
  /** B2 file ID of the most recent successful upload (informational). */
  readonly fileId?: string
}

/** The on-disk manifest format. */
export interface Manifest {
  /** Schema version. Bump when the layout changes incompatibly. */
  readonly version: 1
  /** Base64url-encoded PBKDF2 salt for this repository. */
  readonly salt: string
  /** When the manifest was last written. */
  readonly updatedAt: string
  /** All files in the backup, keyed by relative path. */
  readonly files: Record<string, FileEntry>
}

const MANIFEST_NAME = '.b2-backup.json'

/**
 * Read the manifest from `<root>/.b2-backup.json`. Returns null if the file
 * does not exist; throws on parse errors.
 *
 * @param root - The backup root directory.
 *
 * @returns The parsed manifest, or null if no manifest exists yet.
 */
export async function readManifest(root: string): Promise<Manifest | null> {
  const path = `${root}/${MANIFEST_NAME}`
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw) as Manifest
  if (parsed.version !== 1) {
    throw new Error(`unsupported manifest version: ${parsed.version}`)
  }
  return parsed
}

/**
 * Persist the manifest to `<root>/.b2-backup.json`.
 *
 * @param root - The backup root directory.
 * @param manifest - The manifest to write.
 */
export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  const path = `${root}/${MANIFEST_NAME}`
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
}

/**
 * Create a new manifest with a fresh salt. Used on the first snapshot run.
 *
 * @param salt - The newly-generated PBKDF2 salt.
 *
 * @returns An empty manifest pinned to the current schema version.
 */
export function newManifest(salt: Uint8Array<ArrayBuffer>): Manifest {
  return {
    version: 1,
    salt: saltToString(salt),
    updatedAt: new Date().toISOString(),
    files: {},
  }
}

/** Convenience accessor: get the binary salt out of a parsed manifest. */
export function manifestSalt(manifest: Manifest): Uint8Array<ArrayBuffer> {
  return saltFromString(manifest.salt)
}

/** Result of comparing the local tree to the manifest. */
export interface Diff {
  /** Files present locally but not in the manifest, or whose sha1 changed. */
  readonly toUpload: ScannedFile[]
  /** Files in the manifest no longer present locally. */
  readonly toRemove: string[]
  /** Files whose sha1 still matches the manifest (skipped). */
  readonly unchanged: ScannedFile[]
}

/** A file located during the local scan, with its plaintext SHA-1. */
export interface ScannedFile {
  readonly path: string
  readonly absPath: string
  readonly size: number
  readonly mtime: string
  readonly sha1: string
}

/**
 * Compute the SHA-1 of a file's plaintext, streaming so we don't OOM on
 * multi-GB files.
 *
 * @param absPath - Absolute path to read.
 *
 * @returns Lowercase-hex 40-character digest.
 */
export async function sha1File(absPath: string): Promise<string> {
  const hash = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('end', () => {
      resolve()
    })
    stream.on('error', reject)
  })
  return hash.digest('hex')
}

/**
 * Walk a directory recursively, returning every regular file with its size,
 * mtime, and plaintext sha1. The manifest file itself is skipped.
 *
 * @param root - The directory to walk.
 *
 * @returns An array of scanned files relative to `root`.
 */
export async function scan(root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === MANIFEST_NAME) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        const info = await stat(abs)
        const rel = relative(root, abs).split(sep).join('/')
        const sha1 = await sha1File(abs)
        out.push({
          path: rel,
          absPath: abs,
          size: info.size,
          mtime: info.mtime.toISOString(),
          sha1,
        })
      }
    }
  }
  await walk(root)
  return out
}

/**
 * Compare a fresh scan to the manifest and return what should be uploaded,
 * removed, or skipped.
 *
 * @param scanned - Files discovered locally.
 * @param manifest - The current manifest.
 *
 * @returns The {@link Diff} between local state and manifest state.
 */
export function diff(scanned: ScannedFile[], manifest: Manifest): Diff {
  const toUpload: ScannedFile[] = []
  const unchanged: ScannedFile[] = []
  const seen = new Set<string>()

  for (const file of scanned) {
    seen.add(file.path)
    const prior = manifest.files[file.path]
    if (prior && prior.sha1 === file.sha1) {
      unchanged.push(file)
    } else {
      toUpload.push(file)
    }
  }

  const toRemove: string[] = []
  for (const path of Object.keys(manifest.files)) {
    if (!seen.has(path)) toRemove.push(path)
  }

  return { toUpload, toRemove, unchanged }
}

/**
 * Apply an upload to the manifest, returning an updated copy. The original
 * manifest is not mutated.
 *
 * @param manifest - The current manifest.
 * @param file - The just-uploaded file's scan record.
 * @param fileId - The B2 file ID returned by the upload.
 *
 * @returns A new manifest with the file recorded.
 */
export function recordUpload(manifest: Manifest, file: ScannedFile, fileId: string): Manifest {
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    files: {
      ...manifest.files,
      [file.path]: {
        path: file.path,
        size: file.size,
        mtime: file.mtime,
        sha1: file.sha1,
        fileId,
      },
    },
  }
}

/**
 * Remove an entry from the manifest. The original is not mutated.
 *
 * @param manifest - The current manifest.
 * @param path - The path to drop.
 *
 * @returns A new manifest without that file.
 */
export function recordRemove(manifest: Manifest, path: string): Manifest {
  const next = { ...manifest.files }
  delete next[path]
  return { ...manifest, updatedAt: new Date().toISOString(), files: next }
}
