import { describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import {
  AccessDeniedError,
  B2PartnerAuthorizationError,
  B2RealmConfigurationError,
  BadAuthTokenError,
  BadRequestError,
  ExpiredAuthTokenError,
  InvalidEmailError,
  InvalidGroupIdError,
  InvalidMemberAccountIdError,
  InvalidRegionError,
  InvalidSmsPhoneError,
  OutOfRangeError,
} from '../errors/index.ts'
import {
  FetchTransport,
  type HttpRequest,
  type HttpTransport,
  RetryTransport,
  type UrlGuardedTransport,
} from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { B2Simulator, type B2SimulatorOptions } from '../simulator/index.ts'
import { jsonErrorResponse, jsonResponse, recordingTransport } from '../test-utils/index.ts'
import { Capability } from '../types/auth.ts'
import type { PartnerToken } from '../types/ids.ts'
import { accountId, applicationKeyId, bucketId, groupId, partnerToken } from '../types/ids.ts'
import {
  type CreateGroupMemberResult,
  type PartnerAuthorizeResponse,
  PartnerCapability,
  Region,
  type ReserveTrialCreateAccountRequest,
  type ReserveTrialCreateAccountResult,
} from '../types/partner.ts'
import { partnerAuthorizeResponseForPersistence } from './auth-clone.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient, validatePartnerAuthorizeResponseEndpoints } from './raw.ts'
import {
  APPLICATION_KEY_REDACTED,
  createGroupMemberResponseToRedactedJson,
  createGroupMemberResultToRedactedJson,
  PARTNER_TOKEN_REDACTED,
  partnerAuthorizeResponseToRedactedJson,
  redactPartnerAuthorizeResponse,
  reserveTrialCreateAccountResponseToRedactedJson,
  reserveTrialCreateAccountResultToRedactedJson,
} from './redaction.ts'

function apiEndpointName(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

function apiVersionSegment(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-2) ?? ''
}

function partnerAuthorizeResponse(
  overrides: { readonly groupsApiUrl?: string; readonly backupApiUrl?: string } = {},
) {
  const groupsApiUrl = overrides.groupsApiUrl ?? 'https://groups.backblazeb2.com/partner'
  const backupApiUrl = overrides.backupApiUrl ?? 'https://backup.backblazeb2.com/backup'
  return {
    accountId: accountId('partner-account'),
    authorizationToken: 'partner-token',
    apiInfo: {
      groupsApi: {
        groupsApiUrl,
        capabilities: [PartnerCapability.All],
        infoType: 'groupsApi',
      },
      backupApi: {
        backupApiUrl,
        capabilities: [PartnerCapability.All],
        infoType: 'backupApi',
      },
    },
    applicationKeyExpirationTimestamp: 1_786_662_000_000,
  }
}

function cachedPartnerAuth(): PartnerAuthorizeResponse {
  return {
    accountId: accountId('partner-account'),
    authorizationToken: partnerToken('partner-token'),
    apiInfo: {
      groupsApi: {
        groupsApiUrl: 'https://groups.backblazeb2.com/partner',
        capabilities: [PartnerCapability.All],
        infoType: 'groupsApi',
      },
      backupApi: {
        backupApiUrl: 'https://backup.backblazeb2.com/backup',
        capabilities: [PartnerCapability.All],
        infoType: 'backupApi',
      },
    },
    groupsApiUrl: 'https://groups.backblazeb2.com/partner',
    backupApiUrl: 'https://backup.backblazeb2.com/backup',
    groupsCapabilities: [PartnerCapability.All],
    backupCapabilities: [PartnerCapability.All],
    applicationKeyExpirationTimestamp: null,
  }
}

function requestJsonBody(request: HttpRequest): unknown {
  if (typeof request.body !== 'string') throw new Error('expected JSON request body')
  return JSON.parse(request.body) as unknown
}

function makePartnerEndpointRawClient(responses: Readonly<Record<string, unknown>>): {
  readonly raw: PartnerRawClient
  readonly seenRequests: HttpRequest[]
  readonly urlGuard: UrlGuard
} {
  const seenRequests: HttpRequest[] = []
  const urlGuard = new UrlGuard()
  urlGuard.setAllowedSuffixes(['backblazeb2.com'])
  const transport: UrlGuardedTransport = {
    urlGuard,
    async send(request) {
      seenRequests.push(request)
      const endpoint = new URL(request.url).pathname.split('/').at(-1) ?? ''
      return jsonResponse(responses[endpoint] ?? {})
    },
  }
  return { raw: new PartnerRawClient({ transport }), seenRequests, urlGuard }
}

function makeRecordingSimulatorTransport(sim: B2Simulator): {
  readonly transport: HttpTransport
  readonly seenRequests: HttpRequest[]
} {
  const seenRequests: HttpRequest[] = []
  const inner = sim.transport()
  return {
    seenRequests,
    transport: {
      async send(request) {
        seenRequests.push(request)
        return inner.send(request)
      },
    },
  }
}

async function makeSimulatorPartnerRawClient(options?: B2SimulatorOptions): Promise<{
  readonly raw: PartnerRawClient
  readonly sim: B2Simulator
  readonly seenRequests: HttpRequest[]
  readonly groupsApiUrl: string
  readonly authToken: PartnerToken
  readonly adminAccountId: ReturnType<typeof accountId>
}> {
  const sim = new B2Simulator({ ...options, partnerAuthorize: true })
  const { seenRequests, transport } = makeRecordingSimulatorTransport(sim)
  const raw = new PartnerRawClient({
    transport: new RetryTransport({
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      sleepImpl: noSleep,
    }),
  })
  const auth = await raw.authorizePartner('master-key-id', 'master-key')
  if (auth.groupsApiUrl === undefined) throw new Error('expected simulator Partner API URL')
  return {
    raw,
    sim,
    seenRequests,
    groupsApiUrl: auth.groupsApiUrl,
    authToken: auth.authorizationToken,
    adminAccountId: auth.accountId,
  }
}

function noSleep(): Promise<void> {
  return Promise.resolve()
}

describe('Partner redaction projections', () => {
  it('drops unknown secret-looking fields from Partner authorize projections', () => {
    const auth = {
      accountId: accountId('partner-account'),
      authorizationToken: partnerToken('partner-token-secret'),
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
          backupApplicationKey: 'nested-groups-backup-key-secret',
          rawResponse: { applicationKey: 'nested-groups-raw-key-secret' },
        },
        backupApi: {
          backupApiUrl: 'https://backup.backblazeb2.com/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
          authorizationToken: 'nested-backup-token-secret',
          rawResponse: { applicationKey: 'nested-backup-raw-key-secret' },
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      backupApiUrl: 'https://backup.backblazeb2.com/backup',
      groupsCapabilities: [PartnerCapability.All],
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
      applicationKey: 'top-level-application-key-secret',
      backupApplicationKey: 'top-level-backup-key-secret',
      rawResponse: { applicationKey: 'top-level-raw-key-secret' },
    } as unknown as PartnerAuthorizeResponse

    const redacted = partnerAuthorizeResponseToRedactedJson(auth)
    const serialized = JSON.stringify(redacted)
    const groupsApi = redacted.apiInfo.groupsApi
    const backupApi = redacted.apiInfo.backupApi
    if (groupsApi === undefined || backupApi === undefined) {
      throw new Error('expected redacted Partner and Backup API info')
    }

    expect(redacted.authorizationToken).toBe(PARTNER_TOKEN_REDACTED)
    expect(Object.hasOwn(redacted, 'applicationKey')).toBe(false)
    expect(Object.hasOwn(redacted, 'backupApplicationKey')).toBe(false)
    expect(Object.hasOwn(redacted, 'rawResponse')).toBe(false)
    expect(Object.hasOwn(redacted.apiInfo, 'rawResponse')).toBe(false)
    expect(Object.hasOwn(groupsApi, 'backupApplicationKey')).toBe(false)
    expect(Object.hasOwn(groupsApi, 'rawResponse')).toBe(false)
    expect(Object.hasOwn(backupApi, 'authorizationToken')).toBe(false)
    expect(Object.hasOwn(backupApi, 'rawResponse')).toBe(false)
    expect(serialized).not.toContain('partner-token-secret')
    expect(serialized).not.toContain('top-level-application-key-secret')
    expect(serialized).not.toContain('top-level-backup-key-secret')
    expect(serialized).not.toContain('top-level-raw-key-secret')
    expect(serialized).not.toContain('nested-groups-backup-key-secret')
    expect(serialized).not.toContain('nested-groups-raw-key-secret')
    expect(serialized).not.toContain('nested-backup-token-secret')
    expect(serialized).not.toContain('nested-backup-raw-key-secret')
  })

  it('drops unknown secret-looking fields from create-group-member projections', () => {
    const result = {
      applicationKeyId: applicationKeyId('application-key-id'),
      applicationKey: 'group-member-application-key-secret',
      groupMember: {
        accountId: accountId('member-account'),
        email: 'member@example.com',
        groupId: groupId('254'),
        groupName: 'Example Group',
        region: Region.UsWest,
        s3Endpoint: 's3.us-west-004.backblazeb2.com',
        applicationKey: 'nested-member-application-key-secret',
        backupApplicationKey: 'nested-member-backup-key-secret',
        rawResponse: { applicationKey: 'nested-member-raw-key-secret' },
      },
      authorizationToken: 'group-member-token-secret',
      backupApplicationKey: 'group-member-backup-key-secret',
      rawResponse: { applicationKey: 'group-member-raw-key-secret' },
    } as unknown as CreateGroupMemberResult

    const redacted = createGroupMemberResultToRedactedJson(result)
    const redactedFromResponse = createGroupMemberResponseToRedactedJson(result)
    const serialized = JSON.stringify(redacted)

    expect(redactedFromResponse).toEqual(redacted)
    expect(redacted.applicationKey).toBe(APPLICATION_KEY_REDACTED)
    expect(Object.hasOwn(redacted, 'authorizationToken')).toBe(false)
    expect(Object.hasOwn(redacted, 'backupApplicationKey')).toBe(false)
    expect(Object.hasOwn(redacted, 'rawResponse')).toBe(false)
    expect(Object.hasOwn(redacted.groupMember, 'applicationKey')).toBe(false)
    expect(Object.hasOwn(redacted.groupMember, 'backupApplicationKey')).toBe(false)
    expect(Object.hasOwn(redacted.groupMember, 'rawResponse')).toBe(false)
    expect(serialized).not.toContain('group-member-application-key-secret')
    expect(serialized).not.toContain('group-member-token-secret')
    expect(serialized).not.toContain('group-member-backup-key-secret')
    expect(serialized).not.toContain('group-member-raw-key-secret')
    expect(serialized).not.toContain('nested-member-application-key-secret')
    expect(serialized).not.toContain('nested-member-backup-key-secret')
    expect(serialized).not.toContain('nested-member-raw-key-secret')
  })

  it('drops unknown secret-looking fields from reserve-trial projections', () => {
    const result = {
      accountId: accountId('trial-account'),
      applicationKey: 'trial-application-key-secret',
      applicationKeyId: applicationKeyId('trial-key-id'),
      s3Endpoint: 's3.us-west-004.backblazeb2.com',
      startDate: '2026-08-21',
      endDate: '2026-08-28',
      email: 'trial@example.com',
      bucketName: 'trial-bucket',
      bucketId: bucketId('trial-bucket-id'),
      authorizationToken: 'trial-token-secret',
      backupApplicationKey: 'trial-backup-key-secret',
      rawResponse: { applicationKey: 'trial-raw-key-secret' },
    } as unknown as ReserveTrialCreateAccountResult

    const redacted = reserveTrialCreateAccountResultToRedactedJson(result)
    const redactedFromResponse = reserveTrialCreateAccountResponseToRedactedJson(result)
    const serialized = JSON.stringify(redacted)

    expect(redactedFromResponse).toEqual(redacted)
    expect(redacted.applicationKey).toBe(APPLICATION_KEY_REDACTED)
    expect(Object.hasOwn(redacted, 'authorizationToken')).toBe(false)
    expect(Object.hasOwn(redacted, 'backupApplicationKey')).toBe(false)
    expect(Object.hasOwn(redacted, 'rawResponse')).toBe(false)
    expect(serialized).not.toContain('trial-application-key-secret')
    expect(serialized).not.toContain('trial-token-secret')
    expect(serialized).not.toContain('trial-backup-key-secret')
    expect(serialized).not.toContain('trial-raw-key-secret')
  })
})

describe('PartnerRawClient group management endpoints', () => {
  const groupsApiUrl = 'https://groups.backblazeb2.com/partner'
  const authToken = partnerToken('partner-token')
  const adminAccountId = accountId('admin-account')
  const memberAccountId = accountId('member-account')
  const group = groupId('254')
  const groupMember = {
    accountId: memberAccountId,
    email: 'member@example.com',
    groupId: group,
    groupName: 'Example Group',
    region: Region.UsWest,
    s3Endpoint: 's3.us-west-004.backblazeb2.com',
  }
  const groupMemberResult: CreateGroupMemberResult = {
    applicationKey: 'application-key-secret',
    applicationKeyId: applicationKeyId('application-key-id'),
    groupMember,
  }
  const reserveTrialResult: ReserveTrialCreateAccountResult = {
    accountId: accountId('trial-account'),
    applicationKey: 'trial-application-key-secret',
    applicationKeyId: applicationKeyId('trial-application-key-id'),
    bucketId: bucketId('trial-bucket-id'),
    bucketName: 'trial-bucket',
    email: 'trial-one@example.com',
    endDate: '2026-08-28',
    s3Endpoint: 's3.us-west-004.backblazeb2.com',
    startDate: '2026-08-21',
  }

  it('pins Partner group-management methods to v4 endpoints', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: groupMemberResult,
      b2_eject_group_member: groupMember,
      b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      b2_list_group_members: [
        {
          groupId: group,
          groupName: 'Example Group',
          groupMembers: [],
          nextEmail: null,
        },
      ],
      b2_reserve_trial_create_account: reserveTrialResult,
    })

    await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
    })
    await raw.ejectGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberAccountId,
    })
    await raw.listGroups(groupsApiUrl, authToken, { adminAccountId })
    await raw.listGroupMembers(groupsApiUrl, authToken, { adminAccountId, groupId: group })
    await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-one@example.com',
      term: 7,
      storage: 1,
    })

    expect(
      seenRequests.map((request) => [apiEndpointName(request), apiVersionSegment(request)]),
    ).toEqual([
      ['b2_create_group_member', 'v4'],
      ['b2_eject_group_member', 'v4'],
      ['b2_list_groups', 'v4'],
      ['b2_list_group_members', 'v4'],
      ['b2_reserve_trial_create_account', 'v4'],
    ])
  })

  it('sends Partner POST bodies through the partner base path', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: {
        applicationKey: 'application-key-secret',
        applicationKeyId: applicationKeyId('application-key-id'),
        groupMember,
      },
      b2_eject_group_member: groupMember,
    })

    const created = await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
      region: Region.UsWest,
    })
    const ejected = await raw.ejectGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberAccountId,
      email: 'replacement@example.com',
    })

    expect(created.groupMember.accountId).toBe(memberAccountId)
    expect(ejected.accountId).toBe(memberAccountId)
    expect(seenRequests).toHaveLength(2)
    const createRequest = seenRequests[0]
    const ejectRequest = seenRequests[1]
    if (createRequest === undefined || ejectRequest === undefined) {
      throw new Error('expected create and eject requests')
    }
    expect(createRequest).toMatchObject({
      url: 'https://groups.backblazeb2.com/partner/b2api/v4/b2_create_group_member',
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      retry: { maxRetries: 0 },
    })
    expect(requestJsonBody(createRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
      region: Region.UsWest,
    })
    expect(ejectRequest).toMatchObject({
      url: 'https://groups.backblazeb2.com/partner/b2api/v4/b2_eject_group_member',
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      retry: { maxRetries: 0 },
    })
    expect(requestJsonBody(ejectRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberAccountId,
      email: 'replacement@example.com',
    })
  })

  it('redacts group-member application keys through SDK safe serialization paths', async () => {
    const secret = 'application-key-secret'
    const { raw } = makePartnerEndpointRawClient({
      b2_create_group_member: {
        applicationKey: secret,
        applicationKeyId: applicationKeyId('application-key-id'),
        groupMember,
      },
    })

    const result = await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
    })
    const created = result
    const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')
    const inspectedResult = (created as unknown as Record<symbol, () => unknown>)[inspectSymbol]?.()
    const inspectedResponse = (result as unknown as Record<symbol, () => unknown>)[
      inspectSymbol
    ]?.()

    expect(created.applicationKey).toBe(secret)
    expect(JSON.stringify(result)).toContain(APPLICATION_KEY_REDACTED)
    expect(JSON.stringify(created)).toContain(APPLICATION_KEY_REDACTED)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(created)).not.toContain(secret)
    expect(String(result)).not.toContain(secret)
    expect(String(created)).not.toContain(secret)
    expect(JSON.stringify(inspectedResult)).not.toContain(secret)
    expect(JSON.stringify(inspectedResponse)).not.toContain(secret)
    expect(createGroupMemberResponseToRedactedJson(result).applicationKey).toBe(
      APPLICATION_KEY_REDACTED,
    )
  })

  it('sends Partner list endpoints as canonical GET query requests', async () => {
    const nextGroup = groupId('255')
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_list_groups: {
        accountId: adminAccountId,
        groups: [],
        nextGroupId: nextGroup,
      },
      b2_list_group_members: [
        {
          groupId: group,
          groupName: 'Example Group',
          groupMembers: [],
          nextEmail: 'next@example.com',
        },
      ],
    })

    const groups = await raw.listGroups(groupsApiUrl, authToken, {
      adminAccountId,
      groupName: 'Example Group',
      startGroupId: group,
      maxGroupCount: 10,
    })
    const members = await raw.listGroupMembers(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      startEmail: 'next@example.com',
      maxMemberCount: 1000,
    })

    expect(groups.nextGroupId).toBe(nextGroup)
    expect(members[0]?.nextEmail).toBe('next@example.com')
    expect(seenRequests).toEqual([
      {
        url: 'https://groups.backblazeb2.com/partner/b2api/v4/b2_list_groups?adminAccountId=admin-account&groupName=Example%20Group&startGroupId=254&maxGroupCount=10',
        method: 'GET',
        headers: { Authorization: authToken },
      },
      {
        url: 'https://groups.backblazeb2.com/partner/b2api/v4/b2_list_group_members?adminAccountId=admin-account&groupId=254&startEmail=next%40example.com&maxMemberCount=1000',
        method: 'GET',
        headers: { Authorization: authToken },
      },
    ])
  })

  it('surfaces empty list pages with null cursors', async () => {
    const { raw } = makePartnerEndpointRawClient({
      b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      b2_list_group_members: [
        {
          groupId: group,
          groupName: 'Example Group',
          groupMembers: [],
          nextEmail: null,
        },
      ],
    })

    const groups = await raw.listGroups(groupsApiUrl, authToken, { adminAccountId })
    const members = await raw.listGroupMembers(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
    })

    expect(groups).toEqual({ accountId: adminAccountId, groups: [], nextGroupId: null })
    expect(members).toEqual([
      {
        groupId: group,
        groupMembers: [],
        groupName: 'Example Group',
        nextEmail: null,
      },
    ])
  })

  it('round-trips Partner endpoints through B2Simulator with documented shapes and cursors', async () => {
    const { raw, groupsApiUrl, authToken, adminAccountId } = await makeSimulatorPartnerRawClient()

    const firstGroupsPage = await raw.listGroups(groupsApiUrl, authToken, {
      adminAccountId,
      maxGroupCount: 1,
    })
    expect(Array.isArray(firstGroupsPage)).toBe(false)
    expect(firstGroupsPage.groups).toHaveLength(1)
    expect(firstGroupsPage.nextGroupId).toEqual(expect.any(String))
    const listedGroup = firstGroupsPage.groups[0]
    const nextGroupId = firstGroupsPage.nextGroupId
    if (listedGroup === undefined || nextGroupId === null) {
      throw new Error('expected simulator group page with a next cursor')
    }

    const secondGroupsPage = await raw.listGroups(groupsApiUrl, authToken, {
      adminAccountId,
      startGroupId: nextGroupId,
      maxGroupCount: 1,
    })
    expect(Array.isArray(secondGroupsPage)).toBe(false)
    expect(secondGroupsPage.groups[0]?.groupId).toBe(nextGroupId)

    const createdB = await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: listedGroup.groupId,
      memberEmail: 'b-raw-simulator@example.com',
      region: Region.UsEast,
    })
    const createdA = await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: listedGroup.groupId,
      memberEmail: 'a-raw-simulator@example.com',
    })
    expect(Array.isArray(createdB)).toBe(false)
    expect(Array.isArray(createdA)).toBe(false)
    expect(createdB.groupMember).toMatchObject({
      email: 'b-raw-simulator@example.com',
      region: Region.UsEast,
      s3Endpoint: 's3.us-east-001.backblazeb2.com',
    })

    const firstMembersPage = await raw.listGroupMembers(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: listedGroup.groupId,
      maxMemberCount: 1,
    })
    expect(Array.isArray(firstMembersPage)).toBe(true)
    expect(firstMembersPage[0]?.groupMembers.map((member) => member.email)).toEqual([
      'a-raw-simulator@example.com',
    ])
    expect(firstMembersPage[0]?.nextEmail).toBe('b-raw-simulator@example.com')

    const secondMembersPage = await raw.listGroupMembers(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: listedGroup.groupId,
      startEmail: 'b-raw-simulator@example.com',
      maxMemberCount: 1,
    })
    expect(Array.isArray(secondMembersPage)).toBe(true)
    expect(secondMembersPage[0]?.groupMembers.map((member) => member.email)).toEqual([
      'b-raw-simulator@example.com',
    ])
    expect(secondMembersPage[0]?.nextEmail).toBeNull()

    const createdAMember = createdA.groupMember
    const ejected = await raw.ejectGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: listedGroup.groupId,
      memberAccountId: createdAMember.accountId,
      email: 'a-raw-simulator-ejected@example.com',
    })
    expect(Array.isArray(ejected)).toBe(false)
    expect(ejected).toMatchObject({
      accountId: createdAMember.accountId,
      email: 'a-raw-simulator-ejected@example.com',
    })
  })

  it('maps simulator Partner endpoint error codes to typed SDK errors', async () => {
    const { raw, groupsApiUrl, authToken, adminAccountId } = await makeSimulatorPartnerRawClient()
    const groupsPage = await raw.listGroups(groupsApiUrl, authToken, { adminAccountId })
    const listedGroup = groupsPage.groups[0]
    if (listedGroup === undefined) throw new Error('expected simulator group')

    await expect(
      raw.listGroups(groupsApiUrl, authToken, {
        adminAccountId,
        startGroupId: groupId('missing-group'),
      }),
    ).rejects.toThrow(InvalidGroupIdError)
    await expect(
      raw.listGroups(groupsApiUrl, authToken, { adminAccountId, maxGroupCount: 101 }),
    ).rejects.toThrow(OutOfRangeError)
    await expect(
      raw.listGroupMembers(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: listedGroup.groupId,
        maxMemberCount: 1001,
      }),
    ).rejects.toThrow(OutOfRangeError)
    await expect(
      raw.createGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: listedGroup.groupId,
        memberEmail: 'invalid-region@example.com',
        region: 'antarctica' as Region,
      }),
    ).rejects.toThrow(InvalidRegionError)
    await expect(
      raw.createGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: listedGroup.groupId,
        memberEmail: 'invalid-email',
      }),
    ).rejects.toThrow(InvalidEmailError)
    await expect(
      raw.ejectGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: listedGroup.groupId,
        memberAccountId: accountId('missing-member'),
      }),
    ).rejects.toThrow(InvalidMemberAccountIdError)

    const phoneDisabled = await makeSimulatorPartnerRawClient({
      partnerAccountHasValidPhone: false,
    })
    const phoneDisabledGroupsPage = await phoneDisabled.raw.listGroups(
      phoneDisabled.groupsApiUrl,
      phoneDisabled.authToken,
      { adminAccountId: phoneDisabled.adminAccountId },
    )
    const phoneDisabledGroup = phoneDisabledGroupsPage.groups[0]
    if (phoneDisabledGroup === undefined) throw new Error('expected simulator group')
    await expect(
      phoneDisabled.raw.createGroupMember(phoneDisabled.groupsApiUrl, phoneDisabled.authToken, {
        adminAccountId: phoneDisabled.adminAccountId,
        groupId: phoneDisabledGroup.groupId,
        memberEmail: 'missing-phone@example.com',
      }),
    ).rejects.toThrow(InvalidSmsPhoneError)
  })

  it('omits undefined optional Partner request fields', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: groupMemberResult,
      b2_eject_group_member: groupMember,
      b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      b2_list_group_members: [
        {
          groupId: group,
          groupName: 'Example Group',
          groupMembers: [],
          nextEmail: null,
        },
      ],
    })

    await raw.createGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
    })
    await raw.ejectGroupMember(groupsApiUrl, authToken, {
      adminAccountId,
      groupId: group,
      memberAccountId,
    })
    await raw.listGroups(groupsApiUrl, authToken, { adminAccountId })
    await raw.listGroupMembers(groupsApiUrl, authToken, { adminAccountId, groupId: group })

    const createRequest = seenRequests[0]
    const ejectRequest = seenRequests[1]
    if (createRequest === undefined || ejectRequest === undefined) {
      throw new Error('expected create and eject requests')
    }
    expect(requestJsonBody(createRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
    })
    expect(requestJsonBody(ejectRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberAccountId,
    })
    expect(seenRequests[2]?.url).toBe(
      'https://groups.backblazeb2.com/partner/b2api/v4/b2_list_groups?adminAccountId=admin-account',
    )
    expect(seenRequests[3]?.url).toBe(
      'https://groups.backblazeb2.com/partner/b2api/v4/b2_list_group_members?adminAccountId=admin-account&groupId=254',
    )
  })

  it('forwards request signal and safe retry options for Partner endpoints', async () => {
    const controller = new AbortController()
    const retry = { maxRetries: 2 }
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: groupMemberResult,
      b2_eject_group_member: groupMember,
      b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      b2_list_group_members: [
        {
          groupId: group,
          groupName: 'Example Group',
          groupMembers: [],
          nextEmail: null,
        },
      ],
    })

    await raw.createGroupMember(
      groupsApiUrl,
      authToken,
      { adminAccountId, groupId: group, memberEmail: 'member@example.com' },
      { signal: controller.signal, retry },
    )
    await raw.ejectGroupMember(
      groupsApiUrl,
      authToken,
      { adminAccountId, groupId: group, memberAccountId },
      { signal: controller.signal, retry },
    )
    await raw.listGroups(
      groupsApiUrl,
      authToken,
      { adminAccountId },
      { signal: controller.signal, retry },
    )
    await raw.listGroupMembers(
      groupsApiUrl,
      authToken,
      { adminAccountId, groupId: group },
      { signal: controller.signal, retry },
    )

    expect(seenRequests.map((request) => request.signal)).toEqual([
      controller.signal,
      controller.signal,
      controller.signal,
      controller.signal,
    ])
    expect(seenRequests.map((request) => request.retry)).toEqual([
      { maxRetries: 0 },
      { maxRetries: 0 },
      retry,
      retry,
    ])
  })

  it('keeps mutation retries disabled when only timeout retry options are supplied', async () => {
    const retry = { requestTimeoutMs: 1000 }
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: groupMemberResult,
      b2_eject_group_member: groupMember,
    })

    await raw.createGroupMember(
      groupsApiUrl,
      authToken,
      { adminAccountId, groupId: group, memberEmail: 'member@example.com' },
      { retry },
    )
    await raw.ejectGroupMember(
      groupsApiUrl,
      authToken,
      { adminAccountId, groupId: group, memberAccountId },
      { retry },
    )

    expect(seenRequests.map((request) => request.retry)).toEqual([
      { maxRetries: 0, requestTimeoutMs: 1000 },
      { maxRetries: 0, requestTimeoutMs: 1000 },
    ])
  })

  it.each([
    ['plaintext HTTP', 'http://groups.backblazeb2.com/partner'],
    ['userinfo', 'https://user:secret@groups.backblazeb2.com/partner'],
    ['query string', 'https://groups.backblazeb2.com/partner?token=secret'],
    ['fragment', 'https://groups.backblazeb2.com/partner#token'],
    ['literal metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/partner'],
    ['metadata hostname', 'https://metadata.google.internal/partner'],
    ['off-realm attacker host', 'https://attacker.example/partner'],
  ])(
    'rejects unsafe groupsApiUrl before sending tokens: %s',
    async (_label, unsafeGroupsApiUrl) => {
      const { raw, seenRequests } = makePartnerEndpointRawClient({
        b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      })

      await expect(
        raw.listGroups(unsafeGroupsApiUrl, authToken, { adminAccountId }),
      ).rejects.toThrow(B2PartnerAuthorizationError)

      expect(seenRequests).toEqual([])
    },
  )

  it.each([
    ['plaintext HTTP', 'http://groups.backblazeb2.com/partner'],
    ['literal metadata IP', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/partner'],
    ['off-realm attacker host', 'https://attacker.example/partner'],
  ])(
    'rejects unsafe POST groupsApiUrl before sending tokens: %s',
    async (_label, unsafeGroupsApiUrl) => {
      const { raw, seenRequests } = makePartnerEndpointRawClient({
        b2_create_group_member: groupMemberResult,
      })

      await expect(
        raw.createGroupMember(unsafeGroupsApiUrl, authToken, {
          adminAccountId,
          groupId: group,
          memberEmail: 'member@example.com',
        }),
      ).rejects.toThrow(B2PartnerAuthorizationError)

      expect(seenRequests).toEqual([])
    },
  )

  it('fails closed before a transport URL guard is locked', async () => {
    const noGuard = recordingTransport()
    const rawWithoutGuard = new PartnerRawClient({ transport: noGuard.transport })
    const seenUnlockedRequests: HttpRequest[] = []
    const unlockedTransport: UrlGuardedTransport = {
      urlGuard: new UrlGuard(),
      async send(request) {
        seenUnlockedRequests.push(request)
        return jsonResponse({ accountId: adminAccountId, groups: [], nextGroupId: null })
      },
    }
    const rawWithUnlockedGuard = new PartnerRawClient({ transport: unlockedTransport })

    await expect(
      rawWithoutGuard.listGroups(groupsApiUrl, authToken, { adminAccountId }),
    ).rejects.toThrow(B2PartnerAuthorizationError)
    await expect(
      rawWithUnlockedGuard.listGroups(groupsApiUrl, authToken, { adminAccountId }),
    ).rejects.toThrow(B2PartnerAuthorizationError)

    expect(noGuard.seenRequests).toEqual([])
    expect(seenUnlockedRequests).toEqual([])
  })

  it('does not retry mutation POSTs through RetryTransport by default', async () => {
    const responseFailureRequests: HttpRequest[] = []
    const responseFailureGuard = new UrlGuard()
    responseFailureGuard.setAllowedSuffixes(['backblazeb2.com'])
    const responseFailureTransport: UrlGuardedTransport = {
      urlGuard: responseFailureGuard,
      async send(request) {
        responseFailureRequests.push(request)
        return jsonErrorResponse(503, 'service_unavailable', 'try again')
      },
    }
    const responseFailureRaw = new PartnerRawClient({
      transport: new RetryTransport({
        transport: responseFailureTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      responseFailureRaw.createGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: group,
        memberEmail: 'member@example.com',
      }),
    ).rejects.toThrow()
    expect(responseFailureRequests).toHaveLength(1)
    expect(responseFailureRequests[0]?.idempotent).toBe(false)

    const networkFailureRequests: HttpRequest[] = []
    const networkFailureGuard = new UrlGuard()
    networkFailureGuard.setAllowedSuffixes(['backblazeb2.com'])
    const networkFailureTransport: UrlGuardedTransport = {
      urlGuard: networkFailureGuard,
      async send(request) {
        networkFailureRequests.push(request)
        throw new TypeError('network down')
      },
    }
    const networkFailureRaw = new PartnerRawClient({
      transport: new RetryTransport({
        transport: networkFailureTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      networkFailureRaw.ejectGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: group,
        memberAccountId,
      }),
    ).rejects.toThrow()
    expect(networkFailureRequests).toHaveLength(1)
    expect(networkFailureRequests[0]?.idempotent).toBe(false)
  })

  it('does not retry mutation POSTs when the caller passes maxRetries', async () => {
    const seenRequests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com'])
    const transport: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        seenRequests.push(request)
        return jsonErrorResponse(503, 'service_unavailable', 'try again')
      },
    }
    const raw = new PartnerRawClient({
      transport: new RetryTransport({
        transport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      raw.createGroupMember(
        groupsApiUrl,
        authToken,
        { adminAccountId, groupId: group, memberEmail: 'member@example.com' },
        { retry: { maxRetries: 1 } },
      ),
    ).rejects.toThrow()

    expect(seenRequests).toHaveLength(1)
    expect(seenRequests[0]?.retry?.maxRetries).toBe(0)
    expect(seenRequests[0]?.idempotent).toBe(false)
  })

  it('does not reauthorize and replay mutation POSTs on expired auth token', async () => {
    const seenRequests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com'])
    const transport: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        seenRequests.push(request)
        return jsonErrorResponse(401, 'expired_auth_token', 'expired')
      },
    }
    const onReauth = vi.fn().mockResolvedValue('fresh-token')
    const raw = new PartnerRawClient({
      transport: new RetryTransport({
        transport,
        onReauth,
        retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      raw.createGroupMember(groupsApiUrl, authToken, {
        adminAccountId,
        groupId: group,
        memberEmail: 'member@example.com',
      }),
    ).rejects.toThrow(ExpiredAuthTokenError)

    expect(onReauth).not.toHaveBeenCalled()
    expect(seenRequests).toHaveLength(1)
    expect(seenRequests[0]?.idempotent).toBe(false)
  })
})

describe('PartnerRawClient reserve trial endpoint', () => {
  const authToken = partnerToken('partner-token')
  const reserveTrialResult: ReserveTrialCreateAccountResult = {
    accountId: accountId('trial-account'),
    applicationKey: 'trial-application-key-secret',
    applicationKeyId: applicationKeyId('trial-application-key-id'),
    bucketId: bucketId('trial-bucket-id'),
    bucketName: 'trial-bucket',
    email: 'trial-response-object@example.com',
    endDate: '2026-08-28',
    s3Endpoint: 's3.us-west-004.backblazeb2.com',
    startDate: '2026-08-21',
  }

  it('creates one reserve trial account from a single request through the simulator', async () => {
    const { raw, seenRequests, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    const result = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-one@example.com',
      term: 15,
      storage: 12,
      region: Region.UsEast,
    })

    expect(Array.isArray(result)).toBe(false)
    expect(result).toMatchObject({
      email: 'trial-one@example.com',
      s3Endpoint: 's3.us-east-001.backblazeb2.com',
      startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    expect(result.accountId).toEqual(expect.any(String))
    expect(result.applicationKey).toEqual(expect.any(String))
    expect(result.applicationKeyId).toEqual(expect.any(String))
    expect(result.bucketId).toEqual(expect.any(String))
    expect(result.applicationKey).not.toBe('')
    const reserveRequest = seenRequests.at(-1)
    if (reserveRequest === undefined) throw new Error('expected reserve trial request')
    expect(reserveRequest).toMatchObject({
      url: `${groupsApiUrl}/b2api/v4/b2_reserve_trial_create_account`,
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      retry: expect.objectContaining({ maxRetries: 0 }),
    })
    expect(requestJsonBody(reserveRequest)).toEqual({
      email: 'trial-one@example.com',
      term: 15,
      storage: 12,
      region: Region.UsEast,
    })
  })

  it('rejects array reserve trial requests before sending Partner tokens', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_reserve_trial_create_account: reserveTrialResult,
    })

    await expect(
      raw.reserveTrialCreateAccount('https://groups.backblazeb2.com/partner', authToken, [
        {
          email: 'trial-array-request@example.com',
          term: 7,
          storage: 1,
        },
      ] as unknown as ReserveTrialCreateAccountRequest),
    ).rejects.toThrow('reserveTrialCreateAccount request must be a single account object')
    expect(seenRequests).toEqual([])
  })

  it('authorizes storage clients as the created trial account', async () => {
    const { raw, sim, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    const trial = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-storage-auth@example.com',
      term: 7,
      storage: 1,
    })

    const client = new B2Client({
      applicationKeyId: trial.applicationKeyId,
      applicationKey: trial.applicationKey,
      transport: sim.transport(),
    })
    const auth = await client.authorize()

    expect(auth.accountId).toBe(trial.accountId)
  })

  it('omits null region values from the reserve trial wire request', async () => {
    const { raw, seenRequests, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    const result = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-default-region@example.com',
      term: 7,
      storage: 1,
      region: null,
    })

    expect(result.s3Endpoint).toBe('s3.us-west-001.backblazeb2.com')
    const reserveRequest = seenRequests.at(-1)
    if (reserveRequest === undefined) throw new Error('expected reserve trial request')
    expect(requestJsonBody(reserveRequest)).toEqual({
      email: 'trial-default-region@example.com',
      term: 7,
      storage: 1,
    })
  })

  it('redacts reserve trial application keys through SDK safe serialization paths', async () => {
    const { raw, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    const result = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-redaction@example.com',
      term: 7,
      storage: 1,
    })
    const account = result
    const secret = account.applicationKey
    const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')
    const inspectedResult = (account as unknown as Record<symbol, () => unknown>)[inspectSymbol]?.()
    const inspectedResponse = (result as unknown as Record<symbol, () => unknown>)[
      inspectSymbol
    ]?.()
    const redactedResponseJson = JSON.stringify(result)
    const redactedResultJson = JSON.stringify(account)

    expect(secret).not.toBe(APPLICATION_KEY_REDACTED)
    expect(account.applicationKeyId).not.toBe('')
    expect(account.accountId).not.toBe('')
    expect(redactedResponseJson).toContain(APPLICATION_KEY_REDACTED)
    expect(redactedResponseJson).toContain(account.applicationKeyId)
    expect(redactedResultJson).toContain(APPLICATION_KEY_REDACTED)
    expect(redactedResultJson).toContain(account.accountId)
    expect(String(result)).not.toContain(secret)
    expect(String(account)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(account)).not.toContain(secret)
    expect(JSON.stringify(inspectedResult)).not.toContain(secret)
    expect(JSON.stringify(inspectedResponse)).not.toContain(secret)
    expect(reserveTrialCreateAccountResponseToRedactedJson(result).applicationKey).toBe(
      APPLICATION_KEY_REDACTED,
    )
  })

  it('accepts single-object reserve trial response bodies', async () => {
    const { raw } = makePartnerEndpointRawClient({
      b2_reserve_trial_create_account: reserveTrialResult,
    })

    const result = await raw.reserveTrialCreateAccount(
      'https://groups.backblazeb2.com/partner',
      authToken,
      {
        email: 'trial-response-object@example.com',
        term: 7,
        storage: 1,
      },
    )

    expect(result.applicationKey).toBe(reserveTrialResult.applicationKey)
  })

  it('does not retry reserve trial failures with an embedded b2api base segment', async () => {
    const requests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com'])
    const transport: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        requests.push(request)
        return jsonErrorResponse(503, 'service_unavailable', 'try again')
      },
    }
    const raw = new PartnerRawClient({
      transport: new RetryTransport({
        transport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })
    const groupsApiUrl = 'https://groups.backblazeb2.com/partner/b2api/v3/proxy'

    await expect(
      raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
        email: 'trial-embedded-b2api-retry@example.com',
        term: 7,
        storage: 1,
      }),
    ).rejects.toThrow()

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${groupsApiUrl}/b2api/v4/b2_reserve_trial_create_account`)
    expect(requests[0]?.idempotent).toBe(false)
  })

  it('does not reauthorize reserve trial failures with an embedded b2api base segment', async () => {
    const requests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com'])
    const transport: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        requests.push(request)
        return jsonErrorResponse(401, 'expired_auth_token', 'expired')
      },
    }
    const onReauth = vi.fn().mockResolvedValue('fresh-partner-token')
    const raw = new PartnerRawClient({
      transport: new RetryTransport({
        transport,
        onReauth,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      raw.reserveTrialCreateAccount(
        'https://groups.backblazeb2.com/partner/b2api/v3/proxy',
        authToken,
        {
          email: 'trial-embedded-b2api-reauth@example.com',
          term: 7,
          storage: 1,
        },
      ),
    ).rejects.toThrow(ExpiredAuthTokenError)

    expect(onReauth).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.idempotent).toBe(false)
  })

  it.each([
    ['missing Authorization header', '', AccessDeniedError, 403, 'access_denied'],
    [
      'malformed Authorization header',
      'Bearer partner-token',
      AccessDeniedError,
      403,
      'access_denied',
    ],
    ['leading whitespace Authorization header', ' 000', AccessDeniedError, 403, 'access_denied'],
    ['trailing whitespace Authorization header', '000 ', AccessDeniedError, 403, 'access_denied'],
    ['interior whitespace Authorization header', '0 0 0', AccessDeniedError, 403, 'access_denied'],
    ['invalid token', '000', BadAuthTokenError, 401, 'unauthorized'],
  ])(
    'surfaces the documented reserve trial auth error path: %s',
    async (_label, token, errorClass, status, code) => {
      const { raw, groupsApiUrl } = await makeSimulatorPartnerRawClient()

      await expect(
        raw.reserveTrialCreateAccount(groupsApiUrl, token, {
          email: 'trial-auth@example.com',
          term: 7,
          storage: 1,
        }),
      ).rejects.toMatchObject({
        code,
        status,
      })
      await expect(
        raw.reserveTrialCreateAccount(groupsApiUrl, token, {
          email: 'trial-auth-2@example.com',
          term: 7,
          storage: 1,
        }),
      ).rejects.toThrow(errorClass)
    },
  )

  it('rejects non-issued Partner tokens in strict simulator mode', async () => {
    const { raw, groupsApiUrl } = await makeSimulatorPartnerRawClient({ strictAuth: true })

    await expect(
      raw.reserveTrialCreateAccount(groupsApiUrl, partnerToken('not-issued'), {
        email: 'trial-strict-token@example.com',
        term: 7,
        storage: 1,
      }),
    ).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
    await expect(
      raw.reserveTrialCreateAccount(groupsApiUrl, partnerToken('not-issued-again'), {
        email: 'trial-strict-token-2@example.com',
        term: 7,
        storage: 1,
      }),
    ).rejects.toThrow(BadAuthTokenError)
  })

  it.each([
    ['missing', undefined],
    ['empty', { Authorization: '' }],
    ['non-Basic', { Authorization: 'Bearer partner-token' }],
    ['malformed Basic', { Authorization: `Basic ${btoa('not-a-key-pair')}` }],
    ['empty Basic credentials', { Authorization: `Basic ${btoa(':')}` }],
  ] satisfies readonly (readonly [string, Record<string, string> | undefined])[])(
    'does not mint simulator Partner tokens with %s authorize credentials',
    async (_label, headers) => {
      const sim = new B2Simulator({ partnerAuthorize: true })
      const transport = sim.transport()

      const authResponse = await transport.send({
        url: 'http://localhost:0/b2api/v3/b2_authorize_account',
        method: 'GET',
        ...(headers !== undefined ? { headers } : {}),
      })
      expect(authResponse.status).toBe(401)
      const authBody = (await authResponse.json()) as { readonly authorizationToken?: string }
      expect(authBody.authorizationToken).toBeUndefined()

      const reserveResponse = await transport.send({
        url: 'http://localhost:0/partner/b2api/v4/b2_reserve_trial_create_account',
        method: 'POST',
        headers: {
          Authorization: authBody.authorizationToken ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'attacker@example.com', term: 7, storage: 1 }),
      })

      expect(reserveResponse.status).toBe(403)
      await expect(reserveResponse.json()).resolves.toMatchObject({ code: 'access_denied' })
    },
  )

  it('does not mint simulator Partner tokens for a known application key secret mismatch', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const transport = sim.transport()
    const keyResponse = await transport.send({
      url: 'http://localhost:0/b2api/v4/b2_create_key',
      method: 'POST',
      headers: {
        Authorization: 'sim-auth-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ListBuckets],
        keyName: 'partner-authorize-negative',
      }),
    })
    const key = (await keyResponse.json()) as { applicationKeyId: string }

    const authResponse = await transport.send({
      url: 'http://localhost:0/b2api/v3/b2_authorize_account',
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:wrong-secret`)}`,
      },
    })

    expect(authResponse.status).toBe(401)
    const authBody = (await authResponse.json()) as { readonly authorizationToken?: string }
    expect(authBody.authorizationToken).toBeUndefined()

    const reserveResponse = await transport.send({
      url: 'http://localhost:0/partner/b2api/v4/b2_reserve_trial_create_account',
      method: 'POST',
      headers: {
        Authorization: authBody.authorizationToken ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'mismatch@example.com', term: 7, storage: 1 }),
    })
    expect(reserveResponse.status).toBe(403)
  })

  it('does not mint simulator Partner tokens with child account application keys', async () => {
    const { raw, sim, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()
    const trial = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'child-key-partner-auth@example.com',
      term: 7,
      storage: 1,
    })

    const authResponse = await sim.transport().send({
      url: 'http://localhost:0/b2api/v3/b2_authorize_account',
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${trial.applicationKeyId}:${trial.applicationKey}`)}`,
      },
    })

    expect(authResponse.status).toBe(401)
    await expect(authResponse.json()).resolves.toMatchObject({ code: 'bad_auth_token' })
  })

  it.each([
    ['Partner API disabled', { partnerApiEnabled: false }],
    ['missing valid phone number', { partnerAccountHasValidPhone: false }],
    ['account not in good standing', { partnerAccountInGoodStanding: false }],
  ] satisfies readonly (readonly [string, B2SimulatorOptions])[])(
    'surfaces reserve trial access_denied when %s',
    async (_label, options) => {
      const { raw, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient(options)

      await expect(
        raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
          email: 'trial-prereq@example.com',
          term: 7,
          storage: 1,
        }),
      ).rejects.toMatchObject({
        code: 'access_denied',
        status: 403,
      })
      await expect(
        raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
          email: 'trial-prereq-typed@example.com',
          term: 7,
          storage: 1,
        }),
      ).rejects.toThrow(AccessDeniedError)
    },
  )

  it('maps reserve trial request validation to BadRequestError', async () => {
    const { raw, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    await expect(
      raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
        email: 'trial-term-error@example.com',
        term: 6,
        storage: 1,
      }),
    ).rejects.toThrow(BadRequestError)
  })

  it('models the reserve trial account result shape with branded IDs', async () => {
    const { raw, groupsApiUrl, authToken } = await makeSimulatorPartnerRawClient()

    const result = await raw.reserveTrialCreateAccount(groupsApiUrl, authToken, {
      email: 'trial-shape@example.com',
      term: 7,
      storage: 1,
    })

    expect(result.bucketId).toEqual(bucketId(result.bucketId))
    expect(result.applicationKeyId).toEqual(applicationKeyId(result.applicationKeyId))
  })
})

describe('PartnerRawClient authorizePartner', () => {
  it('normalizes Partner authorize response and stores it in PartnerAccountInfo', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(partnerAuthorizeResponse())
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')

    expect(seenRequests).toEqual([
      {
        url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        method: 'GET',
        headers: {
          Authorization: `Basic ${btoa('master-key-id:master-key')}`,
        },
      },
    ])
    expect(auth).toMatchObject({
      accountId: accountId('partner-account'),
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
        backupApi: {
          backupApiUrl: 'https://backup.backblazeb2.com/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      backupApiUrl: 'https://backup.backblazeb2.com/backup',
      groupsCapabilities: [PartnerCapability.All],
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: 1_786_662_000_000,
    })
    expect(auth.authorizationToken).toBe(partnerToken('partner-token'))
    const authJson = JSON.stringify(auth)
    expect(authJson).toContain(PARTNER_TOKEN_REDACTED)
    expect(authJson).not.toContain('partner-token')
    const poisonedCache = JSON.parse(authJson) as PartnerAuthorizeResponse
    expect(() => new InMemoryPartnerAccountInfo().setAuth(poisonedCache)).toThrow(
      B2PartnerAuthorizationError,
    )
    expect(() => new InMemoryPartnerAccountInfo().setAuth(poisonedCache)).toThrow(
      'Partner authorization token was redacted',
    )

    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(accountInfo.getAuth()).not.toBe(auth)
    expect(accountInfo.getPartnerToken()).toBe('partner-token')
    expect(accountInfo.getGroupsApiUrl()).toBe('https://groups.backblazeb2.com/partner')
    expect(accountInfo.getBackupApiUrl()).toBe('https://backup.backblazeb2.com/backup')
    expect(accountInfo.getAccountId()).toBe(accountId('partner-account'))
    expect(accountInfo.getGroupsCapabilities()).toEqual([PartnerCapability.All])
    expect(accountInfo.getBackupCapabilities()).toEqual([PartnerCapability.All])
    const cachedAuth = accountInfo.getAuth()
    if (cachedAuth === null) throw new Error('expected cached auth')
    expect(Object.keys(cachedAuth)).toContain('authorizationToken')
    const cachedAuthJson = JSON.stringify(cachedAuth)
    expect(cachedAuthJson).toContain(PARTNER_TOKEN_REDACTED)
    expect(cachedAuthJson).not.toContain('partner-token')
    expect(JSON.stringify(accountInfo)).not.toContain('partner-token')
    expect(accountInfo.toString()).not.toContain('partner-token')

    const persistableAuthJson = JSON.stringify(partnerAuthorizeResponseForPersistence(cachedAuth))
    expect(persistableAuthJson).toContain('partner-token')
    expect(persistableAuthJson).not.toContain(PARTNER_TOKEN_REDACTED)

    const rehydrated = JSON.parse(persistableAuthJson) as PartnerAuthorizeResponse
    const restoredAccountInfo = new InMemoryPartnerAccountInfo()
    restoredAccountInfo.setAuth(rehydrated)
    expect(restoredAccountInfo.getPartnerToken()).toBe('partner-token')
  })

  it('rejects cached auth whose endpoint mirrors drift from apiInfo', () => {
    const auth = cachedPartnerAuth()
    const backupApi = auth.apiInfo.backupApi
    if (backupApi === undefined) throw new Error('test fixture must include Backup suite')

    expect(() =>
      validatePartnerAuthorizeResponseEndpoints(
        { ...auth, groupsApiUrl: 'https://attacker.example/partner' },
        'https://api.backblazeb2.com',
        false,
      ),
    ).toThrow(B2PartnerAuthorizationError)

    expect(() =>
      validatePartnerAuthorizeResponseEndpoints(
        {
          ...auth,
          apiInfo: { backupApi },
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          groupsCapabilities: [PartnerCapability.All],
        },
        'https://api.backblazeb2.com',
        false,
      ),
    ).toThrow(B2PartnerAuthorizationError)
  })

  it('rejects cached auth for custom authorize realms without explicit opt-in', () => {
    const auth: PartnerAuthorizeResponse = {
      ...cachedPartnerAuth(),
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.auth.custom.example/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
        backupApi: {
          backupApiUrl: 'https://backup.auth.custom.example/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      groupsApiUrl: 'https://groups.auth.custom.example/partner',
      backupApiUrl: 'https://backup.auth.custom.example/backup',
    }

    expect(() =>
      validatePartnerAuthorizeResponseEndpoints(auth, 'https://auth.custom.example', false),
    ).toThrow(B2RealmConfigurationError)
    expect(() =>
      validatePartnerAuthorizeResponseEndpoints(auth, 'https://auth.custom.example', true),
    ).not.toThrow()
  })

  it('supports Partner-only authorize responses without Backup fields', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.backblazeb2.com/partner',
              capabilities: [PartnerCapability.All],
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')
    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(auth.backupApiUrl).toBeUndefined()
    expect(auth.backupCapabilities).toBeUndefined()
    expect(accountInfo.getBackupApiUrl()).toBeNull()
    expect(accountInfo.getBackupCapabilities()).toBeNull()
  })

  it('supports Backup-only authorize responses without Partner fields', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            backupApi: {
              backupApiUrl: 'https://backup.backblazeb2.com/backup',
              capabilities: [PartnerCapability.All],
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')
    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(auth.groupsApiUrl).toBeUndefined()
    expect(auth.groupsCapabilities).toBeUndefined()
    expect(auth.backupApiUrl).toBe('https://backup.backblazeb2.com/backup')
    expect(auth.backupCapabilities).toEqual([PartnerCapability.All])
    expect(accountInfo.getGroupsApiUrl()).toBeNull()
    expect(accountInfo.getGroupsCapabilities()).toBeNull()
    expect(accountInfo.getBackupApiUrl()).toBe('https://backup.backblazeb2.com/backup')
    expect(accountInfo.getBackupCapabilities()).toEqual([PartnerCapability.All])
  })

  it('rejects authorize responses without Partner or Backup suites', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {},
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key')).rejects.toThrow(
      B2PartnerAuthorizationError,
    )
  })

  it.each([
    ['malformed groupsApiUrl', { groupsApiUrl: 'not a url' }],
    ['plaintext groupsApiUrl', { groupsApiUrl: 'http://groups.backblazeb2.com/partner' }],
    ['literal-IP groupsApiUrl', { groupsApiUrl: 'https://169.254.169.254/latest/meta-data' }],
    ['localhost groupsApiUrl', { groupsApiUrl: 'https://localhost/partner' }],
    [
      'userinfo groupsApiUrl',
      { groupsApiUrl: 'https://user:secret@groups.backblazeb2.com/partner' },
    ],
    ['query-bearing groupsApiUrl', { groupsApiUrl: 'https://groups.backblazeb2.com/partner?x=1' }],
    ['off-realm groupsApiUrl', { groupsApiUrl: 'https://evil.example/collect' }],
    ['plaintext backupApiUrl', { backupApiUrl: 'http://backup.backblazeb2.com/backup' }],
    ['literal-IP backupApiUrl', { backupApiUrl: 'https://169.254.169.254/latest/meta-data' }],
    ['localhost backupApiUrl', { backupApiUrl: 'https://localhost/backup' }],
    [
      'userinfo backupApiUrl',
      { backupApiUrl: 'https://user:secret@backup.backblazeb2.com/backup' },
    ],
    ['fragment-bearing backupApiUrl', { backupApiUrl: 'https://backup.backblazeb2.com/backup#x' }],
    ['off-realm backupApiUrl', { backupApiUrl: 'https://evil.example/collect' }],
  ])('rejects unsafe Partner endpoint payloads: %s', async (_label, overrides) => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse(partnerAuthorizeResponse(overrides))
      },
    }
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key')).rejects.toThrow(
      B2PartnerAuthorizationError,
    )
  })

  it('accepts and locks Backblaze-owned endpoint hosts outside the authorize realm family', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          partnerAuthorizeResponse({
            groupsApiUrl: 'https://groups.backblaze.com/partner',
            backupApiUrl: 'https://backup.backblaze.com/backup',
          }),
        ),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    const urlGuard = new UrlGuard()
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')

    expect(auth.groupsApiUrl).toBe('https://groups.backblaze.com/partner')
    expect(auth.backupApiUrl).toBe('https://backup.backblaze.com/backup')
    expect(urlGuard.getAllowedSuffixes()).toEqual(['backblaze.com', 'backblazeb2.com'])
    fetchMock.mockRestore()
  })

  it('locks a default FetchTransport UrlGuard to Partner endpoint hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partnerAuthorizeResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const urlGuard = new UrlGuard()
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')

    expect(auth.groupsApiUrl).toBe('https://groups.backblazeb2.com/partner')
    expect(urlGuard.getAllowedSuffixes()).toEqual(['backblazeb2.com'])
    expect(() => urlGuard.check('https://evil.example/collect')).toThrow()
    fetchMock.mockRestore()
  })

  it('uses authorizePartner suffixes through transports that do not expose urlGuard', async () => {
    const seenRequests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    const guardedInner: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        seenRequests.push(request)
        const endpoint = new URL(request.url).pathname.split('/').at(-1)
        return endpoint === 'b2_authorize_account'
          ? jsonResponse(partnerAuthorizeResponse())
          : jsonResponse({ accountId: accountId('partner-account'), groups: [], nextGroupId: null })
      },
    }
    const retry = new RetryTransport({
      transport: guardedInner,
      retry: { maxRetries: 0 },
      sleepImpl: noSleep,
    })
    const wrapper: HttpTransport = {
      async send(request) {
        return retry.send(request)
      },
    }
    const raw = new PartnerRawClient({ transport: wrapper })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')
    if (auth.groupsApiUrl === undefined) throw new Error('expected Partner groups API URL')
    const groups = await raw.listGroups(auth.groupsApiUrl, auth.authorizationToken, {
      adminAccountId: auth.accountId,
    })

    expect(groups.nextGroupId).toBeNull()
    expect(seenRequests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
      'b2_authorize_account',
      'b2_list_groups',
    ])
    expect(urlGuard.getAllowedSuffixes()).toEqual([])
  })

  it('merges Partner endpoint hosts with existing FetchTransport guard suffixes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partnerAuthorizeResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com', 'backblaze.com', 'storage.example.com'])
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport })

    await raw.authorizePartner('master-key-id', 'master-key')

    expect(urlGuard.getAllowedSuffixes()).toEqual([
      'backblaze.com',
      'backblazeb2.com',
      'storage.example.com',
    ])
    fetchMock.mockRestore()
  })

  it('rejects insecure realm URLs before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key', 'sandbox')).rejects.toThrow(
      B2RealmConfigurationError,
    )
    expect(seenUrls).toEqual([])
  })

  it('rejects arbitrary HTTPS authorize realms unless explicitly allowed', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new PartnerRawClient({ transport })

    await expect(
      raw.authorizePartner('master-key-id', 'master-key', 'https://attacker.example'),
    ).rejects.toThrow(B2RealmConfigurationError)
    expect(seenUrls).toEqual([])
  })

  it('allows custom authorize realms only with explicit opt-in', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(
          partnerAuthorizeResponse({
            groupsApiUrl: 'https://groups.auth.custom.example/partner',
            backupApiUrl: 'https://backup.auth.custom.example/backup',
          }),
        )
      },
    }
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    const auth = await raw.authorizePartner(
      'master-key-id',
      'master-key',
      'https://auth.custom.example',
    )

    expect(seenRequests[0]?.url).toBe('https://auth.custom.example/b2api/v3/b2_authorize_account')
    expect(auth.groupsApiUrl).toBe('https://groups.auth.custom.example/partner')
    expect(auth.backupApiUrl).toBe('https://backup.auth.custom.example/backup')
  })

  it('rejects custom authorize responses pointing at unrelated endpoint hosts', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(
          partnerAuthorizeResponse({
            groupsApiUrl: 'https://attacker.example/partner',
          }),
        )
      },
    }
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    await expect(
      raw.authorizePartner('master-key-id', 'master-key', 'https://auth.custom.example'),
    ).rejects.toThrow(B2PartnerAuthorizationError)

    expect(seenRequests.map((request) => apiEndpointName(request))).toEqual([
      'b2_authorize_account',
    ])
  })

  it('accepts loopback HTTP Partner endpoints for loopback custom realms', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(
          partnerAuthorizeResponse({
            groupsApiUrl: 'http://127.0.0.1:12345/partner',
            backupApiUrl: 'http://127.0.0.1:12345/backup',
          }),
        )
      },
    }
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    const auth = await raw.authorizePartner('master-key-id', 'master-key', 'http://127.0.0.1:12345')

    expect(auth.groupsApiUrl).toBe('http://127.0.0.1:12345/partner')
    expect(auth.backupApiUrl).toBe('http://127.0.0.1:12345/backup')
    expect(seenRequests.map((request) => apiEndpointName(request))).toEqual([
      'b2_authorize_account',
    ])
  })

  it('allows custom authorize realms to reauthorize after the URL guard is locked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            partnerAuthorizeResponse({
              groupsApiUrl: 'https://groups.auth.custom.example/partner',
              backupApiUrl: 'https://backup.auth.custom.example/backup',
            }),
          ),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    )
    const urlGuard = new UrlGuard()
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    await raw.authorizePartner('master-key-id', 'master-key', 'https://auth.custom.example')
    await raw.authorizePartner('master-key-id', 'master-key', 'https://auth.custom.example')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(urlGuard.getAllowedSuffixes()).toEqual([
      'auth.custom.example',
      'backup.auth.custom.example',
      'groups.auth.custom.example',
    ])
    fetchMock.mockRestore()
  })

  it('locks backblaze.com custom authorize realms for reauthorization', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify(
          partnerAuthorizeResponse({
            groupsApiUrl: 'https://groups.backblaze.com/partner',
            backupApiUrl: 'https://backup.backblaze.com/backup',
          }),
        ),
        {
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
    const urlGuard = new UrlGuard()
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    await raw.authorizePartner('master-key-id', 'master-key', 'https://api.backblaze.com')

    expect(urlGuard.getAllowedSuffixes()).toEqual(['backblaze.com'])
    fetchMock.mockRestore()
  })
})

describe('InMemoryPartnerAccountInfo', () => {
  function partnerAuth(): PartnerAuthorizeResponse {
    return {
      accountId: accountId('partner-account'),
      authorizationToken: 'partner-token' as PartnerToken,
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
        backupApi: {
          backupApiUrl: 'https://backup.backblazeb2.com/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      backupApiUrl: 'https://backup.backblazeb2.com/backup',
      groupsCapabilities: [PartnerCapability.All],
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    }
  }

  it('throws from getters before authorization and after clear', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getGroupsApiUrl()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getBackupApiUrl()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getAccountId()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getGroupsCapabilities()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getBackupCapabilities()).toThrow(B2PartnerAuthorizationError)

    accountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: 'partner-token' as PartnerToken,
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      groupsCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    })
    accountInfo.clear()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow(B2PartnerAuthorizationError)
  })

  it('does not mutate caller-owned auth objects when storing them', () => {
    const auth = partnerAuth()
    const accountInfo = new InMemoryPartnerAccountInfo()

    accountInfo.setAuth(auth)

    expect(accountInfo.getAuth()).not.toBe(auth)
    expect(Object.keys(auth)).toContain('authorizationToken')
    expect(JSON.stringify(auth)).toContain('partner-token')
    expect(JSON.stringify(accountInfo)).not.toContain('partner-token')
  })

  it('rejects auth objects whose flattened fields drift from apiInfo', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()

    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        groupsApiUrl: 'https://other.backblazeb2.com/partner',
      }),
    ).toThrow(B2PartnerAuthorizationError)
    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        groupsCapabilities: [],
      }),
    ).toThrow(B2PartnerAuthorizationError)
    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        backupApiUrl: 'https://other.backblazeb2.com/backup',
      }),
    ).toThrow(B2PartnerAuthorizationError)
    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        backupCapabilities: [],
      }),
    ).toThrow(B2PartnerAuthorizationError)
  })

  it('rejects auth objects with no suites or orphan convenience fields', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()
    const { backupApi, groupsApi } = partnerAuth().apiInfo
    if (backupApi === undefined || groupsApi === undefined) {
      throw new Error('test fixture must include Partner and Backup suites')
    }

    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        apiInfo: {},
      }),
    ).toThrow(B2PartnerAuthorizationError)
    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        apiInfo: { backupApi },
      }),
    ).toThrow(B2PartnerAuthorizationError)
    expect(() =>
      accountInfo.setAuth({
        ...partnerAuth(),
        apiInfo: { groupsApi },
      }),
    ).toThrow(B2PartnerAuthorizationError)
  })

  it('keeps non-extensible auth data enumerable while documenting clone leakage', () => {
    const auth = Object.preventExtensions(partnerAuth())

    const redacted = redactPartnerAuthorizeResponse(auth)

    expect(redacted).not.toBe(auth)
    expect(Object.keys(redacted)).toContain('authorizationToken')
    expect(JSON.stringify(redacted)).toContain(PARTNER_TOKEN_REDACTED)
    expect(JSON.stringify(redacted)).not.toContain('partner-token')
    expect(JSON.stringify({ ...redacted })).toContain('partner-token')
    expect(JSON.stringify(structuredClone(redacted))).toContain('partner-token')
    expect(JSON.stringify(Object.fromEntries(Object.entries(redacted)))).toContain('partner-token')
    expect(redacted.toString()).not.toContain('partner-token')
  })
})
