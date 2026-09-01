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
 *   B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_ID or B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_NAME
 *   B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN
 *   B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN_ACK (must equal the configured domain)
 *
 * Irreversible B2 Reserve trial creation additionally requires:
 *   B2_INTEGRATION_ALLOW_IRREVERSIBLE_PARTNER_TRIAL=1
 *   B2_INTEGRATION_PARTNER_TRIAL_RECONCILIATION_OWNER
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { B2PartnerAuthorizationError } from '../../src/errors/index.ts'
import { PartnerClient } from '../../src/partner/index.ts'
import type { AccountId, GroupId } from '../../src/types/ids.ts'
import { accountId as accountIdOf, groupId as groupIdOf } from '../../src/types/ids.ts'
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
import {
  cleanupAttempts,
  cleanupRetryDelayMs,
  env,
  masterKey,
  masterKeyId,
  requireMasterCredentials,
  safeErrorSummary,
  setupStep,
  skipFeature,
  skipUnlessMasterKey,
} from '../helpers/live-b2.ts'

const realm = env('B2_REALM')
const allowDestructivePartner = process.env['B2_INTEGRATION_ALLOW_DESTRUCTIVE_PARTNER'] === '1'
const allowIrreversiblePartnerTrial =
  process.env['B2_INTEGRATION_ALLOW_IRREVERSIBLE_PARTNER_TRIAL'] === '1'
const destructiveGroupId = env('B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_ID')
const destructiveGroupName = env('B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_NAME')
const disposableEmailDomain = env('B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN')
const disposableEmailDomainAck = env('B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN_ACK')
const reserveTrialReconciliationOwner = env('B2_INTEGRATION_PARTNER_TRIAL_RECONCILIATION_OWNER')
const partnerFeature = 'Partner API groups and members'
const destructiveFeature = 'Partner API destructive provisioning'
const reserveTrialFeature = 'Partner API irreversible reserve-trial provisioning'

requireMasterCredentials()

interface CreatedGroupMemberForCleanup {
  readonly groupId: GroupId
  readonly memberEmail?: string
  readonly memberAccountId: AccountId
}

interface CreatedGroupMemberEmailForCleanup {
  readonly groupId: GroupId
  readonly memberEmail: string
}

interface GroupWithMembers {
  readonly group: PartnerGroup
  readonly members: ListGroupMembersResponse
}

const realmOption = realm !== undefined ? { realm } : {}
const createdMembers = new Map<AccountId, CreatedGroupMemberForCleanup>()
const pendingCreatedMemberEmails = new Map<string, CreatedGroupMemberEmailForCleanup>()

let partner: PartnerClient | null = null
let authorization: PartnerAuthorizeResponse | null = null
let setupSkipReason: string | null = null

describe.skipIf(skipUnlessMasterKey)('Partner live endpoint integration contracts', () => {
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

    const groupWithMembers = await requireGroupWithActiveMember(ctx, livePartner)
    if (groupWithMembers === null) return

    expectListGroupMembersResponseShape(groupWithMembers.members, groupWithMembers.group)
  })

  it.skipIf(!allowDestructivePartner)(
    'creates and ejects a disposable group member',
    async (ctx) => {
      const livePartner = requireAuthorizedPartner(ctx)
      if (livePartner === null) return

      const memberEmail = requireDisposableEmail(ctx, 'group-member')
      if (memberEmail === null) return

      const group = await requireConfiguredDestructiveGroup(ctx, livePartner)
      if (group === null) return

      try {
        let created: CreateGroupMemberResponse
        try {
          created = await livePartner.createGroupMember({
            groupId: group.groupId,
            memberEmail,
          })
          pendingCreatedMemberEmails.set(memberEmail, { groupId: group.groupId, memberEmail })
          await registerCreatedMembersForCleanup(livePartner, created, group.groupId, memberEmail)
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

        await expectGroupMemberListed(livePartner, createdMember.groupId, createdMember.accountId)

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

  it.skipIf(!allowDestructivePartner || !allowIrreversiblePartnerTrial)(
    'reserves a disposable trial account as an object response',
    async (ctx) => {
      const livePartner = requireAuthorizedPartner(ctx)
      if (livePartner === null) return

      const email = requireDisposableEmail(ctx, 'reserve-trial')
      if (email === null) return

      const reconciliationOwner = requireReserveTrialReconciliationOwner(ctx)
      if (reconciliationOwner === null) return

      let reserved: ReserveTrialCreateAccountResponse
      try {
        reserved = await livePartner.reserveTrialAccount({
          email,
          term: 7,
          storage: 1,
        })
      } catch (err) {
        if (isDestructivePrerequisiteError(err)) {
          skipFeature(
            ctx,
            reserveTrialFeature,
            `reserve_trial_create_account unavailable: ${safeErrorSummary(err)}`,
          )
          return
        }
        throw err
      }

      logReserveTrialCreated(reserved, email, reconciliationOwner)
      expectReserveTrialCreateAccountResponseShape(reserved, email)
    },
  )
})

describe('Partner live assertion redaction guards', () => {
  it('keeps secret-bearing response bodies out of shape failures', () => {
    const secret = 'fake-live-application-key-secret'
    const createFailure = assertionFailureMessage(() =>
      expectCreateGroupMemberResponseShape(
        [
          fakeCreateGroupMemberResult(secret, 'one'),
          fakeCreateGroupMemberResult(secret, 'two'),
        ] as unknown as CreateGroupMemberResponse,
        { groupId: groupIdOf('group-id'), memberEmail: 'created@example.test' },
      ),
    )
    const reserveFailure = assertionFailureMessage(() =>
      expectReserveTrialCreateAccountResponseShape(
        [
          fakeReserveTrialResult(secret, 'one'),
          fakeReserveTrialResult(secret, 'two'),
        ] as unknown as ReserveTrialCreateAccountResponse,
        'trial@example.test',
      ),
    )

    expect(createFailure).not.toContain(secret)
    expect(reserveFailure).not.toContain(secret)
  })
})

function assertionFailureMessage(fn: () => void): string {
  let thrown: unknown
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  expect(thrown).toBeDefined()
  return thrown instanceof Error ? thrown.message : String(thrown)
}

function fakeCreateGroupMemberResult(secret: string, suffix: string): unknown {
  return {
    applicationKeyId: `fake-key-id-${suffix}`,
    applicationKey: secret,
    groupMember: {
      accountId: `fake-account-${suffix}`,
      email: 'created@example.test',
      groupId: 'group-id',
      groupName: 'Disposable Test Group',
      region: 'us-west',
      s3Endpoint: 's3.us-west-001.backblazeb2.com',
    },
  }
}

function fakeReserveTrialResult(secret: string, suffix: string): unknown {
  return {
    accountId: `fake-trial-account-${suffix}`,
    applicationKey: secret,
    applicationKeyId: `fake-trial-key-${suffix}`,
    bucketId: `fake-bucket-${suffix}`,
    bucketName: `fake-bucket-name-${suffix}`,
    email: 'trial@example.test',
    endDate: '2026-09-01',
    s3Endpoint: 's3.us-west-001.backblazeb2.com',
    startDate: '2026-08-25',
  }
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

async function requireGroupWithActiveMember(
  ctx: TestContext,
  livePartner: PartnerClient,
): Promise<GroupWithMembers | null> {
  let startGroupId: GroupId | undefined
  for (;;) {
    const groups = await listGroupsOrSkip(ctx, livePartner, 100, startGroupId)
    if (groups === null) return null
    expectListGroupsResponseShape(groups)

    for (const group of groups.groups) {
      const members = await listGroupMembersOrSkip(ctx, livePartner, group.groupId, 100)
      if (members === null) return null
      expectListGroupMembersResponseShape(members, group)
      if ((members[0]?.groupMembers.length ?? 0) > 0) return { group, members }
    }

    if (groups.nextGroupId === null) break
    startGroupId = groups.nextGroupId
  }

  skipFeature(
    ctx,
    partnerFeature,
    'authorized account has no active group members to assert member B2 stats',
  )
  return null
}

async function requireConfiguredDestructiveGroup(
  ctx: TestContext,
  livePartner: PartnerClient,
): Promise<PartnerGroup | null> {
  if (destructiveGroupId === undefined && destructiveGroupName === undefined) {
    skipFeature(
      ctx,
      destructiveFeature,
      'B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_ID or B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_NAME is required',
    )
    return null
  }

  let groupById: PartnerGroup | null = null
  const groupsByName: PartnerGroup[] = []
  let startGroupId: GroupId | undefined
  for (;;) {
    const groups = await listGroupsOrSkip(ctx, livePartner, 100, startGroupId)
    if (groups === null) return null
    expectListGroupsResponseShape(groups)

    for (const group of groups.groups) {
      if (destructiveGroupId !== undefined && group.groupId === destructiveGroupId) {
        groupById = group
      }
      if (destructiveGroupName !== undefined && group.groupName === destructiveGroupName) {
        groupsByName.push(group)
      }
    }

    if (groups.nextGroupId === null) break
    startGroupId = groups.nextGroupId
  }

  if (destructiveGroupId !== undefined) {
    if (groupById === null) {
      skipFeature(ctx, destructiveFeature, 'configured destructive group ID was not found')
      return null
    }
    if (destructiveGroupName !== undefined && groupById.groupName !== destructiveGroupName) {
      throw new Error(
        'configured destructive group ID and name do not refer to the same Partner group',
      )
    }
    return groupById
  }

  if (groupsByName.length === 0) {
    skipFeature(ctx, destructiveFeature, 'configured destructive group name was not found')
    return null
  }
  if (groupsByName.length > 1) {
    throw new Error(
      'configured destructive group name matched multiple Partner groups; set B2_INTEGRATION_PARTNER_DESTRUCTIVE_GROUP_ID',
    )
  }
  return groupsByName[0] ?? null
}

async function listGroupsOrSkip(
  ctx: TestContext,
  livePartner: PartnerClient,
  pageSize: number,
  startGroupId?: GroupId,
): Promise<ListGroupsResponse | null> {
  try {
    return await livePartner.listGroups({
      pageSize,
      ...(startGroupId !== undefined ? { startGroupId } : {}),
    })
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
  if (disposableEmailDomainAck !== disposableEmailDomain) {
    skipFeature(
      ctx,
      destructiveFeature,
      'B2_INTEGRATION_PARTNER_DISPOSABLE_EMAIL_DOMAIN_ACK must equal the disposable email domain',
    )
    return null
  }

  const runId = env('GITHUB_RUN_ID') ?? 'local'
  const runAttempt = env('GITHUB_RUN_ATTEMPT') ?? '1'
  const worker = env('VITEST_WORKER_ID') ?? '0'
  const unique = randomUUID().replaceAll('-', '').slice(0, 12)
  return `b2sdk-it-${label}-${runId}-${runAttempt}-${worker}-${unique}@${disposableEmailDomain}`
}

function requireReserveTrialReconciliationOwner(ctx: TestContext): string | null {
  if (reserveTrialReconciliationOwner !== undefined) return reserveTrialReconciliationOwner
  skipFeature(
    ctx,
    reserveTrialFeature,
    'B2_INTEGRATION_PARTNER_TRIAL_RECONCILIATION_OWNER is required for irreversible trial accounts',
  )
  return null
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

async function cleanupCreatedMembers(livePartner: PartnerClient): Promise<void> {
  const cleanupErrors = await reconcilePendingCreatedMemberEmails(livePartner)
  for (const member of Array.from(createdMembers.values())) {
    const cleaned = await ejectCreatedMemberWithRetry(livePartner, member)
    if (!cleaned.ok) cleanupErrors.push(cleaned.err)
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `failed to eject ${cleanupErrors.length} created Partner group member(s)`,
    )
  }
}

async function ejectCreatedMemberWithRetry(
  livePartner: PartnerClient,
  member: CreatedGroupMemberForCleanup,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly err: unknown }> {
  let lastError: unknown
  for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
    try {
      await livePartner.ejectGroupMember(member)
      createdMembers.delete(member.memberAccountId)
      if (member.memberEmail !== undefined) pendingCreatedMemberEmails.delete(member.memberEmail)
      return { ok: true }
    } catch (err) {
      if (hasB2ErrorCode(err, 'invalid_member_account_id')) {
        createdMembers.delete(member.memberAccountId)
        if (member.memberEmail !== undefined) pendingCreatedMemberEmails.delete(member.memberEmail)
        return { ok: true }
      }
      lastError = err
      console.warn(
        `[b2 integration cleanup] eject Partner group member attempt=${attempt}/${cleanupAttempts} failed groupId=${member.groupId} memberAccountId=${member.memberAccountId} error=${safeErrorSummary(err)}`,
      )
      if (attempt < cleanupAttempts) await delay(cleanupRetryDelayMs)
    }
  }
  return { ok: false, err: lastError }
}

async function reconcilePendingCreatedMemberEmails(livePartner: PartnerClient): Promise<unknown[]> {
  const cleanupErrors: unknown[] = []
  for (const pending of Array.from(pendingCreatedMemberEmails.values())) {
    const found = await findGroupMemberByEmailWithRetry(livePartner, pending)
    if (found !== null) {
      registerGroupMemberForCleanup(found)
      pendingCreatedMemberEmails.delete(pending.memberEmail)
      continue
    }

    cleanupErrors.push(
      new Error(
        `created Partner group member was not found by email for cleanup groupId=${pending.groupId} memberEmail=${pending.memberEmail}`,
      ),
    )
  }
  return cleanupErrors
}

async function findGroupMemberByEmailWithRetry(
  livePartner: PartnerClient,
  pending: CreatedGroupMemberEmailForCleanup,
): Promise<ListedGroupMember | null> {
  let lastError: unknown
  for (let attempt = 1; attempt <= cleanupAttempts; attempt++) {
    try {
      const found = await findGroupMemberByEmail(livePartner, pending.groupId, pending.memberEmail)
      if (found !== null) return found
    } catch (err) {
      lastError = err
    }

    if (attempt < cleanupAttempts) await delay(cleanupRetryDelayMs)
  }

  if (lastError !== undefined) {
    console.warn(
      `[b2 integration cleanup] reconcile Partner group member by email failed groupId=${pending.groupId} memberEmail=${pending.memberEmail} error=${safeErrorSummary(lastError)}`,
    )
  }
  return null
}

async function registerCreatedMembersForCleanup(
  livePartner: PartnerClient,
  response: unknown,
  fallbackGroupId: GroupId,
  memberEmail: string,
): Promise<void> {
  if (registerReturnedGroupMembersForCleanup(response, fallbackGroupId, memberEmail) > 0) return

  const reconciled = await findGroupMemberByEmail(livePartner, fallbackGroupId, memberEmail)
  if (reconciled !== null) {
    registerGroupMemberForCleanup(reconciled)
    return
  }

  console.warn(
    `[b2 integration cleanup] unable to register created Partner group member for cleanup groupId=${fallbackGroupId} memberEmail=${memberEmail}`,
  )
}

function registerReturnedGroupMembersForCleanup(
  response: unknown,
  fallbackGroupId: GroupId,
  fallbackMemberEmail?: string,
): number {
  const entries = Array.isArray(response) ? response : [response]

  let registered = 0
  for (const entry of entries) {
    const cleanup = cleanupTargetFromCreateGroupMemberResult(
      entry,
      fallbackGroupId,
      fallbackMemberEmail,
    )
    if (cleanup === null) continue
    createdMembers.set(cleanup.memberAccountId, cleanup)
    if (cleanup.memberEmail !== undefined) pendingCreatedMemberEmails.delete(cleanup.memberEmail)
    registered += 1
  }
  return registered
}

function cleanupTargetFromCreateGroupMemberResult(
  value: unknown,
  fallbackGroupId: GroupId,
  fallbackMemberEmail?: string,
): CreatedGroupMemberForCleanup | null {
  const record = objectRecord(value)
  const groupMember = objectRecord(record?.['groupMember'])
  const rawAccountId = groupMember?.['accountId']
  if (typeof rawAccountId !== 'string' || rawAccountId === '') return null

  const rawGroupId = groupMember?.['groupId']
  const rawEmail = groupMember?.['email']
  const memberEmail =
    typeof rawEmail === 'string' && rawEmail !== '' ? rawEmail : fallbackMemberEmail
  return {
    memberAccountId: accountIdOf(rawAccountId),
    ...(memberEmail !== undefined ? { memberEmail } : {}),
    groupId:
      typeof rawGroupId === 'string' && rawGroupId !== '' ? groupIdOf(rawGroupId) : fallbackGroupId,
  }
}

function registerGroupMemberForCleanup(member: PartnerGroupMember): void {
  pendingCreatedMemberEmails.delete(member.email)
  createdMembers.set(member.accountId, {
    groupId: member.groupId,
    memberEmail: member.email,
    memberAccountId: member.accountId,
  })
}

async function expectGroupMemberListed(
  livePartner: PartnerClient,
  groupId: GroupId,
  memberAccountId: AccountId,
): Promise<void> {
  const member = await findGroupMemberByAccountId(livePartner, groupId, memberAccountId)
  expect(member !== null).toBe(true)
}

async function findGroupMemberByAccountId(
  livePartner: PartnerClient,
  groupId: GroupId,
  memberAccountId: AccountId,
): Promise<ListedGroupMember | null> {
  return findGroupMember(livePartner, groupId, (member) => member.accountId === memberAccountId)
}

async function findGroupMemberByEmail(
  livePartner: PartnerClient,
  groupId: GroupId,
  email: string,
): Promise<ListedGroupMember | null> {
  return findGroupMember(livePartner, groupId, (member) => member.email === email)
}

async function findGroupMember(
  livePartner: PartnerClient,
  groupId: GroupId,
  predicate: (member: ListedGroupMember) => boolean,
): Promise<ListedGroupMember | null> {
  let startEmail: string | undefined
  for (;;) {
    const page = await livePartner.listGroupMembers({
      groupId,
      pageSize: 1000,
      ...(startEmail !== undefined ? { startEmail } : {}),
    })
    const result = page[0]
    const member = result?.groupMembers.find(predicate)
    if (member !== undefined) return member

    const nextEmail = result?.nextEmail
    if (nextEmail === undefined || nextEmail === null) return null
    startEmail = nextEmail
  }
}

function logReserveTrialCreated(
  response: unknown,
  requestedEmail: string,
  reconciliationOwner: string,
): void {
  const entries = Array.isArray(response) ? response : [response]
  if (entries.length === 0) {
    console.info(
      `[b2 integration] reserve_trial_create_account response owner=${reconciliationOwner} requestedEmail=${requestedEmail} responseShape=${typeof response}`,
    )
    return
  }

  for (const entry of entries) {
    const record = objectRecord(entry)
    const account = stringFieldOrPlaceholder(record, 'accountId')
    const email = stringFieldOrPlaceholder(record, 'email', requestedEmail)
    const bucket = stringFieldOrPlaceholder(record, 'bucketId')
    console.info(
      `[b2 integration] reserve_trial_create_account created owner=${reconciliationOwner} email=${email} accountId=${account} bucketId=${bucket}`,
    )
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringFieldOrPlaceholder(
  record: Record<string, unknown> | null,
  field: string,
  fallback = '[unavailable]',
): string {
  const value = record?.[field]
  return typeof value === 'string' && value !== '' ? value : fallback
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  expect(response.length).toBe(1)
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
  expectNonNegativeIntegerCount(stats.b2BytesStoredCount, 'b2Stats.b2BytesStoredCount')
  expectNonNegativeIntegerCount(stats.b2FilesStoredCount, 'b2Stats.b2FilesStoredCount')
  expectNonNegativeIntegerCount(stats.bucketCount, 'b2Stats.bucketCount')
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
  expect(Array.isArray(response)).toBe(false)
  const result = response
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
  expect(Array.isArray(response)).toBe(false)
  const result = response
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

function expectNonNegativeIntegerCount(value: number, label: string): void {
  expect(typeof value, label).toBe('number')
  expect(Number.isInteger(value), label).toBe(true)
  expect(value, label).toBeGreaterThanOrEqual(0)
}

function expectTimestampString(value: string, label: string): void {
  expectNonEmptyString(value, label)
  // B2 Partner API timestamps use the `dYYYYMMDD_mHHMMSS` format, not ISO 8601.
  expect(value, label).toMatch(/^d\d{8}_m\d{6}$/)
}

function expectDateString(value: string, label: string): void {
  expectNonEmptyString(value, label)
  expect(value, label).toMatch(/^\d{4}-\d{2}-\d{2}$/)
}
