import { mapConcurrent } from '../../upload/concurrency.ts'
import { normalizeVerifiableSha1 } from '../../util/sha1.ts'
import { toError } from '../../util/to-error.ts'
import { formatHashError, isAbortError, type LocalSha1Reader } from '../local-sha1.ts'
import type { SyncPair } from '../pairing.ts'
import { isUntrustedSha1, selectB2ComparableSha1 } from '../sha1-metadata.ts'
import type {
  B2SyncPath,
  CompareMode,
  LocalSyncPath,
  SyncEvent,
  SyncPath,
  SyncSkipEvent,
} from '../types.ts'

export { selectB2ComparableSha1 } from '../sha1-metadata.ts'

/** Reads a B2 file and returns the SHA-1 digest of its actual bytes, or null when unavailable. */
export type B2Sha1Reader = (path: B2SyncPath, signal?: AbortSignal) => Promise<string | null>

/** Options for preparing a file pair before comparison. */
export interface PreparePairForCompareOptions {
  /** Signal used to abort local file hashing. */
  readonly signal?: AbortSignal
  /** Optional idle/no-progress timeout for local SHA-1 reads. */
  readonly sha1ReadTimeoutMillis?: number
  /** Optional local hashing override for tests or custom runtimes. */
  readonly readLocalSha1?: LocalSha1Reader
  /** Optional B2 hashing override used to verify metadata matches before skipping. */
  readonly readB2Sha1?: B2Sha1Reader
}

/** Options for preparing multiple file pairs before comparison. */
export interface PreparePairsForCompareOptions extends PreparePairForCompareOptions {
  /** Maximum number of file pairs to prepare concurrently. */
  readonly concurrency?: number
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

/** A prepared pair result with the original pair retained for event context. */
export interface PreparedComparePair {
  /** Original pair from {@link zipFolders}. */
  readonly originalPair: SyncPair
  /** Preparation result for the original pair. */
  readonly prepared: ComparePreparationResult
}

/**
 * Determines whether two files should be considered different based on the compare mode.
 * For `sha1`, callers that use the low-level policy helpers should first prepare the pair so
 * local hashes and comparable B2 hashes are populated.
 *
 * @param source - The source file metadata.
 * @param dest - The destination file metadata.
 * @param compareMode - The comparison strategy: 'modtime', 'size', 'sha1', or 'none'.
 * @param threshold - Tolerance for the comparison (bytes for size, milliseconds for modtime).
 *
 * @returns `true` if the files are considered different.
 *
 * @throws When `compareMode` is not one of the supported compare modes.
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
    default:
      throw new Error(`Unsupported compare mode: ${String(compareMode)}`)
  }
}

/**
 * Throws when a runtime compare mode value is unsupported.
 *
 * @param compareMode - User-supplied compare mode.
 *
 * @throws When `compareMode` is not one of the supported values.
 */
export function assertSupportedCompareMode(
  compareMode: unknown,
): asserts compareMode is CompareMode {
  switch (compareMode) {
    case 'none':
    case 'size':
    case 'sha1':
    case 'modtime':
      return
    default:
      throw new Error(`Unsupported compare mode: ${String(compareMode)}`)
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
 * For `sha1`, this fills missing B2 hashes from comparable metadata and, when an explicit local
 * reader is supplied, hashes the local side only when size cannot already prove a difference.
 * Reader failures are converted into per-file sync events instead of aborting the whole run.
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
  if (compareMode !== 'sha1') return readyComparePair(pair)

  const [source, dest] = pair
  if (source === null || dest === null) return readyComparePair(pair)
  if (source.size !== dest.size) return readyComparePair(pair)

  const metadataPair: SyncPair = [withB2ContentSha1(source), withB2ContentSha1(dest)]
  if (hasUntrustedSha1(metadataPair) && options.readB2Sha1 === undefined) {
    return readyComparePair(metadataPair)
  }
  if (hasUnavailableB2Sha1(metadataPair)) {
    return skipped(metadataPair, unavailableSha1Event(metadataPair))
  }

  const [metadataSource, metadataDest] = metadataPair
  if (metadataSource === null || metadataDest === null) return readyComparePair(metadataPair)

  const sourceResult = await prepareLocalPathSha1(metadataSource, options)
  if (sourceResult.aborted) return aborted(metadataPair)
  if (sourceResult.event) {
    return skipped(metadataPair, sourceResult.event, sourceResult.error, sourceResult.bytesHashed)
  }

  const destResult = await prepareLocalPathSha1(metadataDest, options)
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

  const shouldVerifyB2Bytes = sourceState.kind === 'untrusted' || destState.kind === 'untrusted'
  const readB2Sha1 = options.readB2Sha1
  if (shouldVerifyB2Bytes && hasB2Path(preparedPair) && readB2Sha1 !== undefined) {
    return verifyB2Sha1Bytes(preparedPair, { ...options, readB2Sha1 }, bytesHashed)
  }

  return readyComparePair(preparedPair, bytesHashed)
}

/**
 * Prepares a list of pairs for the selected compare mode with bounded concurrency.
 *
 * @param pairs - Source/destination pairs from {@link zipFolders}.
 * @param compareMode - The comparison strategy.
 * @param options - Optional hashing dependencies, cancellation signal, and concurrency.
 *
 * @returns Prepared results in the same order as the input pairs.
 */
export async function preparePairsForCompare(
  pairs: readonly SyncPair[],
  compareMode: CompareMode,
  options: PreparePairsForCompareOptions = {},
): Promise<PreparedComparePair[]> {
  if (compareMode !== 'sha1') {
    return pairs.map((pair) => ({ originalPair: pair, prepared: readyComparePair(pair) }))
  }

  const concurrency = normalizeConcurrency(options.concurrency)
  return mapConcurrent(pairs, concurrency, async (pair): Promise<PreparedComparePair> => {
    if (options.signal?.aborted) return { originalPair: pair, prepared: aborted(pair) }
    return {
      originalPair: pair,
      prepared: await preparePairForCompare(pair, compareMode, options),
    }
  })
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

async function prepareLocalPathSha1(
  path: SyncPath,
  options: PreparePairForCompareOptions,
): Promise<PreparedPath> {
  if (!isLocalSyncPath(path)) {
    return { path, bytesHashed: 0, aborted: false }
  }

  if (options.signal?.aborted) return { path, bytesHashed: 0, aborted: true }

  try {
    const readLocalSha1 = options.readLocalSha1
    if (readLocalSha1 === undefined) {
      return {
        path: { ...path, contentSha1: path.contentSha1 ?? null },
        bytesHashed: 0,
        aborted: false,
      }
    }
    const contentSha1 = await readLocalSha1(path, options.signal, {
      ...(options.sha1ReadTimeoutMillis !== undefined
        ? { timeoutMillis: options.sha1ReadTimeoutMillis }
        : {}),
    })
    return {
      path: {
        ...path,
        contentSha1,
      },
      bytesHashed: normalizeVerifiableSha1(contentSha1) === null ? 0 : path.size,
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
        message: `failed to hash local file for sha1 comparison: ${formatHashError(error)}`,
      },
      error,
      aborted: false,
    }
  }
}

async function verifyB2Sha1Bytes(
  pair: SyncPair,
  options: PreparePairForCompareOptions & { readonly readB2Sha1: B2Sha1Reader },
  bytesHashed: number,
): Promise<ComparePreparationResult> {
  const [source, dest] = pair
  /* v8 ignore next -- callers only verify B2 bytes for paired compare results */
  if (source === null || dest === null) return readyComparePair(pair, bytesHashed)

  const sourceResult = await prepareUntrustedB2PathSha1(source, options)
  if (sourceResult.aborted) return aborted(pair)
  if (sourceResult.event) {
    return skipped(pair, sourceResult.event, sourceResult.error, bytesHashed)
  }

  const destResult = await prepareUntrustedB2PathSha1(dest, options)
  /* v8 ignore next -- destination abort mirrors the covered source abort path */
  if (destResult.aborted) return aborted([sourceResult.path, destResult.path])
  if (destResult.event) {
    return skipped(
      [sourceResult.path, destResult.path],
      destResult.event,
      destResult.error,
      bytesHashed,
    )
  }

  return readyComparePair([sourceResult.path, destResult.path], bytesHashed)
}

async function prepareUntrustedB2PathSha1(
  path: SyncPath,
  options: PreparePairForCompareOptions & { readonly readB2Sha1: B2Sha1Reader },
): Promise<PreparedPath> {
  if (!isB2SyncPath(path) || comparableSha1(path).kind !== 'untrusted') {
    return { path, bytesHashed: 0, aborted: false }
  }
  return prepareB2PathSha1(path, options)
}

async function prepareB2PathSha1(
  path: B2SyncPath,
  options: PreparePairForCompareOptions & { readonly readB2Sha1: B2Sha1Reader },
): Promise<PreparedPath> {
  /* v8 ignore next -- pre-aborted B2 reads are covered at pair level */
  if (options.signal?.aborted) return { path, bytesHashed: 0, aborted: true }

  try {
    return {
      path: {
        ...path,
        contentSha1: await options.readB2Sha1(path, options.signal),
      },
      bytesHashed: 0,
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
        message: `failed to hash B2 file for sha1 comparison: ${formatHashError(error)}`,
      },
      error,
      aborted: false,
    }
  }
}

function comparableSha1(path: SyncPath): Sha1State {
  const candidate = path.contentSha1
  if (candidate === null || candidate === undefined) return { kind: 'unavailable' }
  if (isUntrustedSha1(candidate)) return { kind: 'untrusted' }

  const sha1 = normalizeVerifiableSha1(candidate)
  if (sha1 === null) return { kind: 'untrusted' }
  return { kind: 'verified', value: sha1 }
}

function withB2ContentSha1(path: SyncPath): SyncPath {
  if (!isB2SyncPath(path) || path.contentSha1 !== undefined) return path
  return { ...path, contentSha1: selectB2ComparableSha1(path.selectedVersion) }
}

function hasUnavailableB2Sha1(pair: SyncPair): boolean {
  const [source, dest] = pair
  return (
    (source !== null && isB2SyncPath(source) && comparableSha1(source).kind === 'unavailable') ||
    (dest !== null && isB2SyncPath(dest) && comparableSha1(dest).kind === 'unavailable')
  )
}

function hasUntrustedSha1(pair: SyncPair): boolean {
  const [source, dest] = pair
  return (
    (source !== null && comparableSha1(source).kind === 'untrusted') ||
    (dest !== null && comparableSha1(dest).kind === 'untrusted')
  )
}

function hasB2Path(pair: SyncPair): boolean {
  const [source, dest] = pair
  return (source !== null && isB2SyncPath(source)) || (dest !== null && isB2SyncPath(dest))
}

function isB2SyncPath(path: SyncPath): path is B2SyncPath {
  return 'selectedVersion' in path
}

function isLocalSyncPath(path: SyncPath): path is LocalSyncPath {
  return 'absolutePath' in path
}

/**
 * Creates a successful no-op compare preparation result for a pair.
 *
 * @param pair - Source/destination pair from {@link zipFolders}.
 * @param bytesHashed - Local file bytes read while preparing the pair.
 *
 * @returns A ready preparation result that allows action generation.
 */
export function readyComparePair(pair: SyncPair, bytesHashed = 0): ComparePreparationResult {
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

function unavailableSha1Event(pair: SyncPair): SyncSkipEvent {
  /* v8 ignore next -- unavailable SHA-1 events always have at least one side */
  const path = (pair[0] ?? pair[1])?.relativePath ?? ''
  return {
    type: 'skip',
    path,
    size: 0,
    message: 'sha1 comparison skipped because a verifiable SHA-1 is unavailable',
  }
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 1
  return Math.max(1, Math.floor(value))
}
