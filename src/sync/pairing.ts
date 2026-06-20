import { filterSyncPaths } from './filters.ts'
import { compareSyncRelativePaths } from './path-order.ts'
import { validateSyncFilters } from './regexp-safety.ts'
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

  try {
    let sourceResult = await sourceIter.next()
    let destResult = await destIter.next()

    while (!sourceResult.done || !destResult.done) {
      const s = sourceResult.done ? null : sourceResult.value
      const d = destResult.done ? null : destResult.value

      if (s === null) {
        yield [null, d]
        destResult = await destIter.next()
      } else if (d === null) {
        yield [s, null]
        sourceResult = await sourceIter.next()
      } else {
        const order = compareSyncRelativePaths(s.relativePath, d.relativePath)
        if (order < 0) {
          yield [s, null]
          sourceResult = await sourceIter.next()
        } else if (order > 0) {
          yield [null, d]
          destResult = await destIter.next()
        } else {
          yield [s, d]
          sourceResult = await sourceIter.next()
          destResult = await destIter.next()
        }
      }
    }
  } finally {
    await closeScanIterator(sourceIter)
    await closeScanIterator(destIter)
  }
}

async function closeScanIterator(iterator: AsyncIterator<SyncPath>): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // Best-effort scanner cleanup should not mask the original stop reason.
  }
}

function scanWithFilters(
  folder: SyncFolder,
  filters: SyncScanOptions | undefined,
): AsyncIterable<SyncPath> {
  const scanned = folder.scan(filters)
  return folder.appliesScanFilters === true ? scanned : filterSyncPaths(scanned, filters)
}
