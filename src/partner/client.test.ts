import { describe, expect, it, vi } from 'vitest'
import {
  B2PartnerAuthorizationError,
  B2SsrfError,
  BadAuthTokenError,
  ExpiredAuthTokenError,
  InvalidGroupIdError,
  ServiceUnavailableError,
} from '../errors/index.ts'
import type { HttpRequest, HttpTransport } from '../http/transport.ts'
import { B2Simulator, type B2SimulatorOptions } from '../simulator/index.ts'
import { jsonErrorResponse, jsonResponse } from '../test-utils/index.ts'
import { accountId, groupId, partnerToken } from '../types/ids.ts'
import {
  type ListedGroupMember,
  type PartnerAuthorizeResponse,
  PartnerCapability,
  type PartnerGroup,
  Region,
} from '../types/partner.ts'
import type { PartnerAccountInfo } from './account-info.ts'
import { PartnerClient, type PartnerClientOptions } from './client.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'

const runtimeGlobals = globalThis as Record<string, unknown>
const runtimeProcess = runtimeGlobals['process'] as
  | { readonly versions?: { readonly node?: string } }
  | undefined
const isNode = typeof runtimeProcess?.versions?.node === 'string'

function requestJsonBody(request: HttpRequest): unknown {
  if (typeof request.body !== 'string') throw new Error('expected JSON request body')
  return JSON.parse(request.body) as unknown
}

function apiEndpointName(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

function makeRecordingPartnerClient(options?: {
  readonly sim?: B2SimulatorOptions
  readonly client?: Partial<Omit<PartnerClientOptions, 'masterKeyId' | 'masterKey' | 'transport'>>
}): {
  readonly client: PartnerClient
  readonly sim: B2Simulator
  readonly seenRequests: HttpRequest[]
} {
  const sim = new B2Simulator({ partnerAuthorize: true, ...(options?.sim ?? {}) })
  const inner = sim.transport()
  const seenRequests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request) {
      seenRequests.push(request)
      return inner.send(request)
    },
  }
  return {
    client: new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      ...(options?.client ?? {}),
    }),
    sim,
    seenRequests,
  }
}

function partnerAuthorizeResponse(
  token: string,
  overrides: { readonly groupsApiUrl?: string; readonly backupApiUrl?: string } = {},
): PartnerAuthorizeResponse {
  const groupsApiUrl = overrides.groupsApiUrl ?? 'https://groups.backblazeb2.com/partner'
  const backupApiUrl = overrides.backupApiUrl ?? 'https://backup.backblazeb2.com/backup'
  return {
    accountId: accountId('partner-account'),
    authorizationToken: partnerToken(token),
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
    groupsApiUrl,
    backupApiUrl,
    groupsCapabilities: [PartnerCapability.All],
    backupCapabilities: [PartnerCapability.All],
    applicationKeyExpirationTimestamp: null,
  }
}

function make401ListGroupsClient(code: string): {
  readonly client: PartnerClient
  readonly listAuthorizations: readonly string[]
  authorizeCount(): number
} {
  let authorizeCount = 0
  const listAuthorizations: string[] = []
  const transport: HttpTransport = {
    async send(request) {
      const endpoint = apiEndpointName(request)
      if (endpoint === 'b2_authorize_account') {
        authorizeCount += 1
        return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
      }
      if (endpoint === 'b2_list_groups') {
        listAuthorizations.push(request.headers?.['Authorization'] ?? '')
        if (listAuthorizations.length === 1) {
          return jsonErrorResponse(401, code, 'simulated 401')
        }
        return jsonResponse({
          accountId: accountId('partner-account'),
          groups: [],
          nextGroupId: null,
        })
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    },
  }

  return {
    client: new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    }),
    listAuthorizations,
    authorizeCount: () => authorizeCount,
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition was not met')
}

describe('PartnerClient facade', () => {
  it('authorizes and reads Partner API coordinates from PartnerAccountInfo', async () => {
    const { client, seenRequests } = makeRecordingPartnerClient()

    const auth = await client.authorize()
    const page = await client.listGroups({ pageSize: 1 })

    expect(client.raw).toBeDefined()
    expect(client.partnerAccountInfo.getPartnerToken()).toBe(auth.authorizationToken)
    expect(page.accountId).toBe(auth.accountId)
    expect(page.groups).toHaveLength(1)

    const listRequest = seenRequests.find(
      (request) => apiEndpointName(request) === 'b2_list_groups',
    )
    if (listRequest === undefined) throw new Error('expected b2_list_groups request')
    const query = new URL(listRequest.url).searchParams
    expect(query.get('adminAccountId')).toBe(auth.accountId)
    expect(query.get('maxGroupCount')).toBe('1')
    expect(listRequest.headers).toMatchObject({ Authorization: auth.authorizationToken })
  })

  it('redacts credentials and tokens from JSON serialization paths', () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token-secret'))
    const client = new PartnerClient({
      masterKeyId: 'master-key-id-secret',
      masterKey: 'master-key-secret',
      partnerAccountInfo,
      transport: {
        async send() {
          throw new Error('unexpected request')
        },
      },
    })

    const rendered = [
      JSON.stringify(client),
      JSON.stringify({ client }),
      JSON.stringify({ client: { ...client } }),
      String(client),
    ].join('\n')

    expect(rendered).not.toContain('master-key-id-secret')
    expect(rendered).not.toContain('master-key-secret')
    expect(rendered).not.toContain('masterKey')
    expect(rendered).not.toContain('masterKeyId')
    expect(rendered).not.toContain('partner-token-secret')
    expect(rendered).not.toContain('application-key-secret')
    expect(rendered).toContain('[redacted')
  })

  it.skipIf(!isNode)('redacts credentials and tokens from Node inspect', async () => {
    const { inspect } = await import(/* @vite-ignore */ 'node:util')
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token-secret'))
    const client = new PartnerClient({
      masterKeyId: 'master-key-id-secret',
      masterKey: 'master-key-secret',
      partnerAccountInfo,
      transport: {
        async send() {
          throw new Error('unexpected request')
        },
      },
    })

    const rendered = [inspect(client), inspect({ client: { ...client } })].join('\n')

    expect(rendered).not.toContain('master-key-id-secret')
    expect(rendered).not.toContain('master-key-secret')
    expect(rendered).not.toContain('masterKey')
    expect(rendered).not.toContain('masterKeyId')
    expect(rendered).not.toContain('partner-token-secret')
    expect(rendered).not.toContain('application-key-secret')
    expect(rendered).toContain('[redacted')
  })

  it('paginates groups and group members through the simulator', async () => {
    const { client } = makeRecordingPartnerClient()
    await client.authorize()

    const groups: PartnerGroup[] = []
    for await (const group of client.paginateGroups({ pageSize: 1 })) {
      groups.push(group)
    }
    expect(groups.map((group) => group.groupName)).toEqual([
      'Simulator Group 1',
      'Simulator Group 2',
      'Simulator Group 3',
    ])
    const group = groups[0]
    if (group === undefined) throw new Error('expected default simulator group')

    const createdZ = await client.createGroupMember({
      groupId: group.groupId,
      memberEmail: 'z-facade-member@example.com',
      region: Region.UsEast,
    })
    const createdA = await client.createGroupMember({
      groupId: group.groupId,
      memberEmail: 'a-facade-member@example.com',
    })
    const createdAMember = createdA[0]?.groupMember
    if (createdAMember === undefined) throw new Error('expected created group member')

    expect(createdZ[0]?.groupMember).toMatchObject({
      email: 'z-facade-member@example.com',
      region: Region.UsEast,
      s3Endpoint: 's3.us-east-001.backblazeb2.com',
    })

    const firstMembersPage = await client.listGroupMembers({
      groupId: group.groupId,
      pageSize: 1,
    })
    expect(firstMembersPage[0]?.groupMembers.map((member) => member.email)).toEqual([
      'a-facade-member@example.com',
    ])
    expect(firstMembersPage[0]?.nextEmail).toBe('z-facade-member@example.com')

    const members: ListedGroupMember[] = []
    for await (const member of client.paginateGroupMembers({
      groupId: group.groupId,
      pageSize: 1,
    })) {
      members.push(member)
    }
    expect(members.map((member) => member.email)).toEqual([
      'a-facade-member@example.com',
      'z-facade-member@example.com',
    ])

    const ejected = await client.ejectGroupMember({
      groupId: group.groupId,
      memberAccountId: createdAMember.accountId,
      email: 'a-facade-ejected@example.com',
    })
    expect(ejected.email).toBe('a-facade-ejected@example.com')

    const remainingMembers: ListedGroupMember[] = []
    for await (const member of client.paginateGroupMembers({ groupId: group.groupId })) {
      remainingMembers.push(member)
    }
    expect(remainingMembers.map((member) => member.email)).toEqual(['z-facade-member@example.com'])
  })

  it('authorizes and calls Partner endpoints for loopback HTTP custom realms', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      realm: 'http://127.0.0.1:12345',
      allowCustomAuthorizeRealm: true,
      disableSsrfGuard: true,
      transport: sim.transport(),
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    const auth = await client.authorize()
    const page = await client.listGroups({ pageSize: 1 })

    expect(auth.groupsApiUrl).toBe('http://127.0.0.1:12345/partner')
    expect(page.groups).toHaveLength(1)
  })

  it('passes documented null member options through to the raw layer', async () => {
    const { client } = makeRecordingPartnerClient()
    await client.authorize()
    const group = groupId('group-id')
    const memberAccountId = accountId('member-account')
    const createSpy = vi.spyOn(client.raw, 'createGroupMember').mockResolvedValue([])
    const ejectSpy = vi.spyOn(client.raw, 'ejectGroupMember').mockResolvedValue({
      accountId: memberAccountId,
      email: 'member@example.com',
      groupId: group,
      groupName: 'Example Group',
      region: Region.UsWest,
      s3Endpoint: 's3.us-west-001.backblazeb2.com',
    })

    await client.createGroupMember({
      groupId: group,
      memberEmail: 'member@example.com',
      region: null,
    })
    await client.ejectGroupMember({
      groupId: group,
      memberAccountId,
      email: null,
    })

    expect(createSpy.mock.calls[0]?.[2]).toMatchObject({ region: null })
    expect(ejectSpy.mock.calls[0]?.[2]).toMatchObject({ email: null })
  })

  it('reserves trial accounts from single and array inputs through the simulator', async () => {
    const { client, seenRequests } = makeRecordingPartnerClient()
    const controller = new AbortController()
    await client.authorize()

    const single = await client.reserveTrialAccounts(
      {
        email: 'facade-trial-one@example.com',
        term: 15,
        storage: 12,
        region: Region.UsEast,
      },
      { signal: controller.signal },
    )
    const multiple = await client.reserveTrialAccounts([
      {
        email: 'facade-trial-two@example.com',
        term: 7,
        storage: 1,
      },
      {
        email: 'facade-trial-three@example.com',
        term: 30,
        storage: 50,
        region: Region.EuCentral,
      },
    ])

    expect(single.map((trial) => trial.email)).toEqual(['facade-trial-one@example.com'])
    expect(multiple.map((trial) => trial.email)).toEqual([
      'facade-trial-two@example.com',
      'facade-trial-three@example.com',
    ])
    const reserveRequests = seenRequests.filter(
      (request) => apiEndpointName(request) === 'b2_reserve_trial_create_account',
    )
    expect(reserveRequests).toHaveLength(2)
    const singleReserveRequest = reserveRequests[0]
    const multipleReserveRequest = reserveRequests[1]
    if (singleReserveRequest === undefined || multipleReserveRequest === undefined) {
      throw new Error('expected reserve trial requests')
    }
    expect(requestJsonBody(singleReserveRequest)).toEqual([
      {
        email: 'facade-trial-one@example.com',
        term: 15,
        storage: 12,
        region: Region.UsEast,
      },
    ])
    expect(singleReserveRequest.signal).toBe(controller.signal)
    expect(requestJsonBody(multipleReserveRequest)).toEqual([
      {
        email: 'facade-trial-two@example.com',
        term: 7,
        storage: 1,
      },
      {
        email: 'facade-trial-three@example.com',
        term: 30,
        storage: 50,
        region: Region.EuCentral,
      },
    ])
  })

  it('rejects empty reserve trial account arrays before the raw request', async () => {
    const { client, seenRequests } = makeRecordingPartnerClient()
    await client.authorize()

    await expect(
      client.reserveTrialAccounts(
        [] as unknown as Parameters<typeof client.reserveTrialAccounts>[0],
      ),
    ).rejects.toThrow(
      'reserveTrialAccounts request array must include at least one account request',
    )

    expect(
      seenRequests.filter(
        (request) => apiEndpointName(request) === 'b2_reserve_trial_create_account',
      ),
    ).toEqual([])
  })

  it('reauthorizes and retries list requests on expired auth token errors', async () => {
    const { client, listAuthorizations, authorizeCount } =
      make401ListGroupsClient('expired_auth_token')

    await client.authorize()
    const page = await client.listGroups()

    expect(page.groups).toEqual([])
    expect(authorizeCount()).toBe(2)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('collapses concurrent expired-token reauthorization into one authorize call', async () => {
    let authorizeCount = 0
    let releaseReauth: (() => void) | undefined
    const reauthGate = new Promise<void>((resolve) => {
      releaseReauth = resolve
    })
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount > 1) await reauthGate
          return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    const calls = Array.from({ length: 5 }, () => client.listGroups())
    await waitUntil(() => authorizeCount === 2)
    releaseReauth?.()
    const pages = await Promise.all(calls)

    expect(pages.every((page) => page.groups.length === 0)).toBe(true)
    expect(authorizeCount).toBe(2)
    expect(listAuthorizations).toEqual([
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
    ])
  })

  it('keeps cached auth when expired-token reauthorization fails', async () => {
    let authorizeCount = 0
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          return jsonErrorResponse(503, 'service_unavailable', 'try again')
        }
        if (endpoint === 'b2_list_groups') {
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    await expect(client.listGroups()).rejects.toThrow(ServiceUnavailableError)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')

    await expect(client.listGroups()).rejects.toThrow(ServiceUnavailableError)
    expect(authorizeCount).toBe(3)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')
  })

  it('cancels expired-token reauthorization with the original list signal', async () => {
    let authorizeCount = 0
    let reauthorizeSignal: AbortSignal | undefined
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          reauthorizeSignal = request.signal
          return new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          })
        }
        if (endpoint === 'b2_list_groups') {
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const controller = new AbortController()

    await client.authorize()
    const pending = client.listGroups({ signal: controller.signal })
    await waitUntil(() => authorizeCount === 2)
    controller.abort(new DOMException('caller canceled', 'AbortError'))

    await expect(pending).rejects.toThrow('caller canceled')
    expect(reauthorizeSignal?.aborted).toBe(true)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')
  })

  it('clears shared expired-token reauthorization when the final waiter aborts', async () => {
    let authorizeCount = 0
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          if (authorizeCount === 2) {
            return new Promise(() => {})
          }
          return jsonResponse(partnerAuthorizeResponse('partner-token-2'))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const controller = new AbortController()

    await client.authorize()
    const first = client.listGroups({ signal: controller.signal })
    await waitUntil(() => authorizeCount === 2)
    controller.abort(new DOMException('caller canceled', 'AbortError'))

    await expect(first).rejects.toThrow('caller canceled')
    const page = await client.listGroups()

    expect(page.groups).toEqual([])
    expect(authorizeCount).toBe(3)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('keeps shared expired-token reauthorization alive for non-aborted waiters', async () => {
    let authorizeCount = 0
    let releaseReauth: (() => void) | undefined
    let reauthorizeSignal: AbortSignal | undefined
    const reauthGate = new Promise<void>((resolve) => {
      releaseReauth = resolve
    })
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          reauthorizeSignal = request.signal
          await reauthGate
          return jsonResponse(partnerAuthorizeResponse('partner-token-2'))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    await client.authorize()
    const first = client.listGroups({ signal: firstController.signal })
    const second = client.listGroups({ signal: secondController.signal })
    await waitUntil(() => authorizeCount === 2 && listAuthorizations.length === 2)
    firstController.abort(new DOMException('first caller canceled', 'AbortError'))

    await expect(first).rejects.toThrow('first caller canceled')
    expect(reauthorizeSignal?.aborted).toBe(false)

    releaseReauth?.()
    const page = await second

    expect(page.groups).toEqual([])
    expect(authorizeCount).toBe(2)
    expect(reauthorizeSignal?.aborted).toBe(false)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('does not reauthorize recursively when authorize returns expired_auth_token', async () => {
    let authorizeCount = 0
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport: {
        async send(request) {
          if (apiEndpointName(request) !== 'b2_authorize_account') {
            throw new Error('unexpected non-authorize request')
          }
          authorizeCount += 1
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        },
      },
      retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await expect(client.authorize()).rejects.toThrow(ExpiredAuthTokenError)
    expect(authorizeCount).toBe(1)
  })

  it('does not reauthorize for partner 401 non-expired auth codes', async () => {
    const { client, listAuthorizations, authorizeCount } = make401ListGroupsClient('unauthorized')

    await client.authorize()
    await expect(client.listGroups()).rejects.toThrow(BadAuthTokenError)

    expect(authorizeCount()).toBe(1)
    expect(listAuthorizations).toEqual(['partner-token-1'])
  })

  it('does not reauthorize for simulator partner validation 401 responses', async () => {
    const { client, seenRequests } = makeRecordingPartnerClient()
    await client.authorize()

    await expect(client.listGroups({ startGroupId: groupId('missing-group') })).rejects.toThrow(
      InvalidGroupIdError,
    )

    expect(
      seenRequests.filter((request) => apiEndpointName(request) === 'b2_authorize_account'),
    ).toHaveLength(1)
  })

  it.each([
    ['off-realm HTTPS', { groupsApiUrl: 'https://attacker.example/partner' }],
    ['plaintext HTTP', { groupsApiUrl: 'http://groups.backblazeb2.com/partner' }],
    ['userinfo', { groupsApiUrl: 'https://user:secret@groups.backblazeb2.com/partner' }],
    ['query string', { groupsApiUrl: 'https://groups.backblazeb2.com/partner?token=secret' }],
    ['fragment', { groupsApiUrl: 'https://groups.backblazeb2.com/partner#token' }],
    ['internal host', { groupsApiUrl: 'https://metadata.google.internal/partner' }],
  ])('rejects unsafe cached auth before Partner tokens can leave: %s', async (_label, overrides) => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('victim-partner-token', overrides))
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({ accountId: accountId('partner-account'), groups: [] })
        },
      },
    })

    expect(partnerAccountInfo.getPartnerToken()).toBe('victim-partner-token')
    await expect(client.listGroups()).rejects.toThrow(B2PartnerAuthorizationError)

    expect(seenRequests).toEqual([])
  })

  it('rejects cached auth whose endpoint mirror points away from apiInfo', async () => {
    const cachedAuth = {
      ...partnerAuthorizeResponse('victim-partner-token'),
      groupsApiUrl: 'https://attacker.example/partner',
    }
    let cleared = false
    const partnerAccountInfo: PartnerAccountInfo = {
      setAuth() {},
      getAuth: () => cachedAuth,
      clear() {
        cleared = true
      },
      getPartnerToken: () => cachedAuth.authorizationToken,
      getGroupsApiUrl: () => cachedAuth.groupsApiUrl ?? null,
      getBackupApiUrl: () => cachedAuth.backupApiUrl ?? null,
      getAccountId: () => cachedAuth.accountId,
      getGroupsCapabilities: () => cachedAuth.groupsCapabilities ?? null,
      getBackupCapabilities: () => cachedAuth.backupCapabilities ?? null,
    }
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({ accountId: accountId('partner-account'), groups: [] })
        },
      },
    })

    expect(cleared).toBe(false)
    await expect(client.listGroups()).rejects.toThrow(B2PartnerAuthorizationError)

    expect(seenRequests).toEqual([])
  })

  it('uses validated cached auth with a custom transport without reauthorizing', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('cached-partner-token'))
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        },
      },
    })

    await client.listGroups()

    expect(seenRequests.map((request) => apiEndpointName(request))).toEqual(['b2_list_groups'])
    expect(seenRequests[0]?.headers?.['Authorization']).toBe('cached-partner-token')
  })

  it('locks the default URL guard from Partner authorize response hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accountId: 'partner-account',
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.backblaze.com/partner',
              capabilities: [PartnerCapability.All],
              infoType: 'groupsApi',
            },
            backupApi: {
              backupApiUrl: 'https://backup.backblazeb2.com/backup',
              capabilities: [PartnerCapability.All],
              infoType: 'backupApi',
            },
          },
          applicationKeyExpirationTimestamp: null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )
    try {
      const client = new PartnerClient({
        masterKeyId: 'master-key-id',
        masterKey: 'master-key',
        additionalAllowedHostSuffixes: [],
      })

      await client.authorize()

      expect(client.urlGuard?.getAllowedSuffixes()).toEqual(['backblaze.com', 'backblazeb2.com'])
      expect(() => client.urlGuard?.check('https://evil.example/collect')).toThrow(B2SsrfError)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('disables the default URL guard only through disableSsrfGuard', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partnerAuthorizeResponse('partner-token')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const client = new PartnerClient({
        masterKeyId: 'master-key-id',
        masterKey: 'master-key',
        disableSsrfGuard: true,
      })

      await client.authorize()

      expect(client.urlGuard?.getAllowedSuffixes()).toEqual([])
    } finally {
      fetchMock.mockRestore()
    }
  })
})
