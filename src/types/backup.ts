import type { AccountId, ComputerId } from './ids.ts'

/**
 * Request parameters for `bz_list_computers`.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface ListComputersRequest {
  /** Account ID whose active computer backups should be listed. */
  readonly accountId: AccountId
  /** Computer ID to start listing from for pagination. */
  readonly startComputerId?: ComputerId
  /** Maximum number of computers to return. The documented range is 1 through 500. */
  readonly maxComputerCount?: number
}

/**
 * Computer Backup record returned by list and delete operations.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface ComputerBackup {
  /** Unique identifier for the computer backup. */
  readonly computerId: ComputerId
  /** Name of the computer backup. */
  readonly computerName: string
  /** Timestamp in milliseconds of the last file uploaded by the backup client. */
  readonly lastFileUploadedTimestamp: number
}

/**
 * Result object returned by `bz_list_computers`.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface ListComputersResult {
  /** Next computer ID to use for pagination, or null if all computers have been listed. */
  readonly nextComputerId: ComputerId | null
  /** Active computer backups matching the request. */
  readonly computers: readonly ComputerBackup[]
}

/**
 * Wire response from `bz_list_computers`.
 *
 * The `bz_list_computers` wire response is a single JSON object containing a
 * pagination cursor and the list of computers.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export type ListComputersResponse = ListComputersResult

/**
 * Request parameters for `bz_delete_computer`.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface DeleteComputerRequest {
  /** Account ID that owns the computer backup. */
  readonly accountId: AccountId
  /** Computer ID of the backup to delete. */
  readonly computerId: ComputerId
}

/**
 * Single result element returned by `bz_delete_computer`.
 *
 * The `bz_delete_computer` wire response is a JSON array of these objects.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface DeleteComputerResult {
  /** Unique identifier for the deleted computer backup. */
  readonly computerId: ComputerId
  /** Name of the deleted computer backup. */
  readonly computerName: string
  /** Timestamp in milliseconds of the last file uploaded by the backup client. */
  readonly lastFileUploadedTimestamp: number
}

/**
 * Array-shaped wire response from `bz_delete_computer`.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export type DeleteComputerResponse = readonly DeleteComputerResult[]
