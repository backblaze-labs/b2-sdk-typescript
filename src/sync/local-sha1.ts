import { IncrementalSha1 } from '../streams/hash.ts'
import { sanitizeErrorReason } from '../util/error-reason.ts'
import { toError } from '../util/to-error.ts'
import { assertSameScannedRegularFile } from './local-file-io.ts'
import { normalizeSha1TimeoutMillis } from './sha1-options.ts'
import type { LocalSyncPath } from './types.ts'

/** Options for reading a local file SHA-1 digest. */
export interface LocalSha1ReadOptions {
  /**
   * Maximum milliseconds to allow without filesystem progress while hashing.
   * Defaults to 30 seconds.
   */
  readonly timeoutMillis?: number
}

/** Reads a local file and returns its SHA-1 digest, or null when unavailable. */
export type LocalSha1Reader = (
  path: LocalSyncPath,
  signal?: AbortSignal,
  options?: LocalSha1ReadOptions,
) => Promise<string | null>

/**
 * Formats a hash error for public sync events without leaking filesystem paths.
 *
 * @param error - Error thrown while hashing.
 *
 * @returns A sanitized reason suitable for event messages.
 */
export function formatHashError(error: Error): string {
  return sanitizeErrorReason(error)
}

/**
 * Returns whether an error represents an abort.
 *
 * @param err - Unknown thrown value.
 *
 * @returns True for AbortError values.
 */
export function isAbortError(err: unknown): boolean {
  const error = toError(err)
  return error.name === 'AbortError'
}

/**
 * Reads a local file and computes its SHA-1 digest with non-regular-file rejection,
 * scanned-size bounds, abort support, and an idle/no-progress timeout.
 *
 * @param path - Local sync path to hash.
 * @param signal - Optional abort signal.
 * @param options - Optional idle timeout override.
 *
 * @returns The lowercase SHA-1 digest of the file bytes.
 */
export async function readLocalSha1File(
  path: LocalSyncPath,
  signal?: AbortSignal,
  options: LocalSha1ReadOptions = {},
): Promise<string> {
  const { constants } = await import('node:fs')
  const { lstat, open } = await import('node:fs/promises')
  const timeoutMillis = normalizeSha1TimeoutMillis(options.timeoutMillis)
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  const hash = new IncrementalSha1()
  let stream: (AsyncIterable<Uint8Array> & { destroy(error?: Error): void }) | undefined
  let file: Awaited<ReturnType<typeof open>> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  function armTimeout(onTimeout: () => void): void {
    if (timeout !== undefined) clearTimeout(timeout)
    timeout = setTimeout(onTimeout, timeoutMillis)
  }

  try {
    signal?.throwIfAborted()

    const preOpenStat = await withTimeout(
      lstat(path.absolutePath),
      timeoutMillis,
      'sha1 file status',
    )
    assertSameScannedRegularFile(preOpenStat, path, 'sha1 comparison')

    file = await openWithTimeout(open(path.absolutePath, flags), timeoutMillis)

    const postOpenStat = await withTimeout(
      lstat(path.absolutePath),
      timeoutMillis,
      'sha1 file status',
    )
    assertSameScannedRegularFile(postOpenStat, path, 'sha1 comparison')

    const stat = await withTimeout(file.stat(), timeoutMillis, 'sha1 file status')
    assertSameScannedRegularFile(stat, path, 'sha1 comparison')

    stream = file.createReadStream({
      ...(path.size > 0 ? { start: 0, end: path.size - 1 } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })

    let bytesRead = 0
    /* v8 ignore next 3 -- idle-timeout firing is timing-dependent in filesystem tests */
    armTimeout(() => {
      stream?.destroy(new Error(`sha1 read stalled for ${timeoutMillis} ms`))
    })
    for await (const chunk of stream) {
      bytesRead += chunk.byteLength
      await hash.update(chunk)
      /* v8 ignore next 3 -- idle-timeout firing is timing-dependent in filesystem tests */
      armTimeout(() => {
        stream?.destroy(new Error(`sha1 read stalled for ${timeoutMillis} ms`))
      })
    }

    /* v8 ignore next -- defensive TOCTOU guard after the bounded stream completes */
    if (bytesRead !== path.size) throw new Error('file changed during sha1 comparison')
    return hash.digest()
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    stream?.destroy()
    await file?.close().catch(() => {})
  }
}

/* v8 ignore start -- defensive stale-filesystem stall handling is not portable to trigger */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMillis: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${operation} stalled for ${timeoutMillis} ms`))
        }, timeoutMillis)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function openWithTimeout<T extends { close(): Promise<void> }>(
  promise: Promise<T>,
  timeoutMillis: number,
): Promise<T> {
  let timedOut = false
  const tracked = promise.then(
    (file) => {
      if (timedOut) void file.close().catch(() => {})
      return file
    },
    (err: unknown) => {
      throw err
    },
  )

  try {
    return await withTimeout(tracked, timeoutMillis, 'sha1 file open')
  } catch (err) {
    timedOut = true
    throw err
  }
}
/* v8 ignore stop */
