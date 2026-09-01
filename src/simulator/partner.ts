import { Capability } from '../types/auth.ts'
import type { ComputerBackup } from '../types/backup.ts'
import type { BucketInfo, BucketType } from '../types/bucket.ts'
import {
  accountId as accountIdOf,
  applicationKeyId as applicationKeyIdOf,
  computerId as computerIdOf,
  groupId as groupIdOf,
} from '../types/ids.ts'
import {
  type CreateGroupMemberRequest,
  type CreateGroupMemberResult,
  type EjectGroupMemberRequest,
  type EjectGroupMemberResponse,
  type ListedGroupMember,
  type ListGroupMembersRequest,
  type ListGroupMembersResult,
  type ListGroupsResult,
  type PartnerB2Stats,
  PartnerCapability,
  type PartnerGroup,
  type PartnerGroupMember,
  Region,
  type ReserveTrialCreateAccountRequestEntry,
  type ReserveTrialCreateAccountResult,
} from '../types/partner.ts'
import type { B2SimulatorOptions, SimulatorJsonResponse } from './index.ts'
import {
  missingPartnerCapabilities,
  PARTNER_ENDPOINT_NAMES,
  PartnerEndpoint,
  partnerEndpointCapabilityRequirementFor,
} from './partner-capabilities.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const PARTNER_REGIONS = new Set<string>(Object.values(Region))
const PARTNER_API_ENDPOINTS = new Set<PartnerEndpoint>(PARTNER_ENDPOINT_NAMES)
const DEFAULT_GROUP_COUNT = 3
const MAX_GROUPS_PER_ADMIN = 500
const DEFAULT_MAX_GROUP_COUNT = 100 // Default group page size.
const MAX_GROUP_COUNT = 100 // Maximum accepted group page size.
const MAX_AUTO_PROVISIONED_ADMINS = 100
const MAX_GROUP_MEMBERS = 5000
const DEFAULT_MAX_MEMBER_COUNT = 100
const MAX_MEMBER_COUNT = 1000
const DEFAULT_MAX_COMPUTER_COUNT = 100
const MIN_COMPUTER_COUNT = 1
const MAX_COMPUTER_COUNT = 500
const DEFAULT_COMPUTER_COUNT = 3
const MAX_AUTO_PROVISIONED_BACKUP_ACCOUNTS = 100
const PARTNER_CREATED_STORAGE_KEY_CAPABILITIES = Object.freeze([
  Capability.ListBuckets,
  Capability.ReadBuckets,
  Capability.WriteBuckets,
  Capability.ListFiles,
  Capability.ReadFiles,
  Capability.WriteFiles,
  Capability.DeleteFiles,
])

function isPartnerApiEndpoint(endpoint: string): endpoint is PartnerEndpoint {
  return PARTNER_API_ENDPOINTS.has(endpoint as PartnerEndpoint)
}

const PARTNER_QUERY_ENDPOINTS = new Set<PartnerEndpoint>([
  PartnerEndpoint.ListGroups,
  PartnerEndpoint.ListGroupMembers,
  PartnerEndpoint.ListComputers,
])

/**
 * Checks whether a JSON API endpoint can safely receive GET query parameters.
 *
 * @param endpoint - Endpoint name parsed from the request path.
 *
 * @returns `true` for Partner/Backup list endpoints that document GET query requests.
 */
export function isPartnerQueryEndpoint(endpoint: string): boolean {
  return PARTNER_QUERY_ENDPOINTS.has(endpoint as PartnerEndpoint)
}

function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// B2 Partner API timestamps are `dYYYYMMDD_mHHMMSS` (UTC), not ISO 8601.
function b2FriendlyTimestamp(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const day = `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  return `d${day}_m${time}`
}

function utcDayStartMs(ms: number): number {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

interface IssuedPartnerToken {
  readonly accountId: string
  readonly backupCapabilities: readonly PartnerCapability[]
  readonly expiresAt: number
  readonly groupsCapabilities: readonly PartnerCapability[]
}

interface AuthorizedPartnerRequest {
  readonly accountId: string | null
}

interface StoredPartnerGroup {
  readonly adminAccountId: string
  readonly groupId: string
  readonly groupName: string
  readonly groupProducts: readonly string[]
  readonly createdTimestamp: number
  deleted: boolean
}

interface StoredPartnerGroupMember {
  readonly accountId: string
  email: string
  normalizedEmail: string
  readonly groupId: string
  readonly groupName: string
  readonly region: Region
  readonly s3Endpoint: string
  readonly applicationKeyId: string
  readonly applicationKey: string
  readonly createdTimestamp: number
  ejected: boolean
}

interface StoredComputerBackup {
  readonly accountId: string
  readonly computerId: string
  readonly computerName: string
  readonly lastFileUploadedTimestamp: number
  deleted: boolean
}

function requestObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function isValidEmailAddress(email: string): boolean {
  const trimmed = email.trim()
  if (trimmed !== email || trimmed.length < 3 || trimmed.length > 254) return false
  const at = trimmed.indexOf('@')
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return false
  const domain = trimmed.slice(at + 1)
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false
  return !/\s/.test(trimmed)
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function clonePartnerCapabilities(
  capabilities: readonly PartnerCapability[],
): readonly PartnerCapability[] {
  return Object.freeze([...capabilities])
}

export interface PartnerStoredKey {
  readonly applicationKeyId: string
  readonly keyName: string
  readonly capabilities: readonly Capability[]
  readonly accountId: string
  readonly applicationKey: string
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly expirationTimestamp: number | null
}

export interface PartnerSimulatorHost {
  readonly accountId: string
  readonly authTokenTtlMs: number
  readonly minimumPartSize: number
  readonly recommendedPartSize: number
  canAuthorize(authzHeader: string | undefined): boolean
  createBucket(req: {
    bucketName: string
    bucketType: BucketType
    accountId: string
  }): SimulatorJsonResponse
  error(status: number, code: string, message: string): SimulatorJsonResponse
  genId(prefix: string): string
  monotonicTimestamp(): number
  now(): number
  storeKey(key: PartnerStoredKey): void
}

/**
 * Handles Partner and Computer Backup simulator state and endpoint logic.
 *
 * B2Simulator owns dispatch and shared storage primitives. This collaborator
 * intentionally keeps both Partner and Backup surfaces together because one
 * Partner token authorizes both products. Product-specific state remains split
 * by map: groups/trials/members for Partner, computers for Backup.
 *
 * Auth has two modes:
 *
 * - default `new B2Simulator()` endpoint tests are permissive and accept any
 *   non-empty Partner token without binding request account IDs;
 * - `partnerAuthorize: true` or `strictAuth: true` turns on issued-token
 *   validation so client auth-error tests can still exercise 401 responses.
 */
export class PartnerSimulator {
  private readonly issuedTokens = new Map<string, IssuedPartnerToken>()
  private readonly knownEmails = new Set<string>()
  private readonly groups = new Map<string, StoredPartnerGroup>()
  private readonly groupsByAdmin = new Map<string, string[]>()
  private readonly groupMembers = new Map<string, Map<string, StoredPartnerGroupMember>>()
  private readonly groupMembersByAccountId = new Map<string, StoredPartnerGroupMember>()
  private readonly computersByAccount = new Map<string, Map<string, StoredComputerBackup>>()
  private readonly authorizeEnabled: boolean
  private readonly validateIssuedTokens: boolean
  private readonly apiEnabled: boolean
  private readonly accountHasValidPhone: boolean
  private readonly accountInGoodStanding: boolean
  private readonly groupsCapabilities: readonly PartnerCapability[]
  private readonly backupCapabilities: readonly PartnerCapability[]

  /**
   * Creates the Partner/Backup simulator facade.
   *
   * @param host - Narrow callbacks into the parent B2 simulator.
   * @param options - Parent simulator options relevant to Partner behavior.
   */
  constructor(
    private readonly host: PartnerSimulatorHost,
    options: B2SimulatorOptions,
  ) {
    this.authorizeEnabled = options.partnerAuthorize ?? false
    this.validateIssuedTokens = this.authorizeEnabled || (options.strictAuth ?? false)
    this.apiEnabled = options.partnerApiEnabled ?? true
    this.accountHasValidPhone = options.partnerAccountHasValidPhone ?? true
    this.accountInGoodStanding = options.partnerAccountInGoodStanding ?? true
    this.groupsCapabilities = clonePartnerCapabilities(
      options.partnerGroupsCapabilities ?? [PartnerCapability.All],
    )
    this.backupCapabilities = clonePartnerCapabilities(
      options.partnerBackupCapabilities ?? [PartnerCapability.All],
    )
  }

  /**
   * Reports whether v3 authorize should return Partner/Backup suites.
   *
   * @returns `true` when Partner authorization is enabled.
   */
  isAuthorizeEnabled(): boolean {
    return this.authorizeEnabled
  }

  /**
   * Checks whether an endpoint name belongs to Partner or Backup APIs.
   *
   * @param endpoint - Endpoint name parsed from the request path.
   *
   * @returns `true` when this simulator should handle the endpoint.
   */
  isEndpoint(endpoint: string): boolean {
    return isPartnerApiEndpoint(endpoint)
  }

  /**
   * Authorizes a Partner administrator and mints a Partner token.
   *
   * @param authzHeader - Basic authorization header from b2_authorize_account.
   * @param origin - Request origin used to build simulator endpoint URLs.
   *
   * @returns JSON response with Partner, Backup, and storage API information.
   */
  authorize(authzHeader: string | undefined, origin = 'http://localhost:0'): SimulatorJsonResponse {
    if (!this.host.canAuthorize(authzHeader)) {
      return this.host.error(
        401,
        'bad_auth_token',
        'missing or invalid Partner authorize credentials',
      )
    }

    const tokenStr = this.host.genId('sim_partner_auth_token')
    this.issuedTokens.set(tokenStr, {
      accountId: this.host.accountId,
      backupCapabilities: this.backupCapabilities,
      expiresAt: this.host.now() + this.host.authTokenTtlMs,
      groupsCapabilities: this.groupsCapabilities,
    })
    return {
      status: 200,
      body: {
        accountId: accountIdOf(this.host.accountId),
        authorizationToken: tokenStr,
        apiInfo: {
          storageApi: {
            absoluteMinimumPartSize: this.host.minimumPartSize,
            apiUrl: origin,
            bucketId: null,
            bucketName: null,
            capabilities: [
              Capability.ListBuckets,
              Capability.ReadBuckets,
              Capability.WriteBuckets,
              Capability.DeleteBuckets,
              Capability.ListFiles,
              Capability.ReadFiles,
              Capability.WriteFiles,
              Capability.DeleteFiles,
            ],
            downloadUrl: origin,
            infoType: 'storageApi',
            namePrefix: null,
            recommendedPartSize: this.host.recommendedPartSize,
            s3ApiUrl: origin,
          },
          groupsApi: {
            capabilities: this.groupsCapabilities,
            groupsApiUrl: `${origin}/partner`,
            infoType: 'groupsApi',
          },
          backupApi: {
            backupApiUrl: `${origin}/backup`,
            capabilities: this.backupCapabilities,
            infoType: 'backupApi',
          },
        },
        applicationKeyExpirationTimestamp: null,
      },
    }
  }

  /**
   * Handles b2_reserve_trial_create_account.
   *
   * @param body - Parsed JSON request body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  reserveTrialCreateAccount(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.ReserveTrialCreateAccount, authToken)
    if ('status' in auth) return auth
    const parsed = this.parseReserveTrialCreateAccountRequest(body)
    if (parsed.error !== null) return parsed.error

    const startDayMs = utcDayStartMs(this.host.now())
    const result = this.createReserveTrialAccount(parsed.entry, parsed.normalizedEmail, startDayMs)
    return { status: 200, body: result }
  }

  /**
   * Handles b2_create_group_member.
   *
   * @param body - Parsed JSON request body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  createGroupMember(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.CreateGroupMember, authToken, {
      checkPhone: false,
    })
    if ('status' in auth) return auth
    const record = requestObject(body)
    const request = this.parseCreateGroupMemberRequest(record)
    if ('error' in request) return request.error
    const accountError = this.authorizeAccount(auth, request.adminAccountId)
    if (accountError !== null) return accountError

    const group = this.activeGroup(request.groupId, request.adminAccountId)
    if (group === null) {
      return this.host.error(401, 'invalid_group_id', 'group ID is invalid or deleted')
    }
    if (!this.accountHasValidPhone) {
      return this.host.error(401, 'invalid_sms_phone', 'account is missing a valid SMS phone')
    }

    const normalizedEmail = normalizeEmail(request.memberEmail)
    if (!isValidEmailAddress(request.memberEmail) || this.knownEmails.has(normalizedEmail)) {
      return this.host.error(401, 'invalid_email', 'email address is invalid or already exists')
    }

    const members = this.membersForGroup(group.groupId)
    if (this.activeMembersForGroup(group.groupId).length >= MAX_GROUP_MEMBERS) {
      return this.host.error(401, 'too_many_members', 'group member count limit exceeded')
    }

    const accountId = accountIdOf(this.host.genId('sim_group_member_account'))
    const applicationKeyId = applicationKeyIdOf(this.host.genId('sim_key'))
    const applicationKey = this.host.genId('sim_secret')
    const region = request.region ?? Region.UsWest
    const stored: StoredPartnerGroupMember = {
      accountId,
      email: request.memberEmail,
      normalizedEmail,
      groupId: group.groupId,
      groupName: group.groupName,
      region,
      s3Endpoint: `s3.${region}-001.backblazeb2.com`,
      applicationKeyId,
      applicationKey,
      createdTimestamp: this.host.monotonicTimestamp(),
      ejected: false,
    }
    members.set(normalizedEmail, stored)
    this.groupMembersByAccountId.set(accountId, stored)
    this.knownEmails.add(normalizedEmail)
    this.host.storeKey({
      applicationKeyId,
      keyName: `group-member-${accountId}`,
      capabilities: PARTNER_CREATED_STORAGE_KEY_CAPABILITIES,
      accountId,
      applicationKey,
      bucketIds: null,
      namePrefix: null,
      expirationTimestamp: null,
    })

    const result: CreateGroupMemberResult = {
      applicationKeyId,
      applicationKey,
      groupMember: this.publicGroupMember(stored),
    }
    return { status: 200, body: result }
  }

  /**
   * Handles b2_eject_group_member.
   *
   * @param body - Parsed JSON request body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  ejectGroupMember(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.EjectGroupMember, authToken)
    if ('status' in auth) return auth
    const record = requestObject(body)
    const request = this.parseEjectGroupMemberRequest(record)
    if ('error' in request) return request.error
    const accountError = this.authorizeAccount(auth, request.adminAccountId)
    if (accountError !== null) return accountError

    const group = this.activeGroup(request.groupId, request.adminAccountId)
    if (group === null) {
      return this.host.error(401, 'invalid_group_id', 'group ID is invalid or deleted')
    }

    const member = this.groupMembersByAccountId.get(request.memberAccountId)
    if (member === undefined || member.ejected || member.groupId !== group.groupId) {
      return this.host.error(401, 'invalid_member_account_id', 'group member account ID is invalid')
    }

    const previousNormalizedEmail = member.normalizedEmail
    if (request.email !== undefined && request.email !== null) {
      const normalizedEmail = normalizeEmail(request.email)
      const keepsSameEmail = normalizedEmail === previousNormalizedEmail
      if (
        !isValidEmailAddress(request.email) ||
        (!keepsSameEmail && this.knownEmails.has(normalizedEmail))
      ) {
        return this.host.error(401, 'invalid_email', 'email address is invalid or already exists')
      }
      if (!keepsSameEmail) {
        this.knownEmails.delete(previousNormalizedEmail)
        this.knownEmails.add(normalizedEmail)
      }
      member.email = request.email
      member.normalizedEmail = normalizedEmail
    }

    member.ejected = true
    this.groupMembers.get(group.groupId)?.delete(previousNormalizedEmail)
    const response: EjectGroupMemberResponse = this.publicGroupMember(member)
    return { status: 200, body: response }
  }

  /**
   * Handles b2_list_groups.
   *
   * @param body - Parsed GET query parameters or JSON body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  listGroups(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.ListGroups, authToken, {
      checkPhone: false,
    })
    if ('status' in auth) return auth
    const record = requestObject(body)
    const adminAccountId = this.requiredString(record, 'adminAccountId', 400, 'bad_request')
    if ('error' in adminAccountId) return adminAccountId.error
    const accountError = this.authorizeAccount(auth, adminAccountId.value)
    if (accountError !== null) return accountError
    const maxGroupCount = this.optionalInteger(
      record,
      'maxGroupCount',
      DEFAULT_MAX_GROUP_COUNT,
      1,
      MAX_GROUP_COUNT,
      401,
      'out_of_range',
    )
    if ('error' in maxGroupCount) return maxGroupCount.error

    const groupSeedError = this.ensureGroupsForAdmin(adminAccountId.value)
    if (groupSeedError !== null) return groupSeedError
    const groupNameValue = record['groupName']
    const groupName = typeof groupNameValue === 'string' ? groupNameValue : undefined
    const startGroupIdValue = record['startGroupId']
    const startGroupId = typeof startGroupIdValue === 'string' ? startGroupIdValue : undefined
    if (
      startGroupId !== undefined &&
      this.activeGroup(startGroupId, adminAccountId.value) === null
    ) {
      return this.host.error(401, 'invalid_group_id', 'group ID is invalid or deleted')
    }

    const allGroups = this.activeGroupsForAdmin(adminAccountId.value)
      .filter((group) => groupName === undefined || group.groupName === groupName)
      .sort((left, right) => compareStrings(left.groupId, right.groupId))
    const startIndex =
      startGroupId === undefined ? 0 : allGroups.findIndex((group) => group.groupId >= startGroupId)
    const normalizedStartIndex = startIndex === -1 ? allGroups.length : startIndex
    const page = allGroups.slice(normalizedStartIndex, normalizedStartIndex + maxGroupCount.value)
    const next = allGroups[normalizedStartIndex + maxGroupCount.value]
    const response: ListGroupsResult = {
      accountId: accountIdOf(adminAccountId.value),
      groups: page.map((group) => this.publicGroup(group)),
      nextGroupId: next === undefined ? null : groupIdOf(next.groupId),
    }
    return { status: 200, body: response }
  }

  /**
   * Handles b2_list_group_members.
   *
   * @param body - Parsed GET query parameters or JSON body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  listGroupMembers(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.ListGroupMembers, authToken, {
      checkPhone: false,
    })
    if ('status' in auth) return auth
    const record = requestObject(body)
    const request = this.parseListGroupMembersRequest(record)
    if ('error' in request) return request.error
    const accountError = this.authorizeAccount(auth, request.adminAccountId)
    if (accountError !== null) return accountError

    const group = this.activeGroup(request.groupId, request.adminAccountId)
    if (group === null) {
      return this.host.error(401, 'invalid_group_id', 'group ID is invalid or deleted')
    }

    const members = this.activeMembersForGroup(group.groupId).sort((left, right) =>
      compareStrings(left.normalizedEmail, right.normalizedEmail),
    )
    const startEmail =
      request.startEmail === undefined ? undefined : normalizeEmail(request.startEmail)
    const startIndex =
      startEmail === undefined
        ? 0
        : members.findIndex((member) => member.normalizedEmail >= startEmail)
    const normalizedStartIndex = startIndex === -1 ? members.length : startIndex
    const page = members.slice(normalizedStartIndex, normalizedStartIndex + request.maxMemberCount)
    const next = members[normalizedStartIndex + request.maxMemberCount]
    const response: ListGroupMembersResult = {
      groupId: groupIdOf(group.groupId),
      groupName: group.groupName,
      groupMembers: page.map((member) => this.publicListedGroupMember(member)),
      nextEmail: next === undefined ? null : next.email,
    }
    return { status: 200, body: response }
  }

  /**
   * Handles bz_list_computers.
   *
   * @param body - Parsed GET query parameters or JSON body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  listComputers(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.ListComputers, authToken, {
      checkPhone: false,
    })
    if ('status' in auth) return auth
    const record = requestObject(body)
    const accountId = this.requiredString(record, 'accountId', 400, 'invalid_account_id')
    if ('error' in accountId) return accountId.error
    const accountError = this.authorizeAccount(auth, accountId.value)
    if (accountError !== null) return accountError
    const maxComputerCount = this.optionalInteger(
      record,
      'maxComputerCount',
      DEFAULT_MAX_COMPUTER_COUNT,
      MIN_COMPUTER_COUNT,
      MAX_COMPUTER_COUNT,
      400,
      'out_of_range',
    )
    if ('error' in maxComputerCount) return maxComputerCount.error

    const computers = this.ensureComputersForAccount(accountId.value)
    if ('status' in computers) return computers
    const startComputerIdValue = record['startComputerId']
    const startComputerId =
      typeof startComputerIdValue === 'string' ? startComputerIdValue : undefined
    if (startComputerId !== undefined) {
      const start = computers.get(startComputerId)
      if (start === undefined || start.deleted) {
        // Backup API invalid computer identifiers are validation failures.
        return this.host.error(400, 'invalid_computer_id', 'computer ID is invalid or deleted')
      }
    }

    const activeComputers = [...computers.values()]
      .filter((computer) => !computer.deleted)
      .sort((left, right) => compareStrings(left.computerId, right.computerId))
    const startIndex =
      startComputerId === undefined
        ? 0
        : activeComputers.findIndex((computer) => computer.computerId >= startComputerId)
    const normalizedStartIndex = startIndex === -1 ? activeComputers.length : startIndex
    const page = activeComputers.slice(
      normalizedStartIndex,
      normalizedStartIndex + maxComputerCount.value,
    )
    const next = activeComputers[normalizedStartIndex + maxComputerCount.value]
    return {
      status: 200,
      body: {
        nextComputerId: next === undefined ? null : next.computerId,
        computers: page.map((computer) => this.publicComputer(computer)),
      },
    }
  }

  /**
   * Handles bz_delete_computer.
   *
   * @param body - Parsed JSON request body.
   * @param authToken - Partner authorization token.
   *
   * @returns Simulator JSON response.
   */
  deleteComputer(body: unknown, authToken?: string): SimulatorJsonResponse {
    const auth = this.authorizeRequest(PartnerEndpoint.DeleteComputer, authToken, {
      checkPhone: false,
    })
    if ('status' in auth) return auth
    const record = requestObject(body)
    const accountId = this.requiredString(record, 'accountId', 400, 'invalid_account_id')
    if ('error' in accountId) return accountId.error
    const computerId = this.requiredString(record, 'computerId', 400, 'invalid_computer_id')
    if ('error' in computerId) return computerId.error
    const accountError = this.authorizeAccount(auth, accountId.value)
    if (accountError !== null) return accountError

    const computers = this.computersByAccount.get(accountId.value)
    const computer = computers?.get(computerId.value)
    if (computer === undefined || computer.deleted) {
      return this.host.error(400, 'invalid_computer_id', 'computer ID is invalid or deleted')
    }
    computer.deleted = true
    return { status: 200, body: [this.publicComputer(computer)] }
  }

  private authorizeRequest(
    endpoint: PartnerEndpoint,
    authToken: string | undefined,
    options: { readonly checkPhone?: boolean } = {},
  ): AuthorizedPartnerRequest | SimulatorJsonResponse {
    if (authToken === undefined || authToken.trim() === '' || /\s/.test(authToken)) {
      return this.host.error(
        403,
        'access_denied',
        'missing or malformed Partner API Authorization header',
      )
    }

    if (!this.validateIssuedTokens) {
      if (!this.apiEnabled) {
        return this.host.error(403, 'access_denied', 'account is not enabled for Partner API')
      }
      if (options.checkPhone !== false && !this.accountHasValidPhone) {
        return this.host.error(403, 'access_denied', 'account does not have a valid phone number')
      }
      if (!this.accountInGoodStanding) {
        return this.host.error(403, 'access_denied', 'account is not in good standing')
      }
      return { accountId: null }
    }

    const token = this.issuedTokens.get(authToken)
    if (token === undefined || this.host.now() > token.expiresAt) {
      return this.host.error(401, 'unauthorized', 'invalid Partner API authorization token')
    }
    if (!this.apiEnabled) {
      return this.host.error(403, 'access_denied', 'account is not enabled for Partner API')
    }
    if (options.checkPhone !== false && !this.accountHasValidPhone) {
      return this.host.error(403, 'access_denied', 'account does not have a valid phone number')
    }
    if (!this.accountInGoodStanding) {
      return this.host.error(403, 'access_denied', 'account is not in good standing')
    }
    const capabilityError = this.authorizeEndpointCapabilities(endpoint, token)
    if (capabilityError !== null) return capabilityError
    return { accountId: token.accountId }
  }

  private authorizeEndpointCapabilities(
    endpoint: PartnerEndpoint,
    token: IssuedPartnerToken,
  ): SimulatorJsonResponse | null {
    const requirement = partnerEndpointCapabilityRequirementFor(endpoint)
    if (requirement === null) {
      return this.host.error(401, 'unauthorized', `no Partner capability policy for ${endpoint}`)
    }
    const granted =
      requirement.suite === 'groups' ? token.groupsCapabilities : token.backupCapabilities
    const missing = missingPartnerCapabilities(requirement.capabilities, granted)
    if (missing.length === 0) return null
    return this.host.error(
      401,
      'unauthorized',
      `Partner token lacks required capabilities: ${missing.join(', ')}`,
    )
  }

  private authorizeAccount(
    auth: AuthorizedPartnerRequest,
    requestedAccountId: string,
  ): SimulatorJsonResponse | null {
    if (auth.accountId === null) return null
    if (auth.accountId === requestedAccountId) return null
    return this.host.error(
      403,
      'unauthorized',
      'Partner token is not authorized for requested account',
    )
  }

  private parseReserveTrialCreateAccountRequest(value: unknown):
    | {
        readonly entry: ReserveTrialCreateAccountRequestEntry
        readonly normalizedEmail: string
        readonly error: null
      }
    | {
        readonly error: SimulatorJsonResponse
      } {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {
        error: this.host.error(400, 'bad_request', 'trial account request must be an object'),
      }
    }
    const record = value as Record<string, unknown>
    const email = record['email']
    if (typeof email !== 'string') {
      return { error: this.host.error(400, 'bad_request', 'email is required') }
    }
    if (!isValidEmailAddress(email)) {
      return { error: this.host.error(400, 'bad_request', 'email address is invalid') }
    }
    const normalizedEmail = normalizeEmail(email)
    if (this.knownEmails.has(normalizedEmail)) {
      return {
        error: this.host.error(
          400,
          'bad_request',
          'email must not already exist as a Backblaze account',
        ),
      }
    }
    const term = record['term']
    if (typeof term !== 'number' || !Number.isInteger(term) || term < 7 || term > 30) {
      return { error: this.host.error(400, 'bad_request', 'term must be between 7 and 30 days') }
    }
    const storage = record['storage']
    if (typeof storage !== 'number' || !Number.isInteger(storage) || storage < 1 || storage > 50) {
      return { error: this.host.error(400, 'bad_request', 'storage must be between 1 and 50 TB') }
    }
    const region = record['region']
    if (
      region !== undefined &&
      region !== null &&
      (typeof region !== 'string' || !PARTNER_REGIONS.has(region))
    ) {
      return { error: this.host.error(400, 'bad_request', 'region is not supported') }
    }

    return {
      entry: {
        email,
        term,
        storage,
        ...(region !== undefined ? { region: region as Region | null } : {}),
      },
      normalizedEmail,
      error: null,
    }
  }

  private createReserveTrialAccount(
    request: ReserveTrialCreateAccountRequestEntry,
    normalizedEmail: string,
    startDayMs: number,
  ): ReserveTrialCreateAccountResult {
    const accountId = accountIdOf(this.host.genId('sim_trial_account'))
    const bucketName = `trial-${this.host.genId('bucket').slice(-8)}`
    const bucketResponse = this.host.createBucket({
      accountId,
      bucketName,
      bucketType: 'allPrivate',
    })
    if (bucketResponse.status !== 200) {
      throw new Error('failed to create simulator reserve trial bucket')
    }
    const bucket = bucketResponse.body as BucketInfo
    const keyId = applicationKeyIdOf(this.host.genId('sim_key'))
    const applicationKey = this.host.genId('sim_secret')
    this.host.storeKey({
      applicationKeyId: keyId,
      keyName: `reserve-trial-${bucketName}`,
      capabilities: PARTNER_CREATED_STORAGE_KEY_CAPABILITIES,
      accountId,
      applicationKey,
      bucketIds: [bucket.bucketId],
      namePrefix: null,
      expirationTimestamp: null,
    })
    this.knownEmails.add(normalizedEmail)
    const region = request.region ?? Region.UsWest
    const account: ReserveTrialCreateAccountResult = {
      accountId,
      applicationKey,
      applicationKeyId: keyId,
      s3Endpoint: `s3.${region}-001.backblazeb2.com`,
      startDate: utcDateString(startDayMs),
      endDate: utcDateString(startDayMs + request.term * DAY_MS),
      email: request.email,
      bucketName: bucket.bucketName,
      bucketId: bucket.bucketId,
    }
    return account
  }

  private parseCreateGroupMemberRequest(
    record: Record<string, unknown>,
  ): CreateGroupMemberRequest | { readonly error: SimulatorJsonResponse } {
    const adminAccountId = this.requiredString(record, 'adminAccountId', 400, 'bad_request')
    if ('error' in adminAccountId) return adminAccountId
    const groupId = this.requiredString(record, 'groupId', 401, 'invalid_group_id')
    if ('error' in groupId) return groupId
    const memberEmail = this.requiredString(record, 'memberEmail', 401, 'invalid_email')
    if ('error' in memberEmail) return memberEmail
    const regionValue = record['region']
    if (
      regionValue !== undefined &&
      regionValue !== null &&
      (typeof regionValue !== 'string' || !PARTNER_REGIONS.has(regionValue))
    ) {
      return { error: this.host.error(401, 'invalid_region', 'region is invalid') }
    }
    return {
      adminAccountId: accountIdOf(adminAccountId.value),
      groupId: groupIdOf(groupId.value),
      memberEmail: memberEmail.value,
      ...(regionValue !== undefined ? { region: regionValue as Region | null } : {}),
    }
  }

  private parseEjectGroupMemberRequest(
    record: Record<string, unknown>,
  ): EjectGroupMemberRequest | { readonly error: SimulatorJsonResponse } {
    const adminAccountId = this.requiredString(record, 'adminAccountId', 400, 'bad_request')
    if ('error' in adminAccountId) return adminAccountId
    const groupId = this.requiredString(record, 'groupId', 401, 'invalid_group_id')
    if ('error' in groupId) return groupId
    const memberAccountId = this.requiredString(
      record,
      'memberAccountId',
      401,
      'invalid_member_account_id',
    )
    if ('error' in memberAccountId) return memberAccountId
    const email = record['email']
    if (email !== undefined && email !== null && typeof email !== 'string') {
      return { error: this.host.error(401, 'invalid_email', 'email address is invalid') }
    }
    return {
      adminAccountId: accountIdOf(adminAccountId.value),
      groupId: groupIdOf(groupId.value),
      memberAccountId: accountIdOf(memberAccountId.value),
      ...(email !== undefined ? { email: email as string | null } : {}),
    }
  }

  private parseListGroupMembersRequest(
    record: Record<string, unknown>,
  ):
    | (ListGroupMembersRequest & { readonly maxMemberCount: number })
    | { readonly error: SimulatorJsonResponse } {
    const adminAccountId = this.requiredString(record, 'adminAccountId', 400, 'bad_request')
    if ('error' in adminAccountId) return adminAccountId
    const groupId = this.requiredString(record, 'groupId', 401, 'invalid_group_id')
    if ('error' in groupId) return groupId
    const maxMemberCount = this.optionalInteger(
      record,
      'maxMemberCount',
      DEFAULT_MAX_MEMBER_COUNT,
      1,
      MAX_MEMBER_COUNT,
      401,
      'out_of_range',
      { zeroUsesDefault: true },
    )
    if ('error' in maxMemberCount) return maxMemberCount
    const startEmail = record['startEmail']
    if (startEmail !== undefined && typeof startEmail !== 'string') {
      return { error: this.host.error(400, 'bad_request', 'startEmail must be a string') }
    }
    return {
      adminAccountId: accountIdOf(adminAccountId.value),
      groupId: groupIdOf(groupId.value),
      ...(startEmail !== undefined ? { startEmail } : {}),
      maxMemberCount: maxMemberCount.value,
    }
  }

  private requiredString(
    record: Record<string, unknown>,
    field: string,
    status: number,
    code: string,
  ): { readonly value: string } | { readonly error: SimulatorJsonResponse } {
    const value = record[field]
    if (typeof value !== 'string' || value === '') {
      return { error: this.host.error(status, code, `${field} is required`) }
    }
    return { value }
  }

  private optionalInteger(
    record: Record<string, unknown>,
    field: string,
    defaultValue: number,
    min: number,
    max: number,
    status: number,
    code: string,
    options: { readonly zeroUsesDefault?: boolean } = {},
  ): { readonly value: number } | { readonly error: SimulatorJsonResponse } {
    const raw = record[field]
    if (raw === undefined) return { value: defaultValue }
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw !== ''
          ? Number(raw)
          : Number.NaN
    if (options.zeroUsesDefault === true && value === 0) return { value: defaultValue }
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: this.host.error(status, code, `${field} must be between ${min} and ${max}`) }
    }
    return { value }
  }

  private ensureGroupsForAdmin(adminAccountId: string): SimulatorJsonResponse | null {
    if (this.groupsByAdmin.has(adminAccountId)) return null
    if (this.groupsByAdmin.size >= MAX_AUTO_PROVISIONED_ADMINS) {
      return this.host.error(
        400,
        'too_many_accounts',
        'simulator Partner account auto-provisioning cap exceeded',
      )
    }
    this.groupsByAdmin.set(adminAccountId, [])
    for (let index = 1; index <= DEFAULT_GROUP_COUNT; index += 1) {
      this.createGroup(adminAccountId, `Simulator Group ${index}`)
    }
    return null
  }

  private createGroup(adminAccountId: string, groupName: string): StoredPartnerGroup {
    const existingGroupIds = this.groupsByAdmin.get(adminAccountId) ?? []
    if (existingGroupIds.length >= MAX_GROUPS_PER_ADMIN) {
      throw new Error('simulator Partner group cap exceeded')
    }
    const group: StoredPartnerGroup = {
      adminAccountId,
      groupId: this.host.genId('sim_group'),
      groupName,
      groupProducts: ['STORAGE', 'BACKUP'],
      createdTimestamp: this.host.monotonicTimestamp(),
      deleted: false,
    }
    this.groups.set(group.groupId, group)
    existingGroupIds.push(group.groupId)
    this.groupsByAdmin.set(adminAccountId, existingGroupIds)
    this.groupMembers.set(group.groupId, new Map())
    return group
  }

  private activeGroup(groupId: string, adminAccountId: string): StoredPartnerGroup | null {
    const group = this.groups.get(groupId)
    if (group === undefined || group.deleted || group.adminAccountId !== adminAccountId) return null
    return group
  }

  private activeGroupsForAdmin(adminAccountId: string): StoredPartnerGroup[] {
    const groupIds = this.groupsByAdmin.get(adminAccountId) ?? []
    return groupIds
      .map((groupId) => this.groups.get(groupId))
      .filter((group): group is StoredPartnerGroup => group !== undefined && !group.deleted)
  }

  private membersForGroup(groupId: string): Map<string, StoredPartnerGroupMember> {
    const existing = this.groupMembers.get(groupId)
    if (existing !== undefined) return existing
    const created = new Map<string, StoredPartnerGroupMember>()
    this.groupMembers.set(groupId, created)
    return created
  }

  private activeMembersForGroup(groupId: string): StoredPartnerGroupMember[] {
    return [...(this.groupMembers.get(groupId)?.values() ?? [])].filter((member) => !member.ejected)
  }

  private ensureComputersForAccount(
    accountId: string,
  ): Map<string, StoredComputerBackup> | SimulatorJsonResponse {
    const existing = this.computersByAccount.get(accountId)
    if (existing !== undefined) return existing
    if (this.computersByAccount.size >= MAX_AUTO_PROVISIONED_BACKUP_ACCOUNTS) {
      return this.host.error(
        400,
        'too_many_accounts',
        'simulator Backup account auto-provisioning cap exceeded',
      )
    }
    const computers = new Map<string, StoredComputerBackup>()
    for (let index = 1; index <= DEFAULT_COMPUTER_COUNT; index += 1) {
      const computer: StoredComputerBackup = {
        accountId,
        computerId: this.host.genId('sim_computer'),
        computerName: `sim-computer-${index}`,
        lastFileUploadedTimestamp: this.host.monotonicTimestamp(),
        deleted: false,
      }
      computers.set(computer.computerId, computer)
    }
    this.computersByAccount.set(accountId, computers)
    return computers
  }

  private publicGroup(group: StoredPartnerGroup): PartnerGroup {
    const timestamp = b2FriendlyTimestamp(group.createdTimestamp)
    return {
      accountStandingDetails: { state: 'B2_GOOD_STANDING' },
      b2Stats: this.emptyB2Stats(group.createdTimestamp),
      groupId: groupIdOf(group.groupId),
      groupName: group.groupName,
      groupProducts: group.groupProducts,
      groupStats: {
        createdTimestamp: timestamp,
        groupStatsAsOfTimestamp: timestamp,
        memberCount: this.activeMembersForGroup(group.groupId).length,
      },
    }
  }

  private publicGroupMember(member: StoredPartnerGroupMember): PartnerGroupMember {
    return {
      accountId: accountIdOf(member.accountId),
      email: member.email,
      groupId: groupIdOf(member.groupId),
      groupName: member.groupName,
      region: member.region,
      s3Endpoint: member.s3Endpoint,
    }
  }

  private publicListedGroupMember(member: StoredPartnerGroupMember): ListedGroupMember {
    return {
      ...this.publicGroupMember(member),
      b2Stats: this.emptyB2Stats(member.createdTimestamp),
    }
  }

  private publicComputer(computer: StoredComputerBackup): ComputerBackup {
    return {
      computerId: computerIdOf(computer.computerId),
      computerName: computer.computerName,
      lastFileUploadedTimestamp: computer.lastFileUploadedTimestamp,
    }
  }

  private emptyB2Stats(timestamp: number): PartnerB2Stats {
    return {
      b2BytesStoredCount: 0,
      b2FilesStoredCount: 0,
      b2StatsAsOfTimestamp: b2FriendlyTimestamp(timestamp),
      bucketCount: 0,
    }
  }
}
