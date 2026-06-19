import { IncrementalSha1 } from '../../streams/hash.ts'
import type { FileVersion } from '../../types/file.ts'
import { normalizeVerifiableSha1 } from '../../util/sha1.ts'
import { toError } from '../../util/to-error.ts'
import type { SyncPair } from '../pairing.ts'
import type { B2SyncPath, CompareMode, LocalSyncPath, SyncEvent, SyncPath } from '../types.ts'

const unverifiedSha1Prefix = 'unverified:'

/** Reads a local file and returns its SHA-1 digest. */
export type LocalSha1Reader = (path: LocalSyncPath, signal?: AbortSignal) => Promise<string>

/** Options for preparing a file pair before comparison. */
export interface PreparePairForCompareOptions {
  /** Signal used to abort local file hashing. */
  readonly signal?: AbortSignal
  /** Optional local hashing override for tests or custom runtimes. */
  readonly readLocalSha1?: LocalSha1Reader
}

/** Result of preparing a file pair before policy comparison. */
export interface ComparePreparationResult {
  /** The pair with compare-mode metadata populated where possible. */
  readonly pair: SyncPair
  /** Events surfaced while preparing the pair, such as per-file hash errors or skips. */
  readonly events: readonly SyncEvent[]
  /** Errors surfaced while preparing the pair. These contribute to the final summary. */
  readonly errors: readonly Error[]
  /** Local file bytes read for hashing while preparing this pair. */
  readonly bytesHashed: number
  /** Whether action generation should be skipped for this pair. */
  readonly skipActionGeneration: boolean
  /** Whether preparation stopped because the abort signal fired. */
  readonly aborted: boolean
}

/**
 * Determines whether two files should be considered different based on the compare mode.
 * For `sha1`, callers that use the low-level policy helpers should first call
 * {@link preparePairForCompare} so local hashes and B2 multipart hash fallbacks are populated.
 *
 * @param source - The source file metadata.
 * @param dest - The destination file metadata.
 * @param compareMode - The comparison strategy: 'modtime', 'size', 'sha1', or 'none'.
 * @param threshold - Tolerance for the comparison (bytes for size, milliseconds for modtime).
 *
 * @returns `true` if the files are considered different.
 */
export function filesAreDifferent(
  source: SyncPath,
  dest: SyncPath,
  compareMode: CompareMode,
  threshold = 0,
): boolean {
  switch (compareMode) {
    case 'none':
      return false
    case 'size':
      return Math.abs(source.size - dest.size) > threshold
    case 'sha1':
      return sha1ValuesAreDifferent(source, dest)
    case 'modtime':
      return Math.abs(source.modTimeMillis - dest.modTimeMillis) > threshold
  }
}

function sha1ValuesAreDifferent(source: SyncPath, dest: SyncPath): boolean {
  if (source.size !== dest.size) return true

  const sourceSha1 = comparableSha1(source)
  const destSha1 = comparableSha1(dest)
  if (sourceSha1.kind === 'untrusted' || destSha1.kind === 'untrusted') return true
  if (sourceSha1.kind === 'unavailable' || destSha1.kind === 'unavailable') return true
  return sourceSha1.value !== destSha1.value
}

/**
 * Prepares a pair for the selected compare mode.
 *
 * For `sha1`, this fills missing B2 hashes from verified metadata, hashes the local side only
 * when size cannot already prove a difference, and converts local hash I/O failures into
 * per-file sync events instead of aborting the whole run.
 *
 * @param pair - Source/destination pair from {@link zipFolders}.
 * @param compareMode - The comparison strategy.
 * @param options - Optional hashing dependencies and cancellation signal.
 *
 * @returns The prepared pair plus any preparation events.
 */
export async function preparePairForCompare(
  pair: SyncPair,
  compareMode: CompareMode,
  options: PreparePairForCompareOptions = {},
): Promise<ComparePreparationResult> {
  if (compareMode !== 'sha1') return ready(pair)

  const [source, dest] = pair
  if (source === null || dest === null) return ready(pair)
  if (source.size !== dest.size) return ready(pair)

  const metadataPair: SyncPair = [withB2ContentSha1(source), withB2ContentSha1(dest)]
  if (hasUntrustedSha1(metadataPair)) return ready(metadataPair)
  if (hasUnavailableB2Sha1(metadataPair)) {
    return skipped(metadataPair, unavailableSha1Event(metadataPair))
  }

  const [metadataSource, metadataDest] = metadataPair
  if (metadataSource === null || metadataDest === null) return ready(metadataPair)

  const sourceResult = await preparePathSha1(metadataSource, options)
  if (sourceResult.aborted) return aborted(metadataPair)
  if (sourceResult.event) {
    return skipped(metadataPair, sourceResult.event, sourceResult.error, sourceResult.bytesHashed)
  }

  const destResult = await preparePathSha1(metadataDest, options)
  if (destResult.aborted) return aborted([sourceResult.path, destResult.path])
  if (destResult.event) {
    return skipped(
      [sourceResult.path, destResult.path],
      destResult.event,
      destResult.error,
      sourceResult.bytesHashed,
    )
  }

  const preparedPair: SyncPair = [sourceResult.path, destResult.path]
  const sourceState = comparableSha1(sourceResult.path)
  const destState = comparableSha1(destResult.path)
  const bytesHashed = sourceResult.bytesHashed + destResult.bytesHashed

  if (sourceState.kind === 'unavailable' || destState.kind === 'unavailable') {
    return skipped(preparedPair, unavailableSha1Event(preparedPair), undefined, bytesHashed)
  }

  return ready(preparedPair, bytesHashed)
}

/**
 * Extracts the best verifiable SHA-1 value from a B2 file version.
 *
 * Large/multipart B2 files report `contentSha1: null`; when a whole-file digest exists it is
 * stored in `fileInfo.large_file_sha1`, so that value is used as a verified fallback.
 * `unverified:<hex>` values are preserved as untrusted sentinels and never prove equality.
 *
 * @param version - B2 file version metadata.
 *
 * @returns A lowercase verifiable SHA-1, an untrusted sentinel, or null when unavailable.
 */
export function selectB2ComparableSha1(version: FileVersion): string | null {
  if (isUntrustedSha1(version.contentSha1)) return version.contentSha1.toLowerCase()
  return (
    normalizeVerifiableSha1(version.contentSha1) ??
    normalizeVerifiableSha1(version.fileInfo['large_file_sha1'])
  )
}

type Sha1State =
  | { readonly kind: 'verified'; readonly value: string }
  | { readonly kind: 'untrusted' }
  | { readonly kind: 'unavailable' }

interface PreparedPath {
  readonly path: SyncPath
  readonly bytesHashed: number
  readonly event?: SyncEvent
  readonly error?: Error
  readonly aborted: boolean
}

async function preparePathSha1(
  path: SyncPath,
  options: PreparePairForCompareOptions,
): Promise<PreparedPath> {
  if (!isLocalSyncPath(path) || path.contentSha1 !== undefined) {
    return { path, bytesHashed: 0, aborted: false }
  }

  if (options.signal?.aborted) return { path, bytesHashed: 0, aborted: true }

  try {
    const readLocalSha1 = options.readLocalSha1 ?? sha1File
    return {
      path: { ...path, contentSha1: await readLocalSha1(path, options.signal) },
      bytesHashed: path.size,
      aborted: false,
    }
  } catch (err) {
    if (options.signal?.aborted || isAbortError(err)) return { path, bytesHashed: 0, aborted: true }
    const error = toError(err)
    return {
      path,
      bytesHashed: 0,
      event: {
        type: 'error',
        path: path.relativePath,
        size: 0,
        message: `failed to hash local file for sha1 comparison: ${error.message}`,
      },
      error,
      aborted: false,
    }
  }
}

function comparableSha1(path: SyncPath): Sha1State {
  if (isUntrustedSha1(path.contentSha1)) return { kind: 'untrusted' }

  const sha1 = normalizeVerifiableSha1(path.contentSha1)
  if (sha1 === null) return { kind: 'unavailable' }
  return { kind: 'verified', value: sha1 }
}

function withB2ContentSha1(path: SyncPath): SyncPath {
  if (!isB2SyncPath(path) || path.contentSha1 !== undefined) return path
  return { ...path, contentSha1: selectB2ComparableSha1(path.selectedVersion) }
}

function hasUntrustedSha1(pair: SyncPair): boolean {
  const [source, dest] = pair
  return (
    (source !== null && comparableSha1(source).kind === 'untrusted') ||
    (dest !== null && comparableSha1(dest).kind === 'untrusted')
  )
}

function hasUnavailableB2Sha1(pair: SyncPair): boolean {
  const [source, dest] = pair
  return (
    (source !== null && isB2SyncPath(source) && comparableSha1(source).kind === 'unavailable') ||
    (dest !== null && isB2SyncPath(dest) && comparableSha1(dest).kind === 'unavailable')
  )
}

function isUntrustedSha1(sha1: string | null | undefined): sha1 is string {
  return sha1?.toLowerCase().startsWith(unverifiedSha1Prefix) ?? false
}

function isB2SyncPath(path: SyncPath): path is B2SyncPath {
  return 'selectedVersion' in path
}

function isLocalSyncPath(path: SyncPath): path is LocalSyncPath {
  return 'absolutePath' in path
}

function ready(pair: SyncPair, bytesHashed = 0): ComparePreparationResult {
  return {
    pair,
    events: [],
    errors: [],
    bytesHashed,
    skipActionGeneration: false,
    aborted: false,
  }
}

function skipped(
  pair: SyncPair,
  event: SyncEvent,
  error?: Error,
  bytesHashed = 0,
): ComparePreparationResult {
  return {
    pair,
    events: [event],
    errors: error !== undefined ? [error] : [],
    bytesHashed,
    skipActionGeneration: true,
    aborted: false,
  }
}

function aborted(pair: SyncPair): ComparePreparationResult {
  return {
    pair,
    events: [],
    errors: [],
    bytesHashed: 0,
    skipActionGeneration: true,
    aborted: true,
  }
}

function unavailableSha1Event(pair: SyncPair): SyncEvent {
  const path = (pair[0] ?? pair[1])?.relativePath ?? ''
  return {
    type: 'skip',
    path,
    size: 0,
    message: 'sha1 comparison skipped because a verifiable SHA-1 is unavailable',
  }
}

async function sha1File(path: LocalSyncPath, signal?: AbortSignal): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const stream = createReadStream(path.absolutePath, { signal })
  const hash = new IncrementalSha1()

  for await (const chunk of stream) {
    if (signal?.aborted) {
      stream.destroy()
      throw new Error('aborted')
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError('createReadStream yielded a non-byte chunk')
    }
    await hash.update(chunk)
  }

  return hash.digest()
}

function isAbortError(err: unknown): boolean {
  const error = toError(err)
  return error.name === 'AbortError'
}
