import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import { BufferSource } from '../streams/source.ts'
import { makeClient } from '../test-utils/index.ts'
import { Capability } from '../types/auth.ts'
import { BucketRetentionMode, BucketType } from '../types/bucket.ts'
import { LegalHoldValue, RetentionMode } from '../types/lock.ts'

describe('simulator small-file Object Lock', () => {
  it.each(['upload', 'copy'] as const)(
    'stores explicit retention and legal hold on %s and refuses deletion',
    async (operation) => {
      const { client } = makeClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: `lock-explicit-${operation}`,
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
      })
      const retention = {
        mode: RetentionMode.Compliance,
        retainUntilTimestamp: Date.now() + 86_400_000,
      }
      const source = new BufferSource(new Uint8Array([1, 2, 3]))
      const result =
        operation === 'upload'
          ? await bucket.upload({
              fileName: 'protected',
              source,
              fileRetention: retention,
              legalHold: LegalHoldValue.On,
            })
          : await client.raw.copyFile(
              client.accountInfo.getApiUrl(),
              client.accountInfo.getAuthToken(),
              {
                sourceFileId: (await bucket.upload({ fileName: 'source', source })).fileId,
                destinationBucketId: bucket.id,
                fileName: 'protected',
                fileRetention: retention,
                legalHold: LegalHoldValue.On,
              },
            )
      const stored = await client.raw.getFileInfo(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { fileId: result.fileId },
      )
      expect(stored.fileRetention.value).toEqual(retention)
      expect(stored.legalHold.value).toBe(LegalHoldValue.On)
      await expect(bucket.deleteFileVersion('protected', result.fileId)).rejects.toMatchObject({
        status: 400,
        code: 'file_lock_legal_hold_protected',
      })
    },
  )

  it.each(['upload', 'copy'] as const)(
    'applies destination default retention on %s and refuses deletion',
    async (operation) => {
      const { client } = makeClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: `lock-default-${operation}`,
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
        defaultRetention: {
          mode: BucketRetentionMode.Compliance,
          period: { duration: 1, unit: 'days' },
        },
      })
      const source = new BufferSource(new Uint8Array([1, 2, 3]))
      const result =
        operation === 'upload'
          ? await bucket.upload({ fileName: 'protected', source })
          : await bucket.copyFile({
              sourceFileId: (await bucket.upload({ fileName: 'source', source })).fileId,
              fileName: 'protected',
            })
      const stored = await client.raw.getFileInfo(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { fileId: result.fileId },
      )
      expect(stored.fileRetention.value).toEqual({
        mode: RetentionMode.Compliance,
        retainUntilTimestamp: result.uploadTimestamp + 86_400_000,
      })
      await expect(bucket.deleteFileVersion('protected', result.fileId)).rejects.toMatchObject({
        status: 400,
        code: 'file_lock_compliance_protected',
      })
    },
  )

  it.each(['upload', 'copy'] as const)(
    'rejects invalid lock settings on %s without creating a version',
    async (operation) => {
      const { client } = makeClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: `lock-invalid-${operation}`,
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
      })
      const source = new BufferSource(new Uint8Array([1]))
      const badHold = 'invalid' as LegalHoldValue
      const action =
        operation === 'upload'
          ? bucket.upload({ fileName: 'invalid', source, legalHold: badHold })
          : client.raw.copyFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
              sourceFileId: (await bucket.upload({ fileName: 'source', source })).fileId,
              destinationBucketId: bucket.id,
              fileName: 'invalid',
              legalHold: badHold,
            })
      await expect(action).rejects.toMatchObject({ status: 400, code: 'bad_request' })
      const listed = await client.raw.listFileNames(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id, prefix: 'invalid' },
      )
      expect(listed.files).toHaveLength(0)
    },
  )

  it.each(['upload', 'copy'] as const)(
    'requires lock-write capabilities for explicit settings on %s',
    async (operation) => {
      const { client, sim } = makeClient({ sim: { strictAuth: true } })
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: `lock-caps-${operation}`,
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
      })
      const source = await bucket.upload({
        fileName: 'source',
        source: new BufferSource(new Uint8Array([1])),
      })
      const key = await client.createKey({
        keyName: `lock-caps-${operation}`,
        bucketId: bucket.id,
        capabilities: [Capability.WriteFiles, Capability.ReadFiles, Capability.ListFiles],
      })
      const restricted = new B2Client({
        applicationKeyId: key.applicationKeyId,
        applicationKey: key.applicationKey,
        transport: sim.transport(),
        retry: { maxRetries: 0 },
      })
      await restricted.authorize()
      const apiUrl = restricted.accountInfo.getApiUrl()
      const authToken = restricted.accountInfo.getAuthToken()
      const url = await restricted.raw.getUploadUrl(apiUrl, authToken, { bucketId: bucket.id })
      const action =
        operation === 'upload'
          ? restricted.raw.uploadFile(
              url.uploadUrl,
              {
                authorization: url.authorizationToken,
                fileName: 'invalid',
                contentType: 'application/octet-stream',
                contentLength: 1,
                contentSha1: 'do_not_verify',
                legalHold: LegalHoldValue.On,
              },
              new Uint8Array([1]),
            )
          : restricted.raw.copyFile(apiUrl, authToken, {
              sourceFileId: source.fileId,
              destinationBucketId: bucket.id,
              fileName: 'invalid',
              legalHold: LegalHoldValue.On,
            })
      await expect(action).rejects.toMatchObject({ status: 403, code: 'unauthorized' })
      const listed = await restricted.raw.listFileNames(apiUrl, authToken, {
        bucketId: bucket.id,
        prefix: 'invalid',
      })
      expect(listed.files).toHaveLength(0)
    },
  )

  it.each(['upload', 'copy'] as const)(
    'rejects malformed retention on %s without creating a version',
    async (operation) => {
      const { client } = makeClient()
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: `lock-ret-invalid-${operation}`,
        bucketType: BucketType.AllPrivate,
        fileLockEnabled: true,
      })
      const source = new BufferSource(new Uint8Array([1]))
      const retention = { mode: RetentionMode.Compliance, retainUntilTimestamp: 1 }
      const action =
        operation === 'upload'
          ? bucket.upload({ fileName: 'invalid', source, fileRetention: retention })
          : client.raw.copyFile(client.accountInfo.getApiUrl(), client.accountInfo.getAuthToken(), {
              sourceFileId: (await bucket.upload({ fileName: 'source', source })).fileId,
              destinationBucketId: bucket.id,
              fileName: 'invalid',
              fileRetention: retention,
            })
      await expect(action).rejects.toMatchObject({ status: 400, code: 'bad_request' })
      const listed = await client.raw.listFileNames(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id, prefix: 'invalid' },
      )
      expect(listed.files).toHaveLength(0)
    },
  )
})
