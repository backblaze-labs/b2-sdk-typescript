/** @packageDocumentation */

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
export { InMemoryPartnerAccountInfo } from './in-memory.ts'
export { PartnerRawClient, type PartnerRawClientOptions } from './raw.ts'
