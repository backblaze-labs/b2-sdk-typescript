import { describe, expect, it, vi } from 'vitest'
import { B2PartnerAuthorizationError, B2RealmConfigurationError } from '../errors/index.ts'
import { FetchTransport, type HttpRequest, type HttpTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import type { PartnerToken } from '../types/ids.ts'
import { accountId, applicationKeyId, groupId, partnerToken } from '../types/ids.ts'
import { type PartnerAuthorizeResponse, PartnerCapability, Region } from '../types/partner.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient } from './raw.ts'
import { redactPartnerAuthorizeResponse } from './redaction.ts'

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

function requestJsonBody(request: HttpRequest): unknown {
  if (typeof request.body !== 'string') throw new Error('expected JSON request body')
  return JSON.parse(request.body) as unknown
}

function makePartnerEndpointRawClient(responses: Readonly<Record<string, unknown>>): {
  readonly raw: PartnerRawClient
  readonly seenRequests: HttpRequest[]
} {
  const seenRequests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request) {
      seenRequests.push(request)
      const endpoint = new URL(request.url).pathname.split('/').at(-1) ?? ''
      return jsonResponse(responses[endpoint] ?? {})
    },
  }
  return { raw: new PartnerRawClient({ transport }), seenRequests }
}

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

  it('sends Partner POST bodies through the partner base path', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: [
        {
          applicationKey: 'application-key-secret',
          applicationKeyId: applicationKeyId('application-key-id'),
          groupMember,
        },
      ],
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

    expect(created[0]?.groupMember.accountId).toBe(memberAccountId)
    expect(ejected.accountId).toBe(memberAccountId)
    expect(seenRequests).toHaveLength(2)
    const createRequest = seenRequests[0]
    const ejectRequest = seenRequests[1]
    if (createRequest === undefined || ejectRequest === undefined) {
      throw new Error('expected create and eject requests')
    }
    expect(createRequest).toMatchObject({
      url: 'https://groups.backblazeb2.com/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
    })
    expect(requestJsonBody(createRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberEmail: 'member@example.com',
      region: Region.UsWest,
    })
    expect(ejectRequest).toMatchObject({
      url: 'https://groups.backblazeb2.com/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
    })
    expect(requestJsonBody(ejectRequest)).toEqual({
      adminAccountId,
      groupId: group,
      memberAccountId,
      email: 'replacement@example.com',
    })
  })

  it('sends Partner list endpoints as canonical GET query requests', async () => {
    const nextGroup = groupId('255')
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_list_groups: {
        accountId: adminAccountId,
        groups: [],
        nextGroupId: nextGroup,
      },
      b2_list_group_members: {
        groupId: group,
        groupName: 'Example Group',
        groupMembers: [],
        nextEmail: 'next@example.com',
      },
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
    expect(members.nextEmail).toBe('next@example.com')
    expect(seenRequests).toEqual([
      {
        url: 'https://groups.backblazeb2.com/partner/b2api/v3/b2_list_groups?adminAccountId=admin-account&groupName=Example+Group&startGroupId=254&maxGroupCount=10',
        method: 'GET',
        headers: { Authorization: authToken },
      },
      {
        url: 'https://groups.backblazeb2.com/partner/b2api/v3/b2_list_group_members?adminAccountId=admin-account&groupId=254&startEmail=next%40example.com&maxMemberCount=1000',
        method: 'GET',
        headers: { Authorization: authToken },
      },
    ])
  })

  it('omits undefined optional Partner request fields', async () => {
    const { raw, seenRequests } = makePartnerEndpointRawClient({
      b2_create_group_member: [],
      b2_eject_group_member: groupMember,
      b2_list_groups: { accountId: adminAccountId, groups: [], nextGroupId: null },
      b2_list_group_members: {
        groupId: group,
        groupName: 'Example Group',
        groupMembers: [],
        nextEmail: null,
      },
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
      'https://groups.backblazeb2.com/partner/b2api/v3/b2_list_groups?adminAccountId=admin-account',
    )
    expect(seenRequests[3]?.url).toBe(
      'https://groups.backblazeb2.com/partner/b2api/v3/b2_list_group_members?adminAccountId=admin-account&groupId=254',
    )
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

    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(accountInfo.getAuth()).not.toBe(auth)
    expect(accountInfo.getPartnerToken()).toBe('partner-token')
    expect(accountInfo.getGroupsApiUrl()).toBe('https://groups.backblazeb2.com/partner')
    expect(accountInfo.getBackupApiUrl()).toBe('https://backup.backblazeb2.com/backup')
    expect(accountInfo.getAccountId()).toBe(accountId('partner-account'))
    expect(accountInfo.getGroupsCapabilities()).toEqual([PartnerCapability.All])
    expect(accountInfo.getBackupCapabilities()).toEqual([PartnerCapability.All])
    expect(Object.keys(accountInfo.getAuth() ?? {})).toContain('authorizationToken')
    expect(JSON.stringify(accountInfo.getAuth())).toContain('partner-token')
    expect(JSON.stringify(accountInfo)).not.toContain('partner-token')
    expect(accountInfo.toString()).not.toContain('partner-token')

    const rehydrated = JSON.parse(JSON.stringify(accountInfo.getAuth())) as PartnerAuthorizeResponse
    const restoredAccountInfo = new InMemoryPartnerAccountInfo()
    restoredAccountInfo.setAuth(rehydrated)
    expect(restoredAccountInfo.getPartnerToken()).toBe('partner-token')
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

  it('keeps non-extensible auth data enumerable while adding inspection redaction to a copy', () => {
    const auth = Object.preventExtensions(partnerAuth())

    const redacted = redactPartnerAuthorizeResponse(auth)

    expect(redacted).not.toBe(auth)
    expect(Object.keys(redacted)).toContain('authorizationToken')
    expect(JSON.stringify(redacted)).toContain('partner-token')
    expect(redacted.toString()).not.toContain('partner-token')
  })
})
