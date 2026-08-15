import type { Capability } from './auth.ts'
import type { AccountId, ApplicationKeyId, BucketId, GroupId, PartnerToken } from './ids.ts'

export type { ComputerId, GroupId, PartnerToken } from './ids.ts'
export { computerId, groupId, partnerToken } from './ids.ts'

/**
 * Named constants for Partner API and Computer Backup API capabilities.
 *
 * Partner grant sets are separate from the storage-facing capability set. The
 * Partner and Backup authorization surfaces currently document the full-access
 * grant as `all`.
 */
export const PartnerCapability = {
  /** Full Partner API or Computer Backup API access for the authorized key. */
  All: 'all',
} as const

/** Partner API or Computer Backup API capability derived from {@link PartnerCapability}. */
export type PartnerCapability = (typeof PartnerCapability)[keyof typeof PartnerCapability]

/**
 * Named constants for Backblaze regions accepted by Partner API account-creation endpoints.
 */
export const Region = {
  /** US East region. */
  UsEast: 'us-east',
  /** US West region. */
  UsWest: 'us-west',
  /** Canada East region. */
  CaEast: 'ca-east',
  /** EU Central region. */
  EuCentral: 'eu-central',
} as const

/** Backblaze region identifier derived from {@link Region}. */
export type Region = (typeof Region)[keyof typeof Region]

/** Partner API endpoint information returned by `b2_authorize_account`. */
export interface PartnerGroupsApiInfo {
  /** Capabilities granted for Partner API calls, currently documented as `['all']`. */
  readonly capabilities: readonly PartnerCapability[]
  /** Base URL for Partner API calls. */
  readonly groupsApiUrl: string
  /** Discriminator indicating this is Partner API information. */
  readonly infoType: 'groupsApi'
}

/** Computer Backup API endpoint information returned by `b2_authorize_account`. */
export interface PartnerBackupApiInfo {
  /** Capabilities granted for Computer Backup API calls, currently documented as `['all']`. */
  readonly capabilities: readonly PartnerCapability[]
  /** Base URL for Computer Backup API calls. */
  readonly backupApiUrl: string
  /** Discriminator indicating this is Computer Backup API information. */
  readonly infoType: 'backupApi'
}

/** Storage API endpoint information returned alongside Partner authorization details. */
export interface PartnerStorageApiInfo {
  /** Minimum allowed part size for large file uploads, in bytes. */
  readonly absoluteMinimumPartSize: number
  /** Base URL for B2 Native API calls. */
  readonly apiUrl: string
  /** Bucket ID this key is restricted to, or null if unrestricted. */
  readonly bucketId: BucketId | null
  /** Bucket name this key is restricted to, or null if unrestricted or unavailable. */
  readonly bucketName: string | null
  /** Storage API capabilities granted to this key. */
  readonly capabilities: readonly Capability[]
  /** Base URL for file downloads. */
  readonly downloadUrl: string
  /** Discriminator indicating this is storage API information. */
  readonly infoType: 'storageApi'
  /** File name prefix this key is restricted to, or null if unrestricted. */
  readonly namePrefix: string | null
  /** Recommended part size for large file uploads, in bytes. */
  readonly recommendedPartSize: number
  /** Base URL for the S3-compatible API. */
  readonly s3ApiUrl: string
}

/**
 * API-specific information needed by Partner and Computer Backup API clients.
 * At least one of `groupsApi` or `backupApi` is present in a normalized
 * Partner authorization response. Suite URLs and capabilities in this object
 * are the authoritative values; flattened fields on
 * {@link PartnerAuthorizeResponse} are convenience mirrors.
 */
export interface PartnerApiInfo {
  /** B2 Native API configuration returned with Partner authorization details when storage is enabled. */
  readonly storageApi?: PartnerStorageApiInfo
  /** Partner API configuration, present when the authorized account has Partner API access. */
  readonly groupsApi?: PartnerGroupsApiInfo
  /** Computer Backup API configuration, present when the authorized account has Backup API access. */
  readonly backupApi?: PartnerBackupApiInfo
}

/** Response from Partner-oriented `b2_authorize_account`. */
export interface PartnerAuthorizeResponse {
  /** Account ID for the authorized partner administrator. */
  readonly accountId: AccountId
  /** Authorization token to use for Partner API and Computer Backup API requests. Do not log this secret value. */
  readonly authorizationToken: PartnerToken
  /** Suite-shaped API information returned by `b2_authorize_account`; authoritative for suite URLs and capabilities. */
  readonly apiInfo: PartnerApiInfo
  /** Convenience mirror of `apiInfo.groupsApi.groupsApiUrl` when the Partner suite is enabled. */
  readonly groupsApiUrl?: string
  /** Convenience mirror of `apiInfo.backupApi.backupApiUrl` when the Backup suite is enabled. */
  readonly backupApiUrl?: string
  /** Convenience mirror of `apiInfo.groupsApi.capabilities` when the Partner suite is enabled. */
  readonly groupsCapabilities?: readonly PartnerCapability[]
  /** Convenience mirror of `apiInfo.backupApi.capabilities` when the Backup suite is enabled. */
  readonly backupCapabilities?: readonly PartnerCapability[]
  /** Expiration timestamp of the application key in milliseconds, or null if the key does not expire. */
  readonly applicationKeyExpirationTimestamp: number | null
}

/**
 * Request parameters for `b2_create_group_member`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface CreateGroupMemberRequest {
  /** Account ID of the group administrator authorized for the Partner API. */
  readonly adminAccountId: AccountId
  /** Group ID that the new Backblaze account will join. */
  readonly groupId: GroupId
  /** Email address for the new group member account. */
  readonly memberEmail: string
  /** Region for the new account's data, or null to use the current default region. */
  readonly region?: Region | null
}

/**
 * Group member fields returned by Partner API membership operations.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerGroupMember {
  /** Account ID for the group member. Group member account IDs reuse the SDK's existing AccountId brand. */
  readonly accountId: AccountId
  /** Email address of the group member account. */
  readonly email: string
  /** Group ID that contains the member. */
  readonly groupId: GroupId
  /** Name of the group that contains the member. */
  readonly groupName: string
  /** Region where the group member account's data resides. */
  readonly region: Region
  /** S3-compatible endpoint domain for the group member account. */
  readonly s3Endpoint: string
}

/**
 * Single result element returned by `b2_create_group_member`.
 *
 * The `b2_create_group_member` wire response is a JSON array of these objects.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface CreateGroupMemberResult {
  /** Application key ID for the new group member account. */
  readonly applicationKeyId: ApplicationKeyId
  /** Application key secret for the new group member account. Do not log this secret value. */
  readonly applicationKey: string
  /** Newly created group member account details. */
  readonly groupMember: PartnerGroupMember
}

/**
 * Array-shaped wire response from `b2_create_group_member`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type CreateGroupMemberResponse = readonly CreateGroupMemberResult[]

/**
 * Request parameters for `b2_eject_group_member`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface EjectGroupMemberRequest {
  /** Account ID of the group administrator authorized for the Partner API. */
  readonly adminAccountId: AccountId
  /** Group ID that currently contains the member. */
  readonly groupId: GroupId
  /** Account ID of the group member being ejected. */
  readonly memberAccountId: AccountId
  /** Replacement email for the ejected account, or null to keep the current email address. */
  readonly email?: string | null
}

/**
 * Single result element returned by `b2_eject_group_member`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type EjectGroupMemberResult = PartnerGroupMember

/**
 * Single-object wire response from `b2_eject_group_member`.
 *
 * B2 returns one ejected-member object (not an array), unlike
 * `b2_create_group_member` which returns an array.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type EjectGroupMemberResponse = EjectGroupMemberResult

/**
 * Request parameters for `b2_list_groups`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupsRequest {
  /** Account ID of the group administrator authorized for the Partner API. */
  readonly adminAccountId: AccountId
  /** Optional group name filter. Multiple groups may share the same name. */
  readonly groupName?: string
  /** Group ID to start listing from for pagination. */
  readonly startGroupId?: GroupId
  /** Maximum number of groups to return. The documented range is 1 through 100. */
  readonly maxGroupCount?: number
}

/**
 * B2 storage statistics returned for partner groups and group members.
 *
 * The Partner API currently returns count fields as JSON strings even though
 * they are numeric-looking values. The SDK preserves those decimal strings
 * instead of normalizing them to numbers.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerB2Stats {
  /** Total bytes stored as a decimal string. */
  readonly b2BytesStoredCount: string
  /** Total files stored as a decimal string. */
  readonly b2FilesStoredCount: string
  /** ISO 8601 UTC date-time string for the daily B2 statistics snapshot, or null if unavailable. */
  readonly b2StatsAsOfTimestamp: string | null
  /** Total bucket count as a decimal string. */
  readonly bucketCount: string
}

/**
 * Account standing information for a partner group.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerAccountStandingDetails {
  /** Account standing state reported by the Partner API. */
  readonly state: string
}

/**
 * Daily group statistics returned by `b2_list_groups`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerGroupStats {
  /** ISO 8601 UTC date-time string for when the group was created. */
  readonly createdTimestamp: string
  /** ISO 8601 UTC date-time string for the last update to the group's statistics. */
  readonly groupStatsAsOfTimestamp: string
  /** Total number of accepted members in the group. */
  readonly memberCount: number
}

/**
 * Group record returned by `b2_list_groups`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerGroup {
  /** Account standing information for the group. */
  readonly accountStandingDetails: PartnerAccountStandingDetails
  /** B2 storage statistics for the group. Count fields are preserved as decimal strings. */
  readonly b2Stats: PartnerB2Stats
  /** Unique ID of the group. */
  readonly groupId: GroupId
  /** Human-readable group name. */
  readonly groupName: string
  /** Products enabled for the group, such as `BACKUP` or `STORAGE`. */
  readonly groupProducts: readonly string[]
  /** Daily aggregate statistics for the group. */
  readonly groupStats: PartnerGroupStats
}

/**
 * Single result element returned by `b2_list_groups`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupsResult {
  /** Account ID for the group administrator whose groups were listed. */
  readonly accountId: AccountId
  /** Groups matching the request. */
  readonly groups: readonly PartnerGroup[]
  /** Next group ID to use for pagination, or null if all groups have been listed. */
  readonly nextGroupId: GroupId | null
}

/**
 * Single-object wire response from `b2_list_groups`.
 *
 * B2 returns one object with `accountId`, `groups`, and the `nextGroupId`
 * cursor (not an array), unlike `b2_list_group_members` which returns an array.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type ListGroupsResponse = ListGroupsResult

/**
 * Request parameters for `b2_list_group_members`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupMembersRequest {
  /** Account ID of the group administrator authorized for the Partner API. */
  readonly adminAccountId: AccountId
  /** Group ID whose active members should be listed. */
  readonly groupId: GroupId
  /** First member email address to return for pagination. */
  readonly startEmail?: string
  /** Maximum number of group members to return. The documented maximum is 1000. */
  readonly maxMemberCount?: number
}

/**
 * Group member record returned by `b2_list_group_members`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListedGroupMember extends PartnerGroupMember {
  /** B2 storage statistics for the member. Count fields are preserved as decimal strings. */
  readonly b2Stats: PartnerB2Stats
}

/**
 * Single result element returned by `b2_list_group_members`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupMembersResult {
  /** Group ID whose members were listed. */
  readonly groupId: GroupId
  /** Human-readable group name. */
  readonly groupName: string
  /** Next email address to use for pagination, or null if all members have been listed. */
  readonly nextEmail: string | null
  /** Active accepted group members matching the request. */
  readonly groupMembers: readonly ListedGroupMember[]
}

/**
 * Array-shaped wire response from `b2_list_group_members`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type ListGroupMembersResponse = readonly ListGroupMembersResult[]

/**
 * Single request element accepted by `b2_reserve_trial_create_account`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ReserveTrialCreateAccountRequestEntry {
  /** Email address for the new B2 reserve trial account. */
  readonly email: string
  /** Region for the new account's data, or null to let Backblaze choose. */
  readonly region?: Region | null
  /** Trial duration in days. The documented range is 7 through 30. */
  readonly term: number
  /** Trial storage amount in TB. The documented range is 1 through 50. */
  readonly storage: number
}

/**
 * Array-shaped wire request body for `b2_reserve_trial_create_account`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type ReserveTrialCreateAccountRequest = readonly ReserveTrialCreateAccountRequestEntry[]

/**
 * Single result element returned by `b2_reserve_trial_create_account`.
 *
 * The `b2_reserve_trial_create_account` wire response is a JSON array of
 * these objects.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ReserveTrialCreateAccountResult {
  /** Account ID of the newly created B2 reserve trial account. */
  readonly accountId: AccountId
  /** Application key secret for the new account. Do not log this secret value. */
  readonly applicationKey: string
  /** Application key ID for the new account. */
  readonly applicationKeyId: ApplicationKeyId
  /** S3-compatible endpoint domain for the new account. */
  readonly s3Endpoint: string
  /** Trial start date in ISO 8601 `yyyy-MM-dd` format in UTC. */
  readonly startDate: string
  /** Trial end date in ISO 8601 `yyyy-MM-dd` format in UTC. */
  readonly endDate: string
  /** Email address for the new B2 reserve trial account. */
  readonly email: string
  /** Bucket name accessible with the returned application key. */
  readonly bucketName: string
  /** Bucket ID accessible with the returned application key. */
  readonly bucketId: BucketId
}

/**
 * Array-shaped wire response from `b2_reserve_trial_create_account`.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export type ReserveTrialCreateAccountResponse = readonly ReserveTrialCreateAccountResult[]
