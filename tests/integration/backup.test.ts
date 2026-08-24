/**
 * Live Computer Backup API coverage against a real Backblaze B2 account.
 *
 * Requires a Master Application Key with sales-approved Partner / Computer
 * Backup API access:
 *   B2_MASTER_KEY_ID
 *   B2_MASTER_KEY
 *   B2_REALM (optional)
 *
 * Optional target account override for read-safe listing:
 *   B2_INTEGRATION_BACKUP_ACCOUNT_ID
 *
 * Destructive backup deletion is skipped unless explicitly enabled:
 *   B2_INTEGRATION_ALLOW_DESTRUCTIVE_PARTNER=1
 *   B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID
 *   B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID_ACK (must equal the configured computer ID)
 *   B2_INTEGRATION_BACKUP_DISPOSABLE_ACCOUNT_ID (optional; defaults to the read target account)
 */

import { beforeAll, describe, expect, it, type TestContext } from 'vitest'
import { BackupClient } from '../../src/backup/index.ts'
import { B2PartnerAuthorizationError } from '../../src/errors/index.ts'
import { b2Url } from '../../src/raw/url.ts'
import type {
  ComputerBackup,
  DeleteComputerResponse,
  ListComputersResponse,
} from '../../src/types/backup.ts'
import type { AccountId, ComputerId } from '../../src/types/ids.ts'
import { accountId as accountIdOf, computerId as computerIdOf } from '../../src/types/ids.ts'
import type { PartnerAuthorizeResponse } from '../../src/types/partner.ts'
import { hasB2ErrorCode } from '../helpers/b2-cleanup.ts'
import { logFeatureSkip, safeErrorSummary, setupStep } from '../helpers/live-b2.ts'

const masterKeyId = process.env['B2_MASTER_KEY_ID'] ?? ''
const masterKey = process.env['B2_MASTER_KEY'] ?? ''
const realm = env('B2_REALM')
const skipMissingMasterKey = masterKeyId === '' || masterKey === ''
const requirePartnerCredentials = process.env['B2_INTEGRATION_REQUIRE_PARTNER_CREDENTIALS'] === '1'
const configuredBackupAccountId = env('B2_INTEGRATION_BACKUP_ACCOUNT_ID')
const allowDestructivePartner = process.env['B2_INTEGRATION_ALLOW_DESTRUCTIVE_PARTNER'] === '1'
const disposableComputerId = env('B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID')
const disposableComputerIdAck = env('B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID_ACK')
const disposableAccountId = env('B2_INTEGRATION_BACKUP_DISPOSABLE_ACCOUNT_ID')
const backupFeature = 'Computer Backup API'
const destructiveFeature = 'Computer Backup destructive deletion'

if (skipMissingMasterKey && requirePartnerCredentials) {
  throw new Error(
    'B2 master-key integration credentials are required when B2_INTEGRATION_REQUIRE_PARTNER_CREDENTIALS=1',
  )
}

const realmOption = realm !== undefined ? { realm } : {}

let backup: BackupClient | null = null
let authorization: PartnerAuthorizeResponse | null = null
let setupSkipReason: string | null = null

describe.skipIf(skipMissingMasterKey)('Computer Backup live endpoint integration contracts', () => {
  beforeAll(async () => {
    backup = new BackupClient({
      masterKeyId,
      masterKey,
      ...realmOption,
    })

    try {
      authorization = await setupStep('authorize Computer Backup', () =>
        requireBackup().authorize(),
      )
    } catch (err) {
      if (isBackupAccessUnavailableError(err)) {
        setupSkipReason = `Computer Backup account prerequisite unavailable: ${safeErrorSummary(err)}`
        return
      }
      throw err
    }

    if (authorization.apiInfo.backupApi === undefined) {
      setupSkipReason =
        'authorize response omitted apiInfo.backupApi; Computer Backup API access is unavailable'
    }
  })

  it('lists computers with GET as a single object response', async (ctx) => {
    const liveBackup = requireAuthorizedBackup(ctx)
    if (liveBackup === null) return

    const accountId = targetAccountId()
    const response = await listComputersOrSkip(ctx, liveBackup, accountId, 100)
    if (response === null) return

    expectListComputersResponseShape(response)
  })

  it('rejects POST for bz_list_computers after a successful GET probe', async (ctx) => {
    const liveBackup = requireAuthorizedBackup(ctx)
    if (liveBackup === null) return

    const accountId = targetAccountId()
    const response = await listComputersOrSkip(ctx, liveBackup, accountId, 1)
    if (response === null) return
    expectListComputersResponseShape(response)

    const postProbe = await postListComputers(accountId)
    expect(postProbe.status).toBe(405)
    expect(objectField(postProbe.body, 'code')).toBe('method_not_allowed')
  })

  it.skipIf(!allowDestructivePartner)(
    'deletes a configured disposable computer as an array response',
    async (ctx) => {
      const liveBackup = requireAuthorizedBackup(ctx)
      if (liveBackup === null) return

      const computerId = requireDisposableComputerId(ctx)
      if (computerId === null) return

      const accountId =
        disposableAccountId !== undefined ? accountIdOf(disposableAccountId) : targetAccountId()
      const computer = await findComputerOrSkip(ctx, liveBackup, accountId, computerId)
      if (computer === null) return

      let deleted: DeleteComputerResponse
      try {
        deleted = await liveBackup.deleteComputer({ accountId, computerId })
      } catch (err) {
        if (isDestructivePrerequisiteError(err)) {
          skipFeature(
            ctx,
            destructiveFeature,
            `delete_computer unavailable: ${safeErrorSummary(err)}`,
          )
          return
        }
        throw err
      }

      expectDeleteComputerResponseShape(deleted, computer)
    },
  )
})

function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function requireBackup(): BackupClient {
  if (backup === null) throw new Error('Backup client was not initialized')
  return backup
}

function requireAuthorization(): PartnerAuthorizeResponse {
  const latestAuthorization = backup?.partnerAccountInfo.getAuth()
  if (latestAuthorization !== undefined && latestAuthorization !== null) {
    authorization = latestAuthorization
  }
  if (authorization === null) throw new Error('Computer Backup authorization was not initialized')
  return authorization
}

function requireAuthorizedBackup(ctx: TestContext): BackupClient | null {
  if (skipIfSetupUnavailable(ctx)) return null
  requireAuthorization()
  return requireBackup()
}

function targetAccountId(): AccountId {
  return configuredBackupAccountId !== undefined
    ? accountIdOf(configuredBackupAccountId)
    : requireAuthorization().accountId
}

async function listComputersOrSkip(
  ctx: TestContext,
  liveBackup: BackupClient,
  accountId: AccountId,
  pageSize: number,
  startComputerId?: ComputerId,
): Promise<ListComputersResponse | null> {
  const auth = requireAuthorization()
  const backupApiUrl = auth.apiInfo.backupApi?.backupApiUrl
  if (backupApiUrl === undefined) throw new Error('authorized Backup API URL is unavailable')

  try {
    return await liveBackup.raw.listComputers(
      backupApiUrl,
      auth.authorizationToken,
      {
        accountId,
        ...(startComputerId !== undefined ? { startComputerId } : {}),
        maxComputerCount: pageSize,
      },
      { retry: { maxRetries: 1 } },
    )
  } catch (err) {
    if (isBackupReadPrerequisiteError(err)) {
      skipFeature(ctx, backupFeature, `list_computers unavailable: ${safeErrorSummary(err)}`)
      return null
    }
    throw err
  }
}

async function postListComputers(accountId: AccountId): Promise<{
  readonly status: number
  readonly body: unknown
}> {
  const auth = requireAuthorization()
  const backupApiUrl = auth.apiInfo.backupApi?.backupApiUrl
  if (backupApiUrl === undefined) throw new Error('authorized Backup API URL is unavailable')

  const response = await fetch(
    b2Url(backupApiUrl, {
      prefix: 'api/backup',
      version: 'v1',
      endpoint: 'bz_list_computers',
    }),
    {
      method: 'POST',
      headers: {
        Authorization: auth.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId }),
    },
  )
  return { status: response.status, body: await safeJson(response) }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function objectField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Readonly<Record<string, unknown>>)[field]
}

async function findComputerOrSkip(
  ctx: TestContext,
  liveBackup: BackupClient,
  accountId: AccountId,
  computerId: ComputerId,
): Promise<ComputerBackup | null> {
  let startComputerId: ComputerId | undefined
  for (;;) {
    const page = await listComputersOrSkip(ctx, liveBackup, accountId, 100, startComputerId)
    if (page === null) return null
    expectListComputersResponseShape(page)

    const computer = page.computers.find((candidate) => candidate.computerId === computerId)
    if (computer !== undefined) return computer

    if (page.nextComputerId === null) break
    startComputerId = page.nextComputerId
  }

  skipFeature(ctx, destructiveFeature, 'configured disposable computer ID was not found')
  return null
}

function requireDisposableComputerId(ctx: TestContext): ComputerId | null {
  if (disposableComputerId === undefined) {
    skipFeature(
      ctx,
      destructiveFeature,
      'B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID is required for disposable targets',
    )
    return null
  }
  if (disposableComputerIdAck !== disposableComputerId) {
    skipFeature(
      ctx,
      destructiveFeature,
      'B2_INTEGRATION_BACKUP_DISPOSABLE_COMPUTER_ID_ACK must equal the disposable computer ID',
    )
    return null
  }
  return computerIdOf(disposableComputerId)
}

function skipIfSetupUnavailable(ctx: TestContext): boolean {
  if (setupSkipReason === null) return false
  skipFeature(ctx, backupFeature, setupSkipReason)
  return true
}

function skipFeature(ctx: TestContext, feature: string, reason: string): void {
  logFeatureSkip(feature, reason)
  ctx.skip(reason)
}

function isBackupAccessUnavailableError(err: unknown): boolean {
  return err instanceof B2PartnerAuthorizationError || hasB2ErrorCode(err, 'access_denied')
}

function isBackupReadPrerequisiteError(err: unknown): boolean {
  return (
    hasB2ErrorCode(err, 'access_denied') ||
    hasB2ErrorCode(err, 'unauthorized') ||
    hasB2ErrorCode(err, 'invalid_account_id')
  )
}

function isDestructivePrerequisiteError(err: unknown): boolean {
  return isBackupReadPrerequisiteError(err) || hasB2ErrorCode(err, 'invalid_computer_id')
}

function expectListComputersResponseShape(response: ListComputersResponse): void {
  expect(Array.isArray(response)).toBe(false)
  expect(typeof response).toBe('object')
  expect(response).not.toBeNull()
  expectNullableString(response.nextComputerId, 'nextComputerId')
  expect(Array.isArray(response.computers)).toBe(true)
  for (const computer of response.computers) expectComputerBackupShape(computer)
}

function expectDeleteComputerResponseShape(
  response: DeleteComputerResponse,
  expected: ComputerBackup,
): void {
  expect(Array.isArray(response)).toBe(true)
  expect(response.length).toBe(1)
  const result = response[0]
  if (result === undefined) throw new Error('expected one deleted computer result')
  expectComputerBackupShape(result)
  expect(result).toEqual(expected)
}

function expectComputerBackupShape(computer: ComputerBackup): void {
  expectNonEmptyString(computer.computerId, 'computerId')
  expect(typeof computer.computerName, 'computerName').toBe('string')
  expect(typeof computer.lastFileUploadedTimestamp, 'lastFileUploadedTimestamp').toBe('number')
  expect(
    Number.isSafeInteger(computer.lastFileUploadedTimestamp),
    'lastFileUploadedTimestamp',
  ).toBe(true)
}

function expectNullableString(value: string | null, label: string): void {
  if (value === null) return
  expectNonEmptyString(value, label)
}

function expectNonEmptyString(value: string, label: string): void {
  expect(typeof value, label).toBe('string')
  expect(value.length, label).toBeGreaterThan(0)
}
