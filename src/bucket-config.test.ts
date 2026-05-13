import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BucketRetentionMode, BucketType, type LifecycleRule } from './types/bucket.ts'
import { applicationKeyId, bucketId as bucketIdOf } from './types/ids.ts'
import type { ReplicationRule } from './types/replication.ts'

/**
 * Tests for the ergonomic Bucket-configuration helpers added on top of the
 * raw API: replication, lifecycle, and default Object Lock retention. These
 * pair with `bucket.test.ts` which covers the upload/download/listing path;
 * isolating them here keeps each test file focused and avoids inflating the
 * primary bucket spec.
 */

async function makeBucket(): Promise<{ bucket: Bucket; client: B2Client }> {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'cfg-bucket',
    bucketType: BucketType.AllPrivate,
  })
  return { bucket, client }
}

describe('Bucket.replication helpers', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await makeBucket())
  })

  it('getReplication returns a no-config shape on a fresh bucket', async () => {
    const config = await bucket.getReplication()
    expect(config.asReplicationSource).toBeNull()
    expect(config.asReplicationDestination).toBeNull()
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
    expect(updated.replicationConfiguration.asReplicationSource?.replicationRules).toHaveLength(1)
    expect(
      updated.replicationConfiguration.asReplicationSource?.replicationRules[0]
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
    expect(after.replicationConfiguration.asReplicationSource?.sourceApplicationKeyId).toBe(
      sourceKey,
    )
    const names = after.replicationConfiguration.asReplicationSource?.replicationRules.map(
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
    expect(after.replicationConfiguration.asReplicationSource?.replicationRules).toHaveLength(1)
    expect(
      after.replicationConfiguration.asReplicationSource?.replicationRules[0]?.fileNamePrefix,
    ).toBe('new/')
    expect(after.replicationConfiguration.asReplicationSource?.replicationRules[0]?.isEnabled).toBe(
      false,
    )
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
    const names = after.replicationConfiguration.asReplicationSource?.replicationRules.map(
      (r) => r.replicationRuleName,
    )
    expect(names).toEqual(['rule-b'])
  })

  it('removeReplicationRule is a no-op when the rule does not exist', async () => {
    const before = await bucket.getReplication()
    const after = await bucket.removeReplicationRule('ghost-rule')
    expect(after.replicationConfiguration.asReplicationSource).toBe(before.asReplicationSource)
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
    ;({ bucket } = await makeBucket())
  })

  it('getDefaultRetention returns mode "none" on a fresh bucket', async () => {
    const r = await bucket.getDefaultRetention()
    expect(r.mode).toBe('none')
    expect(r.period).toBeNull()
  })

  it('setDefaultRetention persists a compliance-mode policy', async () => {
    const after = await bucket.setDefaultRetention({
      mode: BucketRetentionMode.Compliance,
      period: { duration: 30, unit: 'days' },
    })
    expect(after.defaultRetention.mode).toBe(BucketRetentionMode.Compliance)
    expect(after.defaultRetention.period?.duration).toBe(30)
    expect(after.defaultRetention.period?.unit).toBe('days')
  })

  it('setDefaultRetention round-trips via getDefaultRetention', async () => {
    await bucket.setDefaultRetention({
      mode: BucketRetentionMode.Governance,
      period: { duration: 7, unit: 'years' },
    })
    const fetched = await bucket.getDefaultRetention()
    expect(fetched.mode).toBe(BucketRetentionMode.Governance)
    expect(fetched.period?.duration).toBe(7)
    expect(fetched.period?.unit).toBe('years')
  })
})
