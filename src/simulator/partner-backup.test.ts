import { describe, expect, it } from 'vitest'
import type { ComputerBackup } from '../types/backup.ts'
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

interface ListComputersPage {
  readonly nextComputerId: string | null
  readonly computers: readonly ComputerBackup[]
}

type ListComputersResponseBody = readonly ListComputersPage[]

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
      Authorization: request.authorization ?? 'any-partner-token',
      ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  })
  return { status: response.status, body: await response.json<T>() }
}

describe('B2Simulator partner endpoints', () => {
  it('creates, lists, paginates, and ejects group members in permissive mode', async () => {
    const sim = new B2Simulator()
    const adminAccountId = 'admin-account'
    const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${adminAccountId}&maxGroupCount=1`,
    })

    expect(groupsPage.status).toBe(200)
    expect(groupsPage.body.groups).toHaveLength(1)
    expect(groupsPage.body.nextGroupId).toEqual(expect.any(String))
    const group = groupsPage.body.groups[0]
    if (group === undefined) throw new Error('expected default simulator group')

    const createdZ = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
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
    })
    expect(firstMembersPage.status).toBe(200)
    expect(firstMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'a-member@example.com',
    ])
    expect(firstMembersPage.body[0]?.nextEmail).toBe('z-member@example.com')

    const secondMembersPage = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}&startEmail=z-member%40example.com`,
    })
    expect(secondMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'z-member@example.com',
    ])
    expect(secondMembersPage.body[0]?.nextEmail).toBeNull()

    const ejected = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
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
    })
    expect(remainingMembersPage.body[0]?.groupMembers.map((member) => member.email)).toEqual([
      'z-member@example.com',
    ])
  })

  it('reproduces group-member invalid region, group, count, and SMS-phone errors', async () => {
    const sim = new B2Simulator({ partnerAccountHasValidPhone: false })
    const adminAccountId = 'admin-account'
    const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${adminAccountId}`,
    })
    const group = groupsPage.body.groups[0]
    if (group === undefined) throw new Error('expected default simulator group')

    const invalidRegion = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
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
    })
    expect(invalidGroup.status).toBe(401)
    expect(invalidGroup.body.code).toBe('invalid_group_id')

    const outOfRange = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${adminAccountId}&groupId=${group.groupId}&maxMemberCount=1001`,
    })
    expect(outOfRange.status).toBe(401)
    expect(outOfRange.body.code).toBe('out_of_range')

    const missingSmsPhone = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'missing-sms@example.com',
      },
    })
    expect(missingSmsPhone.status).toBe(401)
    expect(missingSmsPhone.body.code).toBe('invalid_sms_phone')
  })
})

describe('B2Simulator backup endpoints', () => {
  it('lists, paginates, and deletes computers under backup-style paths', async () => {
    const sim = new B2Simulator()
    const accountId = 'backup-account'
    const firstPage = await simulatorRequest<ListComputersResponseBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&maxComputerCount=1`,
    })

    expect(firstPage.status).toBe(200)
    expect(firstPage.body[0]?.computers).toHaveLength(1)
    expect(firstPage.body[0]?.nextComputerId).toEqual(expect.any(String))
    const firstComputer = firstPage.body[0]?.computers[0]
    const nextComputerId = firstPage.body[0]?.nextComputerId
    if (firstComputer === undefined || nextComputerId === undefined) {
      throw new Error('expected paginated simulator computers')
    }

    const secondPage = await simulatorRequest<ListComputersResponseBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&startComputerId=${nextComputerId}`,
    })
    expect(secondPage.status).toBe(200)
    expect(secondPage.body[0]?.computers[0]?.computerId).toBe(nextComputerId)

    const deleted = await simulatorRequest<readonly ComputerBackup[]>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
      method: 'POST',
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
      body: {
        accountId,
        computerId: firstComputer.computerId,
      },
    })
    expect(deletedAgain.status).toBe(401)
    expect(deletedAgain.body.code).toBe('invalid_computer_id')

    const deletedCursor = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&startComputerId=${firstComputer.computerId}`,
    })
    expect(deletedCursor.status).toBe(400)
    expect(deletedCursor.body.code).toBe('invalid_computer_id')
  })

  it('rejects out-of-range backup computer counts', async () => {
    const sim = new B2Simulator()

    const result = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=backup-account&maxComputerCount=0',
    })

    expect(result.status).toBe(400)
    expect(result.body.code).toBe('out_of_range')
  })
})
