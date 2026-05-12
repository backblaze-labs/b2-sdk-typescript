import type { SyncEvent } from '../types.js'

/** Discriminated union of all sync action types. */
export type SyncActionType =
  | 'upload'
  | 'download'
  | 'copy'
  | 'hide'
  | 'delete-remote'
  | 'delete-local'
  | 'skip'

/** A single executable sync action produced by the policy engine. */
export interface SyncAction {
  /** The kind of action. */
  readonly type: SyncActionType
  /** Relative path of the file this action targets. */
  readonly relativePath: string
  /** Size in bytes of the file, or 0 for metadata-only actions. */
  readonly size: number
  /**
   * Executes the action (or no-ops if dryRun is true) and returns a corresponding event.
   * @param dryRun - When true, skip the actual I/O but still return the event.
   */
  execute(dryRun: boolean): Promise<SyncEvent>
}

/** Uploads a local file to B2. */
export class UploadAction implements SyncAction {
  readonly type = 'upload' as const

  /**
   * Creates a new UploadAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param absolutePath - Absolute local filesystem path.
   * @param size - File size in bytes.
   * @param doUpload - Callback that performs the actual upload.
   */
  constructor(
    readonly relativePath: string,
    readonly absolutePath: string,
    readonly size: number,
    private readonly doUpload: (absolutePath: string, relativePath: string) => Promise<void>,
  ) {}

  /** Uploads the file (unless dryRun) and returns an 'upload-done' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doUpload(this.absolutePath, this.relativePath)
    }
    return { type: 'upload-done', path: this.relativePath, size: this.size }
  }
}

/** Downloads a B2 file to the local filesystem. */
export class DownloadAction implements SyncAction {
  readonly type = 'download' as const

  /**
   * Creates a new DownloadAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param size - File size in bytes.
   * @param doDownload - Callback that performs the actual download.
   */
  constructor(
    readonly relativePath: string,
    readonly size: number,
    private readonly doDownload: (relativePath: string) => Promise<void>,
  ) {}

  /** Downloads the file (unless dryRun) and returns a 'download-done' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDownload(this.relativePath)
    }
    return { type: 'download-done', path: this.relativePath, size: this.size }
  }
}

/** Server-side copies a B2 file to a new key within the same or different bucket. */
export class CopyAction implements SyncAction {
  readonly type = 'copy' as const

  /**
   * Creates a new CopyAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param size - File size in bytes.
   * @param doCopy - Callback that performs the server-side copy.
   */
  constructor(
    readonly relativePath: string,
    readonly size: number,
    private readonly doCopy: (relativePath: string) => Promise<void>,
  ) {}

  /** Copies the file (unless dryRun) and returns a 'copy-done' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doCopy(this.relativePath)
    }
    return { type: 'copy-done', path: this.relativePath, size: this.size }
  }
}

/** Hides a file in B2 by creating a hide marker (soft delete). */
export class HideAction implements SyncAction {
  readonly type = 'hide' as const
  readonly size = 0

  /**
   * Creates a new HideAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param doHide - Callback that creates the hide marker.
   */
  constructor(
    readonly relativePath: string,
    private readonly doHide: (relativePath: string) => Promise<void>,
  ) {}

  /** Hides the file (unless dryRun) and returns a 'hide' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doHide(this.relativePath)
    }
    return { type: 'hide', path: this.relativePath, size: 0 }
  }
}

/** Permanently deletes a specific file version from B2. */
export class DeleteRemoteAction implements SyncAction {
  readonly type = 'delete-remote' as const
  readonly size = 0

  /**
   * Creates a new DeleteRemoteAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param fileId - The B2 file version ID to delete.
   * @param doDelete - Callback that performs the deletion.
   */
  constructor(
    readonly relativePath: string,
    readonly fileId: string,
    private readonly doDelete: (fileId: string, fileName: string) => Promise<void>,
  ) {}

  /** Deletes the remote file version (unless dryRun) and returns a 'delete-remote' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDelete(this.fileId, this.relativePath)
    }
    return { type: 'delete-remote', path: this.relativePath, size: 0 }
  }
}

/** Deletes a file from the local filesystem. */
export class DeleteLocalAction implements SyncAction {
  readonly type = 'delete-local' as const
  readonly size = 0

  /**
   * Creates a new DeleteLocalAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param absolutePath - Absolute local filesystem path.
   * @param doDelete - Callback that performs the deletion.
   */
  constructor(
    readonly relativePath: string,
    readonly absolutePath: string,
    private readonly doDelete: (absolutePath: string) => Promise<void>,
  ) {}

  /** Deletes the local file (unless dryRun) and returns a 'delete-local' event. */
  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDelete(this.absolutePath)
    }
    return { type: 'delete-local', path: this.relativePath, size: 0 }
  }
}

/** Represents a no-op action for files that do not need syncing. */
export class SkipAction implements SyncAction {
  readonly type = 'skip' as const
  readonly size = 0

  /**
   * Creates a new SkipAction for the given relative path.
   * @param relativePath - Path relative to the sync root.
   * @param reason - Human-readable explanation for why the file was skipped.
   */
  constructor(
    readonly relativePath: string,
    readonly reason: string,
  ) {}

  /** Returns a 'skip' event with the reason message. No I/O is performed. */
  async execute(_dryRun: boolean): Promise<SyncEvent> {
    return { type: 'skip', path: this.relativePath, size: 0, message: this.reason }
  }
}
