import { beforeEach, describe, expect, it } from 'vitest'
import type { Bucket } from './bucket.ts'
import { B2Client } from './client.ts'
import { B2Simulator } from './simulator/index.ts'
import { BufferSource } from './streams/source.ts'

/**
 * Tests for the per-file Object Lock convenience methods added to
 * {@link B2Object}: `setRetention()` and `setLegalHold()`. These are thin
 * delegating wrappers around `Bucket.updateFileRetention` /
 * `Bucket.updateFileLegalHold`, but the wrappers are the only API surface
 * documented as "the way to set retention on a file" so we lock them in.
 */

async function setup(): Promise<{ bucket: Bucket; client: B2Client }> {
  const sim = new B2Simulator()
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  await client.authorize()
  const bucket = await client.createBucket({
    bucketName: 'lock-bucket',
    bucketType: 'allPrivate',
  })
  return { bucket, client }
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

    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days from now
    const result = await bucket
      .file('locked.bin')
      .setRetention(uploaded.fileId, { mode: 'compliance', retainUntilTimestamp: expiresAt })
    expect(result.fileRetention.mode).toBe('compliance')
    expect(result.fileRetention.retainUntilTimestamp).toBe(expiresAt)
  })

  it('applies governance-mode retention and accepts the bypassGovernance flag', async () => {
    const uploaded = await bucket.upload({
      fileName: 'gov.bin',
      source: new BufferSource(new Uint8Array([42])),
    })
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000

    await bucket
      .file('gov.bin')
      .setRetention(uploaded.fileId, { mode: 'governance', retainUntilTimestamp: expiresAt })

    // Shorten the period: requires bypassGovernance: true with a key that has
    // the matching capability. Simulator accepts the flag without enforcing
    // capability so we test the option-forwarding path.
    const earlier = Date.now() + 1 * 24 * 60 * 60 * 1000
    const shortened = await bucket
      .file('gov.bin')
      .setRetention(
        uploaded.fileId,
        { mode: 'governance', retainUntilTimestamp: earlier },
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
      mode: 'governance',
      retainUntilTimestamp: Date.now() + 86_400_000,
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
    const result = await bucket.file('hold.bin').setLegalHold(uploaded.fileId, 'on')
    expect(result.legalHold).toBe('on')
  })

  it('turns the legal hold flag off', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    await bucket.file('hold.bin').setLegalHold(uploaded.fileId, 'on')
    const off = await bucket.file('hold.bin').setLegalHold(uploaded.fileId, 'off')
    expect(off.legalHold).toBe('off')
  })

  it('legal hold is independent of retention (can be set without retention)', async () => {
    const uploaded = await bucket.upload({
      fileName: 'hold-only.bin',
      source: new BufferSource(new Uint8Array([1])),
    })
    const result = await bucket.file('hold-only.bin').setLegalHold(uploaded.fileId, 'on')
    expect(result.legalHold).toBe('on')
    // Retention should still be unset on this file version.
    const info = await bucket.file('hold-only.bin').getFileInfo(uploaded.fileId)
    expect(info.fileRetention?.value).toBeNull()
  })
})
