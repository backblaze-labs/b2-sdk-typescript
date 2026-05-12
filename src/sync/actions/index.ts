import type { SyncEvent } from '../types.js'

export type SyncActionType =
  | 'upload'
  | 'download'
  | 'copy'
  | 'hide'
  | 'delete-remote'
  | 'delete-local'
  | 'skip'

export interface SyncAction {
  readonly type: SyncActionType
  readonly relativePath: string
  readonly size: number
  execute(dryRun: boolean): Promise<SyncEvent>
}

export class UploadAction implements SyncAction {
  readonly type = 'upload' as const

  constructor(
    readonly relativePath: string,
    readonly absolutePath: string,
    readonly size: number,
    private readonly doUpload: (absolutePath: string, relativePath: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doUpload(this.absolutePath, this.relativePath)
    }
    return { type: 'upload-done', path: this.relativePath, size: this.size }
  }
}

export class DownloadAction implements SyncAction {
  readonly type = 'download' as const

  constructor(
    readonly relativePath: string,
    readonly size: number,
    private readonly doDownload: (relativePath: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDownload(this.relativePath)
    }
    return { type: 'download-done', path: this.relativePath, size: this.size }
  }
}

export class CopyAction implements SyncAction {
  readonly type = 'copy' as const

  constructor(
    readonly relativePath: string,
    readonly size: number,
    private readonly doCopy: (relativePath: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doCopy(this.relativePath)
    }
    return { type: 'copy-done', path: this.relativePath, size: this.size }
  }
}

export class HideAction implements SyncAction {
  readonly type = 'hide' as const
  readonly size = 0

  constructor(
    readonly relativePath: string,
    private readonly doHide: (relativePath: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doHide(this.relativePath)
    }
    return { type: 'hide', path: this.relativePath, size: 0 }
  }
}

export class DeleteRemoteAction implements SyncAction {
  readonly type = 'delete-remote' as const
  readonly size = 0

  constructor(
    readonly relativePath: string,
    readonly fileId: string,
    private readonly doDelete: (fileId: string, fileName: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDelete(this.fileId, this.relativePath)
    }
    return { type: 'delete-remote', path: this.relativePath, size: 0 }
  }
}

export class DeleteLocalAction implements SyncAction {
  readonly type = 'delete-local' as const
  readonly size = 0

  constructor(
    readonly relativePath: string,
    readonly absolutePath: string,
    private readonly doDelete: (absolutePath: string) => Promise<void>,
  ) {}

  async execute(dryRun: boolean): Promise<SyncEvent> {
    if (!dryRun) {
      await this.doDelete(this.absolutePath)
    }
    return { type: 'delete-local', path: this.relativePath, size: 0 }
  }
}

export class SkipAction implements SyncAction {
  readonly type = 'skip' as const
  readonly size = 0

  constructor(
    readonly relativePath: string,
    readonly reason: string,
  ) {}

  async execute(_dryRun: boolean): Promise<SyncEvent> {
    return { type: 'skip', path: this.relativePath, size: 0, message: this.reason }
  }
}
