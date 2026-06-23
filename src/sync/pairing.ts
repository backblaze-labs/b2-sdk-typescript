import { filterSyncPaths } from './filters.ts'
import { compareSyncRelativePaths } from './path-order.ts'
import { validateSyncFilters } from './regexp-safety.ts'
import { assertScanEntryLimit, scanEntryLimit } from './scan-limit.ts'
import type { SyncFolder, SyncPath, SyncScanOptions } from './types.ts'

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
 */
export async function* zipFolders(
  source: SyncFolder,
  dest: SyncFolder,
  options: SyncScanOptions = {},
): AsyncGenerator<SyncPair> {
  validateSyncFilters(options)
  const sourceIter = scanWithFilters(source, options)[Symbol.asyncIterator]()
  const destIter = scanWithFilters(dest, options)[Symbol.asyncIterator]()
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
  filters: SyncScanOptions | undefined,
): AsyncIterable<SyncPath> {
  const scanned = filterSyncPaths(folder.scan(filters), filters)
  if (folder.appliesScanSorting === true) return scanned
  return sortSyncPaths(scanned, filters)
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
