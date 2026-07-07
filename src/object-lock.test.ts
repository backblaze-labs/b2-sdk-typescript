import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BufferSource } from './streams/source.ts'
import { daysFromNow } from './test-utils/index.ts'
import { Capability } from './types/auth.ts'
import { BucketType } from './types/bucket.ts'
import { LegalHoldValue, RetentionMode } from './types/lock.ts'

/**
 * Tests for the per-file Object Lock convenience methods added to
 * {@link B2Object}: `setRetention()` and `setLegalHold()`. These are thin
 * delegating wrappers around `Bucket.updateFileRetention` /
 * `Bucket.updateFileLegalHold`, but the wrappers are the only API surface
 * documented as "the way to set retention on a file" so we lock them in.
 */

async function setup(options: { fileLockEnabled?: boolean; strictAuth?: boolean } = {}): Promise<{
  bucket: Bucket
  client: B2Client
  sim: B2Simulator
}> {
  const sim = new B2Simulator(options.strictAuth === true ? { strictAuth: true } : {})
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'lock-bucket',
    bucketType: BucketType.AllPrivate,
    fileLockEnabled: options.fileLockEnabled ?? true,
  })
  return { bucket, client, sim }
}

async function authorizeWithKey(
  sim: B2Simulator,
  key: { applicationKeyId: string; applicationKey: string },
): Promise<B2Client> {
  const client = new B2Client({
    applicationKeyId: key.applicationKeyId,
    applicationKey: key.applicationKey,
    transport: sim.transport(),
  })
  await client.authorize()
  return client
}

describe('B2Object.setRetention', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await setup())
  })

  it('applies a compliance-mode retention policy with a future expiry', async () => {
    const data = new Uint8Array([1, 2, 3])
    const uploaded = await bucket.upload({
      fileName: 'locked.bin',
      source: new BufferSource(data),
    })

    const expiresAt = daysFromNow(30) // 30 days from now
    const result = await bucket.file('locked.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Compliance,
      retainUntilTimestamp: expiresAt,
    })
    expect(result.fileRetention.mode).toBe(RetentionMode.Compliance)
    expect(result.fileRetention.retainUntilTimestamp).toBe(expiresAt)
  })

  it('applies governance-mode retention and accepts the bypassGovernance flag', async () => {
    const uploaded = await bucket.upload({
      fileName: 'gov.bin',
      source: new BufferSource(new Uint8Array([42])),
    })
    const expiresAt = daysFromNow(7)

    await bucket.file('gov.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: expiresAt,
    })

    // Shorten the period: requires bypassGovernance: true with a key that has
    // the matching capability in strict-auth mode.
    const earlier = daysFromNow(1)
    const shortened = await bucket
      .file('gov.bin')
      .setRetention(
        uploaded.fileId,
        { mode: RetentionMode.Governance, retainUntilTimestamp: earlier },
        { bypassGovernance: true },
      )
    expect(shortened.fileRetention.retainUntilTimestamp).toBe(earlier)
  })

  it('clears retention by passing mode null + retainUntilTimestamp null', async () => {
    const uploaded = await bucket.upload({
      fileName: 'clear.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('clear.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: daysFromNow(1),
    })

    const cleared = await bucket
      .file('clear.bin')
      .setRetention(
        uploaded.fileId,
        { mode: null, retainUntilTimestamp: null },
        { bypassGovernance: true },
      )
    expect(cleared.fileRetention.mode).toBeNull()
    expect(cleared.fileRetention.retainUntilTimestamp).toBeNull()
  })
})

describe('B2Object.setLegalHold', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await setup())
  })

  it('turns the legal hold flag on', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const result = await bucket.file('hold.bin').setLegalHold(uploaded.fileId, LegalHoldValue.On)
    expect(result.legalHold).toBe(LegalHoldValue.On)
  })

  it('turns the legal hold flag off', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('hold.bin').setLegalHold(uploaded.fileId, LegalHoldValue.On)
    const off = await bucket.file('hold.bin').setLegalHold(uploaded.fileId, LegalHoldValue.Off)
    expect(off.legalHold).toBe(LegalHoldValue.Off)
  })

  it('legal hold is independent of retention (can be set without retention)', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold-only.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const result = await bucket
      .file('hold-only.bin')
      .setLegalHold(uploaded.fileId, LegalHoldValue.On)
    expect(result.legalHold).toBe(LegalHoldValue.On)
    // Retention should still be unset on this file version.
    const info = await bucket.file('hold-only.bin').getFileInfo(uploaded.fileId)
    expect(info.fileRetention?.value).toBeNull()
  })
})

describe('B2Simulator: update retention and legal hold enforce Object Lock', () => {
  it('rejects retention and legal-hold updates on a lock-disabled bucket', async () => {
    const { bucket } = await setup({ fileLockEnabled: false })
    const uploaded = await bucket.upload({
      fileName: 'plain.bin',
      source: new BufferSource(new Uint8Array([1])),
    })

    await expect(
      bucket.file('plain.bin').setRetention(uploaded.fileId, {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: daysFromNow(1),
      }),
    ).rejects.toThrow(/file lock enabled/)
    await expect(
      bucket.file('plain.bin').setLegalHold(uploaded.fileId, LegalHoldValue.On),
    ).rejects.toThrow(/file lock enabled/)
  })

  it('does not allow compliance-mode retention to be shortened or removed', async () => {
    const { bucket } = await setup()
    const uploaded = await bucket.upload({
      fileName: 'compliance-update.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('compliance-update.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Compliance,
      retainUntilTimestamp: daysFromNow(30),
    })

    await expect(
      bucket.file('compliance-update.bin').setRetention(uploaded.fileId, {
        mode: RetentionMode.Compliance,
        retainUntilTimestamp: daysFromNow(1),
      }),
    ).rejects.toThrow(/Compliance-mode/)
    await expect(
      bucket.file('compliance-update.bin').setRetention(
        uploaded.fileId,
        {
          mode: null,
          retainUntilTimestamp: null,
        },
        { bypassGovernance: true },
      ),
    ).rejects.toThrow(/Compliance-mode/)
  })

  it('requires bypassGovernance to shorten governance-mode retention', async () => {
    const { bucket } = await setup()
    const uploaded = await bucket.upload({
      fileName: 'governance-update.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('governance-update.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: daysFromNow(30),
    })

    await expect(
      bucket.file('governance-update.bin').setRetention(uploaded.fileId, {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: daysFromNow(1),
      }),
    ).rejects.toThrow(/bypassGovernance/)

    const shortened = await bucket.file('governance-update.bin').setRetention(
      uploaded.fileId,
      {
        mode: RetentionMode.Governance,
        retainUntilTimestamp: daysFromNow(1),
      },
      { bypassGovernance: true },
    )
    expect(shortened.fileRetention.mode).toBe(RetentionMode.Governance)
  })

  it('requires the bypassGovernance capability in strict-auth mode', async () => {
    const { bucket, client, sim } = await setup({ strictAuth: true })
    const uploaded = await bucket.upload({
      fileName: 'strict-governance.bin',
      source: new BufferSource(new Uint8Array([1])),
    })

    const withoutBypass = await client.createKey({
      capabilities: [Capability.ListBuckets, Capability.WriteFileRetentions],
      keyName: 'retention-no-bypass',
      bucketId: bucket.id,
    })
    const noBypassClient = await authorizeWithKey(sim, withoutBypass)
    const noBypassBucket = (await noBypassClient.listBuckets({ bucketId: bucket.id }))[0]
    if (noBypassBucket === undefined) throw new Error('scoped bucket not found')

    await noBypassBucket.file('strict-governance.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: daysFromNow(30),
    })

    await expect(
      noBypassBucket.file('strict-governance.bin').setRetention(
        uploaded.fileId,
        {
          mode: RetentionMode.Governance,
          retainUntilTimestamp: daysFromNow(1),
        },
        { bypassGovernance: true },
      ),
    ).rejects.toThrow(/bypassGovernance/)

    const withBypass = await client.createKey({
      capabilities: [
        Capability.ListBuckets,
        Capability.WriteFileRetentions,
        Capability.BypassGovernance,
      ],
      keyName: 'retention-with-bypass',
      bucketId: bucket.id,
    })
    const bypassClient = await authorizeWithKey(sim, withBypass)
    const bypassBucket = (await bypassClient.listBuckets({ bucketId: bucket.id }))[0]
    if (bypassBucket === undefined) throw new Error('scoped bucket not found')

    await expect(
      bypassBucket.file('strict-governance.bin').setRetention(
        uploaded.fileId,
        {
          mode: RetentionMode.Governance,
          retainUntilTimestamp: daysFromNow(1),
        },
        { bypassGovernance: true },
      ),
    ).resolves.toMatchObject({
      fileRetention: { mode: RetentionMode.Governance },
    })
  })

  it('validates legalHold values', async () => {
    const { bucket, client } = await setup()
    const uploaded = await bucket.upload({
      fileName: 'invalid-hold.bin',
      source: new BufferSource(new Uint8Array([1])),
    })

    await expect(
      client.raw.updateFileLegalHold(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        {
          fileName: 'invalid-hold.bin',
          fileId: uploaded.fileId,
          legalHold: 'invalid' as LegalHoldValue,
        },
      ),
    ).rejects.toThrow(/legalHold/)
  })
})

/**
 * Simulator object-lock enforcement on `deleteFileVersion`. Real B2 returns
 * `400 file_lock_*_protected` codes for protected versions; this suite
 * locks the simulator into matching that behaviour so SDK tests no longer
 * silently pass deletes that production would reject.
 */
describe('B2Simulator: deleteFileVersion respects Object Lock', () => {
  let bucket: Bucket

  beforeEach(async () => {
    ;({ bucket } = await setup())
  })

  it('rejects delete of a compliance-mode retained version (no bypass possible)', async () => {
    const uploaded = await bucket.upload({
      fileName: 'compliance.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const expiresAt = daysFromNow(30)
    await bucket.file('compliance.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Compliance,
      retainUntilTimestamp: expiresAt,
    })
    await expect(bucket.deleteFileVersion('compliance.bin', uploaded.fileId)).rejects.toThrow(
      /compliance/,
    )
    // Even passing bypassGovernance must not work for compliance mode.
    await expect(
      bucket.deleteFileVersion('compliance.bin', uploaded.fileId, {
        bypassGovernance: true,
      }),
    ).rejects.toThrow(/compliance/)
  })

  it('rejects delete of a governance-mode retained version without bypass flag', async () => {
    const uploaded = await bucket.upload({
      fileName: 'gov.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const expiresAt = daysFromNow(7)
    await bucket.file('gov.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: expiresAt,
    })
    await expect(bucket.deleteFileVersion('gov.bin', uploaded.fileId)).rejects.toThrow(/governance/)
  })

  it('allows delete of a governance-mode retained version with bypassGovernance: true', async () => {
    const uploaded = await bucket.upload({
      fileName: 'gov-bypass.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const expiresAt = daysFromNow(7)
    await bucket.file('gov-bypass.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: expiresAt,
    })
    await expect(
      bucket.deleteFileVersion('gov-bypass.bin', uploaded.fileId, {
        bypassGovernance: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects delete of a legal-hold-protected version (bypass does not help)', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('hold.bin').setLegalHold(uploaded.fileId, LegalHoldValue.On)
    await expect(bucket.deleteFileVersion('hold.bin', uploaded.fileId)).rejects.toThrow(
      /legal hold/,
    )
    // bypassGovernance is for retention, not legal hold.
    await expect(
      bucket.deleteFileVersion('hold.bin', uploaded.fileId, {
        bypassGovernance: true,
      }),
    ).rejects.toThrow(/legal hold/)
    // Releasing the hold permits the delete.
    await bucket.file('hold.bin').setLegalHold(uploaded.fileId, LegalHoldValue.Off)
    await expect(bucket.deleteFileVersion('hold.bin', uploaded.fileId)).resolves.toBeUndefined()
  })

  it('allows delete of an expired governance-mode retention without bypass', async () => {
    const uploaded = await bucket.upload({
      fileName: 'expired.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    // Retention timestamp in the past — already expired at upload time.
    await bucket.file('expired.bin').setRetention(uploaded.fileId, {
      mode: RetentionMode.Governance,
      retainUntilTimestamp: Date.now() - 1000,
    })
    await expect(bucket.deleteFileVersion('expired.bin', uploaded.fileId)).resolves.toBeUndefined()
  })
})
