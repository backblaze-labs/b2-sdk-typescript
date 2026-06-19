import type { EventType } from '../types/notifications.ts'
import { hmacSha256 } from '../util/crypto.ts'
import { utf8Decoder, utf8Encoder } from '../util/text-codec.ts'

/**
 * The HTTP header B2 attaches to every event-notification webhook delivery.
 * The value is a versioned HMAC-SHA256 signature of the raw request body:
 * `v1=<lowercase-hex>`.
 *
 * The lowercase form matches Node's `req.headers` normalisation and most
 * server-framework conventions. Producers must compare case-insensitively.
 */
export const B2_WEBHOOK_SIGNATURE_HEADER = 'x-bz-event-notification-signature'

/** Current B2 event-notification signature scheme prefix. */
const SIGNATURE_VERSION_PREFIX = 'v1='

/**
 * A single event entry inside a B2 webhook payload.
 *
 * The `events` array on the parsed body contains zero or more of these. Most
 * deliveries hold a single event, but B2 may coalesce multiple events from the
 * same bucket into one delivery for efficiency, so callers should iterate.
 *
 * @see https://www.backblaze.com/apidocs/event-notifications-overview
 */
export interface WebhookEvent {
  /** Account that owns the bucket the event fired on. */
  readonly accountId: string
  /** Bucket ID the event fired on. */
  readonly bucketId: string
  /** Bucket name at the moment the event fired. */
  readonly bucketName: string
  /** Globally unique event identifier (useful for idempotency on the receiver). */
  readonly eventId: string
  /** Event time in UNIX milliseconds (UTC). */
  readonly eventTimestamp: number
  /** Specific event type, e.g. `'b2:ObjectCreated:Upload'`. */
  readonly eventType: EventType
  /** Schema version of the event payload. Currently `1`. */
  readonly eventVersion: number
  /** Name of the `EventNotificationRule` on the bucket that matched. */
  readonly matchedRuleName: string
  /** B2 file name of the affected object. */
  readonly objectName: string
  /** Affected object's size in bytes, when present (absent for some delete events). */
  readonly objectSize?: number
  /** Specific file version ID, when applicable. */
  readonly objectVersionId?: string
}

/**
 * The complete JSON body B2 POSTs to a webhook endpoint after signature
 * verification succeeds. See {@link verifyWebhookSignature}.
 */
export interface WebhookPayload {
  /** One or more event entries. Always non-empty on real deliveries. */
  readonly events: readonly WebhookEvent[]
}

/**
 * Options for {@link verifyWebhookSignature} and {@link requireValidWebhook}.
 */
export interface VerifyWebhookOptions {
  /**
   * The raw request body B2 sent. MUST be the exact bytes received: any
   * JSON re-serialisation or whitespace normalisation will break the HMAC.
   *
   * Pass a `Uint8Array` whenever the surrounding framework gives you raw
   * bytes (e.g. `req.rawBody` in fastify, `req.arrayBuffer()` in Hono /
   * Workers). The string overload is provided for convenience when a
   * framework already decoded the body as UTF-8.
   */
  readonly body: string | Uint8Array
  /**
   * Value of the {@link B2_WEBHOOK_SIGNATURE_HEADER} header.
   *
   * Accepts a single string or an array (Node's `req.headers` returns
   * `string | string[] | undefined`). When an array is supplied, the first
   * non-empty element is used: B2 only ever sends one value, and rejecting
   * the multi-value case prevents callers from accidentally trusting a
   * spoofed second header injected by a buggy reverse proxy.
   */
  readonly signature: string | readonly string[] | undefined
  /**
   * The signing secret from `EventNotificationRule.targetConfiguration.hmacSha256SigningSecret`.
   *
   * This is the exact string B2 returned in the `b2_set_bucket_notification_rules`
   * response. Do NOT base64-decode or otherwise transform it.
   */
  readonly secret: string
}

/**
 * Outcome of {@link verifyWebhookSignature}.
 *
 * The verifier never throws; instead it returns a discriminated result so
 * callers can branch on `valid` and log `reason` without try/catch noise.
 * Use {@link requireValidWebhook} when an exception-based control flow is
 * more convenient.
 */
export interface VerifyWebhookResult {
  /** `true` only when the HMAC matched and the body parsed as a valid payload. */
  readonly valid: boolean
  /** Parsed payload when {@link valid} is `true`; otherwise `null`. */
  readonly payload: WebhookPayload | null
  /** Short reason describing why verification failed, or `null` on success. */
  readonly reason: string | null
}

/**
 * Constant-time comparison of two equal-length byte sequences.
 *
 * Web Crypto exposes no native timing-safe compare, so we do the standard
 * XOR-and-OR pattern ourselves. The early-out on length mismatch is fine
 * here because the signature length is publicly fixed (32 bytes for
 * HMAC-SHA256), so a length-mismatch branch leaks nothing about the secret.
 *
 * @param a - First byte sequence.
 * @param b - Second byte sequence.
 *
 * @returns `true` if the byte sequences are byte-for-byte equal.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) {
    // Non-null asserted: `a` and `b` have the same length and `i` is in range.
    diff |= (a[i] as number) ^ (b[i] as number)
  }
  return diff === 0
}

/**
 * Decode a lowercase hex string into bytes. Returns `null` on any malformed
 * input (odd length, non-hex characters). We don't surface a thrown error
 * because all malformed signatures should land in the same
 * `reason: 'bad signature format'` bucket on the verifier's caller,
 * regardless of which specific malformation triggered it.
 *
 * @param hex - The lowercase hex string to decode.
 *
 * @returns The decoded bytes, or `null` if the input was not valid hex.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.byteLength; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

/**
 * Pick the single signature string from {@link VerifyWebhookOptions.signature}.
 * Returns `null` if absent, empty, or supplied as an empty array.
 *
 * @param raw - The signature value as supplied by the caller.
 *
 * @returns The chosen signature string, or `null` if no candidate was usable.
 */
function pickSignature(raw: VerifyWebhookOptions['signature']): string | null {
  if (raw === undefined) return null
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string' && v.length > 0) return v
    }
    return null
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * Encode a UTF-8 string into bytes using a shared encoder.
 *
 * @param s - The string to encode.
 *
 * @returns The UTF-8 encoded bytes.
 */
function bytes(s: string): Uint8Array {
  return utf8Encoder.encode(s)
}

/**
 * Normalise the body parameter to a `Uint8Array` view of its raw bytes.
 *
 * Strings are UTF-8 encoded. `Uint8Array` inputs pass through untouched.
 *
 * @param body - The raw request body as supplied by the caller.
 *
 * @returns The body as a byte sequence ready for HMAC computation.
 */
function bodyBytes(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? bytes(body) : body
}

/**
 * Best-effort JSON parse that returns `null` on failure. We accept partial
 * structural mismatches (no `events` array etc.) at the caller's discretion.
 *
 * @param raw - The decoded request body string.
 *
 * @returns The parsed payload, or `null` if `raw` is not valid JSON.
 */
function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Narrow `value` to {@link WebhookPayload}. Currently only checks that
 * `events` is an array; per-event validation is the caller's responsibility
 * since B2 may add new optional fields and we don't want to reject deliveries
 * that include them.
 *
 * @param value - The parsed JSON value to validate.
 *
 * @returns `true` if the value matches the {@link WebhookPayload} shape.
 */
function looksLikePayload(value: unknown): value is WebhookPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { events?: unknown }).events)
  )
}

/**
 * Verify the HMAC-SHA256 signature B2 attaches to event-notification webhooks
 * and parse the body on success.
 *
 * Never throws: returns a discriminated {@link VerifyWebhookResult}. Use this
 * when you want a single, explicit place to branch on `valid` and log the
 * `reason` on rejection.
 *
 * @param opts - The body, signature header, and signing secret. See {@link VerifyWebhookOptions}.
 *
 * @returns Verification result with optional parsed payload and failure reason.
 *
 * @example
 * ```ts
 * import { verifyWebhookSignature, B2_WEBHOOK_SIGNATURE_HEADER } from '@backblaze-labs/b2-sdk/notifications'
 *
 * app.post('/webhook', async (req, res) => {
 *   const raw = await readRawBody(req) // raw bytes, NOT json
 *   const result = await verifyWebhookSignature({
 *     body: raw,
 *     signature: req.headers[B2_WEBHOOK_SIGNATURE_HEADER],
 *     secret: process.env.B2_WEBHOOK_SECRET,
 *   })
 *   if (!result.valid) return res.status(401).send(result.reason)
 *   for (const event of result.payload.events) handleEvent(event)
 *   res.status(204).end()
 * })
 * ```
 *
 */
export async function verifyWebhookSignature(
  opts: VerifyWebhookOptions,
): Promise<VerifyWebhookResult> {
  if (typeof opts.secret !== 'string' || opts.secret.length === 0) {
    return { valid: false, payload: null, reason: 'missing signing secret' }
  }

  const signature = pickSignature(opts.signature)
  if (signature === null) {
    return { valid: false, payload: null, reason: 'missing signature header' }
  }

  if (!signature.startsWith(SIGNATURE_VERSION_PREFIX)) {
    return { valid: false, payload: null, reason: 'unsupported signature version' }
  }

  const claimed = hexToBytes(signature.slice(SIGNATURE_VERSION_PREFIX.length).toLowerCase())
  if (claimed === null) {
    return { valid: false, payload: null, reason: 'bad signature format' }
  }

  const raw = bodyBytes(opts.body)
  const expected = await hmacSha256(opts.secret, raw)

  if (!timingSafeEqual(claimed, expected)) {
    return { valid: false, payload: null, reason: 'signature mismatch' }
  }

  const decoded = typeof opts.body === 'string' ? opts.body : utf8Decoder.decode(raw)
  const parsed = tryParse(decoded)
  if (!looksLikePayload(parsed)) {
    return { valid: false, payload: null, reason: 'invalid payload shape' }
  }

  return { valid: true, payload: parsed, reason: null }
}

/**
 * Throwing wrapper around {@link verifyWebhookSignature}. Returns the parsed
 * payload on success; throws an `Error` whose message is the verifier's
 * `reason` string on any failure.
 *
 * Useful when you want the verification to integrate with your framework's
 * existing error-handling middleware rather than handling the result inline.
 *
 * @param opts - The body, signature header, and signing secret. See {@link VerifyWebhookOptions}.
 *
 * @returns The parsed webhook payload.
 *
 * @throws When verification fails for any reason.
 */
export async function requireValidWebhook(opts: VerifyWebhookOptions): Promise<WebhookPayload> {
  const result = await verifyWebhookSignature(opts)
  if (!result.valid || result.payload === null) {
    throw new Error(`B2 webhook verification failed: ${result.reason ?? 'unknown'}`)
  }
  return result.payload
}
