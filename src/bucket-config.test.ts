import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import { B2Client } from './client.ts'
import type { B2Simulator } from './simulator/index.ts'
import { makeClient } from './test-utils/index.ts'
import { Capability } from './types/auth.ts'
import {
  BucketRetentionMode,
  type BucketRetentionPolicy,
  BucketType,
  type LifecycleRule,
} from './types/bucket.ts'
import { applicationKeyId, bucketId as bucketIdOf } from './types/ids.ts'
import type { ReplicationRule } from './types/replication.ts'

/**
 * Tests for the ergonomic Bucket-configuration helpers added on top of the
 * raw API: replication, lifecycle, and default Object Lock retention. These
 * pair with `bucket.test.ts` which covers the upload/download/listing path;
 * isolating them here keeps each test file focused and avoids inflating the
 * primary bucket spec.
 */

async function makeBucket(
  options: {
    readonly defaultRetention?: BucketRetentionPolicy
    readonly fileLockEnabled?: boolean
  } = {},
): Promise<{ bucket: Bucket; client: B2Client }> {
  const { client } = makeClient()
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'cfg-bucket',
    bucketType: BucketType.AllPrivate,
    ...(options.defaultRetention !== undefined
      ? { defaultRetention: options.defaultRetention }
      : {}),
    ...(options.fileLockEnabled !== undefined ? { fileLockEnabled: options.fileLockEnabled } : {}),
  })
  return { bucket, client }
}

async function authorizeWithKey(
  sim: B2Simulator,
  key: { readonly applicationKeyId: string; readonly applicationKey: string },
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

describe('Bucket.replication helpers', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await makeBucket())
  })

  it('getReplication returns a readable no-config wrapper on a fresh bucket', async () => {
    const config = await bucket.getReplication()
    expect(config).toEqual({ isClientAuthorizedToRead: true, value: null })
  })

  it('setReplication replaces the full config in one call', async () => {
    const sourceKey = applicationKeyId('K-src-1')
    const rule: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-bucket-id'),
      fileNamePrefix: '',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'rule-a',
    }
    const updated = await bucket.setReplication({
      asReplicationSource: {
        sourceApplicationKeyId: sourceKey,
        replicationRules: [rule],
      },
      asReplicationDestination: null,
    })
    expect(
      updated.replicationConfiguration.value?.asReplicationSource?.replicationRules,
    ).toHaveLength(1)
    expect(
      updated.replicationConfiguration.value?.asReplicationSource?.replicationRules[0]
        ?.replicationRuleName,
    ).toBe('rule-a')
  })

  it('addReplicationRule requires sourceApplicationKeyId when none exists yet', async () => {
    const rule: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-1'),
      fileNamePrefix: 'photos/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'photos-rule',
    }
    await expect(bucket.addReplicationRule(rule)).rejects.toThrow(/sourceApplicationKeyId/)
  })

  it('addReplicationRule seeds the source key on first call, reuses on subsequent calls', async () => {
    const sourceKey = applicationKeyId('K-src-1')
    const ruleA: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-1'),
      fileNamePrefix: 'a/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'rule-a',
    }
    const ruleB: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-2'),
      fileNamePrefix: 'b/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 2,
      replicationRuleName: 'rule-b',
    }

    await bucket.addReplicationRule(ruleA, { sourceApplicationKeyId: sourceKey })
    // No source key supplied: the helper must reuse the one B2 returned.
    const after = await bucket.addReplicationRule(ruleB)
    expect(after.replicationConfiguration.value?.asReplicationSource?.sourceApplicationKeyId).toBe(
      sourceKey,
    )
    const names = after.replicationConfiguration.value?.asReplicationSource?.replicationRules.map(
      (r) => r.replicationRuleName,
    )
    expect(names).toEqual(['rule-a', 'rule-b'])
  })

  it('addReplicationRule replaces an existing rule with the same name (idempotent)', async () => {
    const sourceKey = applicationKeyId('K-src-1')
    const first: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-1'),
      fileNamePrefix: 'old/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'rule-a',
    }
    const replacement: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-1'),
      fileNamePrefix: 'new/',
      includeExistingFiles: true,
      isEnabled: false,
      priority: 9,
      replicationRuleName: 'rule-a',
    }
    await bucket.addReplicationRule(first, { sourceApplicationKeyId: sourceKey })
    const after = await bucket.addReplicationRule(replacement)
    expect(
      after.replicationConfiguration.value?.asReplicationSource?.replicationRules,
    ).toHaveLength(1)
    expect(
      after.replicationConfiguration.value?.asReplicationSource?.replicationRules[0]
        ?.fileNamePrefix,
    ).toBe('new/')
    expect(
      after.replicationConfiguration.value?.asReplicationSource?.replicationRules[0]?.isEnabled,
    ).toBe(false)
  })

  it('removeReplicationRule drops the named rule and leaves the rest intact', async () => {
    const sourceKey = applicationKeyId('K-src-1')
    const ruleA: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-1'),
      fileNamePrefix: 'a/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'rule-a',
    }
    const ruleB: ReplicationRule = {
      destinationBucketId: bucketIdOf('dest-2'),
      fileNamePrefix: 'b/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 2,
      replicationRuleName: 'rule-b',
    }
    await bucket.addReplicationRule(ruleA, { sourceApplicationKeyId: sourceKey })
    await bucket.addReplicationRule(ruleB)
    const after = await bucket.removeReplicationRule('rule-a')
    const names = after.replicationConfiguration.value?.asReplicationSource?.replicationRules.map(
      (r) => r.replicationRuleName,
    )
    expect(names).toEqual(['rule-b'])
  })

  it('removeReplicationRule is a no-op when the rule does not exist', async () => {
    const before = await bucket.getReplication()
    const after = await bucket.removeReplicationRule('ghost-rule')
    expect(after.replicationConfiguration.value).toBe(before.value)
  })

  it('fails closed when refreshed replication settings are unreadable', async () => {
    const { client, sim } = makeClient({ sim: { strictAuth: true } })
    await client.authorize()

    const source = await client.createBucket({
      bucketName: 'cfg-repl-source',
      bucketType: BucketType.AllPrivate,
    })
    const destination = await client.createBucket({
      bucketName: 'cfg-repl-destination',
      bucketType: BucketType.AllPrivate,
    })
    const sourceKey = await client.createKey({
      capabilities: [Capability.ReadFiles, Capability.ListFiles],
      keyName: 'cfg-repl-source-key',
      bucketId: source.id,
    })
    const destinationKey = await client.createKey({
      capabilities: [Capability.WriteFiles],
      keyName: 'cfg-repl-destination-key',
      bucketId: destination.id,
    })
    await destination.setReplication({
      asReplicationDestination: {
        sourceToDestinationKeyMapping: {
          [sourceKey.applicationKeyId]: destinationKey.applicationKeyId,
        },
      },
      asReplicationSource: null,
    })

    const existingRule: ReplicationRule = {
      destinationBucketId: destination.id,
      fileNamePrefix: 'existing/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 1,
      replicationRuleName: 'existing-rule',
    }
    await source.setReplication({
      asReplicationSource: {
        sourceApplicationKeyId: sourceKey.applicationKeyId,
        replicationRules: [existingRule],
      },
      asReplicationDestination: null,
    })

    const writerKey = await client.createKey({
      capabilities: [Capability.ListBuckets, Capability.WriteBuckets],
      keyName: 'cfg-repl-writer-no-read',
      bucketIds: null,
    })
    const writerClient = await authorizeWithKey(sim, writerKey)
    const [hiddenBucket] = await writerClient.listBuckets({ bucketId: source.id })
    expect(hiddenBucket).toBeDefined()
    if (hiddenBucket === undefined) throw new Error('expected scoped bucket')
    expect(hiddenBucket.info.replicationConfiguration).toEqual({
      isClientAuthorizedToRead: false,
      value: null,
    })
    await expect(hiddenBucket.getReplication()).resolves.toEqual({
      isClientAuthorizedToRead: false,
      value: null,
    })

    const replacementRule: ReplicationRule = {
      destinationBucketId: destination.id,
      fileNamePrefix: 'replacement/',
      includeExistingFiles: false,
      isEnabled: true,
      priority: 2,
      replicationRuleName: 'replacement-rule',
    }
    await expect(
      hiddenBucket.addReplicationRule(replacementRule, {
        sourceApplicationKeyId: sourceKey.applicationKeyId,
      }),
    ).rejects.toThrow(/readBucketReplications/)
    await expect(hiddenBucket.removeReplicationRule('existing-rule')).rejects.toThrow(
      /readBucketReplications/,
    )

    const [fresh] = await client.listBuckets({ bucketId: source.id })
    expect(fresh).toBeDefined()
    if (fresh === undefined) throw new Error('expected source bucket')
    expect(
      fresh.info.replicationConfiguration.value?.asReplicationSource?.replicationRules.map(
        (rule) => rule.replicationRuleName,
      ),
    ).toEqual(['existing-rule'])
  })
})

describe('Bucket.lifecycle helpers', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await makeBucket())
  })

  it('getLifecycleRules returns an empty array on a fresh bucket', async () => {
    expect(await bucket.getLifecycleRules()).toEqual([])
  })

  it('setLifecycleRules replaces the whole set', async () => {
    const rules: LifecycleRule[] = [
      { daysFromHidingToDeleting: 7, daysFromUploadingToHiding: null, fileNamePrefix: 'tmp/' },
      { daysFromHidingToDeleting: 90, daysFromUploadingToHiding: 365, fileNamePrefix: 'logs/' },
    ]
    const after = await bucket.setLifecycleRules(rules)
    expect(after.lifecycleRules).toEqual(rules)
  })

  it('addLifecycleRule appends a rule with a new prefix', async () => {
    await bucket.addLifecycleRule({
      daysFromHidingToDeleting: 7,
      daysFromUploadingToHiding: null,
      fileNamePrefix: 'tmp/',
    })
    const after = await bucket.addLifecycleRule({
      daysFromHidingToDeleting: 30,
      daysFromUploadingToHiding: 90,
      fileNamePrefix: 'logs/',
    })
    expect(after.lifecycleRules.map((r) => r.fileNamePrefix)).toEqual(['tmp/', 'logs/'])
  })

  it('addLifecycleRule replaces an existing rule with the same prefix (idempotent)', async () => {
    await bucket.addLifecycleRule({
      daysFromHidingToDeleting: 7,
      daysFromUploadingToHiding: null,
      fileNamePrefix: 'tmp/',
    })
    const after = await bucket.addLifecycleRule({
      daysFromHidingToDeleting: 1,
      daysFromUploadingToHiding: 14,
      fileNamePrefix: 'tmp/',
    })
    expect(after.lifecycleRules).toHaveLength(1)
    expect(after.lifecycleRules[0]?.daysFromHidingToDeleting).toBe(1)
    expect(after.lifecycleRules[0]?.daysFromUploadingToHiding).toBe(14)
  })

  it('removeLifecycleRule drops the matching prefix and leaves the rest', async () => {
    await bucket.setLifecycleRules([
      { daysFromHidingToDeleting: 7, daysFromUploadingToHiding: null, fileNamePrefix: 'tmp/' },
      { daysFromHidingToDeleting: 30, daysFromUploadingToHiding: 90, fileNamePrefix: 'logs/' },
    ])
    const after = await bucket.removeLifecycleRule('tmp/')
    expect(after.lifecycleRules.map((r) => r.fileNamePrefix)).toEqual(['logs/'])
  })

  it('removeLifecycleRule is a no-op when the prefix is not present', async () => {
    const after = await bucket.removeLifecycleRule('not-there/')
    expect(after.lifecycleRules).toEqual([])
  })
})

describe('Bucket.defaultRetention helpers', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await makeBucket({ fileLockEnabled: true }))
  })

  it('getDefaultRetention returns B2 unset retention on a fresh bucket', async () => {
    const r = await bucket.getDefaultRetention()
    expect(r).toEqual({ mode: null, period: null })
  })

  it('getDefaultRetention returns a policy configured at bucket creation', async () => {
    const policy = {
      mode: BucketRetentionMode.Compliance,
      period: { duration: 30, unit: 'days' },
    } satisfies BucketRetentionPolicy
    const { bucket: configured } = await makeBucket({
      defaultRetention: policy,
      fileLockEnabled: true,
    })

    await expect(configured.getDefaultRetention()).resolves.toEqual(policy)
  })

  it('setDefaultRetention persists a compliance-mode policy', async () => {
    const after = await bucket.setDefaultRetention({
      mode: BucketRetentionMode.Compliance,
      period: { duration: 30, unit: 'days' },
    })
    expect(after.fileLockConfiguration.value?.defaultRetention.mode).toBe(
      BucketRetentionMode.Compliance,
    )
    expect(after.fileLockConfiguration.value?.defaultRetention.period?.duration).toBe(30)
    expect(after.fileLockConfiguration.value?.defaultRetention.period?.unit).toBe('days')
  })

  it('setDefaultRetention round-trips via getDefaultRetention', async () => {
    await bucket.setDefaultRetention({
      mode: BucketRetentionMode.Governance,
      period: { duration: 7, unit: 'years' },
    })
    const fetched = await bucket.getDefaultRetention()
    expect(fetched).toEqual({
      mode: BucketRetentionMode.Governance,
      period: { duration: 7, unit: 'years' },
    })
  })

  it('setDefaultRetention none returns B2 unset retention', async () => {
    await bucket.setDefaultRetention({
      mode: BucketRetentionMode.None,
      period: null,
    })

    await expect(bucket.getDefaultRetention()).resolves.toEqual({ mode: null, period: null })
  })
})
