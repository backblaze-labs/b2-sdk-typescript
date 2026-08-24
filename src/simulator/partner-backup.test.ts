import { describe, expect, it } from 'vitest'
import { APPLICATION_KEY_REDACTED } from '../partner/redaction.ts'
import type { ListComputersResponse } from '../types/backup.ts'
import type { BucketInfo, ListBucketsResponse } from '../types/bucket.ts'
import type {
  CreateGroupMemberResponse,
  EjectGroupMemberResponse,
  ListGroupMembersResponse,
  ListGroupsResponse,
  ReserveTrialCreateAccountResponse,
} from '../types/partner.ts'
import { PartnerCapability, Region } from '../types/partner.ts'
import { B2Simulator, type B2SimulatorOptions } from './index.ts'

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

async function expectPartnerCapabilityError(
  result: Promise<{ readonly status: number; readonly body: ErrorBody }>,
) {
  const response = await result
  expect(response.status).toBe(401)
  expect(response.body).toMatchObject({
    code: 'unauthorized',
    message: expect.stringContaining(PartnerCapability.All),
  })
}

describe('B2Simulator partner endpoints', () => {
  it('accepts arbitrary non-empty Partner tokens in default permissive mode', async () => {
    const sim = new B2Simulator()
    const authorization = 'any-partner-token'
    const adminAccountId = 'offline-admin'

    const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${adminAccountId}`,
      authorization,
    })
    expect(groupsPage.status).toBe(200)
    const group = groupsPage.body.groups[0]
    if (group === undefined) throw new Error('expected default simulator group')

    const created = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization,
      body: {
        adminAccountId,
        groupId: group.groupId,
        memberEmail: 'permissive@example.com',
      },
    })
    expect(created.status).toBe(200)
    expect(created.body[0]?.groupMember.email).toBe('permissive@example.com')

    const computers = await simulatorRequest<ListComputersResponse>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=offline-backup',
      authorization,
    })
    expect(computers.status).toBe(200)
    expect(computers.body.computers).toHaveLength(3)
  })

  it('handles prototype-shaped query keys on Partner GET endpoints', async () => {
    const sim = new B2Simulator()

    const groupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups?__proto__=polluted&constructor=ignored&adminAccountId=query-admin',
      authorization: 'any-partner-token',
    })

    expect(groupsPage.status).toBe(200)
    expect(groupsPage.body.accountId).toBe('query-admin')
  })

  it.each([
    [
      'disabled Partner API',
      { partnerApiEnabled: false },
      'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=default-prereq',
      undefined,
      'account is not enabled for Partner API',
    ],
    [
      'missing SMS phone',
      { partnerAccountHasValidPhone: false },
      'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
      [{ email: 'default-phone@example.com', term: 7, storage: 1 }],
      'account does not have a valid phone number',
    ],
    [
      'account not in good standing',
      { partnerAccountInGoodStanding: false },
      'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=default-standing',
      undefined,
      'account is not in good standing',
    ],
  ] satisfies readonly (readonly [string, B2SimulatorOptions, string, unknown, string])[])(
    'rejects default permissive Partner calls for %s',
    async (_label, options, url, body, message) => {
      const sim = new B2Simulator(options)
      const result = await simulatorRequest<ErrorBody>(sim, {
        url,
        method: body === undefined ? 'GET' : 'POST',
        authorization: 'any-partner-token',
        ...(body === undefined ? {} : { body }),
      })

      expect(result.status).toBe(403)
      expect(result.body).toMatchObject({
        code: 'access_denied',
        message,
      })
    },
  )

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

  it('allows full Partner capabilities on every strict Partner and Backup endpoint', async () => {
    const sim = new B2Simulator({
      partnerAuthorize: true,
      partnerGroupsCapabilities: [PartnerCapability.All],
      partnerBackupCapabilities: [PartnerCapability.All],
    })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)

    const reserved = await simulatorRequest<ReserveTrialCreateAccountResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: [{ email: 'full-cap-trial@example.com', term: 7, storage: 1 }],
    })
    expect(reserved.status).toBe(200)

    const created = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'full-cap-member@example.com',
      },
    })
    expect(created.status).toBe(200)
    const memberAccountId = created.body[0]?.groupMember.accountId
    if (memberAccountId === undefined) throw new Error('expected full-cap member')

    const members = await simulatorRequest<ListGroupMembersResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${auth.accountId}&groupId=${group.groupId}`,
      authorization: auth.authorizationToken,
    })
    expect(members.status).toBe(200)

    const ejected = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId,
      },
    })
    expect(ejected.status).toBe(200)

    const computers = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${auth.accountId}`,
      authorization: auth.authorizationToken,
    })
    expect(computers.status).toBe(200)
    const computerId = computers.body.computers[0]?.computerId
    if (computerId === undefined) throw new Error('expected full-cap computer')

    const deleted = await simulatorRequest<ListComputersResponse['computers']>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        accountId: auth.accountId,
        computerId,
      },
    })
    expect(deleted.status).toBe(200)
  })

  it('rejects strict groups calls when the Partner token lacks the required capability', async () => {
    const sim = new B2Simulator({
      partnerAuthorize: true,
      partnerGroupsCapabilities: [],
    })
    const auth = await authorizePartner(sim)

    await expectPartnerCapabilityError(
      simulatorRequest<ErrorBody>(sim, {
        url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}`,
        authorization: auth.authorizationToken,
      }),
    )
  })

  it('keeps strict Partner capability suites isolated', async () => {
    const groupsOnly = new B2Simulator({
      partnerAuthorize: true,
      partnerBackupCapabilities: [],
    })
    const groupsAuth = await authorizePartner(groupsOnly)
    const groups = await simulatorRequest<ListGroupsResponse>(groupsOnly, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${groupsAuth.accountId}`,
      authorization: groupsAuth.authorizationToken,
    })
    expect(groups.status).toBe(200)
    await expectPartnerCapabilityError(
      simulatorRequest<ErrorBody>(groupsOnly, {
        url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${groupsAuth.accountId}`,
        authorization: groupsAuth.authorizationToken,
      }),
    )
    await expectPartnerCapabilityError(
      simulatorRequest<ErrorBody>(groupsOnly, {
        url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
        method: 'POST',
        authorization: groupsAuth.authorizationToken,
        body: { accountId: groupsAuth.accountId, computerId: 'blocked-computer' },
      }),
    )

    const backupOnly = new B2Simulator({
      partnerAuthorize: true,
      partnerGroupsCapabilities: [],
    })
    const backupAuth = await authorizePartner(backupOnly)
    const computers = await simulatorRequest<ListComputersResponse>(backupOnly, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${backupAuth.accountId}`,
      authorization: backupAuth.authorizationToken,
    })
    expect(computers.status).toBe(200)
    const computerId = computers.body.computers[0]?.computerId
    if (computerId === undefined) throw new Error('expected backup-only computer')
    const deleted = await simulatorRequest<ListComputersResponse['computers']>(backupOnly, {
      url: 'http://localhost:0/api/backup/v1/bz_delete_computer',
      method: 'POST',
      authorization: backupAuth.authorizationToken,
      body: { accountId: backupAuth.accountId, computerId },
    })
    expect(deleted.status).toBe(200)
    await expectPartnerCapabilityError(
      simulatorRequest<ErrorBody>(backupOnly, {
        url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${backupAuth.accountId}`,
        authorization: backupAuth.authorizationToken,
      }),
    )
  })

  it('does not check Partner capabilities in permissive mode', async () => {
    const sim = new B2Simulator({
      partnerGroupsCapabilities: [],
      partnerBackupCapabilities: [],
    })

    const groups = await simulatorRequest<ListGroupsResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=permissive-cap-admin',
      authorization: 'arbitrary-partner-token',
    })
    expect(groups.status).toBe(200)

    const computers = await simulatorRequest<ListComputersResponse>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=permissive-cap-backup',
      authorization: 'arbitrary-partner-token',
    })
    expect(computers.status).toBe(200)
  })

  it('keeps simulator wire response application keys not redacted', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)
    const transport = sim.transport()

    const createdResponse = await transport.send({
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      headers: {
        Authorization: auth.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'wire-member@example.com',
      }),
    })
    const createdText = await createdResponse.text()
    const created = JSON.parse(createdText) as CreateGroupMemberResponse
    const memberKey = created[0]?.applicationKey
    if (memberKey === undefined) throw new Error('expected member application key')
    expect(createdText).toContain(memberKey)
    expect(createdText).not.toContain(APPLICATION_KEY_REDACTED)

    const trialResponse = await transport.send({
      url: 'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
      method: 'POST',
      headers: {
        Authorization: auth.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ email: 'wire-trial@example.com', term: 7, storage: 1 }]),
    })
    const trialText = await trialResponse.text()
    const trial = JSON.parse(trialText) as ReserveTrialCreateAccountResponse
    const trialKey = trial[0]?.applicationKey
    if (trialKey === undefined) throw new Error('expected trial application key')
    expect(trialText).toContain(trialKey)
    expect(trialText).not.toContain(APPLICATION_KEY_REDACTED)
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

  it('reports partner request validation failures', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)
    const group = await firstGroup(sim, auth)

    const invalidReserveTrialBodies: readonly {
      readonly body: unknown
      readonly message: string
    }[] = [
      { body: {}, message: 'request body must be an array' },
      { body: [], message: 'request body must include at least one account' },
      { body: [null], message: 'trial account request must be an object' },
      { body: [{}], message: 'email is required' },
      {
        body: [
          { email: 'duplicate-trial@example.com', term: 7, storage: 1 },
          { email: 'DUPLICATE-TRIAL@example.com', term: 7, storage: 1 },
        ],
        message: 'email must not already exist as a Backblaze account',
      },
      {
        body: [{ email: 'term-error@example.com', term: 6, storage: 1 }],
        message: 'term must be between 7 and 30 days',
      },
      {
        body: [{ email: 'storage-error@example.com', term: 7, storage: 51 }],
        message: 'storage must be between 1 and 50 TB',
      },
      {
        body: [{ email: 'region-error@example.com', term: 7, storage: 1, region: 'antarctica' }],
        message: 'region is not supported',
      },
    ]
    for (const { body, message } of invalidReserveTrialBodies) {
      const result = await simulatorRequest<ErrorBody>(sim, {
        url: 'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
        method: 'POST',
        authorization: auth.authorizationToken,
        body,
      })
      expect(result.status).toBe(400)
      expect(result.body.message).toBe(message)
    }

    const missingAdminAccount = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: { groupId: group.groupId, memberEmail: 'missing-admin@example.com' },
    })
    expect(missingAdminAccount.status).toBe(400)
    expect(missingAdminAccount.body.code).toBe('bad_request')

    const missingGroupId = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: { adminAccountId: auth.accountId, memberEmail: 'missing-group@example.com' },
    })
    expect(missingGroupId.status).toBe(401)
    expect(missingGroupId.body.code).toBe('invalid_group_id')

    const missingMemberEmail = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: { adminAccountId: auth.accountId, groupId: group.groupId },
    })
    expect(missingMemberEmail.status).toBe(401)
    expect(missingMemberEmail.body.code).toBe('invalid_email')

    const invalidCreateGroup = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: 'missing-group',
        memberEmail: 'missing-group@example.com',
      },
    })
    expect(invalidCreateGroup.status).toBe(401)
    expect(invalidCreateGroup.body.code).toBe('invalid_group_id')

    const listGroupsMissingAdmin = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups',
      authorization: auth.authorizationToken,
    })
    expect(listGroupsMissingAdmin.status).toBe(400)
    expect(listGroupsMissingAdmin.body.code).toBe('bad_request')

    const listGroupsOutOfRange = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}&maxGroupCount=101`,
      authorization: auth.authorizationToken,
    })
    expect(listGroupsOutOfRange.status).toBe(401)
    expect(listGroupsOutOfRange.body.code).toBe('out_of_range')

    const filteredGroups = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}&groupName=${encodeURIComponent('Simulator Group 2')}`,
      authorization: auth.authorizationToken,
    })
    expect(filteredGroups.status).toBe(200)
    expect(filteredGroups.body.groups.map((entry) => entry.groupName)).toEqual([
      'Simulator Group 2',
    ])

    const secondGroupsPage = await simulatorRequest<ListGroupsResponse>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}&maxGroupCount=1&startGroupId=${filteredGroups.body.groups[0]?.groupId}`,
      authorization: auth.authorizationToken,
    })
    expect(secondGroupsPage.status).toBe(200)
    expect(secondGroupsPage.body.groups[0]?.groupName).toBe('Simulator Group 2')

    const invalidStartGroup = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=${auth.accountId}&startGroupId=missing-group`,
      authorization: auth.authorizationToken,
    })
    expect(invalidStartGroup.status).toBe(401)
    expect(invalidStartGroup.body.code).toBe('invalid_group_id')

    const invalidStartEmail = await sim.handleRequest(
      'GET',
      'http://localhost:0',
      '/partner/b2api/v3/b2_list_group_members',
      { authorization: auth.authorizationToken },
      { adminAccountId: auth.accountId, groupId: group.groupId, startEmail: 1 },
    )
    expect(invalidStartEmail.status).toBe(400)
    expect((invalidStartEmail.body as ErrorBody).message).toBe('startEmail must be a string')

    const listedWithMissingGroupId = await simulatorRequest<ErrorBody>(sim, {
      url: `http://localhost:0/partner/b2api/v3/b2_list_group_members?adminAccountId=${auth.accountId}`,
      authorization: auth.authorizationToken,
    })
    expect(listedWithMissingGroupId.status).toBe(401)
    expect(listedWithMissingGroupId.body.code).toBe('invalid_group_id')

    const invalidEjectGroup = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: 'missing-group',
        memberAccountId: auth.accountId,
      },
    })
    expect(invalidEjectGroup.status).toBe(401)
    expect(invalidEjectGroup.body.code).toBe('invalid_group_id')

    const invalidMember = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId: auth.accountId,
      },
    })
    expect(invalidMember.status).toBe(401)
    expect(invalidMember.body.code).toBe('invalid_member_account_id')

    const invalidEjectEmailType = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId: auth.accountId,
        email: 123,
      },
    })
    expect(invalidEjectEmailType.status).toBe(401)
    expect(invalidEjectEmailType.body.code).toBe('invalid_email')

    const createdForEject = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'invalid-eject-email@example.com',
      },
    })
    const memberAccountId = createdForEject.body[0]?.groupMember.accountId
    if (memberAccountId === undefined) throw new Error('expected member account id')

    const invalidEjectEmail = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId,
        email: 'invalid-email',
      },
    })
    expect(invalidEjectEmail.status).toBe(401)
    expect(invalidEjectEmail.body.code).toBe('invalid_email')

    const sameEmailEject = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId,
        email: 'invalid-eject-email@example.com',
      },
    })
    expect(sameEmailEject.status).toBe(200)

    const createdWithoutRename = await simulatorRequest<CreateGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberEmail: 'no-rename@example.com',
      },
    })
    const noRenameAccountId = createdWithoutRename.body[0]?.groupMember.accountId
    if (noRenameAccountId === undefined) throw new Error('expected member account id')
    const noRenameEject = await simulatorRequest<EjectGroupMemberResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: {
        adminAccountId: auth.accountId,
        groupId: group.groupId,
        memberAccountId: noRenameAccountId,
      },
    })
    expect(noRenameEject.status).toBe(200)
  })

  it('rejects unauthenticated partner and backup requests before parsing', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const unauthenticatedRequests: readonly {
      readonly url: string
      readonly method?: 'GET' | 'POST'
      readonly body?: unknown
    }[] = [
      { url: 'http://localhost:0/partner/b2api/v3/b2_list_groups' },
      { url: 'http://localhost:0/partner/b2api/v3/b2_list_group_members' },
      {
        url: 'http://localhost:0/partner/b2api/v3/b2_create_group_member',
        method: 'POST',
        body: {},
      },
      {
        url: 'http://localhost:0/partner/b2api/v3/b2_eject_group_member',
        method: 'POST',
        body: {},
      },
      { url: 'http://localhost:0/api/backup/v1/bz_list_computers' },
      { url: 'http://localhost:0/api/backup/v1/bz_delete_computer', method: 'POST', body: {} },
    ]

    for (const request of unauthenticatedRequests) {
      const result = await simulatorRequest<ErrorBody>(sim, request)
      expect(result.status).toBe(403)
      expect(result.body.code).toBe('access_denied')
    }
  })

  it('rejects unknown Partner authorize keys in strict mode', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true, strictAuth: true })
    const transport = sim.transport()

    const authResponse = await transport.send({
      url: 'http://localhost:0/b2api/v3/b2_authorize_account',
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa('attacker-key:any-secret')}`,
      },
    })
    expect(authResponse.status).toBe(401)
    const authBody = (await authResponse.json()) as { readonly authorizationToken?: string }
    expect(authBody.authorizationToken).toBeUndefined()

    const reserveResponse = await transport.send({
      url: 'http://localhost:0/partner/b2api/v3/b2_reserve_trial_create_account',
      method: 'POST',
      headers: {
        Authorization: 'attacker-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ email: 'attacker@example.com', term: 7, storage: 1 }]),
    })
    expect(reserveResponse.status).toBe(401)
    await expect(reserveResponse.json()).resolves.toMatchObject({ code: 'unauthorized' })
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
    const computerId = computers.body.computers[0]?.computerId
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
    const computerId = computers.body.computers[0]?.computerId
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

  it('bounds auto-provisioned state for arbitrary list account IDs', async () => {
    const sim = new B2Simulator()
    const authorization = 'bounded-partner-token'

    const firstGroups = await simulatorRequest<ListGroupsResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=bounded-admin-0',
      authorization,
    })
    const secondGroups = await simulatorRequest<ListGroupsResponse>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=bounded-admin-0',
      authorization,
    })
    expect(secondGroups.body).toEqual(firstGroups.body)

    for (let index = 1; index < 100; index += 1) {
      const result = await simulatorRequest<ListGroupsResponse>(sim, {
        url: `http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=bounded-admin-${index}`,
        authorization,
      })
      expect(result.status).toBe(200)
    }
    const groupCap = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/partner/b2api/v3/b2_list_groups?adminAccountId=bounded-admin-100',
      authorization,
    })
    expect(groupCap.status).toBe(400)
    expect(groupCap.body.code).toBe('too_many_accounts')

    const firstComputers = await simulatorRequest<ListComputersResponse>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=bounded-backup-0',
      authorization,
    })
    const secondComputers = await simulatorRequest<ListComputersResponse>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=bounded-backup-0',
      authorization,
    })
    expect(secondComputers.body).toEqual(firstComputers.body)

    for (let index = 1; index < 100; index += 1) {
      const result = await simulatorRequest<ListComputersResponse>(sim, {
        url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=bounded-backup-${index}`,
        authorization,
      })
      expect(result.status).toBe(200)
    }
    const computerCap = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers?accountId=bounded-backup-100',
      authorization,
    })
    expect(computerCap.status).toBe(400)
    expect(computerCap.body.code).toBe('too_many_accounts')
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
    expect(firstPage.body.computers).toHaveLength(1)
    expect(firstPage.body.nextComputerId).toEqual(expect.any(String))
    const firstComputer = firstPage.body.computers[0]
    const nextComputerId = firstPage.body.nextComputerId
    if (firstComputer === undefined || nextComputerId === null) {
      throw new Error('expected paginated simulator computers')
    }

    const secondPage = await simulatorRequest<ListComputersResponse>(sim, {
      url: `http://localhost:0/api/backup/v1/bz_list_computers?accountId=${accountId}&startComputerId=${nextComputerId}`,
      authorization: auth.authorizationToken,
    })
    expect(secondPage.status).toBe(200)
    expect(secondPage.body.computers[0]?.computerId).toBe(nextComputerId)

    const deleted = await simulatorRequest<ListComputersResponse['computers']>(sim, {
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

  it('rejects POST for GET-only backup computer listing', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const auth = await authorizePartner(sim)

    const result = await simulatorRequest<ErrorBody>(sim, {
      url: 'http://localhost:0/api/backup/v1/bz_list_computers',
      method: 'POST',
      authorization: auth.authorizationToken,
      body: { accountId: auth.accountId },
    })

    expect(result.status).toBe(405)
    expect(result.body.code).toBe('method_not_allowed')
  })
})
