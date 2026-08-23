/**
 * Live Partner API coverage against a real Backblaze B2 account.
 *
 * Requires a Master Application Key with sales-approved Partner API access and
 * Business Groups enabled:
 *   B2_MASTER_KEY_ID
 *   B2_MASTER_KEY
 *   B2_REALM (optional)
 *
 * Destructive Partner provisioning is skipped unless explicitly enabled:
 *   B2_INTEGRATION_ALLOW_DESTRUCTIVE_PARTNER=1
 *   B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN=example.test
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { B2PartnerAuthorizationError } from '../../src/errors/index.ts'
import { PartnerClient } from '../../src/partner/index.ts'
import type { AccountId, GroupId } from '../../src/types/ids.ts'
import type {
  CreateGroupMemberResponse,
  EjectGroupMemberResponse,
  ListedGroupMember,
  ListGroupMembersResponse,
  ListGroupsResponse,
  PartnerAuthorizeResponse,
  PartnerB2Stats,
  PartnerGroup,
  PartnerGroupMember,
  ReserveTrialCreateAccountResponse,
} from '../../src/types/partner.ts'
import { hasB2ErrorCode } from '../helpers/b2-cleanup.ts'
import { logFeatureSkip, safeErrorSummary, setupStep } from '../helpers/live-b2.ts'

const masterKeyId = process.env['B2_MASTER_KEY_ID'] ?? ''
const masterKey = process.env['B2_MASTER_KEY'] ?? ''
const realm = env('B2_REALM')
const skipMissingMasterKey = masterKeyId === '' || masterKey === ''
const requireCredentials = process.env['B2_INTEGRATION_REQUIRE_CREDENTIALS'] === '1'
const allowDestructivePartner = process.env['B2_INTEGRATION_ALLOW_DESTRUCTIVE_PARTNER'] === '1'
const disposableEmailDomain = env('B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN')
const partnerFeature = 'Partner API groups and members'
const destructiveFeature = 'Partner API destructive provisioning'

if (skipMissingMasterKey && requireCredentials) {
  throw new Error(
    'B2 master-key integration credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1',
  )
}

interface CreatedGroupMemberForCleanup {
  readonly groupId: GroupId
  readonly memberAccountId: AccountId
}

const realmOption = realm !== undefined ? { realm } : {}
const createdMembers = new Map<AccountId, CreatedGroupMemberForCleanup>()

let partner: PartnerClient | null = null
let authorization: PartnerAuthorizeResponse | null = null
let setupSkipReason: string | null = null

describe.skipIf(skipMissingMasterKey)('Partner live endpoint integration contracts', () => {
  beforeAll(async () => {
    partner = new PartnerClient({
      masterKeyId,
      masterKey,
      ...realmOption,
    })

    try {
      authorization = await setupStep('authorize Partner', () => requirePartner().authorize())
    } catch (err) {
      if (isPartnerAccessUnavailableError(err)) {
        setupSkipReason = `Partner account prerequisite unavailable: ${safeErrorSummary(err)}`
        return
      }
      throw err
    }

    if (authorization.groupsApiUrl === undefined) {
      setupSkipReason =
        'authorize response omitted apiInfo.groupsApi; Business Groups or Partner API access is unavailable'
    }
  })

  afterAll(async () => {
    if (partner === null) return
    await cleanupCreatedMembers(partner)
  })

  it('lists groups as a single object with string B2 stats counters', async (ctx) => {
    const livePartner = requireAuthorizedPartner(ctx)
    if (livePartner === null) return

    const groups = await listGroupsOrSkip(ctx, livePartner, 100)
    if (groups === null) return
    expectListGroupsResponseShape(groups)
  })

  it('lists group members as an array with string B2 stats counters', async (ctx) => {
    const livePartner = requireAuthorizedPartner(ctx)
    if (livePartner === null) return

    const group = await requireFirstGroup(ctx, livePartner)
    if (group === null) return

    const members = await listGroupMembersOrSkip(ctx, livePartner, group.groupId, 100)
    if (members === null) return
    expectListGroupMembersResponseShape(members, group)
  })

  it.skipIf(!allowDestructivePartner)(
    'creates and ejects a disposable group member',
    async (ctx) => {
      const livePartner = requireAuthorizedPartner(ctx)
      if (livePartner === null) return

      const memberEmail = requireDisposableEmail(ctx, 'group-member')
      if (memberEmail === null) return

      const group = await requireFirstGroup(ctx, livePartner)
      if (group === null) return

      let created: CreateGroupMemberResponse
      try {
        created = await livePartner.createGroupMember({
          groupId: group.groupId,
          memberEmail,
        })
      } catch (err) {
        if (isDestructivePrerequisiteError(err)) {
          skipFeature(
            ctx,
            destructiveFeature,
            `create_group_member unavailable: ${safeErrorSummary(err)}`,
          )
          return
        }
        throw err
      }

      const createdMember = expectCreateGroupMemberResponseShape(created, {
        groupId: group.groupId,
        memberEmail,
      })
      createdMembers.set(createdMember.accountId, {
        groupId: createdMember.groupId,
        memberAccountId: createdMember.accountId,
      })

      try {
        const listed = await livePartner.listGroupMembers({
          groupId: group.groupId,
          pageSize: 1000,
        })
        expect(
          listed
            .flatMap((result) => result.groupMembers)
            .some((member) => member.accountId === createdMember.accountId),
        ).toBe(true)

        const ejected = await livePartner.ejectGroupMember({
          groupId: createdMember.groupId,
          memberAccountId: createdMember.accountId,
        })
        createdMembers.delete(createdMember.accountId)
        expectEjectGroupMemberResponseShape(ejected, createdMember)
      } finally {
        await cleanupCreatedMembers(livePartner)
      }
    },
  )

  it.skipIf(!allowDestructivePartner)(
    'reserves a disposable trial account as an array response',
    async (ctx) => {
      const livePartner = requireAuthorizedPartner(ctx)
      if (livePartner === null) return

      const email = requireDisposableEmail(ctx, 'reserve-trial')
      if (email === null) return

      let reserved: ReserveTrialCreateAccountResponse
      try {
        reserved = await livePartner.reserveTrialAccounts({
          email,
          term: 7,
          storage: 1,
        })
      } catch (err) {
        if (isDestructivePrerequisiteError(err)) {
          skipFeature(
            ctx,
            destructiveFeature,
            `reserve_trial_create_account unavailable: ${safeErrorSummary(err)}`,
          )
          return
        }
        throw err
      }

      expectReserveTrialCreateAccountResponseShape(reserved, email)
    },
  )
})

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function requirePartner(): PartnerClient {
  if (partner === null) throw new Error('Partner client was not initialized')
  return partner
}

function requireAuthorizedPartner(ctx: TestContext): PartnerClient | null {
  if (skipIfSetupUnavailable(ctx)) return null
  if (authorization === null) throw new Error('Partner authorization was not initialized')
  return requirePartner()
}

async function requireFirstGroup(
  ctx: TestContext,
  livePartner: PartnerClient,
): Promise<PartnerGroup | null> {
  const groups = await listGroupsOrSkip(ctx, livePartner, 1)
  if (groups === null) return null
  expectListGroupsResponseShape(groups)
  const group = groups.groups[0]
  if (group !== undefined) return group
  skipFeature(ctx, partnerFeature, 'authorized account has no Business Groups to inspect')
  return null
}

async function listGroupsOrSkip(
  ctx: TestContext,
  livePartner: PartnerClient,
  pageSize: number,
): Promise<ListGroupsResponse | null> {
  try {
    return await livePartner.listGroups({ pageSize })
  } catch (err) {
    if (isPartnerReadPrerequisiteError(err)) {
      skipFeature(ctx, partnerFeature, `list_groups unavailable: ${safeErrorSummary(err)}`)
      return null
    }
    throw err
  }
}

async function listGroupMembersOrSkip(
  ctx: TestContext,
  livePartner: PartnerClient,
  groupId: GroupId,
  pageSize: number,
): Promise<ListGroupMembersResponse | null> {
  try {
    return await livePartner.listGroupMembers({ groupId, pageSize })
  } catch (err) {
    if (isPartnerReadPrerequisiteError(err) || hasB2ErrorCode(err, 'invalid_group_id')) {
      skipFeature(ctx, partnerFeature, `list_group_members unavailable: ${safeErrorSummary(err)}`)
      return null
    }
    throw err
  }
}

function requireDisposableEmail(ctx: TestContext, label: string): string | null {
  if (disposableEmailDomain === undefined) {
    skipFeature(
      ctx,
      destructiveFeature,
      'B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN is required for disposable targets',
    )
    return null
  }
  if (!isEmailDomain(disposableEmailDomain)) {
    throw new Error(
      'B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN must be an email domain such as example.test',
    )
  }

  const runId = env('GITHUB_RUN_ID') ?? 'local'
  const runAttempt = env('GITHUB_RUN_ATTEMPT') ?? '1'
  const worker = env('VITEST_WORKER_ID') ?? '0'
  const unique = randomUUID().replaceAll('-', '').slice(0, 12)
  return `b2sdk-it-${label}-${runId}-${runAttempt}-${worker}-${unique}@${disposableEmailDomain}`
}

function isEmailDomain(value: string): boolean {
  if (value.includes('@')) return false
  if (!value.includes('.')) return false
  if (value.startsWith('.') || value.endsWith('.')) return false
  return /^[A-Za-z0-9.-]+$/.test(value)
}

function skipIfSetupUnavailable(ctx: TestContext): boolean {
  if (setupSkipReason === null) return false
  skipFeature(ctx, partnerFeature, setupSkipReason)
  return true
}

function skipFeature(ctx: TestContext, feature: string, reason: string): void {
  logFeatureSkip(feature, reason)
  ctx.skip(reason)
}

async function cleanupCreatedMembers(livePartner: PartnerClient): Promise<void> {
  for (const member of createdMembers.values()) {
    try {
      await livePartner.ejectGroupMember(member)
      createdMembers.delete(member.memberAccountId)
    } catch (err) {
      if (hasB2ErrorCode(err, 'invalid_member_account_id')) {
        createdMembers.delete(member.memberAccountId)
        continue
      }
      console.warn(
        `[b2 integration cleanup] eject Partner group member failed groupId=${member.groupId} memberAccountId=${member.memberAccountId} error=${safeErrorSummary(err)}`,
      )
    }
  }
}

function isPartnerAccessUnavailableError(err: unknown): boolean {
  return err instanceof B2PartnerAuthorizationError || hasB2ErrorCode(err, 'access_denied')
}

function isPartnerReadPrerequisiteError(err: unknown): boolean {
  return hasB2ErrorCode(err, 'access_denied') || hasB2ErrorCode(err, 'unauthorized')
}

function isDestructivePrerequisiteError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'invalid_group_id') ||
    hasB2ErrorCode(err, 'invalid_sms_phone') ||
    hasB2ErrorCode(err, 'too_many_members')
  )
}

function expectListGroupsResponseShape(response: ListGroupsResponse): void {
  expect(Array.isArray(response)).toBe(false)
  expect(typeof response.accountId).toBe('string')
  expect(Array.isArray(response.groups)).toBe(true)
  expectNullableString(response.nextGroupId, 'nextGroupId')
  for (const group of response.groups) expectPartnerGroupShape(group)
}

function expectListGroupMembersResponseShape(
  response: ListGroupMembersResponse,
  group: PartnerGroup,
): void {
  expect(Array.isArray(response)).toBe(true)
  expect(response).toHaveLength(1)
  const [result] = response
  if (result === undefined) throw new Error('expected one group-member result')

  expect(result.groupId).toBe(group.groupId)
  expect(result.groupName).toBe(group.groupName)
  expectNullableString(result.nextEmail, 'nextEmail')
  expect(Array.isArray(result.groupMembers)).toBe(true)
  for (const member of result.groupMembers) expectListedGroupMemberShape(member, group.groupId)
}

function expectPartnerGroupShape(group: PartnerGroup): void {
  expectNonEmptyString(group.groupId, 'groupId')
  expectNonEmptyString(group.groupName, 'groupName')
  expect(Array.isArray(group.groupProducts)).toBe(true)
  for (const product of group.groupProducts) expectNonEmptyString(product, 'groupProducts item')
  expectNonEmptyString(group.accountStandingDetails.state, 'accountStandingDetails.state')
  expectPartnerB2StatsShape(group.b2Stats)
  expectTimestampString(group.groupStats.createdTimestamp, 'groupStats.createdTimestamp')
  expectTimestampString(
    group.groupStats.groupStatsAsOfTimestamp,
    'groupStats.groupStatsAsOfTimestamp',
  )
  expect(typeof group.groupStats.memberCount).toBe('number')
  expect(Number.isFinite(group.groupStats.memberCount)).toBe(true)
}

function expectPartnerB2StatsShape(stats: PartnerB2Stats): void {
  expectDecimalString(stats.b2BytesStoredCount, 'b2Stats.b2BytesStoredCount')
  expectDecimalString(stats.b2FilesStoredCount, 'b2Stats.b2FilesStoredCount')
  expectDecimalString(stats.bucketCount, 'b2Stats.bucketCount')
  if (stats.b2StatsAsOfTimestamp !== null) {
    expectTimestampString(stats.b2StatsAsOfTimestamp, 'b2Stats.b2StatsAsOfTimestamp')
  }
}

function expectListedGroupMemberShape(member: ListedGroupMember, expectedGroupId: GroupId): void {
  expectPartnerGroupMemberShape(member, expectedGroupId)
  expectPartnerB2StatsShape(member.b2Stats)
}

function expectPartnerGroupMemberShape(
  member: PartnerGroupMember,
  expectedGroupId?: GroupId,
): void {
  expectNonEmptyString(member.accountId, 'accountId')
  expectNonEmptyString(member.email, 'email')
  expectNonEmptyString(member.groupId, 'groupId')
  expectNonEmptyString(member.groupName, 'groupName')
  expectNonEmptyString(member.region, 'region')
  expectNonEmptyString(member.s3Endpoint, 's3Endpoint')
  if (expectedGroupId !== undefined) expect(member.groupId).toBe(expectedGroupId)
}

function expectCreateGroupMemberResponseShape(
  response: CreateGroupMemberResponse,
  expected: { readonly groupId: GroupId; readonly memberEmail: string },
): PartnerGroupMember {
  expect(Array.isArray(response)).toBe(true)
  expect(response).toHaveLength(1)
  const result = response[0]
  if (result === undefined) throw new Error('expected one created group-member result')
  expectNonEmptyString(result.applicationKeyId, 'applicationKeyId')
  expectNonEmptyString(result.applicationKey, 'applicationKey')
  expect(result.groupMember.email).toBe(expected.memberEmail)
  expectPartnerGroupMemberShape(result.groupMember, expected.groupId)
  return result.groupMember
}

function expectEjectGroupMemberResponseShape(
  response: EjectGroupMemberResponse,
  createdMember: PartnerGroupMember,
): void {
  expect(Array.isArray(response)).toBe(false)
  expect(response.accountId).toBe(createdMember.accountId)
  expect(response.email).toBe(createdMember.email)
  expectPartnerGroupMemberShape(response, createdMember.groupId)
}

function expectReserveTrialCreateAccountResponseShape(
  response: ReserveTrialCreateAccountResponse,
  email: string,
): void {
  expect(Array.isArray(response)).toBe(true)
  expect(response).toHaveLength(1)
  const result = response[0]
  if (result === undefined) throw new Error('expected one reserve-trial result')
  expectNonEmptyString(result.accountId, 'accountId')
  expectNonEmptyString(result.applicationKeyId, 'applicationKeyId')
  expectNonEmptyString(result.applicationKey, 'applicationKey')
  expectNonEmptyString(result.bucketId, 'bucketId')
  expectNonEmptyString(result.bucketName, 'bucketName')
  expect(result.email).toBe(email)
  expectDateString(result.startDate, 'startDate')
  expectDateString(result.endDate, 'endDate')
  expectNonEmptyString(result.s3Endpoint, 's3Endpoint')
}

function expectNullableString(value: string | null, label: string): void {
  if (value === null) return
  expectNonEmptyString(value, label)
}

function expectNonEmptyString(value: string, label: string): void {
  expect(typeof value, label).toBe('string')
  expect(value.length, label).toBeGreaterThan(0)
}

function expectDecimalString(value: string, label: string): void {
  expectNonEmptyString(value, label)
  expect(value, label).toMatch(/^\d+$/)
}

function expectTimestampString(value: string, label: string): void {
  expectNonEmptyString(value, label)
  expect(Number.isNaN(Date.parse(value)), label).toBe(false)
}

function expectDateString(value: string, label: string): void {
  expectNonEmptyString(value, label)
  expect(value, label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
}
