import type { SyncFolder, SyncPath } from './types.js'

export type SyncPair = readonly [SyncPath | null, SyncPath | null]

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
