import { filterSyncPaths } from './filters.ts'
import { compareSyncRelativePaths } from './path-order.ts'
import { validateSyncFilters } from './regexp-safety.ts'
import { assertScanEntryLimit, scanEntryLimit } from './scan-limit.ts'
import type {
  SyncFilterPattern,
  SyncFolder,
  SyncPath,
  SyncScanOptions,
  SyncSkipEvent,
} from './types.ts'

/** A paired tuple of source and destination files. Either side may be null if the file is absent. */
export type SyncPair = readonly [SyncPath | null, SyncPath | null]

/**
 * Merge-joins two sorted folder scans by relative path, yielding paired tuples.
 * Files present only in source yield `[source, null]`, only in dest yield `[null, dest]`,
 * and files in both yield `[source, dest]`.
 *
 * @param source - The source folder to scan.
 * @param dest - The destination folder to scan.
 * @param options - Optional scan controls and filters shared by both folders.
 * @param scanCallbacks - Optional internal source/destination skip callbacks.
 */
export async function* zipFolders(
  source: SyncFolder,
  dest: SyncFolder,
  options: SyncScanOptions = {},
  scanCallbacks: {
    readonly onSourceSkip?: (event: SyncSkipEvent) => void
    readonly onDestSkip?: (event: SyncSkipEvent) => void
  } = {},
): AsyncGenerator<SyncPair> {
  validateSyncFilters(options)
  const sourceOptions = scanOptionsSnapshot(options, scanCallbacks.onSourceSkip)
  const destOptions = scanOptionsSnapshot(options, scanCallbacks.onDestSkip)
  const sourceIter = scanWithFilters(source, sourceOptions)[Symbol.asyncIterator]()
  const destIter = scanWithFilters(dest, destOptions)[Symbol.asyncIterator]()
  let sourceDone = false
  let destDone = false

  try {
    let [sourceResult, destResult] = await Promise.all([sourceIter.next(), destIter.next()])
    sourceDone = sourceResult.done === true
    destDone = destResult.done === true

    while (!sourceResult.done || !destResult.done) {
      const s = sourceResult.done ? null : sourceResult.value
      const d = destResult.done ? null : destResult.value

      if (s === null) {
        yield [null, d]
        destResult = await destIter.next()
        destDone = destResult.done === true
      } else if (d === null) {
        yield [s, null]
        sourceResult = await sourceIter.next()
        sourceDone = sourceResult.done === true
      } else {
        const comparison = compareSyncRelativePaths(s.relativePath, d.relativePath)
        if (comparison < 0) {
          yield [s, null]
          sourceResult = await sourceIter.next()
          sourceDone = sourceResult.done === true
        } else if (comparison > 0) {
          yield [null, d]
          destResult = await destIter.next()
          destDone = destResult.done === true
        } else {
          yield [s, d]
          sourceResult = await sourceIter.next()
          destResult = await destIter.next()
          sourceDone = sourceResult.done === true
          destDone = destResult.done === true
        }
      }
    }
  } finally {
    await closeScanIterator(sourceIter, sourceDone)
    await closeScanIterator(destIter, destDone)
  }
}

async function closeScanIterator(
  iterator: AsyncIterator<SyncPath>,
  alreadyDone: boolean,
): Promise<void> {
  if (alreadyDone || iterator.return === undefined) return
  try {
    await iterator.return()
  } catch {
    // Best-effort scanner cleanup should not mask the original stop reason.
  }
}

function scanWithFilters(
  folder: SyncFolder,
  options: { readonly scanner: SyncScanOptions; readonly sdk: SyncScanOptions },
): AsyncIterable<SyncPath> {
  const scanned = filterSyncPaths(folder.scan(options.scanner), options.sdk)
  if (folder.appliesScanSorting === true) return limitSyncPaths(scanned, options.sdk)
  return sortSyncPaths(scanned, options.sdk)
}

async function* limitSyncPaths(
  paths: AsyncIterable<SyncPath>,
  filters: SyncScanOptions | undefined,
): AsyncGenerator<SyncPath> {
  const maxScanEntries = scanEntryLimit(filters)
  let count = 0
  for await (const path of paths) {
    count++
    assertScanEntryLimit(count, maxScanEntries)
    yield path
  }
}

async function* sortSyncPaths(
  paths: AsyncIterable<SyncPath>,
  filters: SyncScanOptions | undefined,
): AsyncGenerator<SyncPath> {
  const maxScanEntries = scanEntryLimit(filters)
  const collected: SyncPath[] = []
  for await (const path of paths) {
    collected.push(path)
    assertScanEntryLimit(collected.length, maxScanEntries)
  }
  collected.sort((a, b) => compareSyncRelativePaths(a.relativePath, b.relativePath))
  yield* collected
}

function scanOptionsSnapshot(
  options: SyncScanOptions,
  onSkip: ((event: SyncSkipEvent) => void) | undefined,
): { readonly scanner: SyncScanOptions; readonly sdk: SyncScanOptions } {
  const onSkipSnapshot =
    options.onSkip === undefined && onSkip === undefined
      ? undefined
      : (event: SyncSkipEvent): void => {
          options.onSkip?.(event)
          onSkip?.(event)
        }

  return {
    scanner: frozenScanOptions(
      options,
      frozenPatterns(options.include),
      frozenPatterns(options.exclude),
      onSkipSnapshot,
    ),
    sdk: frozenScanOptions(
      options,
      frozenPatterns(options.include),
      frozenPatterns(options.exclude),
      onSkipSnapshot,
    ),
  }
}

function frozenScanOptions(
  options: SyncScanOptions,
  include: readonly SyncFilterPattern[] | undefined,
  exclude: readonly SyncFilterPattern[] | undefined,
  onSkip: ((event: SyncSkipEvent) => void) | undefined,
): SyncScanOptions {
  return Object.freeze({
    ...(include !== undefined ? { include } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(onSkip !== undefined ? { onSkip } : {}),
    ...(options.requireLocalSafePaths !== undefined
      ? { requireLocalSafePaths: options.requireLocalSafePaths }
      : {}),
    ...(options.maxScanEntries !== undefined ? { maxScanEntries: options.maxScanEntries } : {}),
  })
}

function frozenPatterns(
  patterns: readonly SyncFilterPattern[] | undefined,
): readonly SyncFilterPattern[] | undefined {
  return patterns === undefined ? undefined : Object.freeze([...patterns])
}
