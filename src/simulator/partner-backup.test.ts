import { describe, expect, it } from 'vitest'
import type { ListComputersResponse } from '../types/backup.ts'
import type { BucketInfo, ListBucketsResponse } from '../types/bucket.ts'
import type {
  CreateGroupMemberResponse,
  EjectGroupMemberResponse,
  ListGroupMembersResponse,
  ListGroupsResponse,
} from '../types/partner.ts'
import { Region } from '../types/partner.ts'
import { B2Simulator } from './index.ts'

interface ErrorBody {
  readonly status: number
  readonly code: string
  readonly message: string
}

interface SimulatorPartnerAuth {
  readonly accountId: string
  readonly authorizationToken: string
}

async function authorizePartner(sim: B2Simulator): Promise<SimulatorPartnerAuth> {
  const response = await sim.transport().send({
    url: 'http://localhost:0/b2api/v3/b2_authorize_account',
    method: 'GET',
    headers: {
      Authorization: `Basic ${btoa('master-key-id:master-key')}`,
    },
  })
  expect(response.status).toBe(200)
  return await response.json<SimulatorPartnerAuth>()
}

async function simulatorRequest<T>(
  sim: B2Simulator,
  request: {
    readonly url: string
    readonly method?: 'GET' | 'HEAD' | 'POST'
    readonly body?: unknown
    readonly authorization?: string
  },
): Promise<{ readonly status: number; readonly body: T }> {
  const response = await sim.transport().send({
    url: request.url,
    method: request.method ?? 'GET',
    headers: {
      ...(request.authorization !== undefined ? { Authorization: request.authorization } : {}),
      ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  })
  return { status: response.status, body: await response.json<T>() }
}

async function firstGroup(
  sim: B2Simulator,
  auth: SimulatorPartnerAuth,
): Promise<ListGroupsResponse['groups'][number]> {
  const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
    url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}`,
    authorization: auth.authorizationToken,
  })
  expect(groupsPage.status).toBe(200)
  const group = groupsPage.body.groups[0]
  if (group === undefined) throw new Error('expected default simulator group')
  return group
}

async function expectUnauthorized(
  result: Promise<{ readonly status: number; readonly body: ErrorBody }>,
) {
  const response = await result
  expect(response.status).toBe(403)
  expect(response.body.code).toBe('unauthorized')
}

describe('B2Simulator partner endpoints', () => {
  it('creates, lists, paginates, and ejects group members with issued Partner tokens', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const adminAccountId = auth.accountId
    const group = await firstGroup(sim, auth)

    const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${adminAccountId}&maxGroupCount=1`,
      authorization: auth.authorizationToken,
    })
    expect(groupsPage.status).toBe(200)
    expect(groupsPage.body.groups).toHaveLength(1)
    expect(groupsPage.body.nextGroupId).toEqual(expect.any(String))

    const createdZ = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'z-member@example.com',
        region: Region.UsEast,
      },
    })
    const createdA = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'a-member@example.com',
      },
    })

    expect(createdZ.status).toBe(200)
    expect(createdA.status).toBe(200)
    expect(createdZ.body[0]?.groupMember).toMatchObject({
      email: 'z-member@example.com',
      groupId: group.groupId,
      region: Region.UsEast,
      s3Endpoint: 's3.us-east-001.backblazeb2.com',
    })
    expect(createdZ.body[0]?.applicationKeyId).toEqual(expect.any(String))
    expect(createdZ.body[0]?.applicationKey).toEqual(expect.any(String))

    const duplicate = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'a-member@example.com',
      },
    })
    expect(duplicate.status).toBe(401)
    expect(duplicate.body.code).toBe('invalid_email')

    const firstMembersPage = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}&maxMemberCount=1`,
      authorization: auth.authorizationToken,
    })
    expect(firstMembersPage.status).toBe(200)
    expect(firstMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'a-member@example.com',
    ])
    expect(firstMembersPage.body[0]?.nextEmail).toBe('z-member@example.com')

    const secondMembersPage = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}&startEmail=z-member%40example.com`,
      authorization: auth.authorizationToken,
    })
    expect(secondMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'z-member@example.com',
    ])
    expect(secondMembersPage.body[0]?.nextEmail).toBeNull()

    const ejected = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberAccountId: createdA.body[0]?.groupMember.accountId,
        email: 'a-ejected@example.com',
      },
    })
    expect(ejected.status).toBe(200)
    expect(ejected.body.email).toBe('a-ejected@example.com')

    const remainingMembersPage = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}`,
      authorization: auth.authorizationToken,
    })
    expect(remainingMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'z-member@example.com',
    ])
  })

  it('reproduces group-member invalid region, group, count, and SMS-phone errors', async () => {
    const sim = new B2Simulator({
      partnerAuthorize: true,
      partnerAccountHasValidPhone: false,
    })
    const auth = await authorizePartner(sim)
    const adminAccountId = auth.accountId
    const group = await firstGroup(sim, auth)

    const invalidRegion = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'invalid-region@example.com',
        region: 'antarctica',
      },
    })
    expect(invalidRegion.status).toBe(401)
    expect(invalidRegion.body.code).toBe('invalid_region')

    const invalidGroup = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=deleted-group`,
      authorization: auth.authorizationToken,
    })
    expect(invalidGroup.status).toBe(401)
    expect(invalidGroup.body.code).toBe('invalid_group_id')

    const outOfRange = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}&maxMemberCount=1001`,
      authorization: auth.authorizationToken,
    })
    expect(outOfRange.status).toBe(401)
    expect(outOfRange.body.code).toBe('out_of_range')

    const missingSmsPhone = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'missing-sms@example.com',
      },
    })
    expect(missingSmsPhone.status).toBe(401)
    expect(missingSmsPhone.body.code).toBe('invalid_sms_phone')
  })

  it('treats maxMemberCount zero as the default page size', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)

    const created = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'zero-count@example.com',
      },
    })
    expect(created.status).toBe(200)

    const queryResult = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${auth.accountId}&groupId=${group.groupId}&maxMemberCount=0`,
      authorization: auth.authorizationToken,
    })
    expect(queryResult.status).toBe(200)
    expect(queryResult.body[0]?.groupMembers.map((member) => member.email)).toContain(
      'zero-count@example.com',
    )

    const bodyResult = await sim.handleRequest(
      'GET',
      'http://localhost:0',
      '/partner/b2api/v3/b2_list_group_members',
      { authorization: auth.authorizationToken },
      { adminAccountId: auth.accountId, groupId: group.groupId, maxMemberCount: 0 },
    )
    expect(bodyResult.status).toBe(200)
    expect((bodyResult.body as ListGroupMembersResponse)[0]?.groupMembers).toHaveLength(1)
  })

  it('releases the old email when ejection renames a member account', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)

    const created = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'reuse@example.com',
      },
    })
    const memberAccountId = created.body[0]?.groupMember.accountId
    if (memberAccountId === undefined) throw new Error('expected created member')

    const ejected = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId,
        email: 'renamed@example.com',
      },
    })
    expect(ejected.status).toBe(200)

    const recreated = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'reuse@example.com',
      },
    })
    expect(recreated.status).toBe(200)
    expect(recreated.body[0]?.groupMember.email).toBe('reuse@example.com')
  })

  it('reports invalid reserve trial email values clearly', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)

    const result = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: [{ email: 'invalid-email', term: 7, storage: 1 }],
    })

    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({
      code: 'bad_request',
      message: 'email address is invalid',
    })
  })

  it('rejects cross-account Partner and Backup requests in strict auth mode', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true, strictAuth: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)
    const wrongAccountId = 'victim-account'

    const created = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'scoped-member@example.com',
      },
    })
    const memberAccountId = created.body[0]?.groupMember.accountId
    if (memberAccountId === undefined) throw new Error('expected scoped member')

    const computers = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${auth.accountId}`,
      authorization: auth.authorizationToken,
    })
    const computerId = computers.body[0]?.computers[0]?.computerId
    if (computerId === undefined) throw new Error('expected simulator computer')

    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${wrongAccountId}`,
        authorization: auth.authorizationToken,
      }),
    )
    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${wrongAccountId}&groupId=${group.groupId}`,
        authorization: auth.authorizationToken,
      }),
    )
    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
        method: 'POST',
        authorization: auth.authorizationToken,
        body: {
          adminAccountId: wrongAccountId,
          groupId: group.groupId,
          memberEmail: 'wrong-create@example.com',
        },
      }),
    )
    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
        method: 'POST',
        authorization: auth.authorizationToken,
        body: {
          adminAccountId: wrongAccountId,
          groupId: group.groupId,
          memberAccountId,
        },
      }),
    )
    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${wrongAccountId}`,
        authorization: auth.authorizationToken,
      }),
    )
    await expectUnauthorized(
      simulatorRequest<ErrorBody>(sim, {
        url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
        method: 'POST',
        authorization: auth.authorizationToken,
        body: { accountId: wrongAccountId, computerId },
      }),
    )
  })

  it('rejects bodyless GET query requests for mutating endpoints', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)

    const createViaGet = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_create_group_member?adminAccountId=${auth.accountId}&groupId=${group.groupId}&memberEmail=get-create%40example.com`,
      authorization: auth.authorizationToken,
    })
    expect(createViaGet.status).toBe(405)
    expect(createViaGet.body.code).toBe('method_not_allowed')

    const validMember = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'get-eject@example.com',
      },
    })
    const memberAccountId = validMember.body[0]?.groupMember.accountId
    if (memberAccountId === undefined) throw new Error('expected created member')

    const ejectViaGet = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_eject_group_member?adminAccountId=${auth.accountId}&groupId=${group.groupId}&memberAccountId=${memberAccountId}`,
      authorization: auth.authorizationToken,
    })
    expect(ejectViaGet.status).toBe(405)
    expect(ejectViaGet.body.code).toBe('method_not_allowed')

    const members = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${auth.accountId}&groupId=${group.groupId}`,
      authorization: auth.authorizationToken,
    })
    expect(members.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'get-eject@example.com',
    ])

    const computers = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${auth.accountId}`,
      authorization: auth.authorizationToken,
    })
    const computerId = computers.body[0]?.computers[0]?.computerId
    if (computerId === undefined) throw new Error('expected simulator computer')

    const deleteComputerViaGet = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_delete_computer?accountId=${auth.accountId}&computerId=${computerId}`,
      authorization: auth.authorizationToken,
    })
    expect(deleteComputerViaGet.status).toBe(405)
    expect(deleteComputerViaGet.body.code).toBe('method_not_allowed')

    const bucket = await simulatorRequest<BucketInfo>(sim, {
      url: 'http://localhost:0/b2api/v3/b2_create_bucket',
      method: 'POST',
      authorization: 'storage-token',
      body: {
        accountId: auth.accountId,
        bucketName: 'method-confusion-bucket',
        bucketType: 'allPrivate',
      },
    })
    expect(bucket.status).toBe(200)

    const deleteBucketViaGet = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/b2api/v3/b2_delete_bucket?bucketId=${bucket.body.bucketId}`,
      authorization: 'storage-token',
    })
    expect(deleteBucketViaGet.status).toBe(405)
    expect(deleteBucketViaGet.body.code).toBe('method_not_allowed')

    const buckets = await simulatorRequest<ListBucketsResponse>(sim, {
      url: 'http://localhost:0/b2api/v3/b2_list_buckets',
      method: 'POST',
      authorization: 'storage-token',
      body: { accountId: auth.accountId },
    })
    expect(buckets.body.buckets.map((listed) => listed.bucketId)).toContain(bucket.body.bucketId)
  })
})

describe('B2Simulator backup endpoints', () => {
  it('lists, paginates, and deletes computers under backup-style paths', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const accountId = auth.accountId
    const firstPage = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&maxComputerCount=1`,
      authorization: auth.authorizationToken,
    })

    expect(firstPage.status).toBe(200)
    expect(firstPage.body[0]?.computers).toHaveLength(1)
    expect(firstPage.body[0]?.nextComputerId).toEqual(expect.any(String))
    const firstComputer = firstPage.body[0]?.computers[0]
    const nextComputerId = firstPage.body[0]?.nextComputerId
    if (firstComputer === undefined || nextComputerId === undefined) {
      throw new Error('expected paginated simulator computers')
    }

    const secondPage = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&startComputerId=${nextComputerId}`,
      authorization: auth.authorizationToken,
    })
    expect(secondPage.status).toBe(200)
    expect(secondPage.body[0]?.computers[0]?.computerId).toBe(nextComputerId)

    const deleted = await simulatorRequest<ListComputersResponse[number]['computers']>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        accountId,
        computerId: firstComputer.computerId,
      },
    })
    expect(deleted.status).toBe(200)
    expect(deleted.body[0]).toEqual(firstComputer)

    const deletedAgain = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        accountId,
        computerId: firstComputer.computerId,
      },
    })
    expect(deletedAgain.status).toBe(400)
    expect(deletedAgain.body.code).toBe('invalid_computer_id')

    const deletedCursor = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&startComputerId=${firstComputer.computerId}`,
      authorization: auth.authorizationToken,
    })
    expect(deletedCursor.status).toBe(400)
    expect(deletedCursor.body.code).toBe('invalid_computer_id')
  })

  it('rejects out-of-range backup computer counts', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)

    const result = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${auth.accountId}&maxComputerCount=0`,
      authorization: auth.authorizationToken,
    })

    expect(result.status).toBe(400)
    expect(result.body.code).toBe('out_of_range')
  })
})
