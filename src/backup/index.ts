/** @packageDocumentation */

export type { PartnerAccountInfo } from '../partner/account-info.ts'
export { InMemoryPartnerAccountInfo } from '../partner/in-memory.ts'
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
