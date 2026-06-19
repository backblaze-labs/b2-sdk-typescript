/** @packageDocumentation */

// `EncryptionKey` is documented as importable from `@backblaze-labs/b2-sdk/streams`
// (it's used alongside the content-source adapters when configuring SSE-C
// uploads). The class itself lives in `../types/encryption.ts` because
// the encryption type aliases live there; this re-export makes the
// import path match the README and IDE-autocomplete expectations.
export { EncryptionKey } from '../types/encryption.ts'
export { IncrementalSha1, sha1Hex } from './hash.ts'
export type { ProgressEvent, ProgressListener } from './progress.ts'
export type { ContentSource, FileSourceOptions, FileSourcePath } from './source.ts'
export {
  AsyncIterableSource,
  BlobSource,
  BufferSource,
  FileSource,
  StreamSource,
  toContentSource,
} from './source.ts'
