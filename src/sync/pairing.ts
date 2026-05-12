import type { SyncFolder, SyncPath } from './types.ts'

/** A paired tuple of source and destination files. Either side may be null if the file is absent. */
export type SyncPair = readonly [SyncPath | null, SyncPath | null]

/**
 * Merge-joins two sorted folder scans by relative path, yielding paired tuples.
 * Files present only in source yield `[source, null]`, only in dest yield `[null, dest]`,
 * and files in both yield `[source, dest]`.
 *
 * @param source - The source folder to scan.
 * @param dest - The destination folder to scan.
 */
export async function* zipFolders(source: SyncFolder, dest: SyncFolder): AsyncGenerator<SyncPair> {
  const sourceIter = source.scan()[Symbol.asyncIterator]()
  const destIter = dest.scan()[Symbol.asyncIterator]()

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
    } else if (s.relativePath < d.relativePath) {
      yield [s, null]
      sourceResult = await sourceIter.next()
    } else if (d.relativePath < s.relativePath) {
      yield [null, d]
      destResult = await destIter.next()
    } else {
      yield [s, d]
      sourceResult = await sourceIter.next()
      destResult = await destIter.next()
    }
  }
}
