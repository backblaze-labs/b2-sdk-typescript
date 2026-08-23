import { beforeEach, describe, expect, it, vi } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpResponse } from '../http/transport.ts'
import { sha1Hex } from '../streams/hash.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient, readStream } from '../test-utils/index.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import {
  BucketRetentionMode,
  type BucketRetentionPolicy,
  BucketType,
  CorsOperation,
  type CorsRule,
  KnownBucketResponseType,
  type LifecycleRule,
} from '../types/bucket.ts'
import type { DownloadAuthorizationRequest } from '../types/download.ts'
import {
  EncryptionKey,
  type EncryptionSetting,
  SSE_B2,
  SSE_NONE,
  sseCustomer,
} from '../types/encryption.ts'
import {
  FileAction,
  type FileVersionListEntry,
  HIDE_MARKER_CONTENT_TYPE,
  type ListedFileVersion,
  MetadataDirective,
} from '../types/file.ts'
import { accountId, applicationKeyId, bucketId, fileId as fileIdOf } from '../types/ids.ts'
import { type FileRetentionValue, LegalHoldValue, RetentionMode } from '../types/lock.ts'
import { type EventNotificationRule, EventType } from '../types/notifications.ts'
import type { ReplicationConfiguration } from '../types/replication.ts'
import {
  type B2Simulator,
  DOWNLOAD_AUTH_DURATION_MAX_SECONDS,
  DOWNLOAD_AUTH_DURATION_MIN_SECONDS,
} from './index.ts'

/**
 * Spec-compliance tests for {@link B2Simulator}. These pin behaviour
 * that matches the published B2 docs at https://www.backblaze.com/apidocs:
 *
 * - Input validation (bucket name, file name, file info, max counts)
 * - Bucket deletion fidelity (non-empty buckets, unfinished large files)
 * - Wire-level edges (Content-Range header, Range header forms)
 * - Pluggable post-upload hooks (webhook delivery, replication)
 * - Strict-auth capability + scope + expiry enforcement
 *
 * Each test cites the spec source inline so future maintainers can
 * verify against the live B2 docs.
 */

function expectConcreteListEntry(
  entry: FileVersionListEntry | undefined,
): asserts entry is ListedFileVersion {
  expect(entry).toBeDefined()
  if (
    entry === undefined ||
    entry.action === FileAction.Folder ||
    entry.action === FileAction.Hide
  ) {
    throw new Error('expected a listed file-version entry with file metadata')
  }
}

function b2JsonApiUrl(
  version: string,
  endpoint: string,
  query?: Record<string, string | number>,
): string {
  const url = new URL(`http://localhost:0/b2api/${version}/${endpoint}`)
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

async function expectJsonResponse<T>(response: HttpResponse, status = 200): Promise<T> {
  expect(response.status).toBe(status)
  return await response.json<T>()
}

async function makeWireContractFixture() {
  const { client, sim } = makeClient({ sim: { strictAuth: true } })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'wire-query-shapes',
    bucketType: BucketType.AllPrivate,
  })
  const authToken = client.accountInfo.getAuthToken()
  const apiUrl = client.accountInfo.getApiUrl()
  const uploaded = await bucket.upload({
    fileName: 'query/visible.txt',
    source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
  })
  const large = await client.raw.startLargeFile(apiUrl, authToken, {
    bucketId: bucket.id,
    fileName: 'query/large.bin',
    contentType: 'application/octet-stream',
  })
  const key = await client.createKey({
    capabilities: [Capability.ListBuckets],
    keyName: 'wire-query-key',
  })
  return { client, sim, bucket, authToken, apiUrl, uploaded, large, key }
}

async function getWireQuery<T>(
  sim: B2Simulator,
  authToken: string,
  endpoint: string,
  query: Record<string, string | number>,
  version = 'v4',
): Promise<T> {
  const response = await sim.transport().send({
    method: 'GET',
    url: b2JsonApiUrl(version, endpoint, query),
    headers: { Authorization: authToken },
  })
  return await expectJsonResponse<T>(response)
}

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------

describe('B2Simulator wire contract: API version and request shape', () => {
  it('accepts v4 as the canonical JSON route and v3 as a supported route', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'wire-route-alias',
      bucketType: BucketType.AllPrivate,
    })
    const body = {
      accountId: client.accountInfo.getAccountId(),
      bucketId: bucket.id,
    }

    for (const version of ['v4', 'v3'] as const) {
      const response = await sim.transport().send({
        method: 'POST',
        url: b2JsonApiUrl(version, 'b2_list_buckets'),
        headers: {
          Authorization: client.accountInfo.getAuthToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const listed = await expectJsonResponse<{ buckets: readonly { bucketId: string }[] }>(
        response,
      )
      expect(listed.buckets.map((candidate) => candidate.bucketId)).toEqual([bucket.id])
    }

    const getResponse = await sim.transport().send({
      method: 'GET',
      url: b2JsonApiUrl('v4', 'b2_list_buckets', body),
      headers: { Authorization: client.accountInfo.getAuthToken() },
    })

    await expectJsonResponse(getResponse, 405)
  })

  it('rejects unsupported JSON API version segments explicitly', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const response = await sim.transport().send({
      method: 'POST',
      url: b2JsonApiUrl('v5', 'b2_list_buckets'),
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ accountId: client.accountInfo.getAccountId() }),
    })

    await expectJsonResponse(response, 400).then((body) =>
      expect(body).toMatchObject({ code: 'unsupported_api_version' }),
    )
  })

  it('returns a structured JSON error for empty GET query requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const response = await sim.transport().send({
      method: 'GET',
      url: b2JsonApiUrl('v4', 'b2_get_upload_url'),
      headers: { Authorization: client.accountInfo.getAuthToken() },
    })

    await expectJsonResponse(response, 400).then((body) =>
      expect(body).toMatchObject({ code: 'bad_bucket_id' }),
    )
  })

  it('accepts b2_get_upload_url as a v4 GET query request', async () => {
    const { sim, bucket, authToken } = await makeWireContractFixture()
    const uploadUrl = await getWireQuery<{ bucketId: string; uploadUrl: string }>(
      sim,
      authToken,
      'b2_get_upload_url',
      { bucketId: bucket.id },
    )
    expect(uploadUrl.bucketId).toBe(bucket.id)
    expect(uploadUrl.uploadUrl).toContain('b2_upload_file')
  })

  it('accepts b2_get_file_info as a v4 GET query request', async () => {
    const { sim, authToken, uploaded } = await makeWireContractFixture()
    const fileInfo = await getWireQuery<{ fileId: string; fileName: string }>(
      sim,
      authToken,
      'b2_get_file_info',
      { fileId: uploaded.fileId },
    )
    expect(fileInfo).toMatchObject({ fileId: uploaded.fileId, fileName: uploaded.fileName })
  })

  it('accepts b2_list_file_names as v4 and v3 GET query requests', async () => {
    const { sim, bucket, authToken } = await makeWireContractFixture()
    const names = await getWireQuery<{ files: readonly { fileName: string }[] }>(
      sim,
      authToken,
      'b2_list_file_names',
      { bucketId: bucket.id, prefix: 'query/', maxFileCount: 1 },
    )
    expect(names.files.map((file) => file.fileName)).toEqual(['query/visible.txt'])

    const v3Names = await getWireQuery<{ files: readonly { fileName: string }[] }>(
      sim,
      authToken,
      'b2_list_file_names',
      { bucketId: bucket.id, prefix: 'query/', maxFileCount: 1 },
      'v3',
    )
    expect(v3Names.files.map((file) => file.fileName)).toEqual(['query/visible.txt'])
  })

  it('accepts b2_list_file_versions as a v4 GET query request', async () => {
    const { sim, bucket, authToken } = await makeWireContractFixture()
    const versions = await getWireQuery<{ files: readonly { fileName: string }[] }>(
      sim,
      authToken,
      'b2_list_file_versions',
      { bucketId: bucket.id, prefix: 'query/', maxFileCount: 10 },
    )
    expect(versions.files.map((file) => file.fileName)).toEqual(['query/visible.txt'])
  })

  it('accepts b2_get_upload_part_url as a v4 GET query request', async () => {
    const { sim, authToken, large } = await makeWireContractFixture()
    const uploadPartUrl = await getWireQuery<{ fileId: string; uploadUrl: string }>(
      sim,
      authToken,
      'b2_get_upload_part_url',
      { fileId: large.fileId },
    )
    expect(uploadPartUrl.fileId).toBe(large.fileId)
    expect(uploadPartUrl.uploadUrl).toContain('b2_upload_part')
  })

  it('accepts b2_list_unfinished_large_files as a v4 GET query request', async () => {
    const { sim, bucket, authToken, large } = await makeWireContractFixture()
    const unfinished = await getWireQuery<{
      files: readonly { fileId: string; fileName: string }[]
    }>(sim, authToken, 'b2_list_unfinished_large_files', {
      bucketId: bucket.id,
      namePrefix: 'query/',
      maxFileCount: 1,
    })
    expect(unfinished.files).toHaveLength(1)
    expect(unfinished.files[0]).toMatchObject({ fileId: large.fileId, fileName: large.fileName })
  })

  it('accepts b2_list_parts as a v4 GET query request', async () => {
    const { sim, authToken, large } = await makeWireContractFixture()
    const parts = await getWireQuery<{ parts: readonly unknown[] }>(
      sim,
      authToken,
      'b2_list_parts',
      {
        fileId: large.fileId,
        startPartNumber: 1,
        maxPartCount: 1,
      },
    )
    expect(parts.parts).toEqual([])
  })

  it('accepts b2_get_download_authorization as a v4 GET query request', async () => {
    const { sim, bucket, authToken } = await makeWireContractFixture()
    const downloadAuth = await getWireQuery<{ bucketId: string; authorizationToken: string }>(
      sim,
      authToken,
      'b2_get_download_authorization',
      {
        bucketId: bucket.id,
        fileNamePrefix: 'query/',
        validDurationInSeconds: 60,
      },
    )
    expect(downloadAuth.bucketId).toBe(bucket.id)
    expect(downloadAuth.authorizationToken).toBeTruthy()
  })

  it('accepts b2_list_keys as a v4 GET query request', async () => {
    const { client, sim, authToken, key } = await makeWireContractFixture()
    const keys = await getWireQuery<{ keys: readonly { applicationKeyId: string }[] }>(
      sim,
      authToken,
      'b2_list_keys',
      { accountId: client.accountInfo.getAccountId(), maxKeyCount: 1 },
    )
    expect(keys.keys).toHaveLength(1)
    expect(keys.keys[0]).toMatchObject({ applicationKeyId: key.applicationKeyId })
  })

  it('accepts b2_get_bucket_notification_rules as a v4 GET query request', async () => {
    const { sim, bucket, authToken } = await makeWireContractFixture()
    const rules = await getWireQuery<{
      bucketId: string
      eventNotificationRules: readonly unknown[]
    }>(sim, authToken, 'b2_get_bucket_notification_rules', { bucketId: bucket.id })
    expect(rules).toEqual({ bucketId: bucket.id, eventNotificationRules: [] })
  })

  it('accepts b2_copy_file as a v4 GET query request', async () => {
    const { sim, authToken, uploaded } = await makeWireContractFixture()
    const copied = await getWireQuery<{ fileName: string }>(sim, authToken, 'b2_copy_file', {
      sourceFileId: uploaded.fileId,
      fileName: 'query/copied.txt',
    })
    expect(copied.fileName).toBe('query/copied.txt')
  })

  it('accepts b2_copy_part as a v4 GET query request', async () => {
    const { client, sim, authToken, apiUrl, uploaded, large } = await makeWireContractFixture()
    const copiedPart = await getWireQuery<{ fileId: string; partNumber: number }>(
      sim,
      authToken,
      'b2_copy_part',
      {
        sourceFileId: uploaded.fileId,
        largeFileId: large.fileId,
        partNumber: 1,
      },
    )
    expect(copiedPart).toMatchObject({ fileId: large.fileId, partNumber: 1 })

    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
    expect(listed.parts.map((part) => part.partNumber)).toEqual([1])
  })

  it.each(['0x10', '1e3', '0o17', '0b101', ' 5 '])(
    'rejects non-canonical numeric query value %s',
    async (maxFileCount) => {
      const { sim, bucket, authToken } = await makeWireContractFixture()
      const response = await sim.transport().send({
        method: 'GET',
        url: b2JsonApiUrl('v4', 'b2_list_file_names', {
          bucketId: bucket.id,
          maxFileCount,
        }),
        headers: { Authorization: authToken },
      })

      await expectJsonResponse(response, 400).then((body) =>
        expect(body).toMatchObject({ code: 'bad_request' }),
      )
    },
  )
})

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('B2Simulator input validation: bucket name', () => {
  let client: B2Client
  let sim: B2Simulator
  beforeEach(async () => {
    ;({ client, sim } = makeClient())
    await client.authorize()
  })

  it('rejects bucket names shorter than 6 characters', async () => {
    await expect(
      client.createBucket({ bucketName: 'short', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/6-63 characters/)
  })

  it('rejects bucket names longer than 63 characters', async () => {
    const tooLong = 'a'.repeat(64)
    await expect(
      client.createBucket({ bucketName: tooLong, bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/6-63 characters/)
  })

  it('rejects bucket names with leading hyphen', async () => {
    await expect(
      client.createBucket({ bucketName: '-leading', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/letters, digits, hyphens, and periods/)
  })

  it('rejects bucket names starting with the reserved "b2-" prefix', async () => {
    await expect(
      client.createBucket({ bucketName: 'b2-reserved', bucketType: BucketType.AllPrivate }),
    ).rejects.toThrow(/reserved prefix/)
  })

  it('accepts a well-formed bucket name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'happy-bucket',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('happy-bucket')
  })

  it('accepts a dotted bucket name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'happy.bucket',
      bucketType: BucketType.AllPrivate,
    })
    expect(bucket.name).toBe('happy.bucket')
  })

  it('rejects response-only bucket types on raw create and update requests', async () => {
    const transport = sim.transport()

    const createResp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_bucket',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        bucketName: 'shared-create',
        bucketType: KnownBucketResponseType.Shared,
      }),
    })
    expect(createResp.status).toBe(400)
    await expect(createResp.json()).resolves.toMatchObject({ code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'request-type',
      bucketType: BucketType.AllPrivate,
    })
    const updateResp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_update_bucket',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        bucketId: bucket.id,
        bucketType: KnownBucketResponseType.Shared,
      }),
    })
    expect(updateResp.status).toBe(400)
    await expect(updateResp.json()).resolves.toMatchObject({ code: 'bad_request' })
  })
})

describe('B2Simulator bucket configuration validation', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('rejects malformed CORS rules on create and update', async () => {
    const malformedCors = [
      {
        allowedHeaders: null,
        allowedOperations: ['b2_not_real'],
        allowedOrigins: ['https://example.com'],
        corsRuleName: 'bad-cors',
        exposeHeaders: null,
        maxAgeSeconds: 3600,
      },
    ] as unknown as CorsRule[]

    await expect(
      client.createBucket({
        bucketName: 'bad-cors-create',
        bucketType: BucketType.AllPrivate,
        corsRules: malformedCors,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'bad-cors-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.update({ corsRules: malformedCors })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })

  it('rejects SSE-C bucket default encryption on create and update', async () => {
    const sseCDefault = { mode: 'SSE-C', algorithm: 'AES256' } as unknown as NonNullable<
      Parameters<B2Client['createBucket']>[0]['defaultServerSideEncryption']
    >

    await expect(
      client.createBucket({
        bucketName: 'bad-sse-create',
        bucketType: BucketType.AllPrivate,
        defaultServerSideEncryption: sseCDefault,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: expect.stringContaining('cannot use SSE-C'),
    })

    const bucket = await client.createBucket({
      bucketName: 'bad-sse-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.update({ defaultServerSideEncryption: sseCDefault })).rejects.toMatchObject(
      {
        status: 400,
        code: 'bad_request',
        message: expect.stringContaining('cannot use SSE-C'),
      },
    )
  })

  it('enforces the CORS maxAgeSeconds upper bound on create and update', async () => {
    const boundaryCorsRule: CorsRule = {
      allowedHeaders: null,
      allowedOperations: [CorsOperation.B2DownloadFileByName],
      allowedOrigins: ['https://example.com'],
      corsRuleName: 'max-age-ok',
      exposeHeaders: null,
      maxAgeSeconds: 86_400,
    }
    const boundaryCors = [boundaryCorsRule]
    const tooHighCors: CorsRule[] = [
      {
        ...boundaryCorsRule,
        corsRuleName: 'max-age-bad',
        maxAgeSeconds: 86_401,
      },
    ]

    await expect(
      client.createBucket({
        bucketName: 'cors-age-ok',
        bucketType: BucketType.AllPrivate,
        corsRules: boundaryCors,
      }),
    ).resolves.toMatchObject({ name: 'cors-age-ok' })
    await expect(
      client.createBucket({
        bucketName: 'cors-age-bad',
        bucketType: BucketType.AllPrivate,
        corsRules: tooHighCors,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'cors-age-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.update({ corsRules: tooHighCors })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })

  it('rejects malformed lifecycle rules on create and update', async () => {
    const malformedLifecycle = [
      {
        daysFromHidingToDeleting: null,
        daysFromUploadingToHiding: null,
        fileNamePrefix: 'tmp/',
      },
    ] as unknown as LifecycleRule[]

    await expect(
      client.createBucket({
        bucketName: 'bad-life-create',
        bucketType: BucketType.AllPrivate,
        lifecycleRules: malformedLifecycle,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'bad-life-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.update({ lifecycleRules: malformedLifecycle })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })

  it('accepts omitted lifecycle fields and unfinished-large-file cancellation', async () => {
    const created = await client.createBucket({
      bucketName: 'life-optional',
      bucketType: BucketType.AllPrivate,
      lifecycleRules: [{ daysFromHidingToDeleting: 30, fileNamePrefix: 'tmp/' }],
    })
    expect(created.info.lifecycleRules).toEqual([
      { daysFromHidingToDeleting: 30, fileNamePrefix: 'tmp/' },
    ])

    const bucket = await client.createBucket({
      bucketName: 'life-cancel',
      bucketType: BucketType.AllPrivate,
    })
    const updated = await bucket.update({
      lifecycleRules: [
        {
          daysFromStartingToCancelingUnfinishedLargeFiles: 3,
          fileNamePrefix: 'uploads/',
        },
      ],
    })
    expect(updated.lifecycleRules).toEqual([
      {
        daysFromStartingToCancelingUnfinishedLargeFiles: 3,
        fileNamePrefix: 'uploads/',
      },
    ])
  })

  it('rejects malformed replication configuration on create and update', async () => {
    const malformedReplication = {
      asReplicationDestination: null,
      asReplicationSource: {
        replicationRules: [
          {
            destinationBucketId: 'dest-bucket-id',
            fileNamePrefix: '',
            includeExistingFiles: 'false',
            isEnabled: true,
            priority: 1,
            replicationRuleName: 'replicate-all',
          },
        ],
        sourceApplicationKeyId: 'source-key-id',
      },
    } as unknown as ReplicationConfiguration

    await expect(
      client.createBucket({
        bucketName: 'bad-repl-create',
        bucketType: BucketType.AllPrivate,
        replicationConfiguration: malformedReplication,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'bad-repl-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(
      bucket.update({ replicationConfiguration: malformedReplication }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })

  it('normalizes partial replication configuration responses', async () => {
    const bucket = await client.createBucket({
      bucketName: 'partial-repl',
      bucketType: BucketType.AllPrivate,
    })

    const updated = await bucket.update({
      replicationConfiguration: {
        asReplicationSource: null,
      } as unknown as ReplicationConfiguration,
    })

    expect(updated.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: true,
      value: null,
    })
    const [fresh] = await client.listBuckets({ bucketId: bucket.id })
    expect(fresh?.info.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: true,
      value: null,
    })
  })

  it('rejects malformed default retention on create and update', async () => {
    const malformedRetention = {
      mode: BucketRetentionMode.Governance,
      period: null,
    } as unknown as BucketRetentionPolicy

    await expect(
      client.createBucket({
        bucketName: 'bad-ret-create',
        bucketType: BucketType.AllPrivate,
        defaultRetention: malformedRetention,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const bucket = await client.createBucket({
      bucketName: 'bad-ret-update',
      bucketType: BucketType.AllPrivate,
    })
    await expect(bucket.update({ defaultRetention: malformedRetention })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
  })

  it('requires Object Lock for non-none default retention', async () => {
    const retainingPolicy = {
      mode: BucketRetentionMode.Governance,
      period: { duration: 7, unit: 'days' },
    } satisfies BucketRetentionPolicy

    await expect(
      client.createBucket({
        bucketName: 'ret-no-lock',
        bucketType: BucketType.AllPrivate,
        defaultRetention: retainingPolicy,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'file_lock_not_enabled' })

    const unlocked = await client.createBucket({
      bucketName: 'ret-update-no-lock',
      bucketType: BucketType.AllPrivate,
    })
    await expect(unlocked.update({ defaultRetention: retainingPolicy })).rejects.toMatchObject({
      status: 400,
      code: 'file_lock_not_enabled',
    })

    await expect(
      client.createBucket({
        bucketName: 'ret-create-lock',
        bucketType: BucketType.AllPrivate,
        defaultRetention: retainingPolicy,
        fileLockEnabled: true,
      }),
    ).resolves.toMatchObject({
      info: { fileLockConfiguration: { value: { defaultRetention: retainingPolicy } } },
    })

    const locked = await client.createBucket({
      bucketName: 'ret-update-lock',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    await expect(locked.update({ defaultRetention: retainingPolicy })).resolves.toMatchObject({
      fileLockConfiguration: { value: { defaultRetention: retainingPolicy } },
    })
  })

  it('rejects huge default retention before upload/delete paths can observe it', async () => {
    const locked = await client.createBucket({
      bucketName: 'ret-huge-lock',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const hugeRetention = {
      mode: BucketRetentionMode.Compliance,
      period: { duration: 1e308, unit: 'years' },
    } as unknown as BucketRetentionPolicy
    const hugeDaysRetention = {
      mode: BucketRetentionMode.Compliance,
      period: { duration: 1e308, unit: 'days' },
    } as unknown as BucketRetentionPolicy

    await expect(locked.update({ defaultRetention: hugeRetention })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
    await expect(locked.update({ defaultRetention: hugeDaysRetention })).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })

    const uploaded = await locked.upload({
      fileName: 'after-rejected-retention.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await expect(
      locked.deleteFileVersion('after-rejected-retention.bin', uploaded.fileId),
    ).resolves.toBeUndefined()

    const { client: largeClient } = makeClient({
      sim: { minimumPartSize: 1024, recommendedPartSize: 1024 },
    })
    await largeClient.authorize()
    const accepted = await largeClient.createBucket({
      bucketName: 'ret-accepted-lock',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
      defaultRetention: {
        mode: BucketRetentionMode.Governance,
        period: { duration: 1, unit: 'days' },
      },
    })
    expect(accepted.info.fileLockConfiguration.value?.defaultRetention.mode).toBe(
      BucketRetentionMode.Governance,
    )

    const retained = await accepted.upload({
      fileName: 'accepted-retention.bin',
      source: new BufferSource(new Uint8Array(2048)),
    })
    await expect(
      accepted.deleteFileVersion('accepted-retention.bin', retained.fileId),
    ).rejects.toMatchObject({ status: 400, code: 'file_lock_governance_protected' })
  })

  it('accepts well-formed bucket configuration', async () => {
    const bucket = await client.createBucket({
      bucketName: 'good-config',
      bucketType: BucketType.AllPrivate,
      corsRules: [
        {
          allowedHeaders: null,
          allowedOperations: [CorsOperation.B2DownloadFileByName],
          allowedOrigins: ['https://example.com'],
          corsRuleName: 'downloads',
          exposeHeaders: null,
          maxAgeSeconds: 3600,
        },
      ],
      defaultRetention: { mode: BucketRetentionMode.None, period: null },
      lifecycleRules: [
        {
          daysFromHidingToDeleting: 30,
          daysFromUploadingToHiding: null,
          fileNamePrefix: 'tmp/',
        },
      ],
      replicationConfiguration: {
        asReplicationDestination: null,
        asReplicationSource: {
          replicationRules: [],
          sourceApplicationKeyId: applicationKeyId('source-key-id'),
        },
      },
    })

    expect(bucket.info.corsRules).toHaveLength(1)
    expect(bucket.info.lifecycleRules).toHaveLength(1)
    expect(bucket.info.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: true,
      value: {
        asReplicationDestination: null,
        asReplicationSource: {
          replicationRules: [],
          sourceApplicationKeyId: applicationKeyId('source-key-id'),
        },
      },
    })
  })
})

describe('B2Simulator listBuckets filters', () => {
  let client: B2Client
  let sim: B2Simulator

  beforeEach(async () => {
    ;({ client, sim } = makeClient())
    await client.authorize()
  })

  it('honors listBuckets bucketId, bucketName, and bucketTypes filters', async () => {
    const privateBucket = await client.createBucket({
      bucketName: 'filter-private',
      bucketType: BucketType.AllPrivate,
    })
    const publicBucket = await client.createBucket({
      bucketName: 'filter-public',
      bucketType: BucketType.AllPublic,
    })

    await expect(client.listBuckets({ bucketId: privateBucket.id })).resolves.toMatchObject([
      { id: privateBucket.id },
    ])
    await expect(client.listBuckets({ bucketName: publicBucket.name })).resolves.toMatchObject([
      { id: publicBucket.id },
    ])
    await expect(
      client.listBuckets({ bucketTypes: [BucketType.AllPrivate] }),
    ).resolves.toMatchObject([{ id: privateBucket.id }])
    await expect(
      client.listBuckets({
        bucketName: publicBucket.name,
        bucketTypes: [BucketType.AllPrivate],
      }),
    ).resolves.toEqual([])
    await expect(client.listBuckets({ bucketTypes: ['all'] })).resolves.toHaveLength(2)
    await expect(
      client.listBuckets({ bucketTypes: [KnownBucketResponseType.Shared] }),
    ).resolves.toEqual([])
    await expect(client.listBuckets({ bucketTypes: ['futureBucketType'] })).resolves.toEqual([])
  })

  it('returns structured 400 responses for malformed bucketTypes filters', async () => {
    const transport = sim.transport()
    for (const bucketTypes of [null, {}, 'allPrivate', [], [42], ['all', 'allPrivate']]) {
      const resp = await transport.send({
        method: 'POST',
        url: 'http://localhost:0/b2api/v3/b2_list_buckets',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: 'sim_account_0001', bucketTypes }),
      })
      expect(resp.status).toBe(400)
      await expect(resp.json()).resolves.toMatchObject({ code: 'bad_request' })
    }
  })
})

describe('B2Simulator updateBucket revision guard', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('returns a 409 conflict when ifRevisionIs does not match', async () => {
    const bucket = await client.createBucket({
      bucketName: 'revision-guard',
      bucketType: BucketType.AllPrivate,
    })

    const updated = await bucket.update({
      bucketInfo: { generation: 'first' },
      ifRevisionIs: bucket.info.revision,
    })
    expect(updated.revision).toBe(bucket.info.revision + 1)

    await expect(
      bucket.update({
        bucketInfo: { generation: 'stale' },
        ifRevisionIs: bucket.info.revision,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' })

    const [fresh] = await client.listBuckets({ bucketId: bucket.id })
    expect(fresh?.info.bucketInfo).toEqual({ generation: 'first' })
    expect(fresh?.info.revision).toBe(updated.revision)
  })
})

// ---------------------------------------------------------------------------
// Bucket deletion
// ---------------------------------------------------------------------------

// b2_delete_bucket requires an empty bucket:
// https://www.backblaze.com/apidocs/b2-delete-bucket
describe('B2Simulator bucket deletion fidelity', () => {
  let client: B2Client

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('rejects b2_delete_bucket while the bucket still has file versions', async () => {
    const bucket = await client.createBucket({
      bucketName: 'non-empty-delete',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'still-here.txt',
      source: new BufferSource(new TextEncoder().encode('data')),
    })

    await expect(bucket.delete()).rejects.toMatchObject({
      status: 400,
      code: 'cannot_delete_non_empty_bucket',
    })
    await expect(client.listBuckets({ bucketId: bucket.id })).resolves.toHaveLength(1)
  })

  it('rejects b2_delete_bucket while the bucket has unfinished large files', async () => {
    const bucket = await client.createBucket({
      bucketName: 'unfinished-delete',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const unfinished = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'unfinished.bin',
      contentType: 'application/octet-stream',
    })

    await expect(bucket.delete()).rejects.toMatchObject({
      status: 400,
      code: 'cannot_delete_non_empty_bucket',
    })
    await expect(client.listBuckets({ bucketId: bucket.id })).resolves.toHaveLength(1)

    await client.raw.cancelLargeFile(apiUrl, authToken, { fileId: unfinished.fileId })
    await expect(bucket.delete()).resolves.toMatchObject({ bucketId: bucket.id })
    await expect(client.listBuckets({ bucketId: bucket.id })).resolves.toHaveLength(0)
  })

  it('deletes the bucket after deleteAll removes every file version', async () => {
    const bucket = await client.createBucket({
      bucketName: 'delete-after-delete-all',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'versioned.txt',
      source: new BufferSource(new TextEncoder().encode('v1')),
    })
    await bucket.upload({
      fileName: 'versioned.txt',
      source: new BufferSource(new TextEncoder().encode('v2')),
    })

    let deleted = 0
    for await (const event of bucket.deleteAll()) {
      if (event.type === 'delete') deleted += 1
    }

    expect(deleted).toBe(2)
    await expect(bucket.delete()).resolves.toMatchObject({ bucketId: bucket.id })
    await expect(client.listBuckets({ bucketId: bucket.id })).resolves.toHaveLength(0)
  })
})

describe('B2Simulator input validation: file name', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'filename-validation',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('rejects file names longer than 1024 UTF-8 bytes', async () => {
    // 1025 ASCII chars = 1025 UTF-8 bytes, one over the cap.
    const tooLong = 'a'.repeat(1025)
    await expect(
      bucket.upload({ fileName: tooLong, source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/1024-byte UTF-8 limit/)
  })

  it('rejects file names containing control characters', async () => {
    await expect(
      bucket.upload({
        fileName: 'hasctrl.txt',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/control characters/)
  })

  it('rejects bare "." and ".." as a complete file name', async () => {
    await expect(
      bucket.upload({ fileName: '.', source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/exactly "\." or "\.\."/)
    await expect(
      bucket.upload({ fileName: '..', source: new BufferSource(new Uint8Array([1])) }),
    ).rejects.toThrow(/exactly "\." or "\.\."/)
  })

  it('accepts file names containing ".." as path segments', async () => {
    // `..` as a path segment (e.g. `../foo`) is fine — it's a key, not
    // a filesystem path. Real B2 stores it verbatim.
    const result = await bucket.upload({
      fileName: '../foo.txt',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    expect(result.fileName).toBe('../foo.txt')
  })

  it('rejects file names with a leading slash', async () => {
    await expect(
      bucket.upload({
        fileName: '/leading-slash',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/cannot start with "\/"/)
  })

  it('rejects file names with double-slash segments', async () => {
    await expect(
      bucket.upload({
        fileName: 'a//b.txt',
        source: new BufferSource(new Uint8Array([1])),
      }),
    ).rejects.toThrow(/"\/\/"/)
  })
})

describe('B2Simulator input validation: maxFileCount caps', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'maxcount-caps',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('rejects b2_list_file_names with pageSize > 10000', async () => {
    await expect(bucket.listFileNames({ pageSize: 10_001 })).rejects.toThrow(/exceeds the/)
  })

  it('rejects b2_list_unfinished_large_files with pageSize > 100', async () => {
    await expect(bucket.listUnfinishedLargeFiles({ pageSize: 101 })).rejects.toThrow(/exceeds the/)
  })

  it('accepts pageSize equal to the documented cap', async () => {
    const page = await bucket.listFileNames({ pageSize: 10_000 })
    expect(page.files).toEqual([])
  })
})

describe('B2Simulator input validation: notification rules', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  let validRule: EventNotificationRule

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'notif-validation',
      bucketType: BucketType.AllPrivate,
    })
    validRule = {
      eventTypes: [EventType.ObjectCreatedAll],
      isEnabled: true,
      isSuspended: false,
      name: 'upload-webhook',
      objectNamePrefix: '',
      suspensionReason: '',
      targetConfiguration: {
        targetType: 'webhook',
        url: 'https://example.com/webhook',
      },
    }
  })

  it('rejects empty and duplicate rule names', async () => {
    await expect(bucket.setNotificationRules([{ ...validRule, name: '' }])).rejects.toThrow(
      /non-empty string/,
    )
    await expect(bucket.setNotificationRules([validRule, { ...validRule }])).rejects.toThrow(
      /unique/,
    )
  })

  it('rejects unknown event types', async () => {
    await expect(
      bucket.setNotificationRules([
        { ...validRule, eventTypes: ['b2:ObjectCreated:Bogus'] as unknown as EventType[] },
      ]),
    ).rejects.toThrow(/unknown event type/)
  })

  it('rejects non-boolean isEnabled values', async () => {
    await expect(
      bucket.setNotificationRules([
        { ...validRule, isEnabled: 'false' } as unknown as EventNotificationRule,
      ]),
    ).rejects.toThrow(/isEnabled/)
    await expect(
      bucket.setNotificationRules([
        { ...validRule, isEnabled: undefined } as unknown as EventNotificationRule,
      ]),
    ).rejects.toThrow(/isEnabled/)
  })

  it('accepts positive integer maxEventsPerBatch values', async () => {
    await bucket.setNotificationRules([{ ...validRule, maxEventsPerBatch: 5 }])
    await expect(bucket.getNotificationRules()).resolves.toMatchObject({
      eventNotificationRules: [{ maxEventsPerBatch: 5 }],
    })
  })

  it('rejects invalid maxEventsPerBatch values', async () => {
    await expect(
      bucket.setNotificationRules([
        { ...validRule, maxEventsPerBatch: '5' } as unknown as EventNotificationRule,
      ]),
    ).rejects.toThrow(/maxEventsPerBatch/)
    await expect(
      bucket.setNotificationRules([
        { ...validRule, maxEventsPerBatch: 0 } as unknown as EventNotificationRule,
      ]),
    ).rejects.toThrow(/maxEventsPerBatch/)
  })

  it('rejects non-webhook targets and non-https URLs', async () => {
    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            targetType: 'url',
            url: 'https://example.com/webhook',
          } as unknown as EventNotificationRule['targetConfiguration'],
        },
      ]),
    ).rejects.toThrow(/targetType/)
    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: { targetType: 'webhook', url: 'http://example.com/webhook' },
        },
      ]),
    ).rejects.toThrow(/https URL/)
  })

  it('accepts and validates customHeaders as wire-shaped objects', async () => {
    const customHeaders = [
      { name: 'X-B2-Source', value: 'sdk-test' },
      { name: 'X-B2-Rule', value: 'upload-webhook' },
    ] as const

    await bucket.setNotificationRules([
      {
        ...validRule,
        targetConfiguration: {
          ...validRule.targetConfiguration,
          customHeaders,
        },
      },
    ])
    await expect(bucket.getNotificationRules()).resolves.toMatchObject({
      eventNotificationRules: [{ targetConfiguration: { customHeaders } }],
    })

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: { 'X-B2-Source': 'sdk-test' },
          } as unknown as EventNotificationRule['targetConfiguration'],
        },
      ]),
    ).rejects.toThrow(/customHeaders must be an array/)
    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [{ name: 'X-B2-Source' }],
          } as unknown as EventNotificationRule['targetConfiguration'],
        },
      ]),
    ).rejects.toThrow(/customHeaders\[0\]\.value/)
  })

  it('rejects customHeaders that production B2 rejects', async () => {
    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [{ name: 'X-Bz-Event-Notification-Signature', value: 'spoofed' }],
          },
        },
      ]),
    ).rejects.toThrow(/must not begin with X-Bz-/)

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [
              { name: 'X-Webhook-Dupe', value: 'one' },
              { name: 'x-webhook-dupe', value: 'two' },
            ],
          },
        },
      ]),
    ).rejects.toThrow(/must be unique/)

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [{ name: 'X-Webhook-Inject', value: 'ok\r\nAuthorization: bad' }],
          },
        },
      ]),
    ).rejects.toThrow(/valid HTTP header value/)

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [{ name: 'X Webhook Bad', value: 'bad' }],
          },
        },
      ]),
    ).rejects.toThrow(/valid HTTP header name/)

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: Array.from({ length: 11 }, (_, index) => ({
              name: `X-Webhook-${index}`,
              value: 'ok',
            })),
          },
        },
      ]),
    ).rejects.toThrow(/no more than 10/)

    await expect(
      bucket.setNotificationRules([
        {
          ...validRule,
          targetConfiguration: {
            ...validRule.targetConfiguration,
            customHeaders: [{ name: 'X-A', value: 'a'.repeat(2043) }],
          },
        },
      ]),
    ).rejects.toThrow(/URL-encoded name\/value bytes/)
  })

  it('rejects unknown rule fields', async () => {
    await expect(
      bucket.setNotificationRules([
        { ...validRule, unexpected: true } as unknown as EventNotificationRule,
      ]),
    ).rejects.toThrow(/not a supported field/)
    await expect(bucket.getNotificationRules()).resolves.toMatchObject({
      bucketId: bucket.id,
      eventNotificationRules: [],
    })
  })
})

describe('B2Simulator listing order', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'listing-order',
      bucketType: BucketType.AllPrivate,
    })
  })

  it('uses deterministic JS string order instead of locale collation', async () => {
    await bucket.upload({
      fileName: 'a-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.upload({
      fileName: 'Z-small.txt',
      source: new BufferSource(new Uint8Array([1])),
    })

    const names = await bucket.listFileNames()
    expect(names.files.map((file) => file.fileName)).toEqual(['Z-small.txt', 'a-small.txt'])

    const versions = await bucket.listFileVersions()
    expect(versions.files.map((file) => file.fileName)).toEqual(['Z-small.txt', 'a-small.txt'])

    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'a-large.bin',
      contentType: 'application/octet-stream',
    })
    await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'Z-large.bin',
      contentType: 'application/octet-stream',
    })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    expect(unfinished.files.map((file) => file.fileName)).toEqual(['Z-large.bin', 'a-large.bin'])
  })

  it('honors delimiter and prefix in listFileNames with virtual folder rows', async () => {
    for (const fileName of [
      'photos/alice.jpg',
      'photos/alfred.jpg',
      'photos/cats/fluffy.jpg',
      'photos/cats/mittens.jpg',
      'photos/dogs/spot.jpg',
      'photos/lilly.jpg',
    ]) {
      await bucket.upload({
        fileName,
        contentType: 'image/jpeg',
        source: new BufferSource(new TextEncoder().encode(fileName)),
      })
    }

    const root = await bucket.listFileNames({ delimiter: '/' })
    expect(root.files.map((file) => ({ action: file.action, fileName: file.fileName }))).toEqual([
      { action: FileAction.Folder, fileName: 'photos/' },
    ])
    expect(root.files[0]).toMatchObject({
      action: FileAction.Folder,
      contentLength: 0,
      contentMd5: null,
      contentSha1: null,
      contentType: null,
      fileId: null,
      fileInfo: {},
      uploadTimestamp: 0,
    })

    const photos = await bucket.listFileNames({ prefix: 'photos/', delimiter: '/' })
    expect(
      photos.files.map((file) => ({
        action: file.action,
        contentType: file.contentType,
        fileId: file.fileId,
        fileName: file.fileName,
      })),
    ).toEqual([
      {
        action: FileAction.Upload,
        contentType: 'image/jpeg',
        fileId: expect.any(String),
        fileName: 'photos/alfred.jpg',
      },
      {
        action: FileAction.Upload,
        contentType: 'image/jpeg',
        fileId: expect.any(String),
        fileName: 'photos/alice.jpg',
      },
      {
        action: FileAction.Folder,
        contentType: null,
        fileId: null,
        fileName: 'photos/cats/',
      },
      {
        action: FileAction.Folder,
        contentType: null,
        fileId: null,
        fileName: 'photos/dogs/',
      },
      {
        action: FileAction.Upload,
        contentType: 'image/jpeg',
        fileId: expect.any(String),
        fileName: 'photos/lilly.jpg',
      },
    ])
  })

  it('does not emit listFileNames rows or folders for hidden files', async () => {
    await bucket.upload({
      fileName: 'hidden/ghost.txt',
      contentType: 'text/plain',
      source: new BufferSource(new TextEncoder().encode('ghost')),
    })
    await bucket.hideFile('hidden/ghost.txt')
    await bucket.upload({
      fileName: 'visible/live.txt',
      contentType: 'text/plain',
      source: new BufferSource(new TextEncoder().encode('live')),
    })

    const names = await bucket.listFileNames()
    expect(names.files.map((file) => file.fileName)).toEqual(['visible/live.txt'])

    const root = await bucket.listFileNames({ delimiter: '/' })
    expect(root.files.map((file) => ({ action: file.action, fileName: file.fileName }))).toEqual([
      { action: FileAction.Folder, fileName: 'visible/' },
    ])

    const hiddenPrefix = await bucket.listFileNames({ prefix: 'hidden/', delimiter: '/' })
    expect(hiddenPrefix.files).toEqual([])
  })

  it('honors delimiter in listFileVersions and shapes folder and hide fields', async () => {
    const changelog = await bucket.upload({
      fileName: 'docs/changelog.txt',
      contentType: 'text/plain',
      source: new BufferSource(new TextEncoder().encode('visible changelog')),
    })
    await bucket.upload({
      fileName: 'docs/archive/old.txt',
      contentType: 'text/plain',
      source: new BufferSource(new TextEncoder().encode('old')),
    })
    await bucket.upload({
      fileName: 'docs/archive/older.txt',
      contentType: 'text/plain',
      source: new BufferSource(new TextEncoder().encode('older')),
    })
    const readme = await bucket.upload({
      fileName: 'docs/readme.txt',
      contentType: 'text/markdown',
      source: new BufferSource(new TextEncoder().encode('# docs')),
    })
    const hidden = await bucket.hideFile('docs/changelog.txt')

    const versions = await bucket.listFileVersions({ prefix: 'docs/', delimiter: '/' })
    expect(
      versions.files.map((file) => ({
        action: file.action,
        contentType: file.contentType,
        fileId: file.fileId,
        fileName: file.fileName,
      })),
    ).toEqual([
      {
        action: FileAction.Folder,
        contentType: null,
        fileId: null,
        fileName: 'docs/archive/',
      },
      {
        action: FileAction.Hide,
        contentType: HIDE_MARKER_CONTENT_TYPE,
        fileId: hidden.fileId,
        fileName: 'docs/changelog.txt',
      },
      {
        action: FileAction.Upload,
        contentType: 'text/plain',
        fileId: changelog.fileId,
        fileName: 'docs/changelog.txt',
      },
      {
        action: FileAction.Upload,
        contentType: 'text/markdown',
        fileId: readme.fileId,
        fileName: 'docs/readme.txt',
      },
    ])
    const hideRow = versions.files.find((file) => file.action === FileAction.Hide)
    expect(hideRow).toMatchObject({
      action: FileAction.Hide,
      contentType: HIDE_MARKER_CONTENT_TYPE,
      fileId: hidden.fileId,
      fileName: 'docs/changelog.txt',
    })
    expect(hideRow).not.toHaveProperty('fileRetention')
    expect(hideRow).not.toHaveProperty('legalHold')
    expect(hideRow).not.toHaveProperty('serverSideEncryption')

    expect(versions.files[0]).toMatchObject({
      action: FileAction.Folder,
      contentLength: 0,
      contentMd5: null,
      contentSha1: null,
      contentType: null,
      fileId: null,
      fileInfo: {},
      uploadTimestamp: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Wire-level edges
// ---------------------------------------------------------------------------

describe('B2Simulator wire-level: Content-Range + Range header forms', () => {
  let sim: B2Simulator
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>
  const fileBytes = new Uint8Array(100).map((_, i) => i)

  beforeEach(async () => {
    ;({ client, sim } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'range-edges',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'numbers.bin',
      source: new BufferSource(fileBytes),
    })
  })

  it('returns 206 + Content-Range header on a closed range', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=10-19' })
    expect(result.headers.contentLength).toBe(10)
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(10, 20))
    // The high-level facade strips Content-Range; route through the
    // raw transport so we can directly assert the header.
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/file/range-edges/numbers.bin',
      headers: { Range: 'bytes=10-19' },
    })
    expect(resp.status).toBe(206)
    expect(resp.headers.get('Content-Range')).toBe(`bytes 10-19/${fileBytes.byteLength}`)
  })

  it('handles bytes=N- (open-ended forward range)', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=90-' })
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(90))
    expect(drained.byteLength).toBe(10)
  })

  it('handles bytes=-N (suffix range, last N bytes)', async () => {
    const result = await bucket.download('numbers.bin', { range: 'bytes=-25' })
    const drained = new Uint8Array(await new Response(result.body).arrayBuffer())
    expect(drained).toEqual(fileBytes.slice(75))
    expect(drained.byteLength).toBe(25)
  })

  it('returns 416 with bytes */<total> when a range starts past EOF', async () => {
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/file/range-edges/numbers.bin',
      headers: { Range: 'bytes=500-600' },
    })
    expect(resp.status).toBe(416)
    expect(resp.headers.get('Content-Range')).toBe(`bytes */${fileBytes.byteLength}`)
  })
})

// ---------------------------------------------------------------------------
// Pluggable post-upload hooks
// ---------------------------------------------------------------------------

describe('B2Simulator hooks: onWebhookDeliver', () => {
  it('fires for matching event-notification rules', async () => {
    const events: Array<{ ruleName: string; fileName: string }> = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: ({ rule, fileVersion }) => {
          events.push({ ruleName: rule.name, fileName: fileVersion.fileName })
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'webhook-fire',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'all-uploads',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: true,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    await bucket.upload({
      fileName: 'fired.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3])),
    })
    // Deterministic flush: wait for every pending hook to settle.
    // Replaces the previous microtask-counting dance, which was
    // brittle (positive case awaited 2 microtasks, negative case 1).
    await sim.flushHooks()
    expect(events).toEqual([{ ruleName: 'all-uploads', fileName: 'fired.bin' }])
  })

  it('does not fire for rules with isEnabled: false', async () => {
    const events: unknown[] = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: (e) => {
          events.push(e)
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'webhook-disabled',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'disabled-rule',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: false,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    await bucket.upload({
      fileName: 'not-fired.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await sim.flushHooks()
    expect(events).toEqual([])
  })

  it('surfaces hook errors via onHookError instead of swallowing them', async () => {
    const errors: Array<{ kind: string; message: string }> = []
    const { client, sim } = makeClient({
      sim: {
        onWebhookDeliver: () => {
          throw new Error('boom')
        },
        onHookError: ({ kind, error }) => {
          errors.push({ kind, message: error.message })
        },
      },
    })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'hook-error',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.setNotificationRules([
      {
        name: 'will-throw',
        eventTypes: ['b2:ObjectCreated:*'],
        isEnabled: true,
        isSuspended: false,
        objectNamePrefix: '',
        suspensionReason: '',
        targetConfiguration: {
          targetType: 'webhook',
          url: 'https://example.com/hook',
          hmacSha256SigningSecret: 'secret',
        },
      },
    ])
    const result = await bucket.upload({
      fileName: 'still-stored.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    // Upload itself succeeded — buggy hook must not corrupt the write.
    expect(result.fileName).toBe('still-stored.bin')
    await sim.flushHooks()
    expect(errors).toEqual([{ kind: 'webhook', message: 'boom' }])
  })
})

// ---------------------------------------------------------------------------
// Authorization grant fidelity
// ---------------------------------------------------------------------------

async function authorizeWithKey(
  sim: B2Simulator,
  key: { applicationKeyId: string; applicationKey: string },
): Promise<B2Client> {
  const client = new B2Client({
    applicationKeyId: key.applicationKeyId,
    applicationKey: key.applicationKey,
    transport: sim.transport(),
    retry: { maxRetries: 0 },
  })
  await client.authorize()
  return client
}

function issuedTokenCount(sim: B2Simulator): number {
  return (
    sim as unknown as {
      readonly issuedTokens: Map<string, unknown>
    }
  ).issuedTokens.size
}

describe('B2Simulator authorize response grants', () => {
  it('derives allowed capabilities and scope from a created key in default mode', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'auth-grant-scope',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'auth-grant-restricted',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })

    const scopedClient = await authorizeWithKey(sim, key)
    const storageApi = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi

    expect(storageApi?.allowed.capabilities).toEqual([Capability.ListFiles])
    expect(storageApi?.allowed.buckets).toEqual([{ id: bucket.id, name: bucket.name }])
    expect(storageApi?.allowed.bucketId).toBe(bucket.id)
    expect(storageApi?.allowed.namePrefix).toBe('allowed/')
    expect(storageApi?.namePrefix).toBe('allowed/')
    expect(scopedClient.hasCapabilities([Capability.ListFiles])).toEqual({
      ok: true,
      missing: [],
    })
    expect(scopedClient.hasCapabilities([Capability.WriteFiles])).toEqual({
      ok: false,
      missing: [Capability.WriteFiles],
    })
  })

  it('keeps default-mode implicit master fallback for unknown Basic credentials', async () => {
    const { sim } = makeClient()
    const fallbackClient = new B2Client({
      applicationKeyId: 'placeholder-key-id',
      applicationKey: 'placeholder-key',
      transport: sim.transport(),
      retry: { maxRetries: 0 },
    })

    await fallbackClient.authorize()

    expect(fallbackClient.accountInfo.getAuth()?.apiInfo.storageApi.allowed.buckets).toBeNull()
    expect(fallbackClient.hasCapabilities([Capability.ListBuckets, Capability.WriteFiles])).toEqual(
      {
        ok: true,
        missing: [],
      },
    )
  })

  it('reports applicationKeyExpirationTimestamp for an expiring created key', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'auth-grant-expiring',
      validDurationInSeconds: 60,
    })

    const scopedClient = await authorizeWithKey(sim, key)

    expect(scopedClient.accountInfo.getAuth()?.applicationKeyExpirationTimestamp).toBe(
      key.expirationTimestamp,
    )
  })

  it('rejects expired created-key credentials and their strict-auth tokens', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'auth-grant-expired',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'auth-grant-expired-key',
      bucketIds: [bucket.id],
      validDurationInSeconds: 1,
    })
    const scopedClient = await authorizeWithKey(sim, key)
    await expect(scopedClient.listBuckets({ bucketId: bucket.id })).resolves.toHaveLength(1)

    sim.advanceTime(1000)
    const beforeExpiredAuthorize = issuedTokenCount(sim)
    const response = await sim.transport().send({
      method: 'GET',
      url: 'http://localhost:0/b2api/v4/b2_authorize_account',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:${key.applicationKey}`)}`,
      },
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('expired'),
    })
    expect(issuedTokenCount(sim)).toBe(beforeExpiredAuthorize)

    const protectedResponse = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v4/b2_list_buckets',
      headers: { Authorization: scopedClient.accountInfo.getAuthToken() },
      body: JSON.stringify({
        accountId: client.accountInfo.getAccountId(),
        bucketId: bucket.id,
      }),
    })
    expect(protectedResponse.status).toBe(401)
    await expect(protectedResponse.json()).resolves.toMatchObject({ code: 'expired_auth_token' })
  })

  it('does not promote invalid created-key credentials to the master grant', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'auth-grant-invalid-secret',
    })

    const response = await sim.transport().send({
      method: 'GET',
      url: 'http://localhost:0/b2api/v4/b2_authorize_account',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:wrong-secret`)}`,
      },
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'unauthorized' })
  })

  it('does not promote deleted created-key credentials to the master grant', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.ListFiles],
      keyName: 'auth-grant-deleted-key',
    })
    await client.deleteKey(key.applicationKeyId)
    const beforeDeletedKeyAuthorize = issuedTokenCount(sim)

    const response = await sim.transport().send({
      method: 'GET',
      url: 'http://localhost:0/b2api/v4/b2_authorize_account',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:${key.applicationKey}`)}`,
      },
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'unauthorized' })
    expect(issuedTokenCount(sim)).toBe(beforeDeletedKeyAuthorize)
  })
})

// ---------------------------------------------------------------------------
// Strict-auth mode
// ---------------------------------------------------------------------------

describe('B2Simulator strictAuth: capability enforcement', () => {
  function forgeAdjacentTokenValue(token: string): string {
    return `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`
  }

  function downloadAuthorizationTokenCount(sim: B2Simulator): number {
    return (
      sim as unknown as {
        readonly downloadAuthorizationTokens: Map<string, unknown>
      }
    ).downloadAuthorizationTokens.size
  }

  it('grants the master credential the documented capability set by default', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = client.accountInfo.getAuth()?.apiInfo.storageApi.allowed
    const capabilities = allowed?.capabilities ?? []

    expect(capabilities).toEqual([
      Capability.ListBuckets,
      Capability.ListAllBucketNames,
      Capability.ReadBuckets,
      Capability.WriteBuckets,
      Capability.DeleteBuckets,
      Capability.ReadBucketEncryption,
      Capability.WriteBucketEncryption,
      Capability.ReadBucketReplications,
      Capability.WriteBucketReplications,
      Capability.ReadBucketNotifications,
      Capability.WriteBucketNotifications,
      Capability.ReadBucketLogging,
      Capability.WriteBucketLogging,
      Capability.ReadBucketLifecycleRules,
      Capability.WriteBucketLifecycleRules,
      Capability.ListFiles,
      Capability.ReadFiles,
      Capability.WriteFiles,
      Capability.DeleteFiles,
      Capability.ListKeys,
      Capability.WriteKeys,
      Capability.DeleteKeys,
      Capability.ShareFiles,
    ])
    expect(allowed?.buckets).toBeNull()
    expect(capabilities).not.toEqual(
      expect.arrayContaining([
        Capability.ReadBucketRetentions,
        Capability.WriteBucketRetentions,
        Capability.ReadFileLegalHolds,
        Capability.WriteFileLegalHolds,
        Capability.ReadFileRetentions,
        Capability.WriteFileRetentions,
        Capability.BypassGovernance,
      ]),
    )
  })

  it('filters replication configuration by readBucketReplications', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'auth-repl-filter',
      bucketType: BucketType.AllPrivate,
    })
    const sourceKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'auth-repl-filter-source',
      bucketId: bucket.id,
    })
    const destinationKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'auth-repl-filter-destination',
      bucketId: bucket.id,
    })
    await bucket.setReplication({
      asReplicationDestination: {
        sourceToDestinationKeyMapping: {
          [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
        },
      },
      asReplicationSource: null,
    })

    const deniedKey = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'auth-repl-filter-denied',
      bucketId: bucket.id,
    })
    const deniedClient = await authorizeWithKey(sim, deniedKey)
    const [deniedBucket] = await deniedClient.listBuckets({ bucketId: bucket.id })
    expect(deniedBucket?.info.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: false,
      value: null,
    })

    const allowedKey = await client.createKey({
      capabilities: [Capability.ListBuckets, Capability.ReadBucketReplications],
      keyName: 'auth-repl-filter-allowed',
      bucketId: bucket.id,
    })
    const allowedClient = await authorizeWithKey(sim, allowedKey)
    const [allowedBucket] = await allowedClient.listBuckets({ bucketId: bucket.id })
    expect(allowedBucket?.info.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: true,
      value: {
        asReplicationDestination: {
          sourceToDestinationKeyMapping: {
            [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
          },
        },
        asReplicationSource: null,
      },
    })
  })

  it('redacts unfinished large-file lock metadata without read capabilities', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'unfinished-lock-redaction',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const restrictedKey = await client.createKey({
      capabilities: [
        Capability.WriteFiles,
        Capability.ListFiles,
        Capability.WriteFileRetentions,
        Capability.WriteFileLegalHolds,
      ],
      keyName: 'unfinished-lock-redacted',
      bucketId: bucket.id,
    })
    const restrictedClient = await authorizeWithKey(sim, restrictedKey)
    const apiUrl = restrictedClient.accountInfo.getApiUrl()
    const authToken = restrictedClient.accountInfo.getAuthToken()
    const fileRetention = {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: Date.now() + 86_400_000,
    } satisfies FileRetentionValue

    const started = await restrictedClient.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'redacted-large.bin',
      contentType: 'application/octet-stream',
      fileRetention,
      legalHold: LegalHoldValue.On,
    })

    expect(started.fileRetention).toEqual({ isClientAuthorizedToRead: false, value: null })
    expect(started.legalHold).toEqual({ isClientAuthorizedToRead: false, value: null })

    const restrictedListing = await restrictedClient.raw.listUnfinishedLargeFiles(
      apiUrl,
      authToken,
      { bucketId: bucket.id, namePrefix: 'redacted-large.bin' },
    )
    expect(restrictedListing.files).toHaveLength(1)
    const [restrictedFile] = restrictedListing.files
    expect(restrictedFile).toMatchObject({
      fileName: 'redacted-large.bin',
      fileRetention: {
        isClientAuthorizedToRead: false,
        value: null,
      },
      legalHold: {
        isClientAuthorizedToRead: false,
        value: null,
      },
    })

    const readerKey = await client.createKey({
      capabilities: [
        Capability.ListFiles,
        Capability.ReadFileRetentions,
        Capability.ReadFileLegalHolds,
      ],
      keyName: 'unfinished-lock-reader',
      bucketId: bucket.id,
    })
    const readerClient = await authorizeWithKey(sim, readerKey)
    const visibleListing = await readerClient.raw.listUnfinishedLargeFiles(
      readerClient.accountInfo.getApiUrl(),
      readerClient.accountInfo.getAuthToken(),
      { bucketId: bucket.id, namePrefix: 'redacted-large.bin' },
    )
    expect(visibleListing.files).toHaveLength(1)
    const [visibleFile] = visibleListing.files
    expect(visibleFile).toMatchObject({
      fileName: 'redacted-large.bin',
      fileRetention: {
        isClientAuthorizedToRead: true,
        value: fileRetention,
      },
      legalHold: {
        isClientAuthorizedToRead: true,
        value: LegalHoldValue.On,
      },
    })
  })

  it('rejects unknown capabilities during key creation', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()

    await expect(
      client.createKey({
        capabilities: ['doEverything'] as unknown as Capability[],
        keyName: 'unknown-capability-key',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: expect.stringContaining('unknown capabilities: doEverything'),
    })
  })

  it('rejects empty capabilities during key creation', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()

    await expect(
      client.createKey({
        capabilities: [],
        keyName: 'empty-capability-key',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: expect.stringContaining('capabilities must not be empty'),
    })
  })

  it('rejects malformed create-key fields in default mode', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const transport = sim.transport()
    const base = {
      accountId: client.accountInfo.getAccountId(),
      capabilities: [Capability.ListBuckets],
      keyName: 'malformed-create-key',
    }

    for (const body of [
      { ...base, capabilities: 'listBuckets' },
      { ...base, capabilities: [123] },
      { ...base, capabilities: ['doEverything'] },
      { ...base, capabilities: [] },
      { ...base, keyName: 42 },
      { ...base, keyName: null },
      { ...base, keyName: 'k'.repeat(101) },
    ]) {
      const resp = await transport.send({
        method: 'POST',
        url: 'http://localhost:0/b2api/v4/b2_create_key',
        headers: {
          Authorization: client.accountInfo.getAuthToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      expect(resp.status).toBe(400)
      await expect(resp.json()).resolves.toMatchObject({ code: 'bad_request' })
    }
  })

  it('does not expose stored create-key capabilities by reference', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const key = await client.createKey({
      capabilities: [Capability.WriteKeys],
      keyName: 'defensive-capabilities',
    })

    ;(key.capabilities as Capability[]).push(Capability.ListBuckets)
    const listed = await client.listKeys()
    const listedKey = listed.keys.find(
      (candidate) => candidate.applicationKeyId === key.applicationKeyId,
    )
    expect(listedKey?.capabilities).toEqual([Capability.WriteKeys])
    if (listedKey === undefined) throw new Error('expected created key to be listed')

    ;(listedKey.capabilities as Capability[]).push(Capability.ListBuckets)
    const relisted = await client.listKeys()
    expect(
      relisted.keys.find((candidate) => candidate.applicationKeyId === key.applicationKeyId)
        ?.capabilities,
    ).toEqual([Capability.WriteKeys])

    const scopedClient = await authorizeWithKey(sim, key)
    expect(scopedClient.accountInfo.getAuth()?.apiInfo.storageApi.allowed.capabilities).toEqual([
      Capability.WriteKeys,
    ])

    const requestCapabilities: Capability[] = [Capability.WriteKeys]
    const direct = await sim.handleRequest(
      'POST',
      'http://localhost:0',
      '/b2api/v4/b2_create_key',
      { authorization: client.accountInfo.getAuthToken() },
      {
        accountId: client.accountInfo.getAccountId(),
        capabilities: requestCapabilities,
        keyName: 'direct-defensive-capabilities',
      },
    )
    expect(direct.status).toBe(200)
    const directKey = direct.body as {
      applicationKeyId: string
      applicationKey: string
      capabilities: readonly Capability[]
    }
    requestCapabilities.push(Capability.ListBuckets)
    ;(directKey.capabilities as Capability[]).push(Capability.DeleteBuckets)

    const directClient = await authorizeWithKey(sim, directKey)
    expect(directClient.accountInfo.getAuth()?.apiInfo.storageApi.allowed.capabilities).toEqual([
      Capability.WriteKeys,
    ])
  })

  it('rejects keys that request capabilities outside the creator grant', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const creatorKey = await client.createKey({
      capabilities: [Capability.WriteKeys],
      keyName: 'delegated-key-creator',
    })
    const creatorClient = await authorizeWithKey(sim, creatorKey)

    await expect(
      creatorClient.createKey({
        capabilities: [Capability.WriteKeys, Capability.ListBuckets],
        keyName: 'too-broad-key',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: expect.stringContaining('listBuckets'),
    })
    await expect(
      creatorClient.createKey({
        capabilities: [Capability.WriteKeys],
        keyName: 'same-grant-key',
      }),
    ).resolves.toMatchObject({ capabilities: [Capability.WriteKeys] })
  })

  it('rejects broader child grants from restricted creators in default mode', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const creatorKey = await client.createKey({
      capabilities: [Capability.WriteKeys],
      keyName: 'default-delegated-key-creator',
    })
    const creatorClient = await authorizeWithKey(sim, creatorKey)

    await expect(
      creatorClient.createKey({
        capabilities: [Capability.WriteKeys, Capability.ListBuckets],
        keyName: 'default-too-broad-key',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      message: expect.stringContaining('listBuckets'),
    })
  })

  it('rejects create-key accountId mismatches for authorized tokens', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const transport = sim.transport()
    const masterAuthToken = client.accountInfo.getAuthToken()

    const masterMismatch = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v4/b2_create_key',
      headers: { Authorization: masterAuthToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'victim_account',
        capabilities: [Capability.ListBuckets],
        keyName: 'cross-account-master',
      }),
    })
    expect(masterMismatch.status).toBe(400)
    await expect(masterMismatch.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'accountId must match authorized account',
    })

    const creatorKey = await client.createKey({
      capabilities: [Capability.WriteKeys, Capability.ListBuckets],
      keyName: 'account-bound-key-creator',
    })
    const creatorClient = await authorizeWithKey(sim, creatorKey)
    const restrictedMismatch = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v4/b2_create_key',
      headers: {
        Authorization: creatorClient.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'victim_account',
        capabilities: [Capability.ListBuckets],
        keyName: 'cross-account-restricted',
      }),
    })
    expect(restrictedMismatch.status).toBe(400)
    await expect(restrictedMismatch.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'accountId must match authorized account',
    })

    const afterMismatches = await client.listKeys()
    expect(afterMismatches.keys).not.toContainEqual(
      expect.objectContaining({ keyName: 'cross-account-master' }),
    )
    expect(afterMismatches.keys).not.toContainEqual(
      expect.objectContaining({ keyName: 'cross-account-restricted' }),
    )
  })

  it('enforces B2 keyName length limits during key creation', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()

    for (const keyName of ['', 'k'.repeat(101)]) {
      await expect(
        client.createKey({
          capabilities: [Capability.ListBuckets],
          keyName,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
        message: expect.stringContaining('keyName must be 1-100 characters'),
      })
    }
    await expect(
      client.createKey({
        capabilities: [Capability.ListBuckets],
        keyName: 'k'.repeat(100),
      }),
    ).resolves.toMatchObject({ keyName: 'k'.repeat(100) })
  })

  it('rejects with 401 when the auth token is unknown', async () => {
    const { sim } = makeClient({ sim: { strictAuth: true } })
    const transport = sim.transport()
    const resp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_list_buckets',
      headers: { Authorization: 'definitely-not-a-real-token' },
      body: JSON.stringify({ accountId: 'sim_account_0001' }),
    })
    expect(resp.status).toBe(401)
    const body = (await resp.json()) as { code: string }
    expect(body.code).toBe('bad_auth_token')
  })

  it('returns 401 expired_auth_token at the wire level once advanceTime pushes past TTL', async () => {
    // Send via the raw transport (bypassing RetryTransport's reauth
    // loop) so we observe the simulator's wire response, not the
    // SDK's post-reauth retry behaviour.
    const { sim } = makeClient({ sim: { strictAuth: true, authTokenTtlMs: 1000 } })
    const transport = sim.transport()
    const authResp = await transport.send({
      method: 'GET',
      url: 'http://localhost:0/b2api/v3/b2_authorize_account',
      headers: { Authorization: `Basic ${btoa('test-key-id:test-key')}` },
    })
    expect(authResp.status).toBe(200)
    const authBody = (await authResp.json()) as { authorizationToken: string }
    const authToken = authBody.authorizationToken

    sim.advanceTime(2000) // push past the 1-second TTL

    const expiredResp = await transport.send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_list_buckets',
      headers: { Authorization: authToken },
      body: JSON.stringify({ accountId: 'sim_account_0001' }),
    })
    expect(expiredResp.status).toBe(401)
    const expiredBody = (await expiredResp.json()) as { code: string }
    expect(expiredBody.code).toBe('expired_auth_token')
  })

  it('enforces single-bucket application key scope from the bucketId alias', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'single-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'single-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'single-scope-key',
      bucketId: allowed.id,
    })
    expect(key.bucketIds).toEqual([allowed.id])

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toEqual([{ id: allowed.id, name: allowed.name }])
    expect(scopedAuth?.bucketId).toBe(allowed.id)
    expect(scopedAuth?.allowed.bucketId).toBe(allowed.id)
    expect(scopedClient.accountInfo.getAllowedBucketId()).toBe(allowed.id)
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toEqual([allowed.id])
    await expect(scopedClient.listBuckets()).rejects.toThrow(/bucket scope is required/)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('enforces multi-bucket application key scope', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const first = await client.createBucket({
      bucketName: 'multi-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'multi-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'multi-scope-c',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'multi-scope-key',
      bucketIds: [first.id, second.id],
    })
    expect(key.bucketIds).toEqual([first.id, second.id])

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ])
    expect(scopedAuth?.bucketId).toBeNull()
    expect(scopedAuth?.allowed.bucketId).toBeNull()
    expect(() => scopedClient.accountInfo.getAllowedBucketId()).toThrow(/exactly one bucket/)
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toEqual([first.id, second.id])
    const directAuthResponse = await sim.transport().send({
      url: 'http://127.0.0.1/b2api/v4/b2_authorize_account',
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${key.applicationKeyId}:${key.applicationKey}`)}`,
      },
    })
    const directAuth = await directAuthResponse.json<AuthorizeAccountResponse>()
    expect(directAuth.apiInfo.storageApi.allowed.buckets).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ])
    expect(directAuth.apiInfo.storageApi.bucketId).toBeNull()
    expect(directAuth.apiInfo.storageApi.allowed.bucketId).toBeNull()
    await expect(scopedClient.listBuckets()).rejects.toThrow(/bucket scope is required/)
    await expect(scopedClient.listBuckets({ bucketId: first.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: second.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('allows all buckets when application key bucketIds are null', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const first = await client.createBucket({
      bucketName: 'all-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'all-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'all-scope-key',
      bucketIds: null,
    })
    expect(key.bucketIds).toBeNull()

    const scopedClient = await authorizeWithKey(sim, key)
    const scopedAuth = scopedClient.accountInfo.getAuth()?.apiInfo.storageApi
    expect(scopedAuth?.allowed.buckets).toBeNull()
    expect(scopedAuth?.bucketId).toBeNull()
    expect(scopedAuth?.allowed.bucketId).toBeNull()
    expect(scopedClient.accountInfo.getAllowedBucketId()).toBeNull()
    expect(scopedClient.accountInfo.getAllowedBucketIds()).toBeNull()
    await expect(scopedClient.listBuckets({ bucketId: first.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: second.id })).resolves.toHaveLength(1)
  })

  it('hides bucket default encryption from keys without readBucketEncryption', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const readableSseB2 = {
      isClientAuthorizedToRead: true,
      value: SSE_B2,
    }
    const unreadable = {
      isClientAuthorizedToRead: false,
      value: null,
    }
    const readableNone = {
      isClientAuthorizedToRead: true,
      value: { mode: null, algorithm: null },
    }

    const bucket = await client.createBucket({
      bucketName: 'hidden-bucket-encryption',
      bucketType: BucketType.AllPrivate,
      defaultServerSideEncryption: SSE_B2,
    })
    expect(bucket.info.defaultServerSideEncryption).toEqual(readableSseB2)

    const hiddenKey = await client.createKey({
      capabilities: [
        Capability.ListBuckets,
        Capability.WriteBuckets,
        Capability.WriteBucketEncryption,
      ],
      keyName: 'hidden-bucket-encryption-key',
      bucketIds: null,
    })
    const hiddenClient = await authorizeWithKey(sim, hiddenKey)
    const hiddenList = await hiddenClient.listBuckets({ bucketId: bucket.id })
    expect(hiddenList[0]?.info.defaultServerSideEncryption).toEqual(unreadable)

    const hiddenCreated = await hiddenClient.createBucket({
      bucketName: 'hidden-created-encryption',
      bucketType: BucketType.AllPrivate,
      defaultServerSideEncryption: SSE_B2,
    })
    expect(hiddenCreated.info.defaultServerSideEncryption).toEqual(unreadable)

    const hiddenUpdated = await hiddenCreated.update({ defaultServerSideEncryption: SSE_NONE })
    expect(hiddenUpdated.defaultServerSideEncryption).toEqual(unreadable)

    const readableKey = await client.createKey({
      capabilities: [Capability.ListBuckets, Capability.ReadBucketEncryption],
      keyName: 'readable-bucket-encryption-key',
      bucketIds: null,
    })
    const readableClient = await authorizeWithKey(sim, readableKey)
    const listedSseB2 = await readableClient.listBuckets({ bucketId: bucket.id })
    expect(listedSseB2[0]?.info.defaultServerSideEncryption).toEqual(readableSseB2)
    const listedNone = await readableClient.listBuckets({ bucketId: hiddenCreated.id })
    expect(listedNone[0]?.info.defaultServerSideEncryption).toEqual(readableNone)
  })

  it('rejects bucket creation with bucket-scoped application keys', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'create-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const scopedKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'create-scope-key',
      bucketIds: [allowed.id],
    })
    const scopedClient = await authorizeWithKey(sim, scopedKey)

    await expect(
      scopedClient.createBucket({
        bucketName: 'create-scope-denied',
        bucketType: BucketType.AllPrivate,
      }),
    ).rejects.toThrow(/bucket scope is required/)

    const unrestrictedKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'create-all-key',
      bucketIds: null,
    })
    const unrestrictedClient = await authorizeWithKey(sim, unrestrictedKey)
    await expect(
      unrestrictedClient.createBucket({
        bucketName: 'create-scope-allowed',
        bucketType: BucketType.AllPrivate,
      }),
    ).resolves.toMatchObject({ name: 'create-scope-allowed' })
  })

  it('rejects replication rules pointing at out-of-scope destination buckets', async () => {
    const replicationEvents: unknown[] = []
    const { client, sim } = makeClient({
      sim: {
        strictAuth: true,
        onReplicate: (event) => {
          replicationEvents.push(event)
        },
      },
    })
    await client.authorize()
    const source = await client.createBucket({
      bucketName: 'repl-scope-src',
      bucketType: BucketType.AllPrivate,
    })
    const destination = await client.createBucket({
      bucketName: 'repl-scope-dst',
      bucketType: BucketType.AllPrivate,
    })
    const sourceKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'repl-source-read',
      bucketId: source.id,
    })
    const destinationKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'repl-destination-write',
      bucketId: destination.id,
    })
    await destination.update({
      replicationConfiguration: {
        asReplicationDestination: {
          sourceToDestinationKeyMapping: {
            [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
          },
        },
        asReplicationSource: null,
      },
    })
    const writerKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'repl-source-only-writer',
      bucketId: source.id,
    })
    const scopedClient = await authorizeWithKey(sim, writerKey)

    await expect(
      scopedClient.raw.updateBucket(
        scopedClient.accountInfo.getApiUrl(),
        scopedClient.accountInfo.getAuthToken(),
        {
          accountId: accountId(scopedClient.accountInfo.getAccountId()),
          bucketId: source.id,
          replicationConfiguration: {
            asReplicationDestination: null,
            asReplicationSource: {
              replicationRules: [
                {
                  destinationBucketId: destination.id,
                  fileNamePrefix: '',
                  includeExistingFiles: false,
                  isEnabled: true,
                  priority: 1,
                  replicationRuleName: 'out-of-scope',
                },
              ],
              sourceApplicationKeyId: sourceKey.applicationKeyId,
            },
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'unauthorized' })

    await source.upload({
      fileName: 'should-not-replicate.txt',
      source: new BufferSource(new Uint8Array([1])),
    })
    await sim.flushHooks()
    expect(replicationEvents).toEqual([])
  })

  it('rejects replication rules for nonexistent or not configured destinations', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const source = await client.createBucket({
      bucketName: 'repl-dest-src',
      bucketType: BucketType.AllPrivate,
    })
    const destination = await client.createBucket({
      bucketName: 'repl-dest-target',
      bucketType: BucketType.AllPrivate,
    })
    const sourceKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'repl-dest-source-key',
      bucketId: source.id,
    })
    const destinationKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'repl-dest-write-key',
      bucketId: destination.id,
    })
    const writerKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'repl-dest-writer',
      bucketIds: null,
    })
    const scopedClient = await authorizeWithKey(sim, writerKey)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const account = accountId(scopedClient.accountInfo.getAccountId())
    const replicationConfiguration = (destinationBucketId: string) => ({
      asReplicationDestination: null,
      asReplicationSource: {
        replicationRules: [
          {
            destinationBucketId: bucketId(destinationBucketId),
            fileNamePrefix: '',
            includeExistingFiles: false,
            isEnabled: true,
            priority: 1,
            replicationRuleName: 'requires-destination',
          },
        ],
        sourceApplicationKeyId: sourceKey.applicationKeyId,
      },
    })

    await expect(
      scopedClient.raw.updateBucket(apiUrl, authToken, {
        accountId: account,
        bucketId: source.id,
        replicationConfiguration: replicationConfiguration('b2_bucket_missing_destination'),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      scopedClient.createBucket({
        bucketName: 'repl-create-missing-dest',
        bucketType: BucketType.AllPrivate,
        replicationConfiguration: replicationConfiguration('b2_bucket_create_missing_destination'),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    await expect(
      scopedClient.raw.updateBucket(apiUrl, authToken, {
        accountId: account,
        bucketId: source.id,
        replicationConfiguration: replicationConfiguration(destination.id),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    await destination.update({
      replicationConfiguration: {
        asReplicationDestination: {
          sourceToDestinationKeyMapping: {
            [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
          },
        },
        asReplicationSource: null,
      },
    })
    await expect(
      scopedClient.raw.updateBucket(apiUrl, authToken, {
        accountId: account,
        bucketId: source.id,
        replicationConfiguration: replicationConfiguration(destination.id),
      }),
    ).resolves.toMatchObject({
      replicationConfiguration: {
        isClientAuthorizedToRead: false,
        value: null,
      },
    })
  })

  it('rejects strictAuth replication configs that reference keys missing capabilities', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const source = await client.createBucket({
      bucketName: 'repl-key-src',
      bucketType: BucketType.AllPrivate,
    })
    const destination = await client.createBucket({
      bucketName: 'repl-key-dst',
      bucketType: BucketType.AllPrivate,
    })
    const missingSourceCapabilityKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'repl-bad-source-key',
      bucketId: source.id,
    })
    const goodSourceKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'repl-good-source-key',
      bucketId: source.id,
    })
    const missingDestinationCapabilityKey = await client.createKey({
      capabilities: [Capability.ReadFiles],
      keyName: 'repl-bad-dest-key',
      bucketId: destination.id,
    })
    const writerKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'repl-key-writer',
      bucketIds: [source.id, destination.id],
    })
    const scopedClient = await authorizeWithKey(sim, writerKey)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const account = accountId(scopedClient.accountInfo.getAccountId())

    await expect(
      scopedClient.raw.updateBucket(apiUrl, authToken, {
        accountId: account,
        bucketId: source.id,
        replicationConfiguration: {
          asReplicationDestination: null,
          asReplicationSource: {
            replicationRules: [
              {
                destinationBucketId: destination.id,
                fileNamePrefix: '',
                includeExistingFiles: false,
                isEnabled: true,
                priority: 1,
                replicationRuleName: 'bad-source-key',
              },
            ],
            sourceApplicationKeyId: missingSourceCapabilityKey.applicationKeyId,
          },
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    await expect(
      scopedClient.raw.updateBucket(apiUrl, authToken, {
        accountId: account,
        bucketId: destination.id,
        replicationConfiguration: {
          asReplicationDestination: {
            sourceToDestinationKeyMapping: {
              [goodSourceKey.applicationKeyId]: missingDestinationCapabilityKey.applicationKeyId,
            },
          },
          asReplicationSource: null,
        },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('uses uniform strictAuth replication key validation errors', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const source = await client.createBucket({
      bucketName: 'repl-oracle-src',
      bucketType: BucketType.AllPrivate,
    })
    const other = await client.createBucket({
      bucketName: 'repl-oracle-other',
      bucketType: BucketType.AllPrivate,
    })
    const missingCapabilityKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'repl-oracle-missing-cap',
      bucketId: source.id,
    })
    const wrongBucketKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'repl-oracle-wrong-bucket',
      bucketId: other.id,
    })
    const writerKey = await client.createKey({
      capabilities: [Capability.WriteBuckets],
      keyName: 'repl-oracle-writer',
      bucketIds: [source.id, other.id],
    })
    const scopedClient = await authorizeWithKey(sim, writerKey)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const account = accountId(scopedClient.accountInfo.getAccountId())
    const rejectionFor = async (sourceApplicationKeyId: string): Promise<unknown> =>
      scopedClient.raw
        .updateBucket(apiUrl, authToken, {
          accountId: account,
          bucketId: source.id,
          replicationConfiguration: {
            asReplicationDestination: null,
            asReplicationSource: {
              replicationRules: [
                {
                  destinationBucketId: other.id,
                  fileNamePrefix: '',
                  includeExistingFiles: false,
                  isEnabled: true,
                  priority: 1,
                  replicationRuleName: 'key-oracle',
                },
              ],
              sourceApplicationKeyId: applicationKeyId(sourceApplicationKeyId),
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )

    const missingKeyError = await rejectionFor('missing-replication-key')
    const missingCapabilityError = await rejectionFor(missingCapabilityKey.applicationKeyId)
    const wrongBucketError = await rejectionFor(wrongBucketKey.applicationKeyId)
    const expected = {
      code: 'bad_request',
      message:
        'replication source application key is invalid or not authorized for this replication configuration',
      status: 400,
    }

    expect(missingKeyError).toMatchObject(expected)
    expect(missingCapabilityError).toMatchObject(expected)
    expect(wrongBucketError).toMatchObject(expected)
  })

  it('rejects deprecated bucketId on direct v4 b2_create_key simulator requests', async () => {
    const { sim } = makeClient()
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v4/b2_create_key',
      headers: { Authorization: 'unused', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ReadFiles],
        keyName: 'wire-bucket-id',
        bucketId: 'bucket-id',
      }),
    })

    expect(resp.status).toBe(400)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('bucketId is not accepted'),
    })
  })

  it('normalizes legacy bucketId on direct v3 b2_create_key simulator requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'v3-key-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'v3-key-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_key',
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ListBuckets],
        keyName: 'v3-wire-bucket-id',
        bucketId: allowed.id,
      }),
    })

    expect(resp.status).toBe(200)
    const key = (await resp.json()) as {
      applicationKeyId: string
      applicationKey: string
      bucketIds: readonly string[]
      bucketId: string
    }
    expect(key.bucketIds).toEqual([allowed.id])
    expect(key.bucketId).toBe(allowed.id)

    const scopedClient = await authorizeWithKey(sim, key)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('rejects mixed bucketId and bucketIds on direct v3 b2_create_key simulator requests', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'v3-key-conflict',
      bucketType: BucketType.AllPrivate,
    })
    const resp = await sim.transport().send({
      method: 'POST',
      url: 'http://localhost:0/b2api/v3/b2_create_key',
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId: 'sim_account_0001',
        capabilities: [Capability.ListBuckets],
        keyName: 'v3-wire-conflict',
        bucketId: bucket.id,
        bucketIds: [bucket.id],
      }),
    })

    expect(resp.status).toBe(400)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('either bucketIds or bucketId'),
    })
  })

  it('keeps stored key scope immutable after request and response arrays mutate', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'immutable-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'immutable-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const requestBucketIds = [allowed.id]
    const key = await client.createKey({
      capabilities: [Capability.ListBuckets],
      keyName: 'immutable-scope-key',
      bucketIds: requestBucketIds,
    })

    requestBucketIds.push(blocked.id)
    ;(key.bucketIds as string[] | null)?.push(blocked.id)

    const scopedClient = await authorizeWithKey(sim, key)
    await expect(scopedClient.listBuckets({ bucketId: allowed.id })).resolves.toHaveLength(1)
    await expect(scopedClient.listBuckets({ bucketId: blocked.id })).rejects.toThrow(
      /scoped to buckets/,
    )
  })

  it('rejects bucket or prefix scoped key-management capabilities', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'key-admin-scope',
      bucketType: BucketType.AllPrivate,
    })

    await expect(
      client.createKey({
        capabilities: [Capability.WriteKeys],
        keyName: 'key-admin-bucket-scoped',
        bucketIds: [bucket.id],
      }),
    ).rejects.toThrow(/account-level/)
    await expect(
      client.createKey({
        capabilities: [Capability.ListKeys],
        keyName: 'key-admin-prefix-scoped',
        namePrefix: 'tenant/',
      }),
    ).rejects.toThrow(/account-level/)
    await expect(
      client.createKey({
        capabilities: [Capability.DeleteKeys],
        keyName: 'key-admin-unscoped',
        bucketIds: null,
      }),
    ).resolves.toMatchObject({ keyName: 'key-admin-unscoped', bucketIds: null })
    await expect(
      client.createKey({
        capabilities: [Capability.DeleteKeys],
        keyName: 'key-admin-empty-prefix',
        namePrefix: '',
      }),
    ).resolves.toMatchObject({ keyName: 'key-admin-empty-prefix', namePrefix: null })
  })

  it('rejects bucket-scoped file operations outside the key bucketIds', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'file-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'file-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const blockedFile = await blocked.upload({
      fileName: 'blocked.txt',
      source: new BufferSource(new TextEncoder().encode('blocked')),
    })
    const blockedLarge = await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: blocked.id,
        fileName: 'blocked-large.bin',
        contentType: 'application/octet-stream',
      },
    )
    const key = await client.createKey({
      capabilities: [
        Capability.ListBuckets,
        Capability.ListFiles,
        Capability.ReadFiles,
        Capability.WriteFiles,
        Capability.DeleteFiles,
      ],
      keyName: 'file-scope-key',
      bucketIds: [allowed.id],
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const downloadUrl = scopedClient.accountInfo.getDownloadUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.listFileNames(apiUrl, authToken, { bucketId: blocked.id }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.getFileInfo(apiUrl, authToken, { fileId: blockedFile.fileId }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: blockedFile.fileId,
        fileName: 'copy.txt',
        destinationBucketId: allowed.id,
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.deleteFileVersion(apiUrl, authToken, {
        fileId: blockedFile.fileId,
        fileName: blockedFile.fileName,
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.getUploadPartUrl(apiUrl, authToken, { fileId: blockedLarge.fileId }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.downloadFileById(downloadUrl, authToken, blockedFile.fileId),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.downloadFileByName(
        downloadUrl,
        authToken,
        blocked.name,
        blockedFile.fileName,
      ),
    ).rejects.toThrow(/scoped to buckets/)
  })

  it('enforces namePrefix on list and download authorization prefixes', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-list-scope',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'allowed/visible.txt',
      source: new BufferSource(new TextEncoder().encode('visible')),
    })
    await bucket.upload({
      fileName: 'blocked/hidden.txt',
      source: new BufferSource(new TextEncoder().encode('hidden')),
    })
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'allowed/incomplete.bin',
        contentType: 'application/octet-stream',
      },
    )
    await client.raw.startLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileName: 'blocked/incomplete.bin',
        contentType: 'application/octet-stream',
      },
    )
    const key = await client.createKey({
      capabilities: [Capability.ListFiles, Capability.ShareFiles],
      keyName: 'prefix-list-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.listFileNames(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.listFileVersions(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.listUnfinishedLargeFiles(apiUrl, authToken, { bucketId: bucket.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: '',
        validDurationInSeconds: 60,
      }),
    ).rejects.toThrow(/outside scope/)

    const names = await scopedClient.raw.listFileNames(apiUrl, authToken, {
      bucketId: bucket.id,
      prefix: 'allowed/',
    })
    expect(names.files.map((file) => file.fileName)).toEqual(['allowed/visible.txt'])

    const versions = await scopedClient.raw.listFileVersions(apiUrl, authToken, {
      bucketId: bucket.id,
      prefix: 'allowed/',
    })
    expect(versions.files.map((file) => file.fileName)).toEqual(['allowed/visible.txt'])

    const unfinished = await scopedClient.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'allowed/',
    })
    expect(unfinished.files.map((file) => file.fileName)).toEqual(['allowed/incomplete.bin'])

    await expect(
      scopedClient.raw.getDownloadAuthorization(apiUrl, authToken, {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
      }),
    ).resolves.toMatchObject({ fileNamePrefix: 'allowed/' })
  })

  it('enforces namePrefix on uploads and large-file starts', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-upload-scope',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'prefix-upload-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await scopedClient.raw.getUploadUrl(
      apiUrl,
      authToken,
      { bucketId: bucket.id },
    )

    await expect(
      scopedClient.raw.uploadFile(
        uploadUrl,
        {
          authorization: authorizationToken,
          fileName: 'blocked/upload.txt',
          contentLength: 1,
          contentSha1: 'do_not_verify',
          contentType: 'text/plain',
        },
        new Uint8Array([1]).buffer,
      ),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.uploadFile(
        uploadUrl,
        {
          authorization: authorizationToken,
          fileName: 'allowed/upload.txt',
          contentLength: 1,
          contentSha1: 'do_not_verify',
          contentType: 'text/plain',
        },
        new Uint8Array([1]).buffer,
      ),
    ).resolves.toMatchObject({ fileName: 'allowed/upload.txt' })
    await expect(
      scopedClient.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucket.id,
        fileName: 'blocked/large.bin',
        contentType: 'application/octet-stream',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.startLargeFile(apiUrl, authToken, {
        bucketId: bucket.id,
        fileName: 'allowed/large.bin',
        contentType: 'application/octet-stream',
      }),
    ).resolves.toMatchObject({ fileName: 'allowed/large.bin' })
  })

  it('enforces download authorization token prefix and expiry on downloads', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-scope',
      bucketType: BucketType.AllPrivate,
    })
    const allowed = await bucket.upload({
      fileName: 'allowed/visible.txt',
      source: new BufferSource(new TextEncoder().encode('visible')),
    })
    await bucket.upload({
      fileName: 'blocked/hidden.txt',
      source: new BufferSource(new TextEncoder().encode('hidden')),
    })
    const nonCurrent = await bucket.upload({
      fileName: 'allowed/history.txt',
      source: new BufferSource(new TextEncoder().encode('old history')),
    })
    await bucket.upload({
      fileName: 'allowed/history.txt',
      source: new BufferSource(new TextEncoder().encode('new history')),
    })
    const hidden = await bucket.upload({
      fileName: 'allowed/hidden.txt',
      source: new BufferSource(new TextEncoder().encode('hidden version')),
    })
    await bucket.hideFile('allowed/hidden.txt')
    const auth = await bucket.getDownloadAuthorization('allowed/', 60)
    const transport = sim.transport()
    const authorizationQuery = `Authorization=${encodeURIComponent(auth.authorizationToken)}`
    const forgedToken = forgeAdjacentTokenValue(auth.authorizationToken)
    const forgedAuthorizationQuery = `Authorization=${encodeURIComponent(forgedToken)}`

    const byName = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${authorizationQuery}`,
    })
    expect(byName.status).toBe(200)
    await expect(byName.text()).resolves.toBe('visible')

    const accountQueryByName = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?Authorization=${encodeURIComponent(client.accountInfo.getAuthToken())}`,
    })
    expect(accountQueryByName.status).toBe(401)
    expect(JSON.parse(await accountQueryByName.text())).toMatchObject({
      code: 'bad_auth_token',
      message: expect.stringContaining('missing authorization token'),
    })

    const directByName = sim.handleDownload(`/file/${bucket.name}/allowed/visible.txt`, {
      Authorization: auth.authorizationToken,
    })
    expect(directByName.status).toBe(200)
    expect(directByName.data).toEqual(new TextEncoder().encode('visible'))

    const directRangeByName = sim.handleDownload(`/file/${bucket.name}/allowed/visible.txt`, {
      Authorization: auth.authorizationToken,
      Range: 'bytes=0-2',
    })
    expect(directRangeByName.status).toBe(206)
    expect(directRangeByName.data).toEqual(new TextEncoder().encode('vis'))

    const accountById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(allowed.fileId)}`,
      headers: { Authorization: client.accountInfo.getAuthToken() },
    })
    expect(accountById.status).toBe(200)
    await expect(accountById.text()).resolves.toBe('visible')

    const directRangeById = sim.handleDownload(
      `/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(allowed.fileId)}`,
      {
        Authorization: client.accountInfo.getAuthToken(),
        Range: 'bytes=0-2',
      },
    )
    expect(directRangeById.status).toBe(206)
    expect(directRangeById.data).toEqual(new TextEncoder().encode('vis'))

    const accountQueryById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(allowed.fileId)}&Authorization=${encodeURIComponent(client.accountInfo.getAuthToken())}`,
    })
    expect(accountQueryById.status).toBe(401)
    expect(JSON.parse(await accountQueryById.text())).toMatchObject({
      code: 'bad_auth_token',
      message: expect.stringContaining('missing authorization token'),
    })

    const downloadAuthById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(allowed.fileId)}`,
      headers: { Authorization: auth.authorizationToken },
    })
    expect(downloadAuthById.status).toBe(403)
    expect(JSON.parse(await downloadAuthById.text())).toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('b2_download_file_by_id'),
    })

    const nonCurrentById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(nonCurrent.fileId)}`,
      headers: { Authorization: auth.authorizationToken },
    })
    expect(nonCurrentById.status).toBe(403)

    const hiddenById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(hidden.fileId)}`,
      headers: { Authorization: auth.authorizationToken },
    })
    expect(hiddenById.status).toBe(403)

    const forgedByName = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${forgedAuthorizationQuery}`,
    })
    expect(forgedByName.status).toBe(401)
    expect(JSON.parse(await forgedByName.text())).toMatchObject({ code: 'bad_auth_token' })

    const forgedById = await transport.send({
      method: 'GET',
      url: `http://localhost:0/b2api/v3/b2_download_file_by_id?fileId=${encodeURIComponent(allowed.fileId)}`,
      headers: { Authorization: forgedToken },
    })
    expect(forgedById.status).toBe(401)
    expect(JSON.parse(await forgedById.text())).toMatchObject({ code: 'bad_auth_token' })

    const wrongPrefix = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/blocked/hidden.txt?${authorizationQuery}`,
    })
    expect(wrongPrefix.status).toBe(403)
    expect(JSON.parse(await wrongPrefix.text())).toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('outside scope'),
    })

    expect(downloadAuthorizationTokenCount(sim)).toBe(1)
    sim.advanceTime(60_000)

    const expired = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${authorizationQuery}`,
    })
    expect(expired.status).toBe(401)
    expect(JSON.parse(await expired.text())).toMatchObject({ code: 'expired_auth_token' })
    expect(downloadAuthorizationTokenCount(sim)).toBe(0)
  })

  it('bounds expired download authorization cleanup during high-volume issuance', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-cleanup',
      bucketType: BucketType.AllPrivate,
    })

    for (let i = 0; i < 150; i++) {
      await bucket.getDownloadAuthorization(`allowed/${i}/`, DOWNLOAD_AUTH_DURATION_MIN_SECONDS)
    }
    expect(downloadAuthorizationTokenCount(sim)).toBe(150)

    sim.advanceTime(DOWNLOAD_AUTH_DURATION_MIN_SECONDS * 1000)

    await bucket.getDownloadAuthorization('allowed/fresh-1/', 60)
    const afterOneIssuance = downloadAuthorizationTokenCount(sim)
    expect(afterOneIssuance).toBeGreaterThan(1)
    expect(afterOneIssuance).toBeLessThan(150)

    await bucket.getDownloadAuthorization('allowed/fresh-2/', 60)
    await bucket.getDownloadAuthorization('allowed/fresh-3/', 60)
    expect(downloadAuthorizationTokenCount(sim)).toBe(3)
  })

  it('rejects malformed download authorization response-header overrides', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-bad-headers',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const getDownloadAuthorization = (request: unknown) =>
      client.raw.getDownloadAuthorization(
        apiUrl,
        authToken,
        request as DownloadAuthorizationRequest,
      )

    await expect(
      getDownloadAuthorization({
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
        b2ContentType: 42,
      }),
    ).rejects.toThrow(/b2ContentType must be a string/)
    await expect(
      getDownloadAuthorization({
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
        b2CacheControl: null,
      }),
    ).rejects.toThrow(/b2CacheControl must be a string/)
    expect(downloadAuthorizationTokenCount(sim)).toBe(0)
  })

  it('enforces download authorization response-header constraints', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-headers',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'allowed/visible.txt',
      source: new BufferSource(new TextEncoder().encode('visible')),
    })
    const auth = await client.raw.getDownloadAuthorization(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: bucket.id,
        fileNamePrefix: 'allowed/',
        validDurationInSeconds: 60,
        b2ContentDisposition: 'attachment; filename="visible.txt"',
        b2ContentType: 'text/plain',
      },
    )
    const transport = sim.transport()

    const matchingParams = new URLSearchParams({
      Authorization: auth.authorizationToken,
      b2ContentDisposition: 'attachment; filename="visible.txt"',
      b2ContentType: 'text/plain',
    })
    const matching = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${matchingParams}`,
    })
    expect(matching.status).toBe(200)
    expect(matching.headers.get('Content-Disposition')).toBe('attachment; filename="visible.txt"')
    expect(matching.headers.get('Content-Type')).toBe('text/plain')
    await expect(matching.text()).resolves.toBe('visible')

    const missingParams = new URLSearchParams({
      Authorization: auth.authorizationToken,
      b2ContentType: 'text/plain',
    })
    const missing = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${missingParams}`,
    })
    expect(missing.status).toBe(403)
    expect(JSON.parse(await missing.text())).toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('b2ContentDisposition'),
    })

    const mismatchedParams = new URLSearchParams({
      Authorization: auth.authorizationToken,
      b2ContentDisposition: 'attachment; filename="visible.txt"',
      b2ContentType: 'application/json',
    })
    const mismatched = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${mismatchedParams}`,
    })
    expect(mismatched.status).toBe(403)
    expect(JSON.parse(await mismatched.text())).toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('b2ContentType'),
    })

    const unconstrained = await bucket.getDownloadAuthorization('allowed/', 60)
    const unexpectedParams = new URLSearchParams({
      Authorization: unconstrained.authorizationToken,
      b2ContentType: 'text/plain',
    })
    const unexpected = await transport.send({
      method: 'GET',
      url: `http://localhost:0/file/${bucket.name}/allowed/visible.txt?${unexpectedParams}`,
    })
    expect(unexpected.status).toBe(200)
    expect(unexpected.headers.get('Content-Type')).toBe('text/plain')
    await expect(unexpected.text()).resolves.toBe('visible')
  })

  it('rejects download authorization durations outside the B2 range', async () => {
    const { client } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-duration',
      bucketType: BucketType.AllPrivate,
    })
    const durationRange = new RegExp(
      `${DOWNLOAD_AUTH_DURATION_MIN_SECONDS} through ${DOWNLOAD_AUTH_DURATION_MAX_SECONDS}`,
    )

    await expect(
      bucket.getDownloadAuthorization('allowed/', DOWNLOAD_AUTH_DURATION_MIN_SECONDS - 1),
    ).rejects.toThrow(durationRange)
    await expect(
      bucket.getDownloadAuthorization('allowed/', DOWNLOAD_AUTH_DURATION_MAX_SECONDS + 1),
    ).rejects.toThrow(durationRange)
    await expect(bucket.getDownloadAuthorization('allowed/', 1.5)).rejects.toThrow(durationRange)
    await expect(
      bucket.getDownloadAuthorization('allowed/', DOWNLOAD_AUTH_DURATION_MIN_SECONDS),
    ).resolves.toMatchObject({ fileNamePrefix: 'allowed/' })
    await expect(
      bucket.getDownloadAuthorization('allowed/', DOWNLOAD_AUTH_DURATION_MAX_SECONDS),
    ).resolves.toMatchObject({ fileNamePrefix: 'allowed/' })
  })

  it('rejects malformed download authorization prefixes', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'download-auth-prefix',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const getDownloadAuthorization = (request: unknown) =>
      client.raw.getDownloadAuthorization(
        apiUrl,
        authToken,
        request as DownloadAuthorizationRequest,
      )
    const prefixError = /fileNamePrefix must be a string/

    await expect(
      getDownloadAuthorization({
        bucketId: bucket.id,
        validDurationInSeconds: 60,
      }),
    ).rejects.toThrow(prefixError)
    await expect(
      getDownloadAuthorization({
        bucketId: bucket.id,
        fileNamePrefix: 42,
        validDurationInSeconds: 60,
      }),
    ).rejects.toThrow(prefixError)
    await expect(
      getDownloadAuthorization({
        bucketId: bucket.id,
        fileNamePrefix: '',
        validDurationInSeconds: 60,
      }),
    ).resolves.toMatchObject({ fileNamePrefix: '' })
    expect(downloadAuthorizationTokenCount(sim)).toBe(1)
  })

  it('handles malformed encoded upload file names during strict auth', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'malformed-upload-name',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'malformed-upload-name-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await scopedClient.raw.getUploadUrl(
      apiUrl,
      authToken,
      { bucketId: bucket.id },
    )

    const resp = await sim.transport().send({
      method: 'POST',
      url: uploadUrl,
      headers: {
        Authorization: authorizationToken,
        'Content-Type': 'application/octet-stream',
        'X-Bz-Content-Sha1': 'do_not_verify',
        'X-Bz-File-Name': 'blocked%zz.txt',
      },
      body: new Uint8Array([1]).buffer,
    })

    expect(resp.status).toBe(403)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('outside scope'),
    })
  })

  it('enforces namePrefix on copy source and destination names', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'prefix-copy-scope',
      bucketType: BucketType.AllPrivate,
    })
    const allowedSource = await bucket.upload({
      fileName: 'allowed/source.txt',
      source: new BufferSource(new TextEncoder().encode('allowed source')),
    })
    const blockedSource = await bucket.upload({
      fileName: 'blocked/source.txt',
      source: new BufferSource(new TextEncoder().encode('blocked source')),
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'prefix-copy-key',
      bucketIds: [bucket.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: blockedSource.fileId,
        fileName: 'allowed/from-blocked.txt',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.copyFile(apiUrl, authToken, {
        sourceFileId: allowedSource.fileId,
        fileName: 'blocked/from-allowed.txt',
      }),
    ).rejects.toThrow(/outside scope/)

    const copy = await scopedClient.raw.copyFile(apiUrl, authToken, {
      sourceFileId: allowedSource.fileId,
      fileName: 'allowed/copy.txt',
    })
    expect(copy.fileName).toBe('allowed/copy.txt')
  })

  it('enforces bucket and namePrefix scope on notification rules', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'notify-scope-a',
      bucketType: BucketType.AllPrivate,
    })
    const blocked = await client.createBucket({
      bucketName: 'notify-scope-b',
      bucketType: BucketType.AllPrivate,
    })
    const key = await client.createKey({
      capabilities: [Capability.ReadBucketNotifications, Capability.WriteBucketNotifications],
      keyName: 'notify-scope-key',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()
    const allowedRule: EventNotificationRule = {
      eventTypes: [EventType.ObjectCreatedAll],
      isEnabled: true,
      isSuspended: false,
      name: 'allowed-rule',
      objectNamePrefix: 'allowed/',
      suspensionReason: '',
      targetConfiguration: { targetType: 'webhook', url: 'https://example.com/allowed' },
    }
    const blockedRule = {
      ...allowedRule,
      name: 'blocked-rule',
      objectNamePrefix: 'blocked/',
    }
    const missingPrefixRule = {
      eventTypes: allowedRule.eventTypes,
      isEnabled: allowedRule.isEnabled,
      isSuspended: allowedRule.isSuspended,
      name: 'missing-prefix-rule',
      suspensionReason: allowedRule.suspensionReason,
      targetConfiguration: allowedRule.targetConfiguration,
    }
    await client.raw.setBucketNotificationRules(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: allowed.id,
        eventNotificationRules: [blockedRule],
      },
    )

    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: blocked.id,
        eventNotificationRules: [allowedRule],
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.getBucketNotificationRules(apiUrl, authToken, { bucketId: allowed.id }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [],
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [allowedRule],
      }),
    ).rejects.toThrow(/outside scope/)
    await client.raw.setBucketNotificationRules(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: allowed.id,
        eventNotificationRules: [],
      },
    )
    await client.raw.setBucketNotificationRules(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: allowed.id,
        eventNotificationRules: [missingPrefixRule as unknown as EventNotificationRule],
      },
    )
    await expect(
      scopedClient.raw.getBucketNotificationRules(apiUrl, authToken, { bucketId: allowed.id }),
    ).rejects.toThrow(/outside scope/)
    await client.raw.setBucketNotificationRules(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      {
        bucketId: allowed.id,
        eventNotificationRules: [],
      },
    )
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [blockedRule],
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.setBucketNotificationRules(apiUrl, authToken, {
        bucketId: allowed.id,
        eventNotificationRules: [allowedRule],
      }),
    ).resolves.toMatchObject({
      bucketId: allowed.id,
      eventNotificationRules: [allowedRule],
    })
    await expect(
      scopedClient.raw.getBucketNotificationRules(apiUrl, authToken, { bucketId: allowed.id }),
    ).resolves.toMatchObject({ bucketId: allowed.id, eventNotificationRules: [allowedRule] })
    await expect(
      scopedClient.raw.getBucketNotificationRules(apiUrl, authToken, { bucketId: blocked.id }),
    ).rejects.toThrow(/scoped to buckets/)
  })

  it('enforces bucket and namePrefix scope on object-lock updates', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()
    const allowed = await client.createBucket({
      bucketName: 'lock-scope-a',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const blocked = await client.createBucket({
      bucketName: 'lock-scope-b',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
    })
    const allowedFile = await allowed.upload({
      fileName: 'allowed/legal.txt',
      source: new BufferSource(new TextEncoder().encode('allowed')),
    })
    const blockedPrefixFile = await allowed.upload({
      fileName: 'blocked/legal.txt',
      source: new BufferSource(new TextEncoder().encode('blocked prefix')),
    })
    const blockedBucketFile = await blocked.upload({
      fileName: 'allowed/legal.txt',
      source: new BufferSource(new TextEncoder().encode('blocked bucket')),
    })
    const key = await client.createKey({
      capabilities: [Capability.WriteFileLegalHolds, Capability.WriteFileRetentions],
      keyName: 'lock-scope-key',
      bucketIds: [allowed.id],
      namePrefix: 'allowed/',
    })
    const scopedClient = await authorizeWithKey(sim, key)
    const apiUrl = scopedClient.accountInfo.getApiUrl()
    const authToken = scopedClient.accountInfo.getAuthToken()

    await expect(
      scopedClient.raw.updateFileLegalHold(apiUrl, authToken, {
        fileId: blockedBucketFile.fileId,
        fileName: blockedBucketFile.fileName,
        legalHold: 'on',
      }),
    ).rejects.toThrow(/scoped to buckets/)
    await expect(
      scopedClient.raw.updateFileLegalHold(apiUrl, authToken, {
        fileId: blockedPrefixFile.fileId,
        fileName: blockedPrefixFile.fileName,
        legalHold: 'on',
      }),
    ).rejects.toThrow(/outside scope/)
    await expect(
      scopedClient.raw.updateFileRetention(apiUrl, authToken, {
        fileId: allowedFile.fileId,
        fileName: allowedFile.fileName,
        fileRetention: { mode: null, retainUntilTimestamp: null },
      }),
    ).resolves.toMatchObject({
      fileId: allowedFile.fileId,
      fileName: allowedFile.fileName,
    })
  })
})

describe('B2Simulator upload authorization tokens', () => {
  const fileBytes = new Uint8Array([1, 2, 3])

  async function expectError(resp: HttpResponse, status: number, code: string): Promise<void> {
    expect(resp.status).toBe(status)
    await expect(resp.json()).resolves.toMatchObject({ code })
  }

  async function wireUploadFile(
    sim: B2Simulator,
    uploadUrl: string,
    authorizationToken?: string,
    fileName = 'wire.txt',
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileBytes.byteLength),
      'X-Bz-Content-Sha1': 'do_not_verify',
      'X-Bz-File-Name': fileName,
    }
    if (authorizationToken !== undefined) headers['Authorization'] = authorizationToken
    return sim.transport().send({
      method: 'POST',
      url: uploadUrl,
      headers,
      body: fileBytes as BodyInit,
    })
  }

  async function wireUploadPart(
    sim: B2Simulator,
    uploadUrl: string,
    authorizationToken?: string,
  ): Promise<HttpResponse> {
    const part = new Uint8Array(1024).fill(7)
    const headers: Record<string, string> = {
      'X-Bz-Part-Number': '1',
      'Content-Length': String(part.byteLength),
      'X-Bz-Content-Sha1': await sha1Hex(part),
    }
    if (authorizationToken !== undefined) headers['Authorization'] = authorizationToken
    return sim.transport().send({
      method: 'POST',
      url: uploadUrl,
      headers,
      body: part as BodyInit,
    })
  }

  function rewritePartUploadTokenPayload(
    authorizationToken: string,
    mutate: (payload: Record<string, unknown>) => void,
  ): string {
    const prefix = 'sim_part_auth_'
    expect(authorizationToken.startsWith(prefix)).toBe(true)
    const [encoded, signature] = authorizationToken.slice(prefix.length).split('.')
    if (encoded === undefined || signature === undefined) {
      throw new Error('unexpected upload token format')
    }
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padding = (4 - (base64.length % 4)) % 4
    const binary = atob(base64.padEnd(base64.length + padding, '='))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    mutate(payload)
    let rewritten = ''
    for (const byte of new TextEncoder().encode(JSON.stringify(payload))) {
      rewritten += String.fromCharCode(byte)
    }
    const rewrittenPayload = btoa(rewritten)
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    return `${prefix}${rewrittenPayload}.${signature}`
  }

  it('accepts issued upload-file and upload-part authorization tokens', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-valid',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()

    const fileUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    const file = await client.raw.uploadFile(
      fileUrl.uploadUrl,
      {
        authorization: fileUrl.authorizationToken,
        fileName: 'valid-file.txt',
        contentType: 'application/octet-stream',
        contentLength: fileBytes.byteLength,
        contentSha1: 'do_not_verify',
      },
      fileBytes as BodyInit,
    )
    expect(file.fileName).toBe('valid-file.txt')

    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'valid-part.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })
    const partBytes = new Uint8Array(1024).fill(8)
    const part = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: partBytes.byteLength,
        contentSha1: await sha1Hex(partBytes),
      },
      partBytes as BodyInit,
    )
    expect(part.fileId).toBe(large.fileId)
    expect(part.partNumber).toBe(1)
  })

  it('rejects upload-part tokens with missing file-name scope', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-part-scope',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'part-scope.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })
    const malformedToken = rewritePartUploadTokenPayload(partUrl.authorizationToken, (payload) => {
      payload['fileName'] = null
    })

    await expectError(
      await wireUploadPart(sim, partUrl.uploadUrl, malformedToken),
      401,
      'bad_auth_token',
    )
  })

  it('classifies upload type from the URL path, not query parameters', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-path-kind',
      bucketType: BucketType.AllPrivate,
    })
    const fileUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    const trickyUrl = `${fileUrl.uploadUrl}&echo=b2_upload_part`

    const resp = await wireUploadFile(sim, trickyUrl, fileUrl.authorizationToken, 'path-kind.txt')

    expect(resp.status).toBe(200)
    await expect(resp.json()).resolves.toMatchObject({ fileName: 'path-kind.txt' })
  })

  it('accepts an issued upload token after simulator replacement in default mode', async () => {
    const first = makeClient()
    await first.client.authorize()
    const bucket = await first.client.createBucket({
      bucketName: 'upload-token-replacement',
      bucketType: BucketType.AllPrivate,
    })
    const fileUrl = await first.client.raw.getUploadUrl(
      first.client.accountInfo.getApiUrl(),
      first.client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )

    const replacement = makeClient()
    await replacement.client.authorize()
    const replacementBucket = await replacement.client.createBucket({
      bucketName: 'upload-token-replacement',
      bucketType: BucketType.AllPrivate,
    })

    expect(replacementBucket.id).toBe(bucket.id)
    const resp = await wireUploadFile(
      replacement.sim,
      fileUrl.uploadUrl,
      fileUrl.authorizationToken,
      'replacement.txt',
    )
    expect(resp.status).toBe(200)
    await expect(resp.json()).resolves.toMatchObject({ fileName: 'replacement.txt' })
  })

  it('rejects missing and wrong upload-file authorization tokens', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-missing',
      bucketType: BucketType.AllPrivate,
    })
    const fileUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )

    await expectError(await wireUploadFile(sim, fileUrl.uploadUrl), 401, 'bad_auth_token')
    await expectError(
      await wireUploadFile(sim, fileUrl.uploadUrl, 'not-an-upload-token'),
      401,
      'bad_auth_token',
    )
  })

  it('invalidates issued upload-file and upload-part tokens', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-invalidate',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const fileUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })

    expect(sim.invalidateUploadToken(fileUrl.authorizationToken)).toBe(true)
    await expectError(
      await wireUploadFile(sim, fileUrl.uploadUrl, fileUrl.authorizationToken),
      401,
      'bad_auth_token',
    )
    expect(sim.invalidateUploadToken('unknown-upload-token')).toBe(false)

    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'invalidated-part.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    expect(sim.invalidateUploadToken(partUrl.authorizationToken)).toBe(true)
    await expectError(
      await wireUploadPart(sim, partUrl.uploadUrl, partUrl.authorizationToken),
      401,
      'bad_auth_token',
    )
  })

  it('rejects upload tokens used with the wrong upload endpoint type', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-kind',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const fileUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'kind-mismatch.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    const resp = await wireUploadPart(sim, partUrl.uploadUrl, fileUrl.authorizationToken)

    expect(resp.status).toBe(401)
    await expect(resp.json()).resolves.toMatchObject({
      code: 'bad_auth_token',
      message: expect.stringContaining('type mismatch'),
    })
  })

  it('rejects upload-file tokens used with another bucket upload URL', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const first = await client.createBucket({
      bucketName: 'upload-token-bucket-a',
      bucketType: BucketType.AllPrivate,
    })
    const second = await client.createBucket({
      bucketName: 'upload-token-bucket-b',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const firstUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: first.id })
    const secondUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: second.id })

    await expectError(
      await wireUploadFile(sim, secondUrl.uploadUrl, firstUrl.authorizationToken),
      401,
      'bad_auth_token',
    )
  })

  it('rejects upload-part tokens used with another large-file upload URL', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-part-url',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const first = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'first-large.bin',
      contentType: 'application/octet-stream',
    })
    const second = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'second-large.bin',
      contentType: 'application/octet-stream',
    })
    const firstUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: first.fileId,
    })
    const secondUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: second.fileId,
    })

    await expectError(
      await wireUploadPart(sim, secondUrl.uploadUrl, firstUrl.authorizationToken),
      401,
      'bad_auth_token',
    )
  })

  it('rejects upload tokens at the exact expiry boundary', async () => {
    const { client, sim } = makeClient({ sim: { authTokenTtlMs: 0 } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-zero-ttl',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const fileUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })

    await expectError(
      await wireUploadFile(sim, fileUrl.uploadUrl, fileUrl.authorizationToken),
      401,
      'expired_auth_token',
    )

    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'zero-ttl-part.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    await expectError(
      await wireUploadPart(sim, partUrl.uploadUrl, partUrl.authorizationToken),
      401,
      'expired_auth_token',
    )
  })

  it('expires upload-file tokens for stale upload URL retry tests', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-stale',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const stale = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })

    expect(sim.expireUploadToken(stale.authorizationToken)).toBe(true)
    await expectError(
      await wireUploadFile(sim, stale.uploadUrl, stale.authorizationToken),
      401,
      'expired_auth_token',
    )

    const fresh = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    const resp = await wireUploadFile(sim, fresh.uploadUrl, fresh.authorizationToken, 'fresh.txt')
    expect(resp.status).toBe(200)
    await expect(resp.json()).resolves.toMatchObject({ fileName: 'fresh.txt' })
  })

  it('expires upload-part tokens for stale part URL retry tests', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-stale-part',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'stale-part.bin',
      contentType: 'application/octet-stream',
    })
    const stale = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    expect(sim.expireUploadToken(stale.authorizationToken)).toBe(true)
    await expectError(
      await wireUploadPart(sim, stale.uploadUrl, stale.authorizationToken),
      401,
      'expired_auth_token',
    )

    const fresh = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })
    const resp = await wireUploadPart(sim, fresh.uploadUrl, fresh.authorizationToken)
    expect(resp.status).toBe(200)
    await expect(resp.json()).resolves.toMatchObject({ fileId: large.fileId, partNumber: 1 })
  })

  it('prunes expired upload tokens during repeated URL issuance', async () => {
    const { client, sim } = makeClient({ sim: { authTokenTtlMs: 60_000 } })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-token-prune',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const expiredFile = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'pruned-part.bin',
      contentType: 'application/octet-stream',
    })
    const expiredPart = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    sim.advanceTime(60_000)
    await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })

    expect(sim.invalidateUploadToken(expiredFile.authorizationToken)).toBe(false)
    expect(sim.invalidateUploadToken(expiredPart.authorizationToken)).toBe(false)

    const active = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    await expect(
      wireUploadFile(sim, active.uploadUrl, active.authorizationToken, 'active-one.txt'),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      wireUploadFile(sim, active.uploadUrl, active.authorizationToken, 'active-two.txt'),
    ).resolves.toMatchObject({ status: 200 })
  })
})

// ---------------------------------------------------------------------------
// Upload write-path validation
// ---------------------------------------------------------------------------

describe('B2Simulator upload write-path validation', () => {
  let sim: B2Simulator
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client, sim } = makeClient({ client: { retry: { maxRetries: 0 } } }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'write-path-validation',
      bucketType: BucketType.AllPrivate,
    })
  })

  async function uploadFileWithContentLength(
    data: Uint8Array,
    contentLength: string,
  ): Promise<HttpResponse> {
    const uploadUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    return sim.transport().send({
      method: 'POST',
      url: uploadUrl.uploadUrl,
      headers: {
        Authorization: uploadUrl.authorizationToken,
        'X-Bz-File-Name': 'length-mismatch.txt',
        'Content-Type': 'application/octet-stream',
        'Content-Length': contentLength,
        'X-Bz-Content-Sha1': await sha1Hex(data),
      },
      body: data as BodyInit,
    })
  }

  async function startPartUpload(fileName: string) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName,
      contentType: 'application/octet-stream',
    })
    const uploadUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: large.fileId,
    })
    return { apiUrl, authToken, large, uploadUrl }
  }

  async function uploadPartWithContentLength(
    uploadUrl: string,
    authorizationToken: string,
    partNumber: number,
    data: Uint8Array,
    contentLength = String(data.byteLength),
  ): Promise<HttpResponse> {
    return sim.transport().send({
      method: 'POST',
      url: uploadUrl,
      headers: {
        Authorization: authorizationToken,
        'X-Bz-Part-Number': String(partNumber),
        'Content-Length': contentLength,
        'X-Bz-Content-Sha1': await sha1Hex(data),
      },
      body: data as BodyInit,
    })
  }

  async function handleUploadFileDirect(
    data: Uint8Array,
    contentLength: string,
  ): Promise<{ status: number; body: unknown }> {
    const uploadUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    return sim.handleUpload(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        'x-bz-file-name': 'direct-length-mismatch.txt',
        'content-type': 'application/octet-stream',
        'Content-Length': contentLength,
        'x-bz-content-sha1': await sha1Hex(data),
      },
      data,
    )
  }

  async function uploadFileWithCustomTimestamp(
    customUploadTimestamp: string,
  ): Promise<HttpResponse> {
    const uploadUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    const data = new Uint8Array([1, 2, 3])
    return sim.transport().send({
      method: 'POST',
      url: uploadUrl.uploadUrl,
      headers: {
        Authorization: uploadUrl.authorizationToken,
        'X-Bz-File-Name': 'custom-timestamp.txt',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.byteLength),
        'X-Bz-Content-Sha1': await sha1Hex(data),
        'X-Bz-Custom-Upload-Timestamp': customUploadTimestamp,
      },
      body: data as BodyInit,
    })
  }

  async function startLargeFileWithCustomTimestamp(
    customUploadTimestamp: unknown,
  ): Promise<HttpResponse> {
    return sim.transport().send({
      method: 'POST',
      url: `${client.accountInfo.getApiUrl()}/b2api/v3/b2_start_large_file`,
      headers: {
        Authorization: client.accountInfo.getAuthToken(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bucketId: bucket.id,
        fileName: 'custom-timestamp-large.bin',
        contentType: 'application/octet-stream',
        customUploadTimestamp,
      }),
    })
  }

  async function handleUploadPartDirect(
    uploadUrl: string,
    authorizationToken: string,
    data: Uint8Array,
    contentLength: string,
  ): Promise<{ status: number; body: unknown }> {
    return sim.handleUpload(
      uploadUrl,
      {
        authorization: authorizationToken,
        'X-Bz-Part-Number': '1',
        'Content-Length': contentLength,
        'x-bz-content-sha1': await sha1Hex(data),
      },
      data,
    )
  }

  it('rejects upload_file and upload_part content-length mismatches', async () => {
    const fileData = new Uint8Array([1, 2, 3])
    const fileResp = await uploadFileWithContentLength(fileData, '4')
    expect(fileResp.status).toBe(400)
    await expect(fileResp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('Content-Length 4 does not match'),
    })

    const { large, uploadUrl } = await startPartUpload('part-length-mismatch.bin')
    const partData = new Uint8Array([4, 5, 6])
    const partResp = await uploadPartWithContentLength(
      uploadUrl.uploadUrl,
      uploadUrl.authorizationToken,
      1,
      partData,
      '2',
    )
    expect(partResp.status).toBe(400)
    await expect(partResp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('Content-Length 2 does not match'),
    })

    const listed = await client.raw.listParts(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: large.fileId },
    )
    expect(listed.parts).toEqual([])
  })

  it('rejects canonical Content-Length mismatches passed directly to handleUpload', async () => {
    const fileData = new Uint8Array([1, 2, 3])
    await expect(handleUploadFileDirect(fileData, '4')).resolves.toMatchObject({
      status: 400,
      body: {
        code: 'bad_request',
        message: expect.stringContaining('Content-Length 4 does not match'),
      },
    })

    const { large, uploadUrl } = await startPartUpload('part-length-mismatch.bin')
    const partData = new Uint8Array([4, 5, 6])
    await expect(
      handleUploadPartDirect(uploadUrl.uploadUrl, uploadUrl.authorizationToken, partData, '2'),
    ).resolves.toMatchObject({
      status: 400,
      body: {
        code: 'bad_request',
        message: expect.stringContaining('Content-Length 2 does not match'),
      },
    })

    const listed = await client.raw.listParts(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: large.fileId },
    )
    expect(listed.parts).toEqual([])
  })

  it('rejects streaming upload bodies as soon as they violate Content-Length', async () => {
    const uploadUrl = await client.raw.getUploadUrl(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    let pullCount = 0
    let canceled = false
    const tooLongStream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1
          controller.enqueue(new Uint8Array([pullCount]))
        },
        cancel() {
          canceled = true
        },
      },
      { highWaterMark: 0 },
    )

    const tooLongResp = await sim.transport().send({
      method: 'POST',
      url: uploadUrl.uploadUrl,
      headers: {
        Authorization: uploadUrl.authorizationToken,
        'X-Bz-File-Name': 'too-long-stream.bin',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1',
        'X-Bz-Content-Sha1': 'do_not_verify',
      },
      body: tooLongStream as BodyInit,
    })

    expect(tooLongResp.status).toBe(400)
    await expect(tooLongResp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'Content-Length 1 does not match request body length 2',
    })
    expect(canceled).toBe(true)
    expect(pullCount).toBeLessThanOrEqual(2)

    const { large, uploadUrl: partUploadUrl } = await startPartUpload('short-stream.bin')
    const shortStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        controller.close()
      },
    })
    const shortResp = await sim.transport().send({
      method: 'POST',
      url: partUploadUrl.uploadUrl,
      headers: {
        Authorization: partUploadUrl.authorizationToken,
        'X-Bz-Part-Number': '1',
        'Content-Length': '2',
        'X-Bz-Content-Sha1': 'do_not_verify',
      },
      body: shortStream as BodyInit,
    })

    expect(shortResp.status).toBe(400)
    await expect(shortResp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'Content-Length 2 does not match request body length 1',
    })
    const listed = await client.raw.listParts(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: large.fileId },
    )
    expect(listed.parts).toEqual([])
  })

  it('rejects out-of-range upload and copy part numbers', async () => {
    const { large, uploadUrl, apiUrl, authToken } = await startPartUpload('bad-part-number.bin')
    const partData = new Uint8Array([7, 8, 9])
    for (const partNumber of [0, 10_001]) {
      const resp = await uploadPartWithContentLength(
        uploadUrl.uploadUrl,
        uploadUrl.authorizationToken,
        partNumber,
        partData,
      )
      expect(resp.status).toBe(400)
      await expect(resp.json()).resolves.toMatchObject({
        code: 'bad_request',
        message: expect.stringContaining('partNumber must be an integer'),
      })
    }

    const source = await bucket.upload({
      fileName: 'copy-part-source.bin',
      source: new BufferSource(new Uint8Array([1, 2, 3, 4])),
    })
    const copyPartResp = await sim.transport().send({
      method: 'POST',
      url: `${apiUrl}/b2api/v3/b2_copy_part`,
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFileId: source.fileId,
        largeFileId: large.fileId,
        partNumber: 10_001,
      }),
    })

    expect(copyPartResp.status).toBe(400)
    await expect(copyPartResp.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('partNumber must be an integer'),
    })
    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
    expect(listed.parts).toEqual([])
  })

  it('reports missing and malformed upload part-number headers clearly', async () => {
    const { large, uploadUrl, apiUrl, authToken } = await startPartUpload('part-number-header.bin')
    const partData = new Uint8Array([1, 2, 3])

    const missing = await sim.transport().send({
      method: 'POST',
      url: uploadUrl.uploadUrl,
      headers: {
        Authorization: uploadUrl.authorizationToken,
        'Content-Length': String(partData.byteLength),
        'X-Bz-Content-Sha1': await sha1Hex(partData),
      },
      body: partData as BodyInit,
    })
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'X-Bz-Part-Number header is required',
    })

    const malformed = await sim.transport().send({
      method: 'POST',
      url: uploadUrl.uploadUrl,
      headers: {
        Authorization: uploadUrl.authorizationToken,
        'X-Bz-Part-Number': 'not-a-number',
        'Content-Length': String(partData.byteLength),
        'X-Bz-Content-Sha1': await sha1Hex(partData),
      },
      body: partData as BodyInit,
    })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'X-Bz-Part-Number must be an integer between 1 and 10000; received not-a-number',
    })

    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
    expect(listed.parts).toEqual([])
  })

  it('classifies malformed and unsatisfiable copyPart ranges distinctly', async () => {
    const source = await bucket.upload({
      fileName: 'copy-part-range-source.bin',
      source: new BufferSource(new TextEncoder().encode('abcdefghij')),
    })
    const { large, apiUrl, authToken } = await startPartUpload('copy-part-range.bin')

    const malformed = await sim.transport().send({
      method: 'POST',
      url: `${apiUrl}/b2api/v3/b2_copy_part`,
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFileId: source.fileId,
        largeFileId: large.fileId,
        partNumber: 1,
        range: 'bytes=abc',
      }),
    })

    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({
      code: 'bad_request',
      message: 'Malformed copy range: bytes=abc',
    })

    const unsatisfiable = await sim.transport().send({
      method: 'POST',
      url: `${apiUrl}/b2api/v3/b2_copy_part`,
      headers: { Authorization: authToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceFileId: source.fileId,
        largeFileId: large.fileId,
        partNumber: 1,
        range: 'bytes=100-200',
      }),
    })

    expect(unsatisfiable.status).toBe(416)
    await expect(unsatisfiable.json()).resolves.toMatchObject({
      code: 'range_not_satisfiable',
      message: 'Unsatisfiable copy range: bytes=100-200',
    })
    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
    expect(listed.parts).toEqual([])
  })

  it('stores monotonic upload timestamps for parts', async () => {
    const { large, uploadUrl, apiUrl, authToken } = await startPartUpload('part-timestamps.bin')
    const firstData = new Uint8Array([1])
    const secondData = new Uint8Array([2])
    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const first = await client.raw.uploadPart(
        uploadUrl.uploadUrl,
        {
          authorization: uploadUrl.authorizationToken,
          partNumber: 1,
          contentLength: firstData.byteLength,
          contentSha1: await sha1Hex(firstData),
        },
        firstData as BodyInit,
      )
      const second = await client.raw.uploadPart(
        uploadUrl.uploadUrl,
        {
          authorization: uploadUrl.authorizationToken,
          partNumber: 2,
          contentLength: secondData.byteLength,
          contentSha1: await sha1Hex(secondData),
        },
        secondData as BodyInit,
      )

      expect(second.uploadTimestamp).toBe(first.uploadTimestamp + 1)
      const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
      expect(listed.parts.map((part) => part.uploadTimestamp)).toEqual([
        first.uploadTimestamp,
        second.uploadTimestamp,
      ])
    } finally {
      dateNow.mockRestore()
    }
  })

  it('returns documented v4 metadata on large-file part responses', async () => {
    const { large, uploadUrl, apiUrl, authToken } = await startPartUpload('part-metadata.bin')
    expect(large).not.toHaveProperty('replicationStatus')
    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'part-metadata.bin',
    })
    expect(unfinished.files[0]?.fileId).toBe(large.fileId)
    expect(unfinished.files[0]).not.toHaveProperty('replicationStatus')

    const partData = new TextEncoder().encode('uploaded part metadata')
    const uploaded = await client.raw.uploadPart(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        partNumber: 1,
        contentLength: partData.byteLength,
        contentSha1: await sha1Hex(partData),
      },
      partData as BodyInit,
    )
    expect(uploaded.contentMd5).toBeNull()

    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: large.fileId })
    expect(listed.parts[0]).toMatchObject({
      contentMd5: null,
      contentSha1: uploaded.contentSha1,
      fileId: large.fileId,
      partNumber: 1,
      serverSideEncryption: { mode: null, algorithm: null },
      uploadTimestamp: uploaded.uploadTimestamp,
    })

    const encryptedLarge = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'encrypted-part-metadata.bin',
      contentType: 'application/octet-stream',
      serverSideEncryption: SSE_B2,
    })
    const encryptedUploadUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: encryptedLarge.fileId,
    })
    const encryptedPartData = new TextEncoder().encode('encrypted listed part metadata')
    const encryptedUploaded = await client.raw.uploadPart(
      encryptedUploadUrl.uploadUrl,
      {
        authorization: encryptedUploadUrl.authorizationToken,
        partNumber: 1,
        contentLength: encryptedPartData.byteLength,
        contentSha1: await sha1Hex(encryptedPartData),
      },
      encryptedPartData as BodyInit,
    )
    const encryptedListed = await client.raw.listParts(apiUrl, authToken, {
      fileId: encryptedLarge.fileId,
    })
    expect(encryptedListed.parts[0]).toMatchObject({
      contentMd5: null,
      contentSha1: encryptedUploaded.contentSha1,
      fileId: encryptedLarge.fileId,
      partNumber: 1,
      serverSideEncryption: SSE_B2,
      uploadTimestamp: encryptedUploaded.uploadTimestamp,
    })

    const source = await bucket.upload({
      fileName: 'copy-part-metadata-source.bin',
      source: new BufferSource(new TextEncoder().encode('copied part metadata')),
    })
    const copyLarge = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'copy-part-metadata-destination.bin',
      contentType: 'application/octet-stream',
    })
    const copied = await client.raw.copyPart(apiUrl, authToken, {
      sourceFileId: source.fileId,
      largeFileId: fileIdOf(copyLarge.fileId),
      partNumber: 1,
    })

    expect(copied).toMatchObject({
      contentMd5: null,
      serverSideEncryption: { mode: null, algorithm: null },
    })
    expect(copied.uploadTimestamp).toEqual(expect.any(Number))
  })

  it('uses uppercase optional replicationStatus on file-returning responses', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const destination = await client.createBucket({
      bucketName: 'replication-status-destination',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.update({
      replicationConfiguration: {
        asReplicationDestination: null,
        asReplicationSource: {
          replicationRules: [
            {
              destinationBucketId: destination.id,
              fileNamePrefix: 'replicated/',
              includeExistingFiles: false,
              isEnabled: true,
              priority: 1,
              replicationRuleName: 'replicated-prefix',
            },
          ],
          sourceApplicationKeyId: applicationKeyId('source-application-key-id'),
        },
      },
    })

    const uncovered = await bucket.upload({
      fileName: 'outside-rule.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    expect(uncovered).not.toHaveProperty('replicationStatus')

    const uploaded = await bucket.upload({
      fileName: 'replicated/small.bin',
      source: new BufferSource(new Uint8Array([2])),
    })
    expect(uploaded.replicationStatus).toBe('PENDING')

    const fileInfo = await client.raw.getFileInfo(apiUrl, authToken, { fileId: uploaded.fileId })
    expect(fileInfo.replicationStatus).toBe('PENDING')

    const names = await bucket.listFileNames({ prefix: 'replicated/small.bin' })
    const listedName = names.files[0]
    expectConcreteListEntry(listedName)
    expect(listedName.replicationStatus).toBe('PENDING')

    const versions = await bucket.listFileVersions({ prefix: 'replicated/small.bin' })
    const listedVersion = versions.files[0]
    expectConcreteListEntry(listedVersion)
    expect(listedVersion.replicationStatus).toBe('PENDING')

    const hidden = await bucket.hideFile('replicated/small.bin')
    expect(hidden).not.toHaveProperty('replicationStatus')

    const hiddenInfo = await client.raw.getFileInfo(apiUrl, authToken, { fileId: hidden.fileId })
    expect(hiddenInfo).not.toHaveProperty('replicationStatus')

    const versionsWithHide = await bucket.listFileVersions({ prefix: 'replicated/small.bin' })
    const hiddenVersion = versionsWithHide.files.find((file) => file.fileId === hidden.fileId)
    expect(hiddenVersion).toBeDefined()
    expect(hiddenVersion).not.toHaveProperty('replicationStatus')

    const coveredLarge = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'replicated/large.bin',
      contentType: 'application/octet-stream',
    })
    expect(coveredLarge.replicationStatus).toBe('PENDING')

    await bucket.update({
      replicationConfiguration: {
        asReplicationDestination: null,
        asReplicationSource: {
          replicationRules: [
            {
              destinationBucketId: destination.id,
              fileNamePrefix: 'replicated/',
              includeExistingFiles: false,
              isEnabled: false,
              priority: 1,
              replicationRuleName: 'replicated-prefix',
            },
          ],
          sourceApplicationKeyId: applicationKeyId('source-application-key-id'),
        },
      },
    })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'replicated/large.bin',
    })
    expect(unfinished.files[0]?.replicationStatus).toBe('PENDING')

    const uploadUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: coveredLarge.fileId,
    })
    const partData = new TextEncoder().encode('replicated large file')
    const partSha1 = await sha1Hex(partData)
    await client.raw.uploadPart(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        partNumber: 1,
        contentLength: partData.byteLength,
        contentSha1: partSha1,
      },
      partData as BodyInit,
    )

    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: coveredLarge.fileId,
      partSha1Array: [partSha1],
    })
    expect(finished.replicationStatus).toBe('PENDING')
  })

  it('stores custom upload timestamps for small and large uploads', async () => {
    ;({ client, sim } = makeClient({
      sim: { customUploadTimestampsEnabled: true },
      client: { retry: { maxRetries: 0 } },
    }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'custom-timestamp-enabled',
      bucketType: BucketType.AllPrivate,
    })
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const smallTimestamp = 1_700_000_000_000
    const largeTimestamp = 1_700_000_000_001
    const smallData = new Uint8Array([1, 2, 3])

    const uploadUrl = await client.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
    const small = await client.raw.uploadFile(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        fileName: 'custom-small.txt',
        contentType: 'application/octet-stream',
        contentLength: smallData.byteLength,
        contentSha1: await sha1Hex(smallData),
        customUploadTimestamp: smallTimestamp,
      },
      smallData as BodyInit,
    )
    expect(small.uploadTimestamp).toBe(smallTimestamp)

    const large = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'custom-large.bin',
      contentType: 'application/octet-stream',
      customUploadTimestamp: String(largeTimestamp),
    })
    expect(large.uploadTimestamp).toBe(largeTimestamp)

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'custom-large.bin',
    })
    expect(unfinished.files[0]?.uploadTimestamp).toBe(largeTimestamp)

    const partData = new Uint8Array([4, 5, 6])
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, { fileId: large.fileId })
    const part = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: partData.byteLength,
        contentSha1: await sha1Hex(partData),
      },
      partData as BodyInit,
    )
    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: large.fileId,
      partSha1Array: [part.contentSha1],
    })
    expect(finished.uploadTimestamp).toBe(largeTimestamp)
  })

  it('rejects custom upload timestamps without account entitlement', async () => {
    const small = await uploadFileWithCustomTimestamp('0')
    expect(small.status).toBe(400)
    await expect(small.json()).resolves.toMatchObject({
      code: 'custom_timestamp_not_allowed',
    })

    const large = await startLargeFileWithCustomTimestamp('0')
    expect(large.status).toBe(400)
    await expect(large.json()).resolves.toMatchObject({
      code: 'custom_timestamp_not_allowed',
    })
  })

  it('rejects unauthorized large-file timestamp backdating before default retention', async () => {
    bucket = await client.createBucket({
      bucketName: 'custom-timestamp-retention-denied',
      bucketType: BucketType.AllPrivate,
      fileLockEnabled: true,
      defaultRetention: {
        mode: BucketRetentionMode.Governance,
        period: { duration: 1, unit: 'days' },
      },
    })

    const rejected = await startLargeFileWithCustomTimestamp('0')
    expect(rejected.status).toBe(400)
    await expect(rejected.json()).resolves.toMatchObject({
      code: 'custom_timestamp_not_allowed',
    })

    const unfinished = await client.raw.listUnfinishedLargeFiles(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { bucketId: bucket.id },
    )
    expect(unfinished.files).toEqual([])

    const { apiUrl, authToken, large, uploadUrl } = await startPartUpload('retained-default.bin')
    const data = new Uint8Array([1])
    const part = await client.raw.uploadPart(
      uploadUrl.uploadUrl,
      {
        authorization: uploadUrl.authorizationToken,
        partNumber: 1,
        contentLength: data.byteLength,
        contentSha1: await sha1Hex(data),
      },
      data,
    )
    const retained = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: large.fileId,
      partSha1Array: [part.contentSha1],
    })
    await expect(
      bucket.deleteFileVersion('retained-default.bin', retained.fileId),
    ).rejects.toMatchObject({ status: 400, code: 'file_lock_governance_protected' })
  })

  it.each([
    ['future', () => Date.now() + 86_400_000],
    ['negative', () => -1],
    ['non-integer', () => 12.5],
    ['non-safe-integer', () => Number.MAX_SAFE_INTEGER + 1],
    ['malformed-string', () => '1e9'],
  ])('rejects %s custom upload timestamps on both write paths', async (_, valueFactory) => {
    ;({ client, sim } = makeClient({
      sim: { customUploadTimestampsEnabled: true },
      client: { retry: { maxRetries: 0 } },
    }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'custom-timestamp-invalid',
      bucketType: BucketType.AllPrivate,
    })
    const value = valueFactory()

    const small = await uploadFileWithCustomTimestamp(String(value))
    expect(small.status).toBe(400)
    await expect(small.json()).resolves.toMatchObject({
      code: 'custom_timestamp_invalid',
    })

    const large = await startLargeFileWithCustomTimestamp(String(value))
    expect(large.status).toBe(400)
    await expect(large.json()).resolves.toMatchObject({
      code: 'custom_timestamp_invalid',
    })
  })

  it('validates future custom upload timestamps against the virtual clock', async () => {
    ;({ client, sim } = makeClient({
      sim: { customUploadTimestampsEnabled: true },
      client: { retry: { maxRetries: 0 } },
    }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'custom-timestamp-virtual-clock',
      bucketType: BucketType.AllPrivate,
    })
    sim.advanceTime(86_400_000)
    const timestamp = Date.now() + 60_000

    const small = await uploadFileWithCustomTimestamp(String(timestamp))
    expect(small.status).toBe(200)
    await expect(small.json()).resolves.toMatchObject({
      uploadTimestamp: timestamp,
    })

    const large = await startLargeFileWithCustomTimestamp(String(timestamp))
    expect(large.status).toBe(200)
    await expect(large.json()).resolves.toMatchObject({
      uploadTimestamp: timestamp,
    })
  })
})

// ---------------------------------------------------------------------------
// Upload integrity: SHA-1 verification (spec: b2_upload_file rejects with
// 400 "Sha1 did not match data received" when the header disagrees with the
// bytes) and fileInfo round-trip.
// ---------------------------------------------------------------------------

describe('B2Simulator server-side encryption fidelity', () => {
  let sim: B2Simulator
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client, sim } = makeClient({ client: { retry: { maxRetries: 0 } } }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'encryption-fidelity',
      bucketType: BucketType.AllPrivate,
    })
  })

  async function rawUpload(
    fileName: string,
    data: Uint8Array,
    contentSha1: string,
    serverSideEncryption?: EncryptionSetting,
  ) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await client.raw.getUploadUrl(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    return client.raw.uploadFile(
      uploadUrl,
      {
        authorization: authorizationToken,
        fileName,
        contentType: 'text/plain',
        contentLength: data.byteLength,
        contentSha1,
        ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
      },
      data as BodyInit,
    )
  }

  async function directSimulatorUpload(
    fileName: string,
    data: Uint8Array,
    extraHeaders: Record<string, string>,
  ) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await client.raw.getUploadUrl(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    return await sim.handleUpload(
      uploadUrl,
      {
        authorization: authorizationToken,
        'x-bz-file-name': fileName,
        'content-type': 'text/plain',
        'content-length': String(data.byteLength),
        'x-bz-content-sha1': await sha1Hex(data),
        ...extraHeaders,
      },
      data,
    )
  }

  async function directSimulatorUploadPart(
    uploadUrl: string,
    authorizationToken: string,
    partNumber: number,
    data: Uint8Array,
    extraHeaders: Record<string, string>,
  ) {
    return await sim.handleUpload(
      uploadUrl,
      {
        authorization: authorizationToken,
        'x-bz-part-number': String(partNumber),
        'content-length': String(data.byteLength),
        'x-bz-content-sha1': await sha1Hex(data),
        ...extraHeaders,
      },
      data,
    )
  }

  async function validSseCustomerSetting(
    fill: number,
  ): Promise<EncryptionSetting & { mode: 'SSE-C' }> {
    const key = await EncryptionKey.fromBytes(new Uint8Array(32).fill(fill))
    return sseCustomer(key.customerKey, key.customerKeyMd5)
  }

  async function rawStartLargeFile(fileName: string, serverSideEncryption?: EncryptionSetting) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    return client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName,
      contentType: 'application/octet-stream',
      ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
    })
  }

  it('returns bucket default encryption in a read-authorized envelope', async () => {
    const defaultNone = {
      isClientAuthorizedToRead: true,
      value: { mode: null, algorithm: null },
    }
    expect(bucket.info.defaultServerSideEncryption).toEqual(defaultNone)

    const sseB2Bucket = await client.createBucket({
      bucketName: 'encryption-fidelity-default-sse-b2',
      bucketType: BucketType.AllPrivate,
      defaultServerSideEncryption: SSE_B2,
    })
    const defaultSseB2 = {
      isClientAuthorizedToRead: true,
      value: SSE_B2,
    }
    expect(sseB2Bucket.info.defaultServerSideEncryption).toEqual(defaultSseB2)

    const listed = await client.listBuckets({ bucketId: sseB2Bucket.id })
    expect(listed[0]?.info.defaultServerSideEncryption).toEqual(defaultSseB2)

    const updated = await sseB2Bucket.update({ defaultServerSideEncryption: SSE_NONE })
    expect(updated.defaultServerSideEncryption).toEqual(defaultNone)
  })

  it('returns B2 null no-encryption shapes from public upload responses', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const small = await rawUpload(
      'no-encryption-small.txt',
      new TextEncoder().encode('plain'),
      await sha1Hex(new TextEncoder().encode('plain')),
    )
    expect(small.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'no-encryption-large.bin',
      contentType: 'application/octet-stream',
    })
    expect(start.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const unfinished = await client.raw.listUnfinishedLargeFiles(apiUrl, authToken, {
      bucketId: bucket.id,
      namePrefix: 'no-encryption-large.bin',
    })
    expect(unfinished.files[0]?.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId,
    })
    const part = new Uint8Array(1024).fill(1)
    const uploadedPart = await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part.byteLength,
        contentSha1: await sha1Hex(part),
      },
      part as BodyInit,
    )
    expect(uploadedPart.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: start.fileId,
      partSha1Array: [uploadedPart.contentSha1],
    })
    expect(finished.serverSideEncryption).toEqual({ mode: null, algorithm: null })

    const listed = await bucket.listFileNames({ prefix: 'no-encryption' })
    expect(
      listed.files.map((file) => {
        expectConcreteListEntry(file)
        return file.serverSideEncryption
      }),
    ).toEqual([
      { mode: null, algorithm: null },
      { mode: null, algorithm: null },
    ])
  })

  it('returns explicit encryption settings from single-file upload responses', async () => {
    const sseB2Data = new TextEncoder().encode('managed key')
    const sseB2 = await rawUpload('sse-b2-small.txt', sseB2Data, await sha1Hex(sseB2Data), SSE_B2)
    expect(sseB2.serverSideEncryption).toEqual(SSE_B2)

    const sseCData = new TextEncoder().encode('customer key')
    const sseCKey = await validSseCustomerSetting(1)
    const sseC = await rawUpload('sse-c-small.txt', sseCData, await sha1Hex(sseCData), sseCKey)
    expect(sseC.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
  })

  it('rejects incomplete SSE-C upload headers', async () => {
    const valid = await validSseCustomerSetting(2)
    const data = new TextEncoder().encode('bad sse-c upload')
    const incomplete: readonly [string, EncryptionSetting][] = [
      [
        'missing-key',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKeyMd5: valid.customerKeyMd5,
        } as EncryptionSetting,
      ],
      [
        'missing-md5',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: valid.customerKey,
        } as EncryptionSetting,
      ],
      [
        'empty-key',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: '',
          customerKeyMd5: valid.customerKeyMd5,
        },
      ],
      [
        'empty-md5',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: valid.customerKey,
          customerKeyMd5: '',
        },
      ],
    ]

    for (const [name, serverSideEncryption] of incomplete) {
      await expect(
        rawUpload(`${name}.txt`, data, await sha1Hex(data), serverSideEncryption),
      ).rejects.toMatchObject({ status: 400 })
    }

    const malformedHeaders: readonly [string, Record<string, string>][] = [
      [
        'missing-algorithm-key',
        {
          'x-bz-server-side-encryption-customer-key': valid.customerKey,
        },
      ],
      [
        'missing-algorithm-md5',
        {
          'x-bz-server-side-encryption-customer-key-md5': valid.customerKeyMd5,
        },
      ],
      [
        'missing-algorithm-key-and-md5',
        {
          'x-bz-server-side-encryption-customer-key': valid.customerKey,
          'x-bz-server-side-encryption-customer-key-md5': valid.customerKeyMd5,
        },
      ],
      [
        'unsupported-algorithm',
        {
          'x-bz-server-side-encryption-customer-algorithm': 'AES512',
          'x-bz-server-side-encryption-customer-key': valid.customerKey,
          'x-bz-server-side-encryption-customer-key-md5': valid.customerKeyMd5,
        },
      ],
    ]

    for (const [name, headers] of malformedHeaders) {
      await expect(directSimulatorUpload(`${name}.txt`, data, headers)).resolves.toMatchObject({
        status: 400,
      })
    }

    await expect(
      directSimulatorUpload('missing-algorithm-message.txt', data, {
        'x-bz-server-side-encryption-customer-key': valid.customerKey,
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { message: 'SSE-C customer algorithm is required' },
    })
  })

  it('rejects oversized SSE-C key and MD5 inputs without decoding them', async () => {
    const valid = await validSseCustomerSetting(3)
    const oversized = 'A'.repeat(65_536)
    const data = new TextEncoder().encode('oversized sse-c input')

    await expect(
      rawUpload('oversized-key.txt', data, await sha1Hex(data), {
        mode: 'SSE-C',
        algorithm: 'AES256',
        customerKey: oversized,
        customerKeyMd5: valid.customerKeyMd5,
      }),
    ).rejects.toMatchObject({ status: 400 })

    await expect(
      rawStartLargeFile('oversized-md5.bin', {
        mode: 'SSE-C',
        algorithm: 'AES256',
        customerKey: valid.customerKey,
        customerKeyMd5: oversized,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects SSE-C upload headers with mismatched MD5', async () => {
    const valid = await validSseCustomerSetting(4)
    const other = await validSseCustomerSetting(5)
    const data = new TextEncoder().encode('bad sse-c upload md5')

    await expect(
      rawUpload('wrong-upload-md5.txt', data, await sha1Hex(data), {
        mode: 'SSE-C',
        algorithm: 'AES256',
        customerKey: valid.customerKey,
        customerKeyMd5: other.customerKeyMd5,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('rejects malformed SSE-C start-large-file settings', async () => {
    const valid = await validSseCustomerSetting(6)
    const other = await validSseCustomerSetting(7)
    const malformed: readonly [string, EncryptionSetting][] = [
      [
        'missing-key',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKeyMd5: valid.customerKeyMd5,
        } as EncryptionSetting,
      ],
      [
        'missing-md5',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: valid.customerKey,
        } as EncryptionSetting,
      ],
      [
        'empty-key',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: '',
          customerKeyMd5: valid.customerKeyMd5,
        },
      ],
      [
        'empty-md5',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: valid.customerKey,
          customerKeyMd5: '',
        },
      ],
      [
        'unsupported-algorithm',
        {
          mode: 'SSE-C',
          algorithm: 'AES512',
          customerKey: valid.customerKey,
          customerKeyMd5: valid.customerKeyMd5,
        } as unknown as EncryptionSetting,
      ],
      [
        'wrong-md5',
        {
          mode: 'SSE-C',
          algorithm: 'AES256',
          customerKey: valid.customerKey,
          customerKeyMd5: other.customerKeyMd5,
        },
      ],
    ]

    for (const [name, serverSideEncryption] of malformed) {
      await expect(rawStartLargeFile(`${name}.bin`, serverSideEncryption)).rejects.toMatchObject({
        status: 400,
      })
    }
    await expect(
      rawStartLargeFile('missing-algorithm-message.bin', {
        mode: 'SSE-C',
        customerKey: valid.customerKey,
        customerKeyMd5: valid.customerKeyMd5,
      } as unknown as EncryptionSetting),
    ).rejects.toMatchObject({
      status: 400,
      message: 'SSE-C customer algorithm is required',
    })
  })

  it('rejects unsupported encryption modes and invalid customer-key fields', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const valid = await validSseCustomerSetting(8)
    const data = new TextEncoder().encode('unsupported encryption modes')
    const source = await rawUpload('unsupported-source.txt', data, await sha1Hex(data))
    const unsupported = {
      mode: 'SSE-CUSTOM',
      algorithm: 'AES256',
    } as unknown as EncryptionSetting

    await expect(
      directSimulatorUpload('unsupported-upload.txt', data, {
        'x-bz-server-side-encryption': 'SSE-CUSTOM',
      }),
    ).resolves.toMatchObject({ status: 400 })
    await expect(
      directSimulatorUpload('sse-b2-upload-extra-key.txt', data, {
        'x-bz-server-side-encryption': 'AES256',
        'x-bz-server-side-encryption-customer-algorithm': 'AES256',
        'x-bz-server-side-encryption-customer-key': valid.customerKey,
        'x-bz-server-side-encryption-customer-key-md5': valid.customerKeyMd5,
      }),
    ).resolves.toMatchObject({ status: 400 })
    await expect(rawStartLargeFile('unsupported-start.bin', unsupported)).rejects.toMatchObject({
      status: 400,
    })
    await expect(
      bucket.copyFile({
        sourceFileId: source.fileId,
        fileName: 'unsupported-copy.txt',
        destinationServerSideEncryption: unsupported,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const started = await rawStartLargeFile('unsupported-copy-part.bin')
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileIdOf(started.fileId),
        partNumber: 1,
        destinationServerSideEncryption: unsupported,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const sseB2WithCustomerKey = {
      ...SSE_B2,
      customerKey: valid.customerKey,
      customerKeyMd5: valid.customerKeyMd5,
    } as unknown as EncryptionSetting
    const noneWithCustomerKey = {
      mode: 'none',
      customerKey: valid.customerKey,
      customerKeyMd5: valid.customerKeyMd5,
    } as unknown as EncryptionSetting
    const nullWithoutAlgorithm = { mode: null } as unknown as EncryptionSetting
    const nullWithExtraField = {
      mode: null,
      algorithm: null,
      extra: 'ignored',
    } as unknown as EncryptionSetting
    const nullWithCustomerKey = {
      mode: null,
      algorithm: null,
      customerKey: valid.customerKey,
      customerKeyMd5: valid.customerKeyMd5,
    } as unknown as EncryptionSetting
    await expect(
      rawStartLargeFile('sse-b2-extra-key.bin', sseB2WithCustomerKey),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      rawStartLargeFile('none-extra-key.bin', noneWithCustomerKey),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      rawStartLargeFile('null-missing-algorithm.bin', nullWithoutAlgorithm),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      rawStartLargeFile('null-extra-field.bin', nullWithExtraField),
    ).rejects.toMatchObject({
      status: 400,
      message: 'No-encryption wire settings must be exactly { mode: null, algorithm: null }',
    })
    await expect(
      bucket.copyFile({
        sourceFileId: source.fileId,
        fileName: 'null-extra-field-copy.txt',
        destinationServerSideEncryption: nullWithExtraField,
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileIdOf(started.fileId),
        partNumber: 2,
        destinationServerSideEncryption: nullWithCustomerKey,
      }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('requires matching SSE-C customer headers to upload large-file parts', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const encryption = await validSseCustomerSetting(9)
    const wrongEncryption = await validSseCustomerSetting(10)
    const started = await rawStartLargeFile('sse-c-parts.bin', encryption)
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: started.fileId,
    })
    const part = new Uint8Array(1024).fill(9)
    const basePartHeaders = {
      authorization: partUrl.authorizationToken,
      partNumber: 1,
      contentLength: part.byteLength,
      contentSha1: await sha1Hex(part),
    }

    await expect(
      client.raw.uploadPart(partUrl.uploadUrl, basePartHeaders, part as BodyInit),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.raw.uploadPart(
        partUrl.uploadUrl,
        { ...basePartHeaders, serverSideEncryption: wrongEncryption },
        part as BodyInit,
      ),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.raw.uploadPart(
        partUrl.uploadUrl,
        { ...basePartHeaders, serverSideEncryption: SSE_B2 },
        part as BodyInit,
      ),
    ).rejects.toMatchObject({ status: 400 })

    const malformedHeaders: readonly [string, Record<string, string>][] = [
      [
        'incomplete',
        {
          'x-bz-server-side-encryption-customer-algorithm': 'AES256',
        },
      ],
      [
        'malformed-key',
        {
          'x-bz-server-side-encryption-customer-algorithm': 'AES256',
          'x-bz-server-side-encryption-customer-key': 'not-base64%%%',
          'x-bz-server-side-encryption-customer-key-md5': encryption.customerKeyMd5,
        },
      ],
      [
        'unsupported-algorithm',
        {
          'x-bz-server-side-encryption-customer-algorithm': 'AES512',
          'x-bz-server-side-encryption-customer-key': encryption.customerKey,
          'x-bz-server-side-encryption-customer-key-md5': encryption.customerKeyMd5,
        },
      ],
    ]
    for (const [, headers] of malformedHeaders) {
      await expect(
        directSimulatorUploadPart(partUrl.uploadUrl, partUrl.authorizationToken, 1, part, headers),
      ).resolves.toMatchObject({ status: 400 })
    }

    const unencryptedStarted = await rawStartLargeFile('plain-parts-with-sse-c-headers.bin')
    const unencryptedPartUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: unencryptedStarted.fileId,
    })
    await expect(
      directSimulatorUploadPart(
        unencryptedPartUrl.uploadUrl,
        unencryptedPartUrl.authorizationToken,
        1,
        part,
        {
          'x-bz-server-side-encryption-customer-algorithm': 'AES256',
          'x-bz-server-side-encryption-customer-key': encryption.customerKey,
          'x-bz-server-side-encryption-customer-key-md5': encryption.customerKeyMd5,
        },
      ),
    ).resolves.toMatchObject({
      status: 400,
      body: { message: 'SSE-C upload part headers require an SSE-C large file' },
    })
    const unencryptedParts = await client.raw.listParts(apiUrl, authToken, {
      fileId: unencryptedStarted.fileId,
    })
    expect(unencryptedParts.parts).toEqual([])

    const beforeMatch = await client.raw.listParts(apiUrl, authToken, { fileId: started.fileId })
    expect(beforeMatch.parts).toEqual([])

    const uploadedPart = await client.raw.uploadPart(
      partUrl.uploadUrl,
      { ...basePartHeaders, serverSideEncryption: encryption },
      part as BodyInit,
    )
    expect(uploadedPart.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })

    const listed = await client.raw.listParts(apiUrl, authToken, { fileId: started.fileId })
    expect(listed.parts).toHaveLength(1)

    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: started.fileId,
      partSha1Array: [uploadedPart.contentSha1],
    })
    expect(finished.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    const downloaded = await bucket.download('sse-c-parts.bin', {
      serverSideEncryption: encryption,
    })
    expect(await readStream(downloaded.body)).toEqual(part)
  })

  it('requires matching SSE-C customer headers to download', async () => {
    const data = new TextEncoder().encode('customer-key protected content')
    const encryption = await validSseCustomerSetting(11)
    const wrongEncryption = await validSseCustomerSetting(12)
    const normalizedEncryption = sseCustomer(
      encryption.customerKey.replace(/=+$/, ''),
      encryption.customerKeyMd5.replace(/=+$/, ''),
    )
    const uploaded = await rawUpload('sse-c-download.txt', data, await sha1Hex(data), encryption)

    expect(uploaded.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    expect(uploaded.serverSideEncryption).not.toHaveProperty('customerKey')
    expect(uploaded.serverSideEncryption).not.toHaveProperty('customerKeyMd5')

    await expect(bucket.download('sse-c-download.txt')).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
    await expect(
      bucket.download('sse-c-download.txt', {
        b2ContentType: 'text/plain',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    })
    await expect(
      bucket.download('sse-c-download.txt', {
        serverSideEncryption: wrongEncryption,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'access_denied' })
    await expect(
      bucket.download('sse-c-download.txt', {
        b2ContentType: 'text/plain',
        serverSideEncryption: wrongEncryption,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'access_denied' })

    const downloaded = await bucket.download('sse-c-download.txt', {
      serverSideEncryption: encryption,
    })
    expect(await readStream(downloaded.body)).toEqual(data)
    const normalizedDownload = await bucket.download('sse-c-download.txt', {
      serverSideEncryption: normalizedEncryption,
    })
    expect(await readStream(normalizedDownload.body)).toEqual(data)

    const info = await client.raw.getFileInfo(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: uploaded.fileId },
    )
    const listed = await bucket.listFileNames({ prefix: 'sse-c-download.txt' })
    const listedFile = listed.files[0]
    expectConcreteListEntry(listedFile)
    expect(info.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    expect(listedFile.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    expect(JSON.stringify([uploaded, info, listed])).not.toContain(encryption.customerKey)
    expect(JSON.stringify([uploaded, info, listed])).not.toContain(encryption.customerKeyMd5)
  })

  it('requires SSE-C source keys for copyFile and uses destination encryption', async () => {
    const data = new TextEncoder().encode('copyFile source key boundary')
    const sourceEncryption = await validSseCustomerSetting(13)
    const wrongSourceEncryption = await validSseCustomerSetting(14)
    const destinationEncryption = await validSseCustomerSetting(15)
    const sseB2Bucket = await client.createBucket({
      bucketName: 'encryption-fidelity-sse-b2',
      bucketType: BucketType.AllPrivate,
      defaultServerSideEncryption: SSE_B2,
    })
    const normalizedSourceEncryption = sseCustomer(
      sourceEncryption.customerKey.replace(/=+$/, ''),
      sourceEncryption.customerKeyMd5.replace(/=+$/, ''),
    )
    const source = await rawUpload(
      'copy-sse-c-source.txt',
      data,
      await sha1Hex(data),
      sourceEncryption,
    )

    await expect(
      bucket.copyFile({
        sourceFileId: source.fileId,
        fileName: 'copy-missing-source-key.txt',
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      bucket.copyFile({
        sourceFileId: source.fileId,
        fileName: 'copy-wrong-source-key.txt',
        sourceServerSideEncryption: wrongSourceEncryption,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const defaultNoneCopy = await bucket.copyFile({
      sourceFileId: source.fileId,
      fileName: 'copy-uses-default-none.txt',
      sourceServerSideEncryption: normalizedSourceEncryption,
    })
    expect(defaultNoneCopy.serverSideEncryption).toEqual({ mode: null, algorithm: null })
    expect(await readStream((await bucket.download('copy-uses-default-none.txt')).body)).toEqual(
      data,
    )

    const defaultSseB2Copy = await bucket.copyFile({
      sourceFileId: source.fileId,
      fileName: 'copy-uses-default-sse-b2.txt',
      destinationBucketId: sseB2Bucket.id,
      sourceServerSideEncryption: sourceEncryption,
    })
    expect(defaultSseB2Copy.serverSideEncryption).toEqual(SSE_B2)
    expect(
      await readStream((await sseB2Bucket.download('copy-uses-default-sse-b2.txt')).body),
    ).toEqual(data)

    const reEncrypted = await bucket.copyFile({
      sourceFileId: source.fileId,
      fileName: 'copy-uses-destination-key.txt',
      sourceServerSideEncryption: sourceEncryption,
      destinationServerSideEncryption: destinationEncryption,
    })
    expect(reEncrypted.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    await expect(
      bucket.download('copy-uses-destination-key.txt', {
        serverSideEncryption: sourceEncryption,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'access_denied' })
    expect(
      await readStream(
        (
          await bucket.download('copy-uses-destination-key.txt', {
            serverSideEncryption: destinationEncryption,
          })
        ).body,
      ),
    ).toEqual(data)

    const publicJson = JSON.stringify([source, defaultNoneCopy, defaultSseB2Copy, reEncrypted])
    expect(publicJson).not.toContain(sourceEncryption.customerKey)
    expect(publicJson).not.toContain(normalizedSourceEncryption.customerKey)
    expect(publicJson).not.toContain(destinationEncryption.customerKey)
  })

  it('requires SSE-C source keys for copyPart into encrypted large files', async () => {
    const data = new TextEncoder().encode('copyPart source key boundary')
    const sourceEncryption = await validSseCustomerSetting(16)
    const wrongSourceEncryption = await validSseCustomerSetting(17)
    const destinationEncryption = await validSseCustomerSetting(18)
    const source = await rawUpload(
      'copy-part-sse-c-source.txt',
      data,
      await sha1Hex(data),
      sourceEncryption,
    )
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const started = await rawStartLargeFile('copy-part-destination.txt', destinationEncryption)

    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileIdOf(started.fileId),
        partNumber: 1,
        destinationServerSideEncryption: destinationEncryption,
      }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      client.raw.copyPart(apiUrl, authToken, {
        sourceFileId: source.fileId,
        largeFileId: fileIdOf(started.fileId),
        partNumber: 1,
        sourceServerSideEncryption: wrongSourceEncryption,
        destinationServerSideEncryption: destinationEncryption,
      }),
    ).rejects.toMatchObject({ status: 400 })

    const part = await client.raw.copyPart(apiUrl, authToken, {
      sourceFileId: source.fileId,
      largeFileId: fileIdOf(started.fileId),
      partNumber: 1,
      sourceServerSideEncryption: sourceEncryption,
      destinationServerSideEncryption: destinationEncryption,
    })
    const finished = await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: started.fileId,
      partSha1Array: [part.contentSha1],
    })

    expect(finished.serverSideEncryption).toEqual({ mode: 'SSE-C', algorithm: 'AES256' })
    await expect(bucket.download('copy-part-destination.txt')).rejects.toMatchObject({
      status: 400,
    })
    expect(
      await readStream(
        (
          await bucket.download('copy-part-destination.txt', {
            serverSideEncryption: destinationEncryption,
          })
        ).body,
      ),
    ).toEqual(data)
    expect(JSON.stringify([source, finished])).not.toContain(sourceEncryption.customerKey)
    expect(JSON.stringify([source, finished])).not.toContain(destinationEncryption.customerKey)
  })
})

describe('B2Simulator upload SHA-1 verification', () => {
  let sim: B2Simulator
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    // maxRetries: 0 so a deliberate 400 surfaces immediately, no backoff.
    ;({ client, sim } = makeClient({ client: { retry: { maxRetries: 0 } } }))
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'sha1-fidelity',
      bucketType: BucketType.AllPrivate,
    })
  })

  /** Upload `data` straight through the raw client with an explicit sha1 header. */
  async function rawUpload(
    fileName: string,
    data: Uint8Array,
    contentSha1: string,
    serverSideEncryption?: EncryptionSetting,
  ) {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const { uploadUrl, authorizationToken } = await client.raw.getUploadUrl(apiUrl, authToken, {
      bucketId: bucket.id,
    })
    return client.raw.uploadFile(
      uploadUrl,
      {
        authorization: authorizationToken,
        fileName,
        contentType: 'text/plain',
        contentLength: data.byteLength,
        contentSha1,
        ...(serverSideEncryption !== undefined ? { serverSideEncryption } : {}),
      },
      data as BodyInit,
    )
  }

  it('rejects an upload whose X-Bz-Content-Sha1 does not match the bytes', async () => {
    const data = new TextEncoder().encode('hello world')
    await expect(rawUpload('mismatch.txt', data, '0'.repeat(40))).rejects.toThrow(
      /Sha1 did not match/i,
    )
  })

  it('accepts an upload whose sha1 matches and stores it', async () => {
    const data = new TextEncoder().encode('verified content')
    const hash = await sha1Hex(data)
    const fv = await rawUpload('match.txt', data, hash)
    expect(fv.contentSha1).toBe(hash)
  })

  it('preserves the synchronous handleDownload API for direct callers', async () => {
    const data = new TextEncoder().encode('direct simulator download')
    await rawUpload('direct-download.txt', data, await sha1Hex(data))

    const result = sim.handleDownload(`/file/${bucket.name}/direct-download.txt`, {})
    expect(result.status).toBe(200)
    expect(result.data).toEqual(data)
  })

  it('skips verification for the do_not_verify sentinel (no stored sha1)', async () => {
    const data = new TextEncoder().encode('unchecked')
    // The simulator stores 'none'; the raw client normalizes that sentinel to null.
    const fv = await rawUpload('skip.txt', data, 'do_not_verify')
    expect(fv.contentSha1).toBeNull()
  })

  it('stores the hash verbatim without verifying for the unverified: prefix', async () => {
    const data = new TextEncoder().encode('claimed but unchecked')
    // A wrong hash behind `unverified:` is accepted as-is (no verification).
    const fv = await rawUpload('unverified.txt', data, `unverified:${'a'.repeat(40)}`)
    expect(fv.contentSha1).toBe('a'.repeat(40))
  })

  it('verifies and strips the trailing digest for hex_digits_at_end', async () => {
    // Trailing-SHA mode: the last 40 bytes are the hex digest, not file content.
    const content = new TextEncoder().encode('trailing sha mode content')
    const digest = await sha1Hex(content)
    const body = new Uint8Array(content.byteLength + 40)
    body.set(content, 0)
    body.set(new TextEncoder().encode(digest), content.byteLength)
    const fv = await rawUpload('trailer.txt', body, 'hex_digits_at_end')
    // Stored length excludes the 40-byte trailer; stored sha1 is the digest.
    expect(fv.contentLength).toBe(content.byteLength)
    expect(fv.contentSha1).toBe(digest)
  })

  it('rejects hex_digits_at_end when the trailing digest does not match', async () => {
    const content = new TextEncoder().encode('bad trailer content')
    const body = new Uint8Array(content.byteLength + 40)
    body.set(content, 0)
    body.set(new TextEncoder().encode('0'.repeat(40)), content.byteLength)
    await expect(rawUpload('bad-trailer.txt', body, 'hex_digits_at_end')).rejects.toThrow(
      /Sha1 did not match/i,
    )
  })

  it('rejects an uploaded part whose sha1 does not match the bytes', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'parts.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId,
    })
    const part = new Uint8Array(1024).fill(7)
    await expect(
      client.raw.uploadPart(
        partUrl.uploadUrl,
        {
          authorization: partUrl.authorizationToken,
          partNumber: 1,
          contentLength: part.byteLength,
          contentSha1: '0'.repeat(40),
        },
        part as BodyInit,
      ),
    ).rejects.toThrow(/Sha1 did not match/i)
  })

  it('rejects finishLargeFile when a partSha1Array entry does not match the uploaded part', async () => {
    const apiUrl = client.accountInfo.getApiUrl()
    const authToken = client.accountInfo.getAuthToken()
    const start = await client.raw.startLargeFile(apiUrl, authToken, {
      bucketId: bucket.id,
      fileName: 'finish-mismatch.bin',
      contentType: 'application/octet-stream',
    })
    const partUrl = await client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: start.fileId,
    })
    const part = new Uint8Array(1024).fill(9)
    await client.raw.uploadPart(
      partUrl.uploadUrl,
      {
        authorization: partUrl.authorizationToken,
        partNumber: 1,
        contentLength: part.byteLength,
        contentSha1: await sha1Hex(part),
      },
      part as BodyInit,
    )
    // The part uploaded fine, but finish supplies the wrong checksum for it.
    await expect(
      client.raw.finishLargeFile(apiUrl, authToken, {
        fileId: start.fileId,
        partSha1Array: ['0'.repeat(40)],
      }),
    ).rejects.toThrow(/does not match the uploaded part/i)
  })
})

describe('B2Simulator upload fileInfo round-trip', () => {
  let client: B2Client
  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
  })

  it('persists custom fileInfo and returns it from getFileInfoByName', async () => {
    const bucket = await client.createBucket({
      bucketName: 'fileinfo-rt',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'meta.txt',
      source: new BufferSource(new TextEncoder().encode('hi')),
      fileInfo: { color: 'blue', purpose: 'test' },
    })
    const info = await bucket.getFileInfoByName('meta.txt')
    expect(info?.fileInfo).toMatchObject({ color: 'blue', purpose: 'test' })
  })

  it('persists fileInfo through a multipart (large-file) upload', async () => {
    // Small recommendedPartSize forces the multipart path (size > part size).
    const { client: mpClient } = makeClient({
      sim: { minimumPartSize: 1024, recommendedPartSize: 1024 },
    })
    await mpClient.authorize()
    const bucket = await mpClient.createBucket({
      bucketName: 'mp-fileinfo',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'big-meta.bin',
      source: new BufferSource(new Uint8Array(3000).fill(1)),
      fileInfo: { kind: 'multipart', owner: 'qa' },
    })
    const info = await bucket.getFileInfoByName('big-meta.bin')
    expect(info?.fileInfo).toMatchObject({ kind: 'multipart', owner: 'qa' })
  })

  it('returns fileInfo via download(), not just getFileInfo', async () => {
    const bucket = await client.createBucket({
      bucketName: 'dl-fileinfo',
      bucketType: BucketType.AllPrivate,
    })
    await bucket.upload({
      fileName: 'dl-meta.txt',
      source: new BufferSource(new TextEncoder().encode('hi')),
      // Value with a space exercises the B2 wire encoding (encodeFileName)
      // round-trip, not just plain alphanumerics.
      fileInfo: { color: 'forest green' },
    })
    const result = await bucket.download('dl-meta.txt')
    await new Response(result.body).arrayBuffer() // drain to release the stream
    expect(result.headers.fileInfo).toMatchObject({ color: 'forest green' })
  })
})

describe('B2Simulator download header encoding', () => {
  it('encodes X-Bz-File-Name with B2 encodeFileName (preserves B2-safe chars)', async () => {
    const { client, sim } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'name-encoding',
      bucketType: BucketType.AllPrivate,
    })
    // '=' and '@' are B2-safe (encodeFileName preserves them); encodeURIComponent
    // would percent-escape them. Assert the raw response header matches B2.
    await bucket.upload({
      fileName: 'release=v1@main.txt',
      source: new BufferSource(new TextEncoder().encode('x')),
    })
    const resp = await sim.transport().send({
      method: 'GET',
      url: 'http://localhost:0/file/name-encoding/release=v1@main.txt',
    })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('X-Bz-File-Name')).toBe('release=v1@main.txt')
  })
})

// ---------------------------------------------------------------------------
// copy_file: metadataDirective (COPY/REPLACE), contentType, fileInfo, range
// ---------------------------------------------------------------------------

describe('B2Simulator copy_file fidelity', () => {
  let client: B2Client
  let bucket: Awaited<ReturnType<B2Client['createBucket']>>

  beforeEach(async () => {
    ;({ client } = makeClient())
    await client.authorize()
    bucket = await client.createBucket({
      bucketName: 'copy-fidelity',
      bucketType: BucketType.AllPrivate,
    })
  })

  /** Upload a 10-byte source file with metadata, return its FileVersion. */
  async function uploadSource(fileName: string) {
    return bucket.upload({
      fileName,
      source: new BufferSource(new TextEncoder().encode('abcdefghij')),
      contentType: 'text/markdown',
      fileInfo: { origin: 'src', tag: 'v1' },
    })
  }

  function rawCopy(req: Parameters<typeof client.raw.copyFile>[2]) {
    return client.raw.copyFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      req,
    )
  }

  it('COPY directive (default) preserves the source contentType and fileInfo', async () => {
    const src = await uploadSource('src-copy.txt')
    const copy = await rawCopy({ sourceFileId: src.fileId, fileName: 'dst-copy.txt' })
    expect(copy.contentType).toBe('text/markdown')
    expect(copy.fileInfo).toMatchObject({ origin: 'src', tag: 'v1' })
    expect(copy.contentLength).toBe(10)
  })

  it('REPLACE directive applies the request contentType and fileInfo', async () => {
    const src = await uploadSource('src-replace.txt')
    const copy = await rawCopy({
      sourceFileId: src.fileId,
      fileName: 'dst-replace.txt',
      metadataDirective: MetadataDirective.Replace,
      contentType: 'application/json',
      fileInfo: { origin: 'replaced', extra: 'yes' },
    })
    expect(copy.contentType).toBe('application/json')
    expect(copy.fileInfo).toMatchObject({ origin: 'replaced', extra: 'yes' })
    expect(copy.fileInfo).not.toHaveProperty('tag') // source's fileInfo not carried over
  })

  it('rejects REPLACE without a contentType (400)', async () => {
    const src = await uploadSource('src-replace-no-type.txt')
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-replace-no-type.txt',
        metadataDirective: MetadataDirective.Replace,
      }),
    ).rejects.toThrow(/contentType is required/i)
  })

  it('copies only the requested byte range and recomputes its sha1', async () => {
    const bytes = new TextEncoder().encode('abcdefghij')
    const src = await bucket.upload({ fileName: 'src-range.txt', source: new BufferSource(bytes) })
    const copy = await rawCopy({
      sourceFileId: src.fileId,
      fileName: 'dst-range.txt',
      range: 'bytes=0-3', // first 4 bytes -> 'abcd'
    })
    expect(copy.contentLength).toBe(4)
    expect(copy.contentSha1).toBe(await sha1Hex(bytes.slice(0, 4)))
    // The stored bytes are the slice, not the whole source.
    const dl = await bucket.download('dst-range.txt')
    const data = new Uint8Array(await new Response(dl.body).arrayBuffer())
    expect(new TextDecoder().decode(data)).toBe('abcd')
  })

  it('rejects an unsatisfiable copy range with 416', async () => {
    const src = await bucket.upload({
      fileName: 'src-badrange.txt',
      source: new BufferSource(new TextEncoder().encode('abc')),
    })
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-badrange.txt',
        range: 'bytes=100-200', // well-formed but past EOF (3 bytes)
      }),
    ).rejects.toThrow(/Unsatisfiable copy range/i)
  })

  it.each(['bytes=abc', 'bytes=5-1', 'bytes=-0'])(
    'rejects a malformed copy range (%s) with 400, not 416',
    async (range) => {
      const src = await bucket.upload({
        fileName: `src-malformed-${range.replace(/[^a-z0-9]/gi, '')}.txt`,
        source: new BufferSource(new TextEncoder().encode('abcdefghij')),
      })
      await expect(
        rawCopy({
          sourceFileId: src.fileId,
          fileName: `dst-${range.replace(/[^a-z0-9]/gi, '')}.txt`,
          range,
        }),
      ).rejects.toThrow(/Malformed copy range/i)
    },
  )

  it('rejects replacement contentType/fileInfo in COPY (default) mode', async () => {
    const src = await uploadSource('src-copy-with-meta.txt')
    // contentType supplied without REPLACE.
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-ct.txt',
        contentType: 'application/json',
      }),
    ).rejects.toThrow(/may only be set when metadataDirective is REPLACE/i)
    // fileInfo supplied without REPLACE.
    await expect(
      rawCopy({ sourceFileId: src.fileId, fileName: 'dst-fi.txt', fileInfo: { a: 'b' } }),
    ).rejects.toThrow(/may only be set when metadataDirective is REPLACE/i)
  })

  it('rejects an unknown metadataDirective', async () => {
    const src = await uploadSource('src-bad-directive.txt')
    await expect(
      rawCopy({
        sourceFileId: src.fileId,
        fileName: 'dst-bad-directive.txt',
        metadataDirective: 'MERGE' as never,
      }),
    ).rejects.toThrow(/Invalid metadataDirective/i)
  })
})
