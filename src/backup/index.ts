/**
 * Computer Backup API client, raw bindings, and types for listing and deleting
 * backup records.
 *
 * Use this subpath when your account has sales-approved Partner API access,
 * a Master Application Key, and Enterprise Controls enabled for the target
 * group. The Backup client shares the Partner authorization model and uses the
 * `backupApiUrl` returned by Partner authorization.
 *
 * @packageDocumentation
 */

export type { PartnerAccountInfo } from '../partner/account-info.ts'
export { InMemoryPartnerAccountInfo } from '../partner/in-memory.ts'
export { partnerAuthorizeResponseToPersistableJson } from '../partner/redaction.ts'
export type {
  ComputerBackup,
  DeleteComputerRequest,
  DeleteComputerResponse,
  DeleteComputerResult,
  ListComputersRequest,
  ListComputersResponse,
  ListComputersResult,
} from '../types/backup.ts'
export type { AccountId, ComputerId, PartnerToken } from '../types/ids.ts'
export { accountId, computerId, partnerToken } from '../types/ids.ts'
export type {
  PartnerApiInfo,
  PartnerAuthorizeResponse,
  PartnerBackupApiInfo,
} from '../types/partner.ts'
export { PartnerCapability } from '../types/partner.ts'
export {
  type BackupAuthorizeOptions,
  BackupClient,
  type BackupClientJson,
  type BackupClientOptions,
  type DeleteComputerOptions,
  type ListComputersOptions,
  type PaginateComputersOptions,
} from './client.ts'
export {
  BackupRawClient,
  type BackupRawClientOptions,
  type BackupRawRequestOptions,
} from './raw.ts'
