import { describe, expect, it, vi } from 'vitest'
import { BadAuthTokenError, InvalidGroupIdError } from '../errors/index.ts'
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
import { PartnerClient, type PartnerClientOptions } from './client.ts'

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

function partnerAuthorizeResponse(token: string): PartnerAuthorizeResponse {
  return {
    accountId: accountId('partner-account'),
    authorizationToken: partnerToken(token),
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

  it('reserves trial accounts from single and array inputs through the simulator', async () => {
    const { client, seenRequests } = makeRecordingPartnerClient()
    await client.authorize()

    const single = await client.reserveTrialAccounts({
      email: 'facade-trial-one@example.com',
      term: 15,
      storage: 12,
      region: Region.UsEast,
    })
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
      })

      await client.authorize()

      expect(client.urlGuard?.getAllowedSuffixes()).toEqual(['backblaze.com', 'backblazeb2.com'])
    } finally {
      fetchMock.mockRestore()
    }
  })
})
