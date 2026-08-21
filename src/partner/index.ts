/**
 * Partner API client, raw bindings, and types for groups, group members, and
 * B2 Reserve trial account creation.
 *
 * Use this subpath when your account has Business Groups enabled,
 * sales-approved Partner API access, a Master Application Key, and the account
 * prerequisites required by the Partner API operation you are calling. Partner
 * authorization is separate from storage authorization and returns Partner API
 * and Computer Backup endpoint information through {@link PartnerAccountInfo}.
 * Pure redacted-projection helpers such as
 * {@link partnerAuthorizeResponseToRedactedJson},
 * {@link createGroupMemberResponseToRedactedJson}, and
 * {@link reserveTrialCreateAccountResponseToRedactedJson} return JSON-safe
 * copies for logs, audit records, and other untrusted output without exposing
 * Partner tokens or one-time application key secrets. The SDK's in-place
 * serialization hook installers remain internal to the client and raw binding
 * implementations.
 *
 * @packageDocumentation
 */

export type {
  AccountId,
  ApplicationKeyId,
  ComputerId,
  GroupId,
  PartnerToken,
} from '../types/ids.ts'
export { accountId, applicationKeyId, partnerToken } from '../types/ids.ts'
export type {
  CreateGroupMemberRequest,
  CreateGroupMemberResponse,
  CreateGroupMemberResult,
  EjectGroupMemberRequest,
  EjectGroupMemberResponse,
  EjectGroupMemberResult,
  ListedGroupMember,
  ListGroupMembersRequest,
  ListGroupMembersResponse,
  ListGroupMembersResult,
  ListGroupsRequest,
  ListGroupsResponse,
  ListGroupsResult,
  PartnerAccountStandingDetails,
  PartnerApiInfo,
  PartnerAuthorizeResponse,
  PartnerB2Stats,
  PartnerBackupApiInfo,
  PartnerGroup,
  PartnerGroupMember,
  PartnerGroupStats,
  PartnerGroupsApiInfo,
  PartnerStorageApiInfo,
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResponse,
  ReserveTrialCreateAccountResult,
} from '../types/partner.ts'
export { computerId, groupId, PartnerCapability, Region } from '../types/partner.ts'
export type { PartnerAccountInfo } from './account-info.ts'
export { partnerAuthorizeResponseForPersistence } from './auth-clone.ts'
export {
  type CreateGroupMemberOptions,
  type EjectGroupMemberOptions,
  type ListGroupMembersOptions,
  type ListGroupsOptions,
  type PaginateGroupMembersOptions,
  type PaginateGroupsOptions,
  type PartnerAuthorizeOptions,
  PartnerClient,
  type PartnerClientJson,
  type PartnerClientOptions,
  type ReserveTrialAccountsOptions,
} from './client.ts'
export {
  InMemoryPartnerAccountInfo,
  type InMemoryPartnerAccountInfoJson,
} from './in-memory.ts'
export {
  PartnerRawClient,
  type PartnerRawClientOptions,
  type PartnerRawRequestOptions,
} from './raw.ts'
export type {
  RedactedCreateGroupMemberResponseJson,
  RedactedCreateGroupMemberResultJson,
  RedactedPartnerAuthorizeResponseJson,
  RedactedReserveTrialCreateAccountResponseJson,
  RedactedReserveTrialCreateAccountResultJson,
} from './redaction.ts'
export {
  APPLICATION_KEY_REDACTED,
  createGroupMemberResponseToRedactedJson,
  createGroupMemberResultToRedactedJson,
  PARTNER_TOKEN_REDACTED,
  partnerAuthorizeResponseToRedactedJson,
  reserveTrialCreateAccountResponseToRedactedJson,
  reserveTrialCreateAccountResultToRedactedJson,
} from './redaction.ts'
