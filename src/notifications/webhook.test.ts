import { describe, expect, it } from 'vitest'
import {
  B2_WEBHOOK_SIGNATURE_HEADER,
  requireValidWebhook,
  verifyWebhookSignature,
  type WebhookPayload,
} from './webhook.ts'

/**
 * Helper: compute B2's webhook signature so each test exercises the same
 * production-path Web Crypto primitives as the verifier. Producing the
 * signature here also locks in the spec ("v1=<lowercase-hex of HMAC-SHA256>")
 * so any drift in the verifier shows up as a test failure rather than as a
 * silent compatibility regression.
 */
async function sign(secret: string, body: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const bytes = new Uint8Array(sig)
  let hex = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return `v1=${hex}`
}

const SECRET = 'super-secret-signing-key-from-b2'

const VALID_PAYLOAD: WebhookPayload = {
  events: [
    {
      accountId: 'acct123',
      bucketId: 'b1',
      bucketName: 'my-bucket',
      eventId: 'evt-1',
      eventTimestamp: 1700000000000,
      eventType: 'b2:ObjectCreated:Upload',
      eventVersion: 1,
      matchedRuleName: 'upload-rule',
      objectName: 'photos/dog.jpg',
      objectSize: 4096,
      objectVersionId: 'v-1',
    },
  ],
}

const VALID_BODY = JSON.stringify(VALID_PAYLOAD)

describe('verifyWebhookSignature', () => {
  it('returns valid + parsed payload when the signature matches', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature,
      secret: SECRET,
    })
    expect(result.valid).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.payload?.events[0]?.objectName).toBe('photos/dog.jpg')
  })

  it('accepts Uint8Array bodies (the fastify / Workers shape)', async () => {
    const raw = new TextEncoder().encode(VALID_BODY)
    const signature = await sign(SECRET, VALID_BODY)
    const result = await verifyWebhookSignature({
      body: raw,
      signature,
      secret: SECRET,
    })
    expect(result.valid).toBe(true)
    expect(result.payload?.events.length).toBe(1)
  })

  it('rejects when the secret is wrong (HMAC mismatch)', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature,
      secret: 'a-different-secret',
    })
    expect(result.valid).toBe(false)
    expect(result.payload).toBeNull()
    expect(result.reason).toBe('signature mismatch')
  })

  it('rejects when even a single body byte is altered after signing', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    // Change a single character in the original body: `.jpg` -> `.png`.
    // The result is still valid JSON of the same length, so any verifier
    // that compares lengths or coarse-grains the body would pass this. Only
    // a byte-exact HMAC catches it.
    const tamperedBody = VALID_BODY.replace('dog.jpg', 'dog.png')
    expect(tamperedBody).not.toBe(VALID_BODY)
    expect(tamperedBody.length).toBe(VALID_BODY.length)
    const result = await verifyWebhookSignature({
      body: tamperedBody,
      signature,
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('signature mismatch')
  })

  it('rejects when the signature header is missing', async () => {
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: undefined,
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('missing signature header')
  })

  it('rejects when the signature header is an empty array', async () => {
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: [],
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('missing signature header')
  })

  it('uses the first non-empty value when the signature header is an array', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: ['', signature, 'v1=deadbeef'],
      secret: SECRET,
    })
    expect(result.valid).toBe(true)
  })

  it('rejects unsupported signature scheme versions', async () => {
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: 'v2=abcdef',
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported signature version')
  })

  it('rejects malformed hex in the signature value (odd length)', async () => {
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: 'v1=abc',
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('bad signature format')
  })

  it('rejects malformed hex in the signature value (non-hex characters)', async () => {
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: 'v1=zzzz',
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('bad signature format')
  })

  it('rejects when the secret is empty', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature,
      secret: '',
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('missing signing secret')
  })

  it('treats the signature as case-insensitive for the hex portion', async () => {
    const lowerSig = await sign(SECRET, VALID_BODY)
    const upperSig = `v1=${lowerSig.slice(3).toUpperCase()}`
    const result = await verifyWebhookSignature({
      body: VALID_BODY,
      signature: upperSig,
      secret: SECRET,
    })
    expect(result.valid).toBe(true)
  })

  it('reports invalid payload shape when the body is valid JSON but not a webhook envelope', async () => {
    const body = JSON.stringify({ not: 'an events array' })
    const signature = await sign(SECRET, body)
    const result = await verifyWebhookSignature({
      body,
      signature,
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('invalid payload shape')
  })

  it('reports invalid payload shape when the body is not JSON at all', async () => {
    const body = 'not json'
    const signature = await sign(SECRET, body)
    const result = await verifyWebhookSignature({
      body,
      signature,
      secret: SECRET,
    })
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('invalid payload shape')
  })

  it('handles a multi-event payload', async () => {
    const payload: WebhookPayload = {
      events: [
        { ...(VALID_PAYLOAD.events[0] as WebhookEventLite), eventId: 'evt-a' },
        { ...(VALID_PAYLOAD.events[0] as WebhookEventLite), eventId: 'evt-b' },
        { ...(VALID_PAYLOAD.events[0] as WebhookEventLite), eventId: 'evt-c' },
      ],
    }
    const body = JSON.stringify(payload)
    const signature = await sign(SECRET, body)
    const result = await verifyWebhookSignature({ body, signature, secret: SECRET })
    expect(result.valid).toBe(true)
    expect(result.payload?.events.length).toBe(3)
    expect(result.payload?.events.map((e) => e.eventId)).toEqual(['evt-a', 'evt-b', 'evt-c'])
  })
})

describe('requireValidWebhook', () => {
  it('returns the payload when verification succeeds', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    const payload = await requireValidWebhook({
      body: VALID_BODY,
      signature,
      secret: SECRET,
    })
    expect(payload.events[0]?.bucketName).toBe('my-bucket')
  })

  it('throws on signature mismatch', async () => {
    const signature = await sign(SECRET, VALID_BODY)
    await expect(
      requireValidWebhook({ body: VALID_BODY, signature, secret: 'wrong' }),
    ).rejects.toThrow(/signature mismatch/)
  })

  it('throws on missing signature header', async () => {
    await expect(
      requireValidWebhook({ body: VALID_BODY, signature: undefined, secret: SECRET }),
    ).rejects.toThrow(/missing signature header/)
  })
})

describe('B2_WEBHOOK_SIGNATURE_HEADER', () => {
  it('is the lowercase canonical form Node uses on req.headers', () => {
    // Locking the constant prevents accidental renames; downstream frameworks
    // (express, Hono, fastify) all normalise header keys to lowercase, so a
    // mixed-case literal would silently miss the header on real deliveries.
    expect(B2_WEBHOOK_SIGNATURE_HEADER).toBe('x-bz-event-notification-signature')
  })
})

// Local alias so the multi-event test stays readable without duplicating
// the full WebhookEvent literal. Marked `Lite` because we don't bother
// constraining the optional fields here.
type WebhookEventLite = (typeof VALID_PAYLOAD.events)[number]
