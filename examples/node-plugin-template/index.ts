/**
 * Public surface for the plugin template. Re-export from here so consumers
 * import a single stable entry point even as the internal layout changes.
 */

export { B2Storage, createStorage } from './storage.ts'
export type { B2StorageConfig, SignedUrlOptions } from './storage.ts'
