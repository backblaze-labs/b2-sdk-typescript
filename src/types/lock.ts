import type { FileId } from './ids.js'

export type RetentionMode = 'compliance' | 'governance'
export type LegalHoldValue = 'on' | 'off'

export interface FileRetentionValue {
  readonly mode: RetentionMode | null
  readonly retainUntilTimestamp: number | null
}

export interface UpdateFileRetentionRequest {
  readonly fileName: string
  readonly fileId: FileId
  readonly fileRetention: FileRetentionValue
}

export interface UpdateFileLegalHoldRequest {
  readonly fileName: string
  readonly fileId: FileId
  readonly legalHold: LegalHoldValue
}

export interface UpdateFileRetentionResponse {
  readonly fileName: string
  readonly fileId: FileId
  readonly fileRetention: FileRetentionValue
}

export interface UpdateFileLegalHoldResponse {
  readonly fileName: string
  readonly fileId: FileId
  readonly legalHold: LegalHoldValue
}
