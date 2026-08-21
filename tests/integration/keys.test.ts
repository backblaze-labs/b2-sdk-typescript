/**
 * Integration tests for live Backblaze B2 application-key lifecycle APIs.
 *
 * Requires dedicated B2_KEY_MANAGEMENT_APPLICATION_KEY_ID /
 * B2_KEY_MANAGEMENT_APPLICATION_KEY credentials. The shared integration
 * credentials intentionally do not enable these tests.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import { Capability, type Capability as CapabilityValue } from '../../src/types/auth.ts'
import { type ApplicationKeyId, type BucketId, bucketId } from '../../src/types/ids.ts'
import type { ApplicationKey, CreateKeyOptions, FullApplicationKey } from '../../src/types/key.ts'
import { hasB2ErrorCode } from '../helpers/b2-cleanup.ts'

const keyManagementKeyId = env('B2_KEY_MANAGEMENT_APPLICATION_KEY_ID')
const keyManagementAppKey = env('B2_KEY_MANAGEMENT_APPLICATION_KEY')
const explicitBucketId = env('B2_KEY_MANAGEMENT_BUCKET_ID')
const requireCredentials = process.env.B2_KEY_MANAGEMENT_REQUIRE_CREDENTIALS === '1'

const hasPartialKeyManagementCredentials =
  (keyManagementKeyId === undefined) !== (keyManagementAppKey === undefined)

if (hasPartialKeyManagementCredentials) {
  throw new Error(
    'B2_KEY_MANAGEMENT_APPLICATION_KEY_ID and B2_KEY_MANAGEMENT_APPLICATION_KEY must be provided together',
  )
}

const keyId = keyManagementKeyId ?? ''
const appKey = keyManagementAppKey ?? ''
const skip = !keyId || !appKey

if (skip && requireCredentials) {
  throw new Error(
    'B2 key lifecycle integration credentials are required when B2_KEY_MANAGEMENT_REQUIRE_CREDENTIALS=1',
  )
}

const requiredKeyCapabilities = [
  Capability.WriteKeys,
  Capability.ListKeys,
  Capability.DeleteKeys,
  Capability.ReadFiles,
] as const
const scopedCapabilities = [Capability.ReadFiles] as const
const subsetRejectionCandidateCapabilities = [
  Capability.ListFiles,
  Capability.WriteFiles,
  Capability.ShareFiles,
  Capability.DeleteFiles,
] as const
const keyNamePrefix = 'sdk-it-key-'
const bucketNamePrefix = 'sdk-it-key-bucket-'
const namePrefix = `keys/${runLabel()}/`
const keyDurationSeconds = 60 * 60

let client: B2Client
let scopedBucketId: BucketId
let createdBucket: Bucket | undefined
let missingScopeableCapability: CapabilityValue | undefined
const createdKeyIds = new Set<ApplicationKeyId>()

describe.skipIf(skip)('B2 application-key lifecycle integration', () => {
  beforeAll(async () => {
    client = new B2Client({
      applicationKeyId: keyId,
      applicationKey: appKey,
    })
    await client.authorize()

    requireCapabilities('application-key lifecycle', requiredKeyCapabilities)
    missingScopeableCapability = subsetRejectionCandidateCapabilities.find(
      (capability) => !client.hasCapabilities([capability]).ok,
    )

    scopedBucketId = await resolveScopedBucketId()
  })

  afterAll(async () => {
    const cleanupErrors: unknown[] = []

    for (const keyId of [...createdKeyIds]) {
      try {
        await client.deleteKey(keyId)
        createdKeyIds.delete(keyId)
      } catch (err) {
        if (isAlreadyDeletedKeyError(err)) {
          createdKeyIds.delete(keyId)
        } else {
          cleanupErrors.push(err)
        }
      }
    }

    if (createdBucket !== undefined) {
      try {
        await createdBucket.delete()
      } catch (err) {
        cleanupErrors.push(err)
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `application-key lifecycle cleanup failed for ${cleanupErrors.length} operation(s)`,
      )
    }
  })

  it('creates, lists, paginates, and deletes scoped application keys', async () => {
    const created = await createScopedKey('lifecycle')

    expect(created.applicationKey).toEqual(expect.any(String))
    expect(created.applicationKey).not.toBe('')
    expectScopedKey(created)

    const scopedClient = new B2Client({
      applicationKeyId: created.applicationKeyId,
      applicationKey: created.applicationKey,
    })
    await scopedClient.authorize()
    const allowed = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi.allowed
    expect(allowed?.capabilities).toEqual(scopedCapabilities)
    expect(allowed?.buckets?.map((bucket) => bucket.id)).toEqual([scopedBucketId])
    expect(allowed?.namePrefix).toBe(namePrefix)

    const listed = await getListedKeyById(created.applicationKeyId)
    expect(listed).toBeDefined()
    assertKeyHasNoSecret(listed)
    expectScopedKey(listed)

    const paginationKey = await createScopedKey('pagination')
    await expectPaginationRoundTrip()
    await deleteCreatedKey(paginationKey.applicationKeyId)

    const deleted = await client.deleteKey(created.applicationKeyId)
    createdKeyIds.delete(created.applicationKeyId)
    assertKeyHasNoSecret(deleted)
    expectScopedKey(deleted)

    await expect(getListedKeyById(created.applicationKeyId)).resolves.toBeUndefined()
  })

  it('rejects requested capabilities outside the creator grant with 400', async (ctx) => {
    if (missingScopeableCapability === undefined) {
      ctx.skip('key-management credential has every checked file-scopeable capability')
      return
    }

    await expectCreateKeyRejectedWith400({
      keyName: makeKeyName('rejected'),
      capabilities: [...scopedCapabilities, missingScopeableCapability],
      bucketIds: [scopedBucketId],
      namePrefix,
      validDurationInSeconds: keyDurationSeconds,
    })
  })
})

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

function runLabel(): string {
  const runId = env('GITHUB_RUN_ID') ?? 'local'
  const runAttempt = env('GITHUB_RUN_ATTEMPT') ?? '1'
  const worker = env('VITEST_WORKER_ID') ?? '0'
  return `${runId}-${runAttempt}-${worker}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function makeKeyName(label: string): string {
  return `${keyNamePrefix}${label}-${runLabel()}`
}

function makeBucketName(): string {
  return `${bucketNamePrefix}${Date.now()}-${randomUUID().slice(0, 8)}`
}

function requireCapabilities(feature: string, capabilities: readonly CapabilityValue[]): void {
  const check = client.hasCapabilities(capabilities)
  if (check.ok) return
  throw new Error(`${feature} requires B2 capabilities: ${check.missing.join(', ')}`)
}

async function resolveScopedBucketId(): Promise<BucketId> {
  const allowedBuckets = client.accountInfo.getAuth()?.apiInfo.storageApi.allowed.buckets

  if (explicitBucketId !== undefined) {
    const id = bucketId(explicitBucketId)
    if (allowedBuckets !== null && allowedBuckets !== undefined) {
      const allowed = allowedBuckets.some((bucket) => bucket.id === id)
      if (!allowed) {
        throw new Error('B2_KEY_MANAGEMENT_BUCKET_ID is outside the credential bucket grant')
      }
    }
    return id
  }

  if (allowedBuckets !== null && allowedBuckets !== undefined) {
    const firstBucket = allowedBuckets[0]
    if (firstBucket === undefined) {
      throw new Error('authorized key has an empty bucket grant')
    }
    return firstBucket.id
  }

  if (client.hasCapabilities([Capability.WriteBuckets, Capability.DeleteBuckets]).ok) {
    createdBucket = await client.createBucket({
      bucketName: makeBucketName(),
      bucketType: 'allPrivate',
    })
    return createdBucket.id
  }

  if (client.hasCapabilities([Capability.ListBuckets]).ok) {
    const existingBucket = (await client.listBuckets())[0]
    if (existingBucket !== undefined) return existingBucket.id
  }

  throw new Error(
    'application-key lifecycle requires B2_KEY_MANAGEMENT_BUCKET_ID or a credential that can provide a bucket id',
  )
}

async function createScopedKey(label: string): Promise<FullApplicationKey> {
  const key = await client.createKey({
    keyName: makeKeyName(label),
    capabilities: scopedCapabilities,
    bucketIds: [scopedBucketId],
    namePrefix,
    validDurationInSeconds: keyDurationSeconds,
  })
  createdKeyIds.add(key.applicationKeyId)
  return key
}

async function deleteCreatedKey(id: ApplicationKeyId): Promise<void> {
  await client.deleteKey(id)
  createdKeyIds.delete(id)
}

async function getListedKeyById(id: ApplicationKeyId): Promise<ApplicationKey | undefined> {
  const page = await client.listKeys({ pageSize: 1, startApplicationKeyId: id })
  const first = page.keys[0]
  return first?.applicationKeyId === id ? first : undefined
}

async function expectPaginationRoundTrip(): Promise<void> {
  const firstPage = await client.listKeys({ pageSize: 1 })
  expect(firstPage.keys).toHaveLength(1)
  expect(firstPage.nextApplicationKeyId).not.toBeNull()

  const nextApplicationKeyId = firstPage.nextApplicationKeyId
  if (nextApplicationKeyId === null) {
    throw new Error('expected listKeys to return nextApplicationKeyId')
  }

  const secondPage = await client.listKeys({
    pageSize: 1,
    startApplicationKeyId: nextApplicationKeyId,
  })
  expect(secondPage.keys[0]?.applicationKeyId).toBe(nextApplicationKeyId)
}

function expectScopedKey(key: ApplicationKey | FullApplicationKey | undefined): void {
  expect(key).toBeDefined()
  expect(key?.capabilities).toEqual(scopedCapabilities)
  expect(key?.bucketIds).toEqual([scopedBucketId])
  expect(key?.bucketId).toBe(scopedBucketId)
  expect(key?.namePrefix).toBe(namePrefix)
  expect(key?.options).toContain('s3')
}

function assertKeyHasNoSecret(key: ApplicationKey | undefined): void {
  expect(key).toBeDefined()
  expect(Object.hasOwn(key as object, 'applicationKey')).toBe(false)
}

async function expectCreateKeyRejectedWith400(options: CreateKeyOptions): Promise<void> {
  let created: FullApplicationKey | undefined
  try {
    created = await client.createKey(options)
    createdKeyIds.add(created.applicationKeyId)
  } catch (err) {
    expect(err).toMatchObject({ status: 400 })
    return
  }

  let cleanupDeferred = false
  try {
    await deleteCreatedKey(created.applicationKeyId)
  } catch {
    cleanupDeferred = true
  }

  throw new Error(
    `expected createKey to reject with 400, but B2 created ${created.applicationKeyId}${
      cleanupDeferred ? '; cleanup deferred to afterAll' : ''
    }`,
  )
}

function isAlreadyDeletedKeyError(err: unknown): boolean {
  return hasB2ErrorCode(err, 'not_found')
}
