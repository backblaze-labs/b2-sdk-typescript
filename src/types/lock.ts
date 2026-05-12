import type { FileId } from './ids.js'

/** File-level Object Lock retention mode. */
export type RetentionMode = 'compliance' | 'governance'

/** Legal hold status for a file: `'on'` to apply, `'off'` to remove. */
export type LegalHoldValue = 'on' | 'off'

/** Retention settings for a specific file version under Object Lock. */
export interface FileRetentionValue {
  /** Retention mode, or null if no retention is set. */
  readonly mode: RetentionMode | null
  /** UTC timestamp (milliseconds) until which the file is retained, or null if not set. */
  readonly retainUntilTimestamp: number | null
}

/**
 * Request parameters for the `b2_update_file_retention` API call.
 * Updates the Object Lock retention settings on a file version.
 */
export interface UpdateFileRetentionRequest {
  /** Name of the file to update. */
  readonly fileName: string
  /** ID of the file version to update. */
  readonly fileId: FileId
  /** New retention settings for the file. */
  readonly fileRetention: FileRetentionValue
  /**
   * When `true`, allows shortening a governance-mode retention period. Requires
   * the `bypassGovernance` capability on the application key. Has no effect on
   * compliance-mode retention.
   */
  readonly bypassGovernance?: boolean
}

/**
 * Request parameters for the `b2_update_file_legal_hold` API call.
 * Updates the legal hold status on a file version.
 */
export interface UpdateFileLegalHoldRequest {
  /** Name of the file to update. */
  readonly fileName: string
  /** ID of the file version to update. */
  readonly fileId: FileId
  /** New legal hold status: `'on'` or `'off'`. */
  readonly legalHold: LegalHoldValue
}

/** Response from the `b2_update_file_retention` API call. */
export interface UpdateFileRetentionResponse {
  /** Name of the updated file. */
  readonly fileName: string
  /** ID of the updated file version. */
  readonly fileId: FileId
  /** Retention settings as applied. */
  readonly fileRetention: FileRetentionValue
}

/** Response from the `b2_update_file_legal_hold` API call. */
export interface UpdateFileLegalHoldResponse {
  /** Name of the updated file. */
  readonly fileName: string
  /** ID of the updated file version. */
  readonly fileId: FileId
  /** Legal hold status as applied. */
  readonly legalHold: LegalHoldValue
}
