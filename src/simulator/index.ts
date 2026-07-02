/**
 * In-memory B2 simulator for testing without network I/O.
 *
 * {@link B2Simulator} implements 25+ B2 native API operations at the
 * request/response level. Create a simulator, call {@link B2Simulator.transport}
 * to get an {@link HttpTransport}, and pass it to `B2Client`. Ideal for
 * unit tests, CI pipelines, and local development.
 *
 * @packageDocumentation
 */

import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { encodeFileName } from '../raw/encoding.ts'
import { sha1Hex } from '../streams/hash.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { type BucketInfo, BucketRetentionMode, type BucketType } from '../types/bucket.ts'
import {
  EncryptionAlgorithm,
  EncryptionMode,
  type EncryptionSetting,
  type PublicEncryptionSetting,
} from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import {
  type AuthToken,
  accountId as accountIdOf,
  type BucketId,
  bucketId as bucketIdOf,
  fileId as fileIdOf,
} from '../types/ids.ts'
import type { FileRetentionValue, LegalHoldValue, RetentionMode } from '../types/lock.ts'
import type { EventNotificationRule } from '../types/notifications.ts'
import { utf8Decoder, utf8Encoder } from '../util/text-codec.ts'
import { toError } from '../util/to-error.ts'

/**
 * Result of {@link parseRangeHeader}. `'ok'` is satisfiable,
 * `'unsatisfiable'` is well-formed but cannot be served (e.g. range
 * against an empty file, or a start offset at or past EOF), and
 * `'malformed'` means the header could not be parsed at all and is
 * ignored (RFC 7233 §3.1 allows servers to treat malformed headers as
 * absent). Real B2 returns `416 Range Not Satisfiable` for the
 * `'unsatisfiable'` case.
 */
type RangeParseResult =
  | { kind: 'ok'; start: number; end: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'malformed' }

/**
 * Parse an RFC 7233 `Range` header value into inclusive start/end byte
 * offsets clamped to the file size. Supports closed (`bytes=0-999`),
 * open-ended (`bytes=1000-`), and suffix (`bytes=-500`) forms.
 *
 * @param header - The raw header value (e.g. `'bytes=0-999'`).
 * @param totalSize - The full file size in bytes (for clamping + suffix).
 *
 * @returns A {@link RangeParseResult} tagged with how the simulator
 *   should respond: serve the range, send 416, or ignore the header.
 *
 * @see https://www.rfc-editor.org/rfc/rfc7233#section-2.1
 */
function parseRangeHeader(header: string, totalSize: number): RangeParseResult {
  const m = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!m) return { kind: 'malformed' }
  const [, startStr, endStr] = m
  const hasStart = startStr !== ''
  const hasEnd = endStr !== ''
  if (!hasStart && !hasEnd) return { kind: 'malformed' }

  // Empty file with any well-formed range request is unsatisfiable —
  // real B2 returns 416. Previously the simulator returned 200 + the
  // empty body, which masked range-aware caller bugs.
  if (totalSize === 0) return { kind: 'unsatisfiable' }

  let start: number
  let end: number
  if (!hasStart) {
    // `bytes=-N` form: the last N bytes.
    const suffixLen = Number.parseInt(endStr ?? '0', 10)
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { kind: 'malformed' }
    start = Math.max(0, totalSize - suffixLen)
    end = totalSize - 1
  } else if (!hasEnd) {
    // `bytes=N-` form: from offset N to end of file.
    start = Number.parseInt(startStr ?? '0', 10)
    end = totalSize - 1
  } else {
    start = Number.parseInt(startStr ?? '0', 10)
    end = Number.parseInt(endStr ?? '0', 10)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
    return { kind: 'malformed' }
  }
  // Start past EOF is unsatisfiable per RFC 7233 §4.4.
  if (start >= totalSize) return { kind: 'unsatisfiable' }
  // Clamp end to the actual file size — RFC 7233 says the server SHOULD
  // satisfy a partially-valid range rather than rejecting.
  end = Math.min(end, totalSize - 1)
  return { kind: 'ok', start, end }
}

/**
 * Parse `X-Bz-Info-*` headers (lowercased Map keys) into a plain
 * fileInfo record. Mirrors the SDK's `parseFileInfoHeaders` in
 * `raw/encoding.ts` but operates on a `Record<string, string>` rather
 * than a `Headers` object so the simulator can reuse the same
 * extraction logic without converting back to `Headers`.
 *
 * @param headers - Lowercased header map.
 *
 * @returns Plain `Record<string, string>` of `fileInfo` keys/values.
 */
function parseFileInfoHeaders(headers: Record<string, string>): Record<string, string> {
  const info: Record<string, string> = {}
  const prefix = 'x-bz-info-'
  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith(prefix)) continue
    const fileInfoKey = decodeURIComponent(key.slice(prefix.length))
    info[fileInfoKey] = decodeURIComponent(value)
  }
  return info
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Compares B2 file names with deterministic JS string order, not locale collation.
 *
 * @param a - First file name.
 * @param b - Second file name.
 *
 * @returns `-1` when `a` sorts first, `1` when `b` sorts first, otherwise `0`.
 */
function compareB2FileNames(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

import { missingCapabilitiesFor } from './capabilities.ts'
import {
  validateBucketInfo,
  validateBucketName,
  validateFileInfo,
  validateFileName,
  validateMaxCount,
} from './validation.ts'

// Re-export the documented B2 spec limit constants so callers of
// `@backblaze-labs/b2-sdk/simulator` can parameterise tests against the
// real caps without reaching into the validation submodule.
export {
  BUCKET_INFO_MAX_KEYS,
  BUCKET_INFO_VALUE_MAX,
  BUCKET_NAME_MAX,
  BUCKET_NAME_MIN,
  FILE_INFO_TOTAL_MAX,
  FILE_INFO_VALUE_MAX,
  FILE_NAME_MAX_BYTES,
  LIST_ENDPOINT_CAPS,
} from './validation.ts'

interface StoredFile {
  readonly fileVersion: FileVersion
  readonly data: Uint8Array
}

interface StoredBucket {
  readonly info: BucketInfo
  readonly files: Map<string, StoredFile[]>
}

interface LargeFileInProgress {
  readonly fileId: string
  readonly bucketId: string
  readonly fileName: string
  readonly contentType: string
  readonly fileInfo: Record<string, string>
  readonly fileRetention: FileRetentionValue | null
  readonly legalHold: LegalHoldValue | null
  readonly serverSideEncryption: EncryptionSetting
  readonly uploadTimestamp: number
  readonly parts: Map<number, { data: Uint8Array; sha1: string }>
}

interface StoredKey {
  readonly applicationKeyId: string
  readonly keyName: string
  readonly capabilities: readonly string[]
  readonly accountId: string
  readonly applicationKey: string
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly expirationTimestamp: number | null
}

type UploadTokenKind = 'file' | 'part'

interface UploadTokenPayload {
  readonly v: 1
  readonly kind: UploadTokenKind
  readonly fileName: string | null
  readonly uploadUrl: string
  readonly namePrefix: string | null
  readonly applicationKeyId: string | null
  readonly expiresAt: number
}

interface StoredUploadToken {
  readonly kind: UploadTokenKind
  readonly fileName: string | null
  readonly uploadUrl: string
  readonly namePrefix: string | null
  readonly applicationKeyId: string | null
  expiresAt: number
  readonly cleanupAt: number
  invalidated: boolean
}

interface RequestScope {
  readonly bucketIds: readonly string[]
  readonly fileNames?: readonly string[]
  readonly requiresBucketScope: boolean
}

function normalizeKeyBucketIds(req: {
  bucketIds?: readonly string[] | null
}): readonly string[] | null {
  return req.bucketIds === undefined || req.bucketIds === null
    ? null
    : Object.freeze([...req.bucketIds])
}

function singleBucketId(bucketIds: readonly string[] | null | undefined): string | null {
  return bucketIds?.length === 1 ? (bucketIds[0] ?? null) : null
}

function cloneBucketIds(bucketIds: readonly string[] | null): readonly string[] | null {
  return bucketIds === null ? null : [...bucketIds]
}

function hasOwnField(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && Object.hasOwn(body, field)
}

function requestStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

function fileNames(...names: readonly (string | undefined)[]): readonly string[] | undefined {
  const present = names.filter((name): name is string => name !== undefined)
  return present.length > 0 ? present : undefined
}

function publicServerSideEncryption(encryption: EncryptionSetting): PublicEncryptionSetting {
  if (encryption.mode === EncryptionMode.SseC) {
    return { mode: encryption.mode, algorithm: encryption.algorithm }
  }
  if (encryption.mode === EncryptionMode.None) {
    return { mode: null, algorithm: null }
  }
  return encryption
}

function uploadServerSideEncryption(
  headers: Record<string, string>,
  fallback: EncryptionSetting,
): EncryptionSetting {
  const customerAlgorithm = headers['x-bz-server-side-encryption-customer-algorithm']
  if (customerAlgorithm === EncryptionAlgorithm.Aes256) {
    return {
      mode: EncryptionMode.SseC,
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey: headers['x-bz-server-side-encryption-customer-key'] ?? '',
      customerKeyMd5: headers['x-bz-server-side-encryption-customer-key-md5'] ?? '',
    }
  }

  if (headers['x-bz-server-side-encryption'] === EncryptionAlgorithm.Aes256) {
    return { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 }
  }

  return fallback
}

function defaultFileRetention(
  policy: BucketInfo['defaultRetention'],
  uploadTimestamp: number,
): FileRetentionValue | null {
  if (policy.mode === BucketRetentionMode.None || policy.period === null) return null
  const days = policy.period.unit === 'days' ? policy.period.duration : policy.period.duration * 365
  return {
    mode: policy.mode as RetentionMode,
    retainUntilTimestamp: uploadTimestamp + days * 24 * 60 * 60 * 1000,
  }
}

/** JSON response returned by {@link B2Simulator.handleRequest} and {@link B2Simulator.handleUpload}. */
export interface SimulatorJsonResponse {
  /** HTTP status code. */
  readonly status: number
  /** JSON response body. */
  readonly body: unknown
}

/** Download response returned by {@link B2Simulator.handleDownload}. */
export interface SimulatorDownloadResponse {
  /** HTTP status code. */
  readonly status: number
  /** B2 response headers (content type, SHA-1, file info, etc.). */
  readonly headers: Record<string, string>
  /** Raw file bytes, or null if the file was not found. */
  readonly data: Uint8Array | null
}

/**
 * Specification for a synthetic failure to return from the simulator's
 * transport. See {@link B2Simulator.injectFailure}.
 */
export interface FaultSpec {
  /**
   * URL substring matched against `request.url`. The fault triggers on
   * every request whose URL contains this substring. Typically a B2
   * endpoint name like `'b2_upload_part'`, `'b2_authorize_account'`,
   * `'b2_download_file_by_id'`, or `'/file/'` for download-by-name.
   */
  readonly on: string
  /** HTTP status to return. Defaults to `503`. */
  readonly status?: number
  /** B2 error code to return in the JSON body. Defaults to `'service_unavailable'`. */
  readonly code?: string
  /** Human-readable message. Defaults to `'simulated failure'`. */
  readonly message?: string
  /**
   * Number of matched requests to fail before the fault retires. Defaults
   * to `Number.POSITIVE_INFINITY` (every matched request fails until
   * cleared). Set to e.g. `3` to fail the next 3 matched requests then
   * stop.
   */
  readonly count?: number
  /**
   * Number of matched requests to let through before failures start.
   * Defaults to `0` (fail from the first matched request). Set to e.g.
   * `2` to let the first 2 succeed and start failing on the 3rd.
   */
  readonly skip?: number
  /**
   * If set, the synthetic response includes a `Retry-After: <n>` header
   * (in seconds). Used to exercise the retry transport's
   * `Retry-After`-respecting backoff path.
   */
  readonly retryAfter?: number
}

/**
 * Handle returned by {@link B2Simulator.injectFailure} so a specific
 * fault registration can be torn down without affecting other faults.
 */
export interface FaultHandle {
  /**
   * Remove this fault registration. Idempotent: calling twice is a no-op.
   * Faults whose `count` budget has already been exhausted retire
   * automatically and do not need to be cleared explicitly.
   */
  clear(): void
}

/**
 * Internal book-keeping for an active {@link FaultSpec}. Tracks the
 * remaining skip/count budget across matched requests and a unique id so
 * the registration can be torn down individually.
 */
interface ActiveFault {
  readonly id: number
  readonly spec: FaultSpec
  remainingSkip: number
  remainingCount: number
}

/**
 * Options for constructing a {@link B2Simulator}.
 */
export interface B2SimulatorOptions {
  /**
   * The minimum part size the simulator advertises in `b2_authorize_account`
   * responses (`apiInfo.storageApi.absoluteMinimumPartSize`). Defaults to
   * `5_000_000` to mirror production B2. Lower this in tests that exercise
   * multipart control-flow branches but don't need realistic part sizes,
   * because v8 coverage instrumentation pushes 5 MB+ part hashing past 60 s
   * on the slowest CI runners, which trips vitest's IPC RPC timeout.
   */
  minimumPartSize?: number
  /**
   * The recommended part size the simulator advertises in
   * `b2_authorize_account` responses (`apiInfo.storageApi.recommendedPartSize`).
   * Defaults to `100_000_000` to mirror production B2. Lower this when a test
   * needs to exercise the SDK's "use the recommended size when the caller
   * omits `partSize`" default-branch without uploading 100 MB of bytes.
   */
  recommendedPartSize?: number
  /**
   * Pluggable hook: invoked after every successful upload, copy, or
   * `finishLargeFile` on a bucket with a matching event-notification
   * rule. Tests can register a hook to assert the SDK's webhook
   * publishing path without spinning up a real HTTP listener.
   *
   * Receives the freshly-stored `FileVersion`, the bucket the upload
   * landed in, and the rule that matched. Returns a promise so async
   * hook implementations are allowed; the simulator never blocks on it
   * (errors thrown from the hook are surfaced via `bestEffort` to
   * avoid masking the underlying API call's success).
   */
  onWebhookDeliver?: (event: {
    rule: EventNotificationRule
    fileVersion: FileVersion
    bucketId: string
  }) => Promise<void> | void
  /**
   * Pluggable hook: invoked after every successful upload on a bucket
   * configured as a replication source. Receives the source `FileVersion`
   * and the destination bucket ID. Tests can register a hook to
   * verify replication intent without actually copying bytes inside
   * the simulator.
   */
  onReplicate?: (event: {
    sourceFileVersion: FileVersion
    sourceBucketId: string
    destinationBucketId: string
  }) => Promise<void> | void
  /**
   * Diagnostic hook: invoked with any error thrown or rejected by
   * `onWebhookDeliver` / `onReplicate`. Without this, errors thrown by
   * user-supplied hooks are silently swallowed (intentional: a buggy
   * hook must not corrupt an otherwise-successful upload), which makes
   * test debugging hard when a hook quietly stops firing. Register
   * `onHookError` to surface what would otherwise be invisible.
   */
  onHookError?: (event: { kind: 'webhook' | 'replication'; error: Error }) => void
  /**
   * When `true`, the simulator enforces application-key capability
   * checks, bucket scoping, prefix scoping, and auth-token expiry on
   * every request. The default `false` keeps the simulator permissive
   * for account/application-key authorization (matching its
   * long-standing behaviour) so the existing test suite doesn't have
   * to set up keys with the right capabilities.
   *
   * Upload authorization tokens returned by `b2_get_upload_url` and
   * `b2_get_upload_part_url` are always enforced, regardless of this
   * option. Upload handlers reject missing, unknown, expired, or
   * wrong-URL upload tokens in both permissive and strict modes.
   *
   * In strict mode:
   *
   * - Unknown auth tokens return HTTP 401 with code `bad_auth_token`.
   * - Expired tokens (per {@link B2Simulator.advanceTime}) return HTTP 401 with code `expired_auth_token`.
   * - Calls without the required capability for the endpoint return HTTP 403 `unauthorized`.
   * - Calls outside the key's bucketIds / namePrefix scope return HTTP 403 `unauthorized`.
   *
   * Each test can opt in: `new B2Simulator({ strictAuth: true })`.
   */
  strictAuth?: boolean
  /**
   * How long auth tokens issued via `b2_authorize_account` are valid
   * for, in milliseconds. The simulator also uses this TTL for upload
   * authorization tokens issued via `b2_get_upload_url` and
   * `b2_get_upload_part_url`. Defaults to 24 hours (real B2). Tests
   * that want to exercise the 401/reauth retry path or stale upload
   * URL handling can lower this and use {@link B2Simulator.advanceTime}
   * to move simulator time past account-token expiry. Upload tokens are
   * rejected at the exact expiry boundary.
   */
  authTokenTtlMs?: number
}

/**
 * In-memory B2 simulator for testing. Implements the B2 native API at the
 * request/response level without any network I/O. Supports 25+ operations
 * including buckets, files, large files, keys, and notifications.
 *
 * @example
 * ```ts
 * const sim = new B2Simulator()
 * const client = new B2Client({
 *   applicationKeyId: 'test-key-id',
 *   applicationKey: 'test-key',
 *   transport: sim.transport(),
 * })
 * await client.authorize()
 * ```
 */
export class B2Simulator {
  private readonly buckets = new Map<string, StoredBucket>()
  private readonly accountId = 'sim_account_0001'
  private readonly largeFiles = new Map<string, LargeFileInProgress>()
  private readonly keys = new Map<string, StoredKey>()
  private readonly notificationRules = new Map<string, EventNotificationRule[]>()
  private readonly minimumPartSize: number
  private readonly recommendedPartSize: number
  private readonly faults: ActiveFault[] = []
  private nextFaultId = 1
  private readonly onWebhookDeliver?: B2SimulatorOptions['onWebhookDeliver']
  private readonly onReplicate?: B2SimulatorOptions['onReplicate']
  private readonly onHookError?: B2SimulatorOptions['onHookError']
  private readonly strictAuth: boolean
  private readonly authTokenTtlMs: number
  /**
   * Issued auth tokens with their associated grant scope + expiry. In
   * permissive mode (`strictAuth: false`) this is still populated by
   * `authorize` but never consulted on subsequent requests. In strict
   * mode each request looks up its `Authorization` header here.
   */
  private readonly issuedTokens = new Map<
    string,
    {
      capabilities: readonly Capability[]
      bucketIds: readonly string[] | null
      namePrefix: string | null
      expiresAt: number
      /**
       * The application-key ID this token was minted for, or `null`
       * for tokens minted from the implicit master credential. Set so
       * {@link deleteKey} can evict every outstanding token whose
       * underlying key was just revoked — without this back-pointer
       * deleted keys keep working until the token TTL expires.
       */
      applicationKeyId: string | null
    }
  >()
  /**
   * Mutable upload-token overrides for tokens minted by `b2_get_upload_url`
   * and `b2_get_upload_part_url`. The token string is self-describing so
   * another simulator instance can validate it, while this map records
   * local invalidation / forced-expiry state for tests.
   */
  private readonly uploadTokens = new Map<string, StoredUploadToken>()
  /**
   * Virtual-clock offset applied to `Date.now()` for expiry checks.
   * Defaults to 0. Tests advance via {@link advanceTime} to fast-forward
   * past auth-token expiry without sleeping.
   */
  private clockOffsetMs = 0
  /**
   * Per-instance monotonic counter used to mint realistic-looking
   * IDs (`b2_bucket_<24-hex>`, `4_z<24-hex>`, etc.) and auth tokens.
   * Module-global previously, which leaked state across `B2Simulator`
   * instances in the same Vitest worker — concurrent tests could see
   * colliding tokens. Per-instance ensures determinism within a single
   * simulator's lifetime.
   */
  private nextId = 1
  /**
   * Last-issued upload timestamp. The simulator enforces strict
   * monotonicity so version ordering is deterministic for tests; if
   * two writes hit the same `Date.now()` millisecond, the second
   * receives `lastTimestamp + 1`.
   */
  private lastTimestamp = 0
  /**
   * Outstanding fire-and-forget hook invocations. Tracked so tests
   * (and future {@link flushHooks} callers) can wait for every
   * dispatched `onWebhookDeliver` / `onReplicate` callback to settle
   * before asserting against observable side effects. The microtask
   * dance in fidelity tests was previously brittle: positive cases
   * flushed twice, negative cases flushed once, and any addition to
   * the hook dispatch chain quietly broke the negative path.
   */
  private readonly pendingHooks = new Set<Promise<void>>()

  /**
   * Constructs a new in-memory B2 simulator.
   * @param options - Optional simulator overrides. See {@link B2SimulatorOptions}.
   */
  constructor(options: B2SimulatorOptions = {}) {
    this.minimumPartSize = options.minimumPartSize ?? 5_000_000
    this.recommendedPartSize = options.recommendedPartSize ?? 100_000_000
    if (options.onWebhookDeliver !== undefined) this.onWebhookDeliver = options.onWebhookDeliver
    if (options.onReplicate !== undefined) this.onReplicate = options.onReplicate
    if (options.onHookError !== undefined) this.onHookError = options.onHookError
    this.strictAuth = options.strictAuth ?? false
    // Real B2 tokens last 24h. Default matches production; tests that
    // want to exercise the reauth path can lower this knob.
    this.authTokenTtlMs = options.authTokenTtlMs ?? 24 * 60 * 60 * 1000
  }

  /**
   * Advance the simulator's virtual clock by `ms` milliseconds. Used in
   * conjunction with `strictAuth: true` + a finite `authTokenTtlMs` to
   * force token expiry without `setTimeout`-based delays.
   *
   * @param ms - Milliseconds to advance. Negative values rewind (rarely useful).
   */
  advanceTime(ms: number): void {
    this.clockOffsetMs += ms
  }

  /**
   * Expire an upload authorization token previously returned by
   * `b2_get_upload_url` or `b2_get_upload_part_url`. Tests can use this
   * to simulate a stale upload URL and verify retry paths that fetch a
   * fresh URL/token pair.
   *
   * @param authorizationToken - The upload authorization token to expire.
   *
   * @returns `true` when the token existed and was expired, otherwise `false`.
   */
  expireUploadToken(authorizationToken: string): boolean {
    const now = this.now()
    const token = this.uploadTokenState(authorizationToken)
    if (token === null || now >= token.cleanupAt) return false
    token.expiresAt = now - 1
    this.uploadTokens.set(authorizationToken, token)
    return true
  }

  /**
   * Invalidate an upload authorization token previously returned by
   * `b2_get_upload_url` or `b2_get_upload_part_url`.
   *
   * @param authorizationToken - The upload authorization token to invalidate.
   *
   * @returns `true` when the token existed and was invalidated, otherwise `false`.
   */
  invalidateUploadToken(authorizationToken: string): boolean {
    const now = this.now()
    const token = this.uploadTokenState(authorizationToken)
    if (token === null || now >= token.cleanupAt) {
      this.pruneExpiredUploadTokens(now)
      return false
    }
    token.invalidated = true
    this.uploadTokens.set(authorizationToken, token)
    this.pruneExpiredUploadTokens()
    return true
  }

  /**
   * Current simulator time. Equal to `Date.now() + clockOffsetMs`.
   *
   * @returns Unix milliseconds.
   */
  private now(): number {
    return Date.now() + this.clockOffsetMs
  }

  private pruneExpiredUploadTokens(now = this.now()): void {
    for (const [authorizationToken, token] of this.uploadTokens.entries()) {
      if (now >= token.cleanupAt) {
        this.uploadTokens.delete(authorizationToken)
      }
    }
  }

  private uploadTokenState(authorizationToken: string): StoredUploadToken | null {
    const stored = this.uploadTokens.get(authorizationToken)
    if (stored !== undefined) return stored
    return this.decodeUploadAuthorizationToken(authorizationToken)
  }

  private encodeUploadAuthorizationToken(token: StoredUploadToken): string {
    const payload: UploadTokenPayload = {
      v: 1,
      kind: token.kind,
      fileName: token.fileName,
      uploadUrl: token.uploadUrl,
      namePrefix: token.namePrefix,
      applicationKeyId: token.applicationKeyId,
      expiresAt: token.expiresAt,
    }
    let binary = ''
    for (const byte of utf8Encoder.encode(JSON.stringify(payload))) {
      binary += String.fromCharCode(byte)
    }
    const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const prefix = token.kind === 'file' ? 'sim_upload_auth' : 'sim_part_auth'
    return `${prefix}_${encoded}`
  }

  private decodeUploadAuthorizationToken(authorizationToken: string): StoredUploadToken | null {
    const filePrefix = 'sim_upload_auth_'
    const partPrefix = 'sim_part_auth_'
    const expectedKind = authorizationToken.startsWith(filePrefix)
      ? 'file'
      : authorizationToken.startsWith(partPrefix)
        ? 'part'
        : null
    if (expectedKind === null) return null

    const encoded = authorizationToken.slice(
      expectedKind === 'file' ? filePrefix.length : partPrefix.length,
    )
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
    const padding = (4 - (base64.length % 4)) % 4
    let parsed: unknown
    try {
      const binary = atob(base64.padEnd(base64.length + padding, '='))
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      parsed = JSON.parse(utf8Decoder.decode(bytes)) as unknown
    } catch {
      return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const payload = parsed as Record<string, unknown>
    if (
      payload['v'] !== 1 ||
      payload['kind'] !== expectedKind ||
      typeof payload['uploadUrl'] !== 'string' ||
      typeof payload['expiresAt'] !== 'number' ||
      !Number.isFinite(payload['expiresAt']) ||
      !(payload['fileName'] === null || typeof payload['fileName'] === 'string') ||
      !(payload['namePrefix'] === null || typeof payload['namePrefix'] === 'string') ||
      !(payload['applicationKeyId'] === null || typeof payload['applicationKeyId'] === 'string')
    ) {
      return null
    }
    return {
      kind: expectedKind,
      fileName: payload['fileName'],
      uploadUrl: payload['uploadUrl'],
      namePrefix: payload['namePrefix'],
      applicationKeyId: payload['applicationKeyId'],
      expiresAt: payload['expiresAt'],
      cleanupAt: payload['expiresAt'],
      invalidated: false,
    }
  }

  /**
   * Generate a deterministic-but-realistic-looking B2 identifier of the
   * shape `<prefix>_<24-hex-counter>`, which approximates the visual
   * width of real B2 wire IDs. The counter is monotonic per instance
   * so test fixtures are deterministic across runs of the same
   * simulator.
   *
   * @param prefix - B2-style prefix (`'b2_bucket'`, `'4_z'`, etc.).
   *
   * @returns A simulator-issued identifier that looks like a B2 wire ID.
   */
  private genId(prefix: string): string {
    const n = this.nextId++
    return `${prefix}_${n.toString(16).padStart(24, '0')}`
  }

  /**
   * Return a strictly-increasing upload timestamp, even when multiple
   * writes land in the same `Date.now()` millisecond. Tests rely on
   * `uploadTimestamp` ordering to discriminate file versions; ties from
   * coarse system-clock resolution would otherwise make version
   * selection nondeterministic.
   *
   * @returns Unix milliseconds.
   */
  private monotonicTimestamp(): number {
    const now = Date.now()
    if (now <= this.lastTimestamp) {
      this.lastTimestamp += 1
    } else {
      this.lastTimestamp = now
    }
    return this.lastTimestamp
  }

  /**
   * Wait for every fire-and-forget hook (`onWebhookDeliver`,
   * `onReplicate`) currently in flight to settle. Use in tests after
   * an upload/copy/finish-large-file call to deterministically observe
   * hook side effects without microtask-flush guesswork.
   *
   * @returns A promise that resolves once every pending hook callback
   *   has either resolved or rejected.
   */
  async flushHooks(): Promise<void> {
    while (this.pendingHooks.size > 0) {
      // Snapshot to avoid mutating the set while iterating; new hooks
      // can be enqueued by the very promises we're awaiting.
      const snapshot = [...this.pendingHooks]
      await Promise.allSettled(snapshot)
    }
  }

  /**
   * Authorize a request against the strict-auth bookkeeping. Returns
   * a `SimulatorJsonResponse` error on failure or `null` on success.
   * Only consulted when `strictAuth: true`.
   *
   * @param authToken - The `Authorization` header value from the request.
   * @param endpoint - B2 endpoint name being invoked.
   * @param scope - Optional effective bucket and file-name scope derived from the request.
   *
   * @returns `null` when the request is authorized, otherwise a 401/403 response.
   */
  private authorizeRequest(
    authToken: string | undefined,
    endpoint: string,
    scope?: RequestScope,
  ): SimulatorJsonResponse | null {
    // Endpoints that don't require auth (just b2_authorize_account today).
    const required = missingCapabilitiesFor(endpoint, [])
    const noCheckNeeded = required.length === 0 && endpoint === 'b2_authorize_account'
    if (noCheckNeeded) return null

    if (authToken === undefined || authToken === '') {
      return this.error(401, 'bad_auth_token', 'missing Authorization header')
    }
    const token = this.issuedTokens.get(authToken)
    if (!token) {
      return this.error(401, 'bad_auth_token', 'unknown auth token')
    }
    if (this.now() > token.expiresAt) {
      return this.error(401, 'expired_auth_token', 'auth token has expired; reauthorize')
    }
    const missing = missingCapabilitiesFor(endpoint, token.capabilities)
    if (missing.length > 0) {
      return this.error(
        403,
        'unauthorized',
        `application key lacks required capabilities: ${missing.join(', ')}`,
      )
    }
    if (token.bucketIds !== null) {
      if ((scope?.bucketIds.length ?? 0) === 0 && scope?.requiresBucketScope === true) {
        return this.error(
          403,
          'unauthorized',
          `application key is scoped to buckets ${token.bucketIds.join(', ')}; bucket scope is required`,
        )
      }
      for (const bucketId of scope?.bucketIds ?? []) {
        if (!token.bucketIds.includes(bucketId)) {
          return this.error(
            403,
            'unauthorized',
            `application key is scoped to buckets ${token.bucketIds.join(', ')}; cannot access ${bucketId}`,
          )
        }
      }
    }
    if (token.namePrefix !== null) {
      for (const fileName of scope?.fileNames ?? []) {
        if (fileName.startsWith(token.namePrefix)) continue
        return this.error(
          403,
          'unauthorized',
          `application key is scoped to prefix "${token.namePrefix}"; "${fileName}" is outside scope`,
        )
      }
    }
    return null
  }

  private requestScope(endpoint: string, body: unknown): RequestScope | undefined {
    const directBucketId = requestStringField(body, 'bucketId')
    const directFileName = requestStringField(body, 'fileName')

    switch (endpoint) {
      case 'b2_create_bucket':
        return { bucketIds: [], requiresBucketScope: true }
      case 'b2_list_buckets': {
        if (directBucketId !== undefined) {
          return { bucketIds: [directBucketId], requiresBucketScope: true }
        }
        const bucketName = requestStringField(body, 'bucketName')
        if (bucketName !== undefined) {
          const bucket = [...this.buckets.values()].find((b) => b.info.bucketName === bucketName)
          return {
            bucketIds: bucket === undefined ? [] : [bucket.info.bucketId as string],
            requiresBucketScope: true,
          }
        }
        return { bucketIds: [], requiresBucketScope: true }
      }
      case 'b2_list_file_names':
      case 'b2_list_file_versions': {
        return {
          bucketIds: directBucketId === undefined ? [] : [directBucketId],
          fileNames: [requestStringField(body, 'prefix') ?? ''],
          requiresBucketScope: true,
        }
      }
      case 'b2_get_file_info':
      case 'b2_delete_file_version':
      case 'b2_update_file_retention':
      case 'b2_update_file_legal_hold': {
        const fileScope = this.fileIdScope(requestStringField(body, 'fileId'))
        if (fileScope !== undefined) return fileScope
        return { bucketIds: [], requiresBucketScope: true }
      }
      case 'b2_get_upload_part_url':
      case 'b2_finish_large_file':
      case 'b2_cancel_large_file':
      case 'b2_list_parts': {
        const largeScope = this.largeFileScope(requestStringField(body, 'fileId'))
        if (largeScope !== undefined) return largeScope
        return { bucketIds: [], requiresBucketScope: true }
      }
      case 'b2_copy_file': {
        const sourceScope = this.fileIdScope(requestStringField(body, 'sourceFileId'))
        const destinationBucketId = requestStringField(body, 'destinationBucketId')
        const bucketIds = [
          ...(sourceScope?.bucketIds ?? []),
          ...(destinationBucketId !== undefined ? [destinationBucketId] : []),
        ]
        const scopedFileNames = fileNames(...(sourceScope?.fileNames ?? []), directFileName)
        return {
          bucketIds,
          ...(scopedFileNames !== undefined ? { fileNames: scopedFileNames } : {}),
          requiresBucketScope: true,
        }
      }
      case 'b2_copy_part': {
        const sourceScope = this.fileIdScope(requestStringField(body, 'sourceFileId'))
        const largeScope = this.largeFileScope(requestStringField(body, 'largeFileId'))
        const scopedFileNames = fileNames(
          ...(sourceScope?.fileNames ?? []),
          ...(largeScope?.fileNames ?? []),
        )
        return {
          bucketIds: [...(sourceScope?.bucketIds ?? []), ...(largeScope?.bucketIds ?? [])],
          ...(scopedFileNames !== undefined ? { fileNames: scopedFileNames } : {}),
          requiresBucketScope: true,
        }
      }
      case 'b2_list_unfinished_large_files':
        return {
          bucketIds: directBucketId === undefined ? [] : [directBucketId],
          fileNames: [requestStringField(body, 'namePrefix') ?? ''],
          requiresBucketScope: true,
        }
      case 'b2_get_download_authorization':
        return {
          bucketIds: directBucketId === undefined ? [] : [directBucketId],
          fileNames: [requestStringField(body, 'fileNamePrefix') ?? ''],
          requiresBucketScope: true,
        }
      default:
        if (directBucketId !== undefined) {
          return {
            bucketIds: [directBucketId],
            ...(directFileName !== undefined ? { fileNames: [directFileName] } : {}),
            requiresBucketScope: true,
          }
        }
        return directFileName !== undefined
          ? { bucketIds: [], fileNames: [directFileName], requiresBucketScope: false }
          : undefined
    }
  }

  private fileIdScope(fileId: string | undefined): RequestScope | undefined {
    if (fileId === undefined) return undefined
    const found = this.findFile(fileId)
    if (found === null) return undefined
    return {
      bucketIds: [found.bucketId],
      fileNames: [found.stored.fileVersion.fileName],
      requiresBucketScope: true,
    }
  }

  private largeFileScope(fileId: string | undefined): RequestScope | undefined {
    if (fileId === undefined) return undefined
    const large = this.largeFiles.get(fileId)
    if (large === undefined) return undefined
    return { bucketIds: [large.bucketId], fileNames: [large.fileName], requiresBucketScope: true }
  }

  private issueUploadAuthorization(
    options:
      | {
          kind: 'file'
          sourceAuthToken: string | undefined
          bucketId: string
        }
      | {
          kind: 'part'
          sourceAuthToken: string | undefined
          fileId: string
          fileName: string
        },
  ): { uploadUrl: string; authorizationToken: string } {
    const now = this.now()
    this.pruneExpiredUploadTokens(now)
    const endpoint = options.kind === 'file' ? 'b2_upload_file' : 'b2_upload_part'
    const idParam = options.kind === 'file' ? 'bucketId' : 'fileId'
    const scopedId = options.kind === 'file' ? options.bucketId : options.fileId
    const uploadId = this.genId(options.kind === 'file' ? 'upload_file' : 'upload_part')
    const uploadUrl = new URL(`http://localhost:0/b2api/v3/${endpoint}`)
    uploadUrl.searchParams.set(idParam, scopedId)
    uploadUrl.searchParams.set('uploadId', uploadId)

    const sourceToken =
      options.sourceAuthToken === undefined
        ? undefined
        : this.issuedTokens.get(options.sourceAuthToken)
    const token: StoredUploadToken = {
      kind: options.kind,
      fileName: options.kind === 'part' ? options.fileName : null,
      uploadUrl: uploadUrl.toString(),
      namePrefix: this.strictAuth ? (sourceToken?.namePrefix ?? null) : null,
      applicationKeyId: sourceToken?.applicationKeyId ?? null,
      expiresAt: now + this.authTokenTtlMs,
      cleanupAt: now + this.authTokenTtlMs,
      invalidated: false,
    }
    const authorizationToken = this.encodeUploadAuthorizationToken(token)
    this.uploadTokens.set(authorizationToken, token)
    return { uploadUrl: uploadUrl.toString(), authorizationToken }
  }

  private validateUploadAuthorization(
    kind: UploadTokenKind,
    uploadUrl: string,
    authToken: string | undefined,
    fileName: string | undefined,
  ): SimulatorJsonResponse | null {
    if (authToken === undefined || authToken === '') {
      return this.error(401, 'bad_auth_token', 'missing upload Authorization header')
    }

    const token = this.uploadTokenState(authToken)
    if (token === null) {
      this.pruneExpiredUploadTokens()
      return this.error(401, 'bad_auth_token', 'unknown upload authorization token')
    }
    const now = this.now()
    if (now >= token.expiresAt) {
      if (now >= token.cleanupAt) {
        this.uploadTokens.delete(authToken)
      } else {
        this.uploadTokens.set(authToken, token)
      }
      this.pruneExpiredUploadTokens(now)
      return this.error(
        401,
        'expired_auth_token',
        'upload authorization token has expired; get a new upload URL',
      )
    }
    if (token.invalidated) {
      this.uploadTokens.set(authToken, token)
      this.pruneExpiredUploadTokens(now)
      return this.error(401, 'bad_auth_token', 'upload authorization token has been invalidated')
    }
    if (token.kind !== kind) {
      this.pruneExpiredUploadTokens(now)
      return this.error(401, 'bad_auth_token', 'upload authorization token type mismatch')
    }
    this.pruneExpiredUploadTokens(now)
    if (!this.uploadUrlMatches(token, uploadUrl)) {
      return this.error(
        401,
        'bad_auth_token',
        'upload authorization token is not valid for this upload URL',
      )
    }
    const scopedName = kind === 'file' ? fileName : (token.fileName ?? undefined)
    if (token.namePrefix !== null && scopedName !== undefined) {
      if (!scopedName.startsWith(token.namePrefix)) {
        return this.error(
          403,
          'unauthorized',
          `application key is scoped to prefix "${token.namePrefix}"; "${scopedName}" is outside scope`,
        )
      }
    }
    return null
  }

  private uploadUrlMatches(token: StoredUploadToken, uploadUrl: string): boolean {
    let expected: URL
    let actual: URL
    try {
      expected = new URL(token.uploadUrl)
      actual = new URL(uploadUrl)
    } catch {
      return false
    }

    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return false
    const scopeParam = token.kind === 'file' ? 'bucketId' : 'fileId'
    return (
      actual.searchParams.get(scopeParam) === expected.searchParams.get(scopeParam) &&
      actual.searchParams.get('uploadId') === expected.searchParams.get('uploadId')
    )
  }

  private allowedBuckets(
    bucketIds: readonly string[] | null | undefined,
  ): readonly { readonly id: BucketId; readonly name: string | null }[] | null {
    if (bucketIds === undefined || bucketIds === null) return null
    return bucketIds.map((id) => ({
      id: bucketIdOf(id),
      name: this.buckets.get(id)?.info.bucketName ?? null,
    }))
  }

  /**
   * Look up the application key matching the `Authorization` header on
   * an `authorize_account` request. The header is in the form
   * `Basic base64(applicationKeyId:applicationKey)`.
   *
   * Returns `null` for the implicit master credential (anything that
   * does not match a key minted via `b2_create_key`); in that case
   * `authorize` grants the full master capability set.
   *
   * @param authzHeader - Raw HTTP `Authorization` header value.
   *
   * @returns The matching key's grant scope, or `null` for the master.
   */
  private findKeyForAuthHeader(authzHeader: string | undefined): {
    capabilities: readonly Capability[]
    bucketIds: readonly string[] | null
    namePrefix: string | null
    applicationKeyId: string
  } | null {
    if (!authzHeader?.startsWith('Basic ')) return null
    // `atob` is standard on Node 16+, browsers, and modern edge runtimes.
    // Wrapped in a try because malformed base64 throws.
    const decoded = (() => {
      try {
        return atob(authzHeader.slice(6))
      } catch {
        return null
      }
    })()
    if (decoded === null) return null
    const idx = decoded.indexOf(':')
    if (idx === -1) return null
    const applicationKeyId = decoded.slice(0, idx)
    const applicationKey = decoded.slice(idx + 1)
    const stored = this.keys.get(applicationKeyId)
    if (!stored || stored.applicationKey !== applicationKey) return null
    return {
      capabilities: stored.capabilities as readonly Capability[],
      bucketIds: stored.bucketIds,
      namePrefix: stored.namePrefix,
      applicationKeyId,
    }
  }

  /**
   * Creates an {@link HttpTransport} that routes requests to this simulator.
   * @returns A transport instance backed by this in-memory simulator.
   */
  transport(): HttpTransport {
    return new SimulatorTransport(this)
  }

  /**
   * Register a synthetic failure to inject on requests whose URL contains
   * `spec.on`. Use this to exercise retry / backoff / error-handling
   * paths in tests without hand-rolling a wrapping `HttpTransport`. The
   * fault is consumed in registration order on each matched request;
   * once its `count` budget is exhausted it auto-retires.
   *
   * Faults are checked BEFORE the simulator's real handlers run, so a
   * matched request never touches in-memory state — failed uploads
   * don't create partial parts, failed deletes don't remove anything.
   *
   * @param spec - The failure to inject. See {@link FaultSpec}.
   *
   * @returns A handle whose `clear()` method removes this specific
   *   fault registration (other faults remain in effect).
   *
   * @example
   * ```ts
   * // Fail the next 2 b2_upload_part calls with 503, then succeed.
   * sim.injectFailure({ on: 'b2_upload_part', status: 503, count: 2 })
   *
   * // Fail every b2_authorize_account with 401 + Retry-After: 5.
   * const handle = sim.injectFailure({
   *   on: 'b2_authorize_account',
   *   status: 401,
   *   code: 'expired_auth_token',
   *   retryAfter: 5,
   * })
   * // ... later
   * handle.clear()
   * ```
   */
  injectFailure(spec: FaultSpec): FaultHandle {
    const id = this.nextFaultId++
    const fault: ActiveFault = {
      id,
      spec,
      remainingSkip: spec.skip ?? 0,
      remainingCount: spec.count ?? Number.POSITIVE_INFINITY,
    }
    this.faults.push(fault)
    return {
      clear: () => {
        const idx = this.faults.findIndex((f) => f.id === id)
        if (idx !== -1) this.faults.splice(idx, 1)
      },
    }
  }

  /**
   * Remove every registered fault. Equivalent to calling `.clear()` on
   * every handle returned by {@link injectFailure}, plus a defensive
   * reset for tests that re-use a simulator across cases.
   */
  clearFaults(): void {
    this.faults.length = 0
  }

  /**
   * Internal: checks the registered faults for a match on the given URL
   * and consumes one if it should fire. Called from
   * {@link SimulatorTransport.send} before any real handler runs.
   *
   * @param url - The request URL to match against each fault's `on`
   *   substring.
   *
   * @returns The fault to apply, or `null` if no fault should fire.
   *
   * @internal
   */
  consumeMatchingFault(url: string): FaultSpec | null {
    for (let i = 0; i < this.faults.length; i++) {
      const fault = this.faults[i] as ActiveFault
      if (!url.includes(fault.spec.on)) continue
      if (fault.remainingSkip > 0) {
        fault.remainingSkip -= 1
        continue
      }
      if (fault.remainingCount <= 0) continue
      fault.remainingCount -= 1
      if (fault.remainingCount <= 0) {
        // Auto-retire when the count budget is spent so subsequent
        // requests see the next-matching fault (or no fault).
        this.faults.splice(i, 1)
      }
      return fault.spec
    }
    return null
  }

  /**
   * Dispatches a JSON API request to the appropriate handler.
   * @param _method - The HTTP method (unused).
   * @param origin - The request URL origin used for simulator-issued endpoints.
   * @param path - The request URL path containing the B2 endpoint name.
   * @param headers - The HTTP request headers; consulted by the
   *   strict-auth gate to look up the issued auth token.
   * @param body - The parsed JSON request body.
   *
   * @returns An object with HTTP status and JSON response body.
   */
  async handleRequest(
    _method: string,
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<SimulatorJsonResponse> {
    const endpoint = path.split('/').pop() ?? ''
    const apiVersion = path.match(/\/b2api\/(v\d+)\//)?.[1] ?? 'v3'

    // Strict-mode auth gate runs BEFORE the dispatch so even endpoints
    // that don't otherwise consult headers (e.g. b2_list_buckets) get
    // capability and scope checks.
    if (this.strictAuth) {
      const authError = this.authorizeRequest(
        headers['authorization'],
        endpoint,
        this.requestScope(endpoint, body),
      )
      if (authError !== null) return authError
    }

    switch (endpoint) {
      case 'b2_authorize_account':
        return this.authorize(headers['authorization'], origin)
      case 'b2_create_bucket':
        return this.createBucket(
          body as { bucketName: string; bucketType: BucketType; accountId: string },
        )
      case 'b2_list_buckets':
        return this.listBuckets(
          body as {
            bucketId?: string
            bucketName?: string
            bucketTypes?: readonly BucketType[]
          },
        )
      case 'b2_delete_bucket':
        return this.deleteBucket(body as { bucketId: string })
      case 'b2_update_bucket':
        return this.updateBucket(body as Record<string, unknown>)
      case 'b2_get_upload_url':
        return this.getUploadUrl(body as { bucketId: string }, headers['authorization'])
      case 'b2_list_file_names':
        return this.listFileNames(
          body as {
            bucketId: string
            maxFileCount?: number
            prefix?: string
            startFileName?: string
          },
        )
      case 'b2_list_file_versions':
        return this.listFileVersions(
          body as {
            bucketId: string
            maxFileCount?: number
            startFileName?: string
            startFileId?: string
            prefix?: string
          },
        )
      case 'b2_get_file_info':
        return this.getFileInfo(body as { fileId: string })
      case 'b2_hide_file':
        return this.hideFile(body as { bucketId: string; fileName: string })
      case 'b2_delete_file_version':
        return this.deleteFileVersion(
          body as { fileId: string; fileName: string; bypassGovernance?: boolean },
        )
      case 'b2_copy_file':
        return await this.copyFile(
          body as {
            sourceFileId: string
            fileName: string
            destinationBucketId?: string
            range?: string
            metadataDirective?: string
            contentType?: string
            fileInfo?: Record<string, string>
          },
        )
      case 'b2_start_large_file':
        return this.startLargeFile(
          body as {
            bucketId: string
            fileName: string
            contentType: string
            fileInfo?: Record<string, string>
            fileRetention?: FileRetentionValue
            legalHold?: LegalHoldValue
            serverSideEncryption?: EncryptionSetting
          },
        )
      case 'b2_get_upload_part_url':
        return this.getUploadPartUrl(body as { fileId: string }, headers['authorization'])
      case 'b2_finish_large_file':
        return this.finishLargeFile(body as { fileId: string; partSha1Array: string[] })
      case 'b2_cancel_large_file':
        return this.cancelLargeFile(body as { fileId: string })
      case 'b2_list_unfinished_large_files':
        return this.listUnfinishedLargeFiles(
          body as {
            bucketId: string
            namePrefix?: string
            startFileId?: string
            maxFileCount?: number
          },
        )
      case 'b2_list_parts':
        return this.listParts(
          body as { fileId: string; startPartNumber?: number; maxPartCount?: number },
        )
      case 'b2_copy_part':
        return await this.copyPart(
          body as {
            sourceFileId: string
            largeFileId: string
            partNumber: number
            range?: string
          },
        )
      case 'b2_get_download_authorization':
        return this.getDownloadAuthorization(
          body as { bucketId: string; fileNamePrefix: string; validDurationInSeconds: number },
        )
      case 'b2_create_key':
        return this.createKey(
          body as {
            accountId: string
            capabilities: string[]
            keyName: string
            validDurationInSeconds?: number
            bucketIds?: readonly string[] | null
            bucketId?: string
            namePrefix?: string
          },
          apiVersion,
        )
      case 'b2_list_keys':
        return this.listKeys(
          body as { accountId: string; maxKeyCount?: number; startApplicationKeyId?: string },
        )
      case 'b2_delete_key':
        return this.deleteKey(body as { applicationKeyId: string })
      case 'b2_update_file_retention':
        return this.updateFileRetention(
          body as {
            fileName: string
            fileId: string
            fileRetention: {
              mode: RetentionMode | null
              retainUntilTimestamp: number | null
            }
          },
        )
      case 'b2_update_file_legal_hold':
        return this.updateFileLegalHold(
          body as { fileName: string; fileId: string; legalHold: string },
        )
      case 'b2_get_bucket_notification_rules':
        return this.getBucketNotificationRules(body as { bucketId: string })
      case 'b2_set_bucket_notification_rules':
        return this.setBucketNotificationRules(
          body as { bucketId: string; eventNotificationRules: EventNotificationRule[] },
        )
      default:
        return {
          status: 400,
          body: { status: 400, code: 'bad_request', message: `Unknown endpoint: ${endpoint}` },
        }
    }
  }

  /**
   * Handles file and part upload requests (`b2_upload_file`, `b2_upload_part`).
   * Dispatches to the appropriate internal handler based on the URL.
   * @param url - The upload endpoint URL used to determine the upload type.
   * @param headers - The HTTP headers containing file metadata and authorization.
   * @param data - The raw file or part content as bytes.
   *
   * @returns A promise resolving to an object with HTTP status and JSON response body.
   */
  async handleUpload(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): Promise<SimulatorJsonResponse> {
    const endpoint = new URL(url).pathname.split('/').pop() ?? ''
    const kind: UploadTokenKind | null =
      endpoint === 'b2_upload_file' ? 'file' : endpoint === 'b2_upload_part' ? 'part' : null
    if (kind === null) return this.error(400, 'bad_request', `Unknown upload endpoint: ${endpoint}`)

    const fileName =
      kind === 'part' || headers['x-bz-file-name'] === undefined
        ? undefined
        : decodeHeaderValue(headers['x-bz-file-name'])
    const authError = this.validateUploadAuthorization(
      kind,
      url,
      headers['authorization'],
      fileName,
    )
    if (authError !== null) return authError

    if (kind === 'part') {
      return await this.handleUploadPart(url, headers, data)
    }
    return await this.handleUploadFile(url, headers, data)
  }

  /**
   * Handles file download requests (`b2_download_file_by_id`, `/file/` by name).
   * Returns the file data along with B2 response headers.
   * @param path - The request URL path identifying the file to download.
   * @param headers - The HTTP request headers for range or authorization.
   * @param method - The HTTP method; `'HEAD'` suppresses the response body.
   *
   * @returns The download response containing file data and B2 headers.
   */
  handleDownload(
    path: string,
    headers: Record<string, string>,
    method: 'GET' | 'HEAD' = 'GET',
  ): SimulatorDownloadResponse {
    if (path.includes('b2_download_file_by_id')) {
      // Strict-mode auth gate for download-by-id. Mirrors the gate in
      // `handleRequest`. Returns a synthetic JSON error body in the
      // download response shape so the transport renders the right
      // status code.
      if (this.strictAuth) {
        const url = new URL(`http://localhost${path}`)
        const authError = this.authorizeRequest(
          headers['authorization'],
          'b2_download_file_by_id',
          this.fileIdScope(url.searchParams.get('fileId') ?? undefined) ?? {
            bucketIds: [],
            requiresBucketScope: true,
          },
        )
        if (authError !== null) return this.errorAsDownload(authError)
      }
      const url = new URL(`http://localhost${path}`)
      const fileId = url.searchParams.get('fileId') ?? ''
      return this.finalizeDownload(this.downloadById(fileId, headers['range']), url, method)
    }

    const fileMatch = path.match(/^([^?]+)/)?.[1]?.match(/\/file\/([^/]+)\/(.+)/)
    if (fileMatch) {
      const bucketName = decodeURIComponent(fileMatch[1] ?? '')
      const fileName = decodeURIComponent(fileMatch[2] ?? '')
      if (this.strictAuth) {
        const bucket = [...this.buckets.values()].find((b) => b.info.bucketName === bucketName)
        const authError = this.authorizeRequest(
          headers['authorization'],
          'b2_download_file_by_name',
          {
            bucketIds: bucket === undefined ? [] : [bucket.info.bucketId as string],
            fileNames: [fileName],
            requiresBucketScope: true,
          },
        )
        if (authError !== null) return this.errorAsDownload(authError)
      }
      const url = new URL(`http://localhost${path}`)
      return this.finalizeDownload(
        this.downloadByName(bucketName, fileName, headers['range']),
        url,
        method,
      )
    }

    return { status: 404, headers: {}, data: null }
  }

  /**
   * Convert a synthetic JSON error body into a `SimulatorDownloadResponse`
   * shape so the strict-auth gate on download paths can surface 401/403s
   * through the same transport plumbing as a regular failed download.
   *
   * @param json - The JSON error from {@link authorizeRequest}.
   *
   * @returns A download-shaped response with the error body bytes inline.
   */
  private errorAsDownload(json: SimulatorJsonResponse): SimulatorDownloadResponse {
    return {
      status: json.status,
      headers: { 'Content-Type': 'application/json' },
      data: utf8Encoder.encode(JSON.stringify(json.body)),
    }
  }

  /**
   * Applies HEAD-method body suppression and `b2Content*` response-header
   * overrides parsed from the download URL's query string. Mirrors what the
   * real B2 service does: any `b2Content*` query parameter is echoed back as
   * the corresponding response header.
   *
   * @param response - The download response produced by {@link downloadById} or {@link downloadByName}.
   * @param url - The parsed download URL (used to read `b2Content*` query params).
   * @param method - The HTTP method of the originating request.
   *
   * @returns The response with overrides applied.
   */
  private finalizeDownload(
    response: SimulatorDownloadResponse,
    url: URL,
    method: 'GET' | 'HEAD',
  ): SimulatorDownloadResponse {
    const overrideMap: Record<string, string> = {
      b2ContentDisposition: 'Content-Disposition',
      b2ContentLanguage: 'Content-Language',
      b2ContentEncoding: 'Content-Encoding',
      b2ContentType: 'Content-Type',
      b2CacheControl: 'Cache-Control',
      b2Expires: 'Expires',
    }
    const newHeaders = { ...response.headers }
    for (const [param, header] of Object.entries(overrideMap)) {
      const value = url.searchParams.get(param)
      if (value !== null) newHeaders[header] = value
    }
    const data = method === 'HEAD' ? null : response.data
    return { status: response.status, headers: newHeaders, data }
  }

  private async handleUploadFile(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): Promise<SimulatorJsonResponse> {
    const bucketId = new URL(url).searchParams.get('bucketId')
    if (!bucketId) return this.error(400, 'bad_request', 'Missing bucketId')

    const bucket = this.buckets.get(bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const fileName = decodeHeaderValue(headers['x-bz-file-name'] ?? '')
    const contentType = headers['content-type'] ?? 'application/octet-stream'

    // B2 spec-compliance: validate file name and optional X-Bz-Info-*
    // headers before storing. Real B2 rejects with `400 invalid_file_name`
    // or `400 invalid_file_info`; the simulator used to store anything.
    const fileNameError = validateFileName(fileName)
    if (fileNameError) return this.error(400, fileNameError.code, fileNameError.message)
    const fileInfo = parseFileInfoHeaders(headers)
    const fileInfoError = validateFileInfo(fileInfo)
    if (fileInfoError) return this.error(400, fileInfoError.code, fileInfoError.message)

    // SHA-1 verification, matching real B2 semantics for X-Bz-Content-Sha1:
    //   - 'none' / 'do_not_verify' (or missing) -> stored as 'none', no check
    //   - 'unverified:<hex>'                     -> store <hex>, no check
    //   - 'hex_digits_at_end'                    -> verify the trailing digest,
    //                                               store body without trailer
    //   - 40-char hex                            -> verify against the bytes,
    //                                               400 bad_request on mismatch
    // Without this, the simulator stored the client's claimed hash verbatim, so
    // a wrong digest or corrupted bytes passed every test.
    const resolved = await this.resolveUploadSha1(headers['x-bz-content-sha1'], data)
    if ('status' in resolved) return resolved
    const { sha1: contentSha1, data: storedData } = resolved

    const fileVersion = this.makeFileVersion({
      bucketId,
      fileName,
      contentType,
      contentLength: storedData.byteLength,
      contentSha1,
      fileInfo,
      action: FileAction.Upload,
      serverSideEncryption: uploadServerSideEncryption(
        headers,
        bucket.info.defaultServerSideEncryption,
      ),
    })
    const stored: StoredFile = { fileVersion, data: storedData }
    const existing = bucket.files.get(fileName)
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(fileName, [stored])
    }

    this.firePostUploadHooks(fileVersion, bucketId, 'b2:ObjectCreated:Upload')
    return { status: 200, body: fileVersion }
  }

  /**
   * Resolve the `X-Bz-Content-Sha1` header into the SHA-1 to store, verifying
   * it against the uploaded bytes where B2 would. Returns the SHA-1 string to
   * persist, or a `400 bad_request` response when a verifiable hash does not
   * match the data received.
   *
   * @param header - The raw `X-Bz-Content-Sha1` header value, if any.
   * @param data - The uploaded bytes.
   *
   * @returns The SHA-1 string to store, or an error response on mismatch.
   */
  private async resolveUploadSha1(
    header: string | undefined,
    data: Uint8Array,
  ): Promise<{ sha1: string; data: Uint8Array } | SimulatorJsonResponse> {
    const value = header ?? 'none'
    if (value === 'none' || value === 'do_not_verify') return { sha1: 'none', data }
    if (value.startsWith('unverified:')) {
      return { sha1: value.slice('unverified:'.length).toLowerCase(), data }
    }
    if (value === 'hex_digits_at_end') {
      // B2 trailing-SHA mode: the final 40 bytes of the body are the hex digest,
      // not file content. Split them off, verify the rest, and store only the
      // body so contentLength and downloaded bytes match real B2.
      if (data.byteLength < 40) {
        return this.error(400, 'bad_request', 'Sha1 did not match data received')
      }
      const body = data.subarray(0, data.byteLength - 40)
      const trailer = utf8Decoder.decode(data.subarray(data.byteLength - 40)).toLowerCase()
      const actual = await sha1Hex(body)
      if (actual !== trailer) {
        return this.error(400, 'bad_request', 'Sha1 did not match data received')
      }
      return { sha1: actual, data: body }
    }
    const expected = value.toLowerCase()
    const actual = await sha1Hex(data)
    if (actual !== expected) {
      // Match real B2's error string exactly (no digests) for fidelity.
      return this.error(400, 'bad_request', 'Sha1 did not match data received')
    }
    return { sha1: expected, data }
  }

  private async handleUploadPart(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): Promise<SimulatorJsonResponse> {
    const fileId = new URL(url).searchParams.get('fileId')
    if (!fileId) return this.error(400, 'bad_request', 'Missing fileId')

    const large = this.largeFiles.get(fileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')

    const partNumber = Number.parseInt(headers['x-bz-part-number'] ?? '0', 10)

    // Verify the part bytes against X-Bz-Content-Sha1, same as b2_upload_file.
    // Parts are always sent with a real (or unverified:) sha1 by the SDK.
    const resolved = await this.resolveUploadSha1(headers['x-bz-content-sha1'], data)
    if ('status' in resolved) return resolved
    const { sha1, data: partData } = resolved

    large.parts.set(partNumber, { data: partData, sha1 })

    return {
      status: 200,
      body: {
        fileId: large.fileId,
        partNumber,
        contentLength: partData.byteLength,
        contentSha1: sha1,
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp: Date.now(),
      },
    }
  }

  private downloadById(fileId: string, range?: string): SimulatorDownloadResponse {
    const found = this.findFile(fileId)
    if (found === null) return { status: 404, headers: {}, data: null }
    return this.serveFile(found.stored, range)
  }

  private downloadByName(
    bucketName: string,
    fileName: string,
    range?: string,
  ): SimulatorDownloadResponse {
    for (const bucket of this.buckets.values()) {
      if (bucket.info.bucketName !== bucketName) continue
      const versions = bucket.files.get(fileName)
      if (!versions || versions.length === 0) break
      const latest = versions[versions.length - 1]
      if (!latest || latest.fileVersion.action === FileAction.Hide) {
        return { status: 404, headers: {}, data: null }
      }
      return this.serveFile(latest, range)
    }
    return { status: 404, headers: {}, data: null }
  }

  private serveFile(
    stored: StoredFile,
    range?: string,
  ): { status: number; headers: Record<string, string>; data: Uint8Array } {
    const fullData = stored.data
    let data = fullData
    let status = 200
    let contentRange: string | null = null

    if (range) {
      const parsed = parseRangeHeader(range, fullData.byteLength)
      if (parsed.kind === 'ok') {
        data = fullData.subarray(parsed.start, parsed.end + 1)
        status = 206
        contentRange = `bytes ${parsed.start}-${parsed.end}/${fullData.byteLength}`
      } else if (parsed.kind === 'unsatisfiable') {
        // RFC 7233 §4.4: 416 with a `Content-Range: bytes */<total>`
        // hint telling the client the legitimate size.
        return {
          status: 416,
          headers: {
            'Content-Type': stored.fileVersion.contentType,
            'Content-Range': `bytes */${fullData.byteLength}`,
          },
          data: new Uint8Array(0),
        }
      }
      // `kind === 'malformed'`: treat as absent and serve the full body.
    }

    const fv = stored.fileVersion
    const headers: Record<string, string> = {
      'Content-Type': fv.contentType,
      'Content-Length': String(data.byteLength),
      'X-Bz-File-Id': fv.fileId,
      'X-Bz-File-Name': encodeFileName(fv.fileName),
      'X-Bz-Content-Sha1': fv.contentSha1 ?? 'none',
      'X-Bz-Upload-Timestamp': String(fv.uploadTimestamp),
    }
    // Serialize stored fileInfo as X-Bz-Info-* response headers so custom
    // metadata round-trips through download(), not just getFileInfo/list. Use
    // the same B2 wire encoding (encodeFileName) the SDK's download parser
    // decodes with (decodeFileName), rather than encodeURIComponent.
    for (const [key, value] of Object.entries(fv.fileInfo)) {
      headers[`X-Bz-Info-${encodeFileName(key)}`] = encodeFileName(value)
    }
    // Preserve the synthetic last-modified default only when the upload didn't
    // set one explicitly.
    if (!('src_last_modified_millis' in fv.fileInfo)) {
      headers['X-Bz-Info-src_last_modified_millis'] = String(fv.uploadTimestamp)
    }
    if (contentRange !== null) {
      // B2 spec-compliance: 206 Partial Content responses MUST carry a
      // `Content-Range: bytes <start>-<end>/<total>` header per RFC
      // 7233 §4.2. The simulator used to return 206 with the partial
      // body but no Content-Range, leaving range-aware callers with no
      // way to verify they got the bytes they asked for.
      headers['Content-Range'] = contentRange
    }
    return { status, headers, data }
  }

  // --- API handlers ---

  private authorize(
    authzHeader?: string,
    origin = 'http://localhost:0',
  ): { status: number; body: AuthorizeAccountResponse } {
    // Master capabilities granted to the implicit "test" credential.
    // Real B2 derives the capability list from the application key the
    // caller authorized with; in permissive mode every auth call gets
    // the full set so existing tests don't have to construct keys
    // first. Strict-mode tests that need a restricted scope authorize
    // with a specific app-key first via b2_create_key, then call
    // authorize-with-that-key (today's simulator returns this full
    // set regardless — strict-mode test seam is in `authorizeRequest`
    // which consults the issued-token map, not the response body).
    // Note: object-lock-related capabilities (BypassGovernance,
    // WriteFileLegalHolds, WriteFileRetentions) are intentionally
    // omitted from the master grant. Real B2 doesn't auto-grant these
    // either — they're opt-in scopes set via b2_create_key. Tests that
    // need them explicit-issue a key via the simulator's createKey
    // handler and reauth with that key.
    const capabilities: readonly Capability[] = [
      Capability.ListBuckets,
      Capability.ReadBuckets,
      Capability.WriteBuckets,
      Capability.DeleteBuckets,
      Capability.ListFiles,
      Capability.ReadFiles,
      Capability.WriteFiles,
      Capability.DeleteFiles,
      Capability.ListKeys,
      Capability.WriteKeys,
      Capability.DeleteKeys,
      Capability.ShareFiles,
      Capability.ReadBucketNotifications,
      Capability.WriteBucketNotifications,
    ]
    // Token validity: real B2 = 24h; configurable via `authTokenTtlMs`.
    // If a key was previously authorized via `authorizeAsKey` (test
    // seam, see `authorizeAsKey` below), the auth header identifies
    // it and the issued token inherits that key's scope.
    const keyForAuth = this.findKeyForAuthHeader(authzHeader)
    const allowedBuckets = this.allowedBuckets(keyForAuth?.bucketIds)
    const legacyBucketId = singleBucketId(keyForAuth?.bucketIds)
    const legacyBucketName =
      legacyBucketId === null ? null : (this.buckets.get(legacyBucketId)?.info.bucketName ?? null)
    const tokenStr = `sim_auth_token_${this.nextId++}`
    this.issuedTokens.set(tokenStr, {
      capabilities: keyForAuth?.capabilities ?? capabilities,
      bucketIds: keyForAuth?.bucketIds ?? null,
      namePrefix: keyForAuth?.namePrefix ?? null,
      expiresAt: this.now() + this.authTokenTtlMs,
      applicationKeyId: keyForAuth?.applicationKeyId ?? null,
    })
    return {
      status: 200,
      body: {
        accountId: accountIdOf(this.accountId),
        // `AuthToken` has no public factory by design — auth tokens are
        // minted by B2, not constructed by user code. The simulator is
        // the only legitimate place that needs to forge one.
        authorizationToken: tokenStr as unknown as AuthToken,
        apiInfo: {
          storageApi: {
            absoluteMinimumPartSize: this.minimumPartSize,
            apiUrl: origin,
            bucketId: legacyBucketId === null ? null : bucketIdOf(legacyBucketId),
            bucketName: legacyBucketName,
            downloadUrl: origin,
            infoType: 'storageApi',
            namePrefix: keyForAuth?.namePrefix ?? null,
            recommendedPartSize: this.recommendedPartSize,
            s3ApiUrl: origin,
            allowed: {
              capabilities: keyForAuth?.capabilities ?? capabilities,
              buckets: allowedBuckets,
              bucketId: legacyBucketId === null ? null : bucketIdOf(legacyBucketId),
              bucketName: legacyBucketName,
              namePrefix: keyForAuth?.namePrefix ?? null,
            },
          },
        },
        applicationKeyExpirationTimestamp: null,
      },
    }
  }

  private createBucket(req: {
    bucketName: string
    bucketType: BucketType
    accountId: string
    bucketInfo?: Record<string, string>
    corsRules?: BucketInfo['corsRules']
    defaultServerSideEncryption?: BucketInfo['defaultServerSideEncryption']
    defaultRetention?: BucketInfo['defaultRetention']
    fileLockEnabled?: boolean
    lifecycleRules?: BucketInfo['lifecycleRules']
    replicationConfiguration?: BucketInfo['replicationConfiguration']
  }): {
    status: number
    body: unknown
  } {
    // B2 spec-compliance: validate bucket name regex + length, plus the
    // optional bucketInfo byte budget. Real B2 rejects bad names with
    // `400 invalid_bucket_name`; the simulator used to accept anything.
    const nameError = validateBucketName(req.bucketName)
    if (nameError) return this.error(400, nameError.code, nameError.message)
    if (req.bucketInfo !== undefined) {
      const infoError = validateBucketInfo(req.bucketInfo)
      if (infoError) return this.error(400, infoError.code, infoError.message)
    }
    for (const b of this.buckets.values()) {
      if (b.info.bucketName === req.bucketName) {
        return this.error(400, 'duplicate_bucket_name', 'Bucket name already in use')
      }
    }
    const bid = bucketIdOf(this.genId('b2_bucket'))
    // Honor optional fields supplied in the create request so callers
    // that construct a bucket with e.g. `fileLockEnabled: true` see the
    // flag reflected back in the returned `BucketInfo` (and in every
    // subsequent `listBuckets` response). Previously these were
    // hardcoded to defaults, forcing tests to mutate `bucket.info`
    // post-create to simulate a non-vanilla bucket.
    const defaultRetention = req.defaultRetention ?? {
      mode: BucketRetentionMode.None,
      period: null,
    }
    const info: BucketInfo = {
      accountId: accountIdOf(req.accountId),
      bucketId: bid,
      bucketName: req.bucketName,
      bucketType: req.bucketType,
      bucketInfo: req.bucketInfo ?? {},
      corsRules: req.corsRules ?? [],
      defaultServerSideEncryption: req.defaultServerSideEncryption ?? { mode: EncryptionMode.None },
      fileLockConfiguration: {
        isClientAuthorizedToRead: true,
        value: {
          isFileLockEnabled: req.fileLockEnabled ?? false,
          defaultRetention,
        },
      },
      lifecycleRules: req.lifecycleRules ?? [],
      options: [],
      revision: 1,
      defaultRetention,
      replicationConfiguration: req.replicationConfiguration ?? {
        asReplicationSource: null,
        asReplicationDestination: null,
      },
    }
    this.buckets.set(bid, { info, files: new Map() })
    return { status: 200, body: info }
  }

  private listBuckets(req: {
    bucketId?: string
    bucketName?: string
    bucketTypes?: readonly BucketType[]
  }): SimulatorJsonResponse {
    const buckets = [...this.buckets.values()]
      .map((b) => b.info)
      .filter((bucket) => req.bucketId === undefined || bucket.bucketId === req.bucketId)
      .filter((bucket) => req.bucketName === undefined || bucket.bucketName === req.bucketName)
      .filter(
        (bucket) => req.bucketTypes === undefined || req.bucketTypes.includes(bucket.bucketType),
      )
    return { status: 200, body: { buckets } }
  }

  private deleteBucket(req: { bucketId: string }): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    this.buckets.delete(req.bucketId)
    return { status: 200, body: bucket.info }
  }

  private updateBucket(req: Record<string, unknown>): SimulatorJsonResponse {
    const bucket = this.buckets.get(req['bucketId'] as string)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    // Validate bucketInfo budget on update too — real B2 rejects
    // oversized info maps on the update path, not just on create.
    if (req['bucketInfo'] !== undefined) {
      const infoError = validateBucketInfo(req['bucketInfo'] as Record<string, string>)
      if (infoError) return this.error(400, infoError.code, infoError.message)
    }
    const updated: BucketInfo = {
      ...bucket.info,
      ...(req['bucketType'] !== undefined ? { bucketType: req['bucketType'] as BucketType } : {}),
      ...(req['bucketInfo'] !== undefined
        ? { bucketInfo: req['bucketInfo'] as Record<string, string> }
        : {}),
      ...(req['lifecycleRules'] !== undefined
        ? { lifecycleRules: req['lifecycleRules'] as BucketInfo['lifecycleRules'] }
        : {}),
      ...(req['corsRules'] !== undefined
        ? { corsRules: req['corsRules'] as BucketInfo['corsRules'] }
        : {}),
      ...(req['replicationConfiguration'] !== undefined
        ? {
            replicationConfiguration: req[
              'replicationConfiguration'
            ] as BucketInfo['replicationConfiguration'],
          }
        : {}),
      ...(req['defaultRetention'] !== undefined
        ? {
            defaultRetention: req['defaultRetention'] as BucketInfo['defaultRetention'],
            fileLockConfiguration: {
              isClientAuthorizedToRead: true,
              value: {
                isFileLockEnabled:
                  bucket.info.fileLockConfiguration.value?.isFileLockEnabled ?? false,
                defaultRetention: req['defaultRetention'] as BucketInfo['defaultRetention'],
              },
            },
          }
        : {}),
      ...(req['defaultServerSideEncryption'] !== undefined
        ? {
            defaultServerSideEncryption: req[
              'defaultServerSideEncryption'
            ] as BucketInfo['defaultServerSideEncryption'],
          }
        : {}),
      revision: bucket.info.revision + 1,
    }
    this.buckets.set(req['bucketId'] as string, { info: updated, files: bucket.files })
    return { status: 200, body: updated }
  }

  private getUploadUrl(req: { bucketId: string }, authToken?: string): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    const uploadAuth = this.issueUploadAuthorization({
      kind: 'file',
      sourceAuthToken: authToken,
      bucketId: req.bucketId,
    })
    return {
      status: 200,
      body: {
        bucketId: req.bucketId,
        uploadUrl: uploadAuth.uploadUrl,
        authorizationToken: uploadAuth.authorizationToken,
      },
    }
  }

  private listFileNames(req: {
    bucketId: string
    maxFileCount?: number
    prefix?: string
    startFileName?: string
  }): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const countError = validateMaxCount(req.maxFileCount, 'b2_list_file_names')
    if (countError) return this.error(400, countError.code, countError.message)
    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    // Real B2: `b2_list_file_names` returns the most recent version per
    // file name. If that most-recent version is a hide marker (created via
    // `b2_hide_file`), it IS the row that gets returned, with
    // `action: 'hide'` and `contentLength: 0`. Filtering hide markers out
    // of the listing would diverge from production behaviour and hide a
    // real test seam: the action / SDK consumer must skip hide-action
    // entries when iterating over "live" files.
    let allFiles = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([_, versions]) => versions[versions.length - 1])
      .filter((v): v is StoredFile => v !== undefined)
      .map((v) => v.fileVersion)
      .sort((a, b) => compareB2FileNames(a.fileName, b.fileName))

    if (req.startFileName) {
      const start = req.startFileName
      allFiles = allFiles.filter((f) => f.fileName >= start)
    }

    const files = allFiles.slice(0, max)
    const nextFileName = allFiles.length > max ? (allFiles[max]?.fileName ?? null) : null

    return { status: 200, body: { files, nextFileName } }
  }

  private listFileVersions(req: {
    bucketId: string
    maxFileCount?: number
    startFileName?: string
    startFileId?: string
    prefix?: string
  }): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const countError = validateMaxCount(req.maxFileCount, 'b2_list_file_versions')
    if (countError) return this.error(400, countError.code, countError.message)
    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    const allVersions = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([_, versions]) => versions.map((v) => v.fileVersion))
      .sort((a, b) => {
        const nameCmp = compareB2FileNames(a.fileName, b.fileName)
        if (nameCmp !== 0) return nameCmp
        return b.uploadTimestamp - a.uploadTimestamp
      })

    // Pagination cursor: `(startFileName, startFileId)` is composite. B2
    // returns BOTH at a page boundary and expects the client to pass BOTH
    // back. Using only `startFileName` would miss intervening versions of
    // a file with many versions (page 2 would replay page 1's last entry
    // instead of resuming at the next version). The cursor is inclusive
    // on the start: callers replay the boundary entry as page N+1's first
    // item.
    let startIdx = 0
    if (req.startFileName !== undefined) {
      const startName = req.startFileName
      const startId = req.startFileId
      // Walk forward to the first entry that matches the cursor. Two
      // sub-cases: (a) `startFileId` was supplied — advance to the exact
      // (name, id) pair, falling back to the first entry of that name if
      // the id has been deleted; (b) no `startFileId` — advance to the
      // first entry whose name is >= `startFileName`.
      const nameIdx = allVersions.findIndex((f) => f.fileName >= startName)
      if (nameIdx === -1) {
        startIdx = allVersions.length
      } else if (startId !== undefined) {
        const exactIdx = allVersions.findIndex((f, i) => i >= nameIdx && f.fileId === startId)
        startIdx = exactIdx !== -1 ? exactIdx : nameIdx
      } else {
        startIdx = nameIdx
      }
    }

    const sliced = allVersions.slice(startIdx, startIdx + max)
    const hasMore = startIdx + max < allVersions.length
    const nextFileName = hasMore ? (allVersions[startIdx + max]?.fileName ?? null) : null
    const nextFileId = hasMore ? (allVersions[startIdx + max]?.fileId ?? null) : null

    return { status: 200, body: { files: sliced, nextFileName, nextFileId } }
  }

  private getFileInfo(req: { fileId: string }): SimulatorJsonResponse {
    const found = this.findFile(req.fileId)
    if (found === null) return this.error(404, 'file_not_present', 'File not found')
    return { status: 200, body: found.stored.fileVersion }
  }

  private hideFile(req: { bucketId: string; fileName: string }): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const nameError = validateFileName(req.fileName)
    if (nameError) return this.error(400, nameError.code, nameError.message)

    const fileVersion = this.makeFileVersion({
      bucketId: req.bucketId,
      fileName: req.fileName,
      contentType: 'application/octet-stream',
      contentLength: 0,
      contentSha1: 'none',
      action: FileAction.Hide,
    })
    const existing = bucket.files.get(req.fileName)
    const stored: StoredFile = { fileVersion, data: new Uint8Array(0) }
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(req.fileName, [stored])
    }
    return { status: 200, body: fileVersion }
  }

  private deleteFileVersion(req: {
    fileId: string
    fileName: string
    bypassGovernance?: boolean
  }): {
    status: number
    body: unknown
  } {
    const found = this.findFile(req.fileId)
    if (found === null || found.stored.fileVersion.fileName !== req.fileName) {
      return this.error(400, 'file_not_present', 'File version not found')
    }

    // Object Lock enforcement. Real B2 surfaces three distinct error
    // codes for protected file versions; the simulator returns the same
    // shapes so test code exercising the typed `B2Error` hierarchy hits
    // realistic responses.
    const fv = found.stored.fileVersion
    const retention = fv.fileRetention?.value
    const legalHold = fv.legalHold?.value
    const now = Date.now()

    if (legalHold === 'on') {
      return this.error(
        400,
        'file_lock_legal_hold_protected',
        'File is on legal hold and cannot be deleted',
      )
    }
    if (
      retention?.mode === 'compliance' &&
      retention.retainUntilTimestamp !== null &&
      retention.retainUntilTimestamp > now
    ) {
      return this.error(
        400,
        'file_lock_compliance_protected',
        `File is under compliance-mode retention and cannot be deleted until ${new Date(retention.retainUntilTimestamp).toISOString()}`,
      )
    }
    if (
      retention?.mode === 'governance' &&
      retention.retainUntilTimestamp !== null &&
      retention.retainUntilTimestamp > now &&
      req.bypassGovernance !== true
    ) {
      return this.error(
        400,
        'file_lock_governance_protected',
        'File is under governance-mode retention; pass bypassGovernance: true to delete',
      )
    }

    found.versions.splice(found.index, 1)
    if (found.versions.length === 0) found.bucket.files.delete(req.fileName)
    return { status: 200, body: { fileId: req.fileId, fileName: req.fileName } }
  }

  private async copyFile(req: {
    sourceFileId: string
    fileName: string
    destinationBucketId?: string
    range?: string
    metadataDirective?: string
    contentType?: string
    fileInfo?: Record<string, string>
  }): Promise<{ status: number; body: unknown }> {
    const nameError = validateFileName(req.fileName)
    if (nameError) return this.error(400, nameError.code, nameError.message)
    const found = this.findFile(req.sourceFileId)
    if (found === null) return this.error(404, 'file_not_present', 'Source file not found')
    const sourceStored = found.stored
    const destBucketId = req.destinationBucketId ?? found.bucketId
    const destBucket = this.buckets.get(destBucketId)
    if (!destBucket) return this.error(400, 'bad_bucket_id', 'Destination bucket not found')

    // Honor an optional byte range: copy only the requested slice. The copied
    // content differs from the source, so its SHA-1 is recomputed; a full copy
    // preserves the source's stored SHA-1 (including 'none' for large files).
    let data = sourceStored.data
    let contentSha1 = sourceStored.fileVersion.contentSha1 ?? 'none'
    if (req.range !== undefined) {
      const parsed = parseRangeHeader(req.range, sourceStored.data.byteLength)
      // B2 returns 416 for a well-formed-but-unsatisfiable range; a malformed
      // range is an invalid request field, so 400 bad_request.
      if (parsed.kind === 'malformed') {
        return this.error(400, 'bad_request', `Malformed copy range: ${req.range}`)
      }
      if (parsed.kind === 'unsatisfiable') {
        return this.error(416, 'range_not_satisfiable', `Unsatisfiable copy range: ${req.range}`)
      }
      data = sourceStored.data.subarray(parsed.start, parsed.end + 1)
      contentSha1 = await sha1Hex(data)
    }

    // Metadata directive: COPY (default) preserves the source's contentType +
    // fileInfo and forbids replacement metadata; REPLACE applies the request's
    // (contentType required, fileInfo validated). Real B2 rejects an unknown
    // directive, and rejects contentType/fileInfo supplied in COPY mode.
    const directive = req.metadataDirective
    if (directive !== undefined && directive !== 'COPY' && directive !== 'REPLACE') {
      return this.error(400, 'bad_request', `Invalid metadataDirective: ${directive}`)
    }
    let contentType: string
    let fileInfo: Record<string, string>
    if (directive === 'REPLACE') {
      if (req.contentType === undefined) {
        return this.error(
          400,
          'bad_request',
          'contentType is required when metadataDirective is REPLACE',
        )
      }
      const replaceFileInfo = req.fileInfo ?? {}
      const fileInfoError = validateFileInfo(replaceFileInfo)
      if (fileInfoError) return this.error(400, fileInfoError.code, fileInfoError.message)
      contentType = req.contentType
      fileInfo = replaceFileInfo
    } else {
      if (req.contentType !== undefined || req.fileInfo !== undefined) {
        return this.error(
          400,
          'bad_request',
          'contentType and fileInfo may only be set when metadataDirective is REPLACE',
        )
      }
      contentType = sourceStored.fileVersion.contentType
      fileInfo = sourceStored.fileVersion.fileInfo
    }

    const fileVersion = this.makeFileVersion({
      bucketId: destBucketId,
      fileName: req.fileName,
      contentType,
      contentLength: data.byteLength,
      contentSha1,
      fileInfo,
      action: FileAction.Copy,
    })
    const copied: StoredFile = { fileVersion, data: new Uint8Array(data) }
    const existing = destBucket.files.get(req.fileName)
    if (existing) {
      existing.push(copied)
    } else {
      destBucket.files.set(req.fileName, [copied])
    }

    this.firePostUploadHooks(fileVersion, destBucketId, 'b2:ObjectCreated:Copy')
    return { status: 200, body: fileVersion }
  }

  private startLargeFile(req: {
    bucketId: string
    fileName: string
    contentType: string
    fileInfo?: Record<string, string>
    fileRetention?: FileRetentionValue
    legalHold?: LegalHoldValue
    serverSideEncryption?: EncryptionSetting
  }): SimulatorJsonResponse {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const nameError = validateFileName(req.fileName)
    if (nameError) return this.error(400, nameError.code, nameError.message)
    if (req.fileInfo !== undefined) {
      const infoError = validateFileInfo(req.fileInfo)
      if (infoError) return this.error(400, infoError.code, infoError.message)
    }

    const fid = this.genId('4_z')
    const uploadTimestamp = this.monotonicTimestamp()
    const large: LargeFileInProgress = {
      fileId: fid,
      bucketId: req.bucketId,
      fileName: req.fileName,
      contentType: req.contentType,
      fileInfo: req.fileInfo ?? {},
      fileRetention:
        req.fileRetention ?? defaultFileRetention(bucket.info.defaultRetention, uploadTimestamp),
      legalHold: req.legalHold ?? null,
      serverSideEncryption: req.serverSideEncryption ?? bucket.info.defaultServerSideEncryption,
      uploadTimestamp,
      parts: new Map(),
    }
    this.largeFiles.set(fid, large)

    return {
      status: 200,
      body: {
        fileId: fid,
        fileName: req.fileName,
        accountId: this.accountId,
        bucketId: req.bucketId,
        contentType: req.contentType,
        fileInfo: large.fileInfo,
        action: FileAction.Start,
        contentLength: 0,
        contentSha1: 'none',
        contentMd5: null,
        fileRetention: {
          isClientAuthorizedToRead: true,
          value: large.fileRetention,
        },
        legalHold: {
          isClientAuthorizedToRead: true,
          value: large.legalHold,
        },
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp: large.uploadTimestamp,
      },
    }
  }

  private getUploadPartUrl(req: { fileId: string }, authToken?: string): SimulatorJsonResponse {
    const large = this.largeFiles.get(req.fileId)
    if (large === undefined) return this.error(400, 'bad_request', 'Large file not found')
    const uploadAuth = this.issueUploadAuthorization({
      kind: 'part',
      sourceAuthToken: authToken,
      fileId: req.fileId,
      fileName: large.fileName,
    })
    return {
      status: 200,
      body: {
        fileId: req.fileId,
        uploadUrl: uploadAuth.uploadUrl,
        authorizationToken: uploadAuth.authorizationToken,
      },
    }
  }

  private finishLargeFile(req: { fileId: string; partSha1Array: string[] }): {
    status: number
    body: unknown
  } {
    const large = this.largeFiles.get(req.fileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')

    const bucket = this.buckets.get(large.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const sortedParts = [...large.parts.entries()].sort((a, b) => a[0] - b[0])

    // B2 spec-compliance: hard cap of 10000 parts per multipart upload.
    // Real B2 rejects with `400 bad_request`; the simulator used to
    // accept any number of parts.
    if (sortedParts.length > 10_000) {
      return this.error(
        400,
        'bad_request',
        `multipart upload has ${sortedParts.length} parts; B2 caps at 10000`,
      )
    }
    // B2 spec-compliance: every part number must be in [1, 10000].
    // Real B2 rejects a part upload with an out-of-range partNumber
    // server-side; we enforce here at finish time as a backstop in case
    // a caller bypassed the upload-side validation (the simulator's
    // own `handleUploadPart` stores whatever number the client sends).
    for (const [partNumber] of sortedParts) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        return this.error(
          400,
          'bad_request',
          `partNumber ${partNumber} is outside the [1, 10000] range B2 accepts`,
        )
      }
    }
    // partSha1Array length must match the parts uploaded — real B2
    // rejects mismatches with `bad_request`.
    if (req.partSha1Array.length !== sortedParts.length) {
      return this.error(
        400,
        'bad_request',
        `partSha1Array has ${req.partSha1Array.length} entries but ${sortedParts.length} parts were uploaded`,
      )
    }
    // B2 spec-compliance: partSha1Array is the ordered checksum list that
    // confirms the right parts were uploaded in the right order. Compare each
    // entry against the stored part's SHA-1; real B2 rejects a mismatch with
    // `bad_request`.
    for (let i = 0; i < sortedParts.length; i++) {
      const [partNumber, part] = sortedParts[i] as [number, { data: Uint8Array; sha1: string }]
      if (req.partSha1Array[i]?.toLowerCase() !== part.sha1) {
        return this.error(
          400,
          'bad_request',
          `part ${partNumber} SHA-1 does not match the uploaded part`,
        )
      }
    }
    // B2 spec-compliance: every non-last part must be at least
    // `absoluteMinimumPartSize`. The last part (highest part number)
    // may be smaller. We enforce here rather than at b2_upload_part
    // time because the simulator can't otherwise know which part is
    // the last until finish_large_file is called.
    for (let i = 0; i < sortedParts.length - 1; i++) {
      const [partNumber, part] = sortedParts[i] as [number, { data: Uint8Array; sha1: string }]
      if (part.data.byteLength < this.minimumPartSize) {
        return this.error(
          400,
          'bad_request',
          `part ${partNumber} (${part.data.byteLength} bytes) is smaller than the minimum part size of ${this.minimumPartSize}`,
        )
      }
    }

    let totalSize = 0
    for (const [_, part] of sortedParts) totalSize += part.data.byteLength
    const combined = new Uint8Array(totalSize)
    let offset = 0
    for (const [_, part] of sortedParts) {
      combined.set(part.data, offset)
      offset += part.data.byteLength
    }

    const fileVersion = this.makeFileVersion({
      bucketId: large.bucketId,
      fileName: large.fileName,
      contentType: large.contentType,
      contentLength: totalSize,
      contentSha1: 'none',
      fileInfo: large.fileInfo,
      action: FileAction.Upload,
      fileRetention: large.fileRetention,
      legalHold: large.legalHold,
      serverSideEncryption: large.serverSideEncryption,
    })
    const stored: StoredFile = { fileVersion, data: combined }
    const existing = bucket.files.get(large.fileName)
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(large.fileName, [stored])
    }

    this.largeFiles.delete(req.fileId)
    this.firePostUploadHooks(fileVersion, large.bucketId, 'b2:ObjectCreated:Upload')
    return { status: 200, body: fileVersion }
  }

  private cancelLargeFile(req: { fileId: string }): SimulatorJsonResponse {
    const large = this.largeFiles.get(req.fileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')
    this.largeFiles.delete(req.fileId)
    return {
      status: 200,
      body: {
        fileId: large.fileId,
        accountId: this.accountId,
        bucketId: large.bucketId,
        fileName: large.fileName,
      },
    }
  }

  private listUnfinishedLargeFiles(req: {
    bucketId: string
    namePrefix?: string
    startFileId?: string
    maxFileCount?: number
  }): SimulatorJsonResponse {
    const countError = validateMaxCount(req.maxFileCount, 'b2_list_unfinished_large_files')
    if (countError) return this.error(400, countError.code, countError.message)
    const prefix = req.namePrefix ?? ''
    const max = req.maxFileCount ?? 100

    // Keep listing order deterministic; resume sorts scanned exact-name
    // matches by uploadTimestamp before selecting one.
    const candidates = [...this.largeFiles.values()]
      .filter((f) => f.bucketId === req.bucketId)
      .filter((f) => f.fileName.startsWith(prefix))
      .sort((a, b) => compareB2FileNames(a.fileName, b.fileName))

    // `startFileId` is the inclusive cursor returned from a prior page.
    // When present in the current listing, that entry is returned first.
    let startIndex = 0
    if (req.startFileId !== undefined) {
      const found = candidates.findIndex((f) => f.fileId === req.startFileId)
      startIndex = found >= 0 ? found : 0
    }

    const slice = candidates.slice(startIndex, startIndex + max)
    const files = slice.map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      accountId: this.accountId,
      bucketId: f.bucketId,
      contentType: f.contentType,
      action: FileAction.Start,
      contentLength: 0,
      contentSha1: 'none',
      contentMd5: null,
      fileInfo: f.fileInfo,
      fileRetention: {
        isClientAuthorizedToRead: true,
        value: f.fileRetention,
      },
      legalHold: {
        isClientAuthorizedToRead: true,
        value: f.legalHold,
      },
      serverSideEncryption: publicServerSideEncryption(f.serverSideEncryption),
      uploadTimestamp: f.uploadTimestamp,
    }))
    const hasMore = startIndex + max < candidates.length
    const nextFileId = hasMore ? (candidates[startIndex + max]?.fileId ?? null) : null
    return { status: 200, body: { files, nextFileId } }
  }

  private listParts(req: {
    fileId: string
    startPartNumber?: number
    maxPartCount?: number
  }): SimulatorJsonResponse {
    const large = this.largeFiles.get(req.fileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')

    const countError = validateMaxCount(req.maxPartCount, 'b2_list_parts')
    if (countError) return this.error(400, countError.code, countError.message)
    const start = req.startPartNumber ?? 1
    const max = req.maxPartCount ?? 1000

    const allParts = [...large.parts.entries()]
      .filter(([n]) => n >= start)
      .sort((a, b) => a[0] - b[0])
      .map(([partNumber, part]) => ({
        fileId: req.fileId,
        partNumber,
        contentLength: part.data.byteLength,
        contentSha1: part.sha1,
        uploadTimestamp: Date.now(),
      }))

    const parts = allParts.slice(0, max)
    const nextPartNumber = allParts.length > max ? (allParts[max]?.partNumber ?? null) : null

    return { status: 200, body: { parts, nextPartNumber } }
  }

  private async copyPart(req: {
    sourceFileId: string
    largeFileId: string
    partNumber: number
    range?: string
  }): Promise<SimulatorJsonResponse> {
    const large = this.largeFiles.get(req.largeFileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')

    const found = this.findFile(req.sourceFileId)
    if (found === null) return this.error(404, 'file_not_present', 'Source file not found')
    const sourceStored = found.stored

    let partData = sourceStored.data
    if (req.range) {
      const match = req.range.match(/bytes=(\d+)-(\d+)?/)
      if (match) {
        const rs = Number.parseInt(match[1] ?? '0', 10)
        const re =
          match[2] !== undefined ? Number.parseInt(match[2], 10) : sourceStored.data.byteLength - 1
        partData = sourceStored.data.slice(rs, re + 1)
      }
    }

    // Hash the part data so list_parts can return a real SHA-1.
    // sha1Hex is isomorphic (node:crypto in Node, WebCrypto in browsers).
    const sha1 = await sha1Hex(partData)
    large.parts.set(req.partNumber, { data: new Uint8Array(partData), sha1 })

    return {
      status: 200,
      body: {
        fileId: req.largeFileId,
        partNumber: req.partNumber,
        contentLength: partData.byteLength,
        contentSha1: sha1,
      },
    }
  }

  private getDownloadAuthorization(req: {
    bucketId: string
    fileNamePrefix: string
    validDurationInSeconds: number
  }): SimulatorJsonResponse {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    return {
      status: 200,
      body: {
        bucketId: req.bucketId,
        fileNamePrefix: req.fileNamePrefix,
        authorizationToken: `sim_dl_auth_${this.genId('tok')}`,
      },
    }
  }

  // --- Keys ---

  private createKey(
    req: {
      accountId: string
      capabilities: string[]
      keyName: string
      validDurationInSeconds?: number
      bucketIds?: readonly string[] | null
      bucketId?: string
      namePrefix?: string
    },
    apiVersion: string,
  ): SimulatorJsonResponse {
    if (apiVersion === 'v4' && hasOwnField(req, 'bucketId')) {
      return this.error(
        400,
        'bad_request',
        'bucketId is not accepted by v4 b2_create_key; use bucketIds',
      )
    }
    if (apiVersion !== 'v4' && req.bucketId !== undefined && req.bucketIds !== undefined) {
      return this.error(400, 'bad_request', 'b2_create_key accepts either bucketIds or bucketId')
    }
    const bucketIds =
      apiVersion !== 'v4' && req.bucketId !== undefined
        ? Object.freeze([req.bucketId])
        : normalizeKeyBucketIds(req)
    const kid = this.genId('sim_key')
    const appKey = this.genId('sim_secret')
    const expiration =
      req.validDurationInSeconds !== undefined
        ? Date.now() + req.validDurationInSeconds * 1000
        : null
    const stored: StoredKey = {
      applicationKeyId: kid,
      keyName: req.keyName,
      capabilities: req.capabilities,
      accountId: req.accountId,
      applicationKey: appKey,
      bucketIds,
      namePrefix: req.namePrefix ?? null,
      expirationTimestamp: expiration,
    }
    this.keys.set(kid, stored)

    return {
      status: 200,
      body: {
        keyName: stored.keyName,
        applicationKeyId: stored.applicationKeyId,
        applicationKey: stored.applicationKey,
        capabilities: stored.capabilities,
        accountId: stored.accountId,
        expirationTimestamp: stored.expirationTimestamp,
        bucketIds: cloneBucketIds(stored.bucketIds),
        bucketId: singleBucketId(stored.bucketIds),
        namePrefix: stored.namePrefix,
        options: [],
      },
    }
  }

  private listKeys(req: {
    accountId: string
    maxKeyCount?: number
    startApplicationKeyId?: string
  }): SimulatorJsonResponse {
    const countError = validateMaxCount(req.maxKeyCount, 'b2_list_keys')
    if (countError) return this.error(400, countError.code, countError.message)
    const max = req.maxKeyCount ?? 1000
    let allKeys = [...this.keys.values()].sort((a, b) =>
      a.applicationKeyId.localeCompare(b.applicationKeyId),
    )

    if (req.startApplicationKeyId) {
      const start = req.startApplicationKeyId
      allKeys = allKeys.filter((k) => k.applicationKeyId >= start)
    }

    const keys = allKeys.slice(0, max).map((k) => ({
      keyName: k.keyName,
      applicationKeyId: k.applicationKeyId,
      capabilities: k.capabilities,
      accountId: k.accountId,
      expirationTimestamp: k.expirationTimestamp,
      bucketIds: cloneBucketIds(k.bucketIds),
      bucketId: singleBucketId(k.bucketIds),
      namePrefix: k.namePrefix,
      options: [],
    }))

    const nextId = allKeys.length > max ? (allKeys[max]?.applicationKeyId ?? null) : null

    return { status: 200, body: { keys, nextApplicationKeyId: nextId } }
  }

  private deleteKey(req: { applicationKeyId: string }): SimulatorJsonResponse {
    const key = this.keys.get(req.applicationKeyId)
    if (!key) return this.error(400, 'bad_request', 'Key not found')
    this.keys.delete(req.applicationKeyId)
    // Evict every issued auth token whose backing application key was
    // just revoked. Real B2 invalidates the token immediately on
    // `b2_delete_key`; before this fix, tokens minted from a deleted
    // key kept passing strict-auth until their TTL expired.
    for (const [token, scope] of this.issuedTokens.entries()) {
      if (scope.applicationKeyId === req.applicationKeyId) {
        this.issuedTokens.delete(token)
      }
    }
    for (const [token, scope] of this.uploadTokens.entries()) {
      if (scope.applicationKeyId === req.applicationKeyId) {
        scope.invalidated = true
        this.uploadTokens.set(token, scope)
      }
    }
    return {
      status: 200,
      body: {
        keyName: key.keyName,
        applicationKeyId: key.applicationKeyId,
        capabilities: key.capabilities,
        accountId: key.accountId,
        expirationTimestamp: key.expirationTimestamp,
        bucketIds: cloneBucketIds(key.bucketIds),
        bucketId: singleBucketId(key.bucketIds),
        namePrefix: key.namePrefix,
        options: [],
      },
    }
  }

  // --- File lock ---

  private updateFileRetention(req: {
    fileName: string
    fileId: string
    fileRetention: { mode: RetentionMode | null; retainUntilTimestamp: number | null }
  }): SimulatorJsonResponse {
    const found = this.findFile(req.fileId)
    if (found === null || found.stored.fileVersion.fileName !== req.fileName) {
      return this.error(404, 'file_not_present', 'File not found')
    }
    found.versions[found.index] = {
      fileVersion: {
        ...found.stored.fileVersion,
        fileRetention: { isClientAuthorizedToRead: true, value: req.fileRetention },
      },
      data: found.stored.data,
    }
    return {
      status: 200,
      body: {
        fileName: req.fileName,
        fileId: req.fileId,
        fileRetention: req.fileRetention,
      },
    }
  }

  private updateFileLegalHold(req: {
    fileName: string
    fileId: string
    legalHold: string
  }): SimulatorJsonResponse {
    const found = this.findFile(req.fileId)
    if (found === null || found.stored.fileVersion.fileName !== req.fileName) {
      return this.error(404, 'file_not_present', 'File not found')
    }
    found.versions[found.index] = {
      fileVersion: {
        ...found.stored.fileVersion,
        legalHold: {
          isClientAuthorizedToRead: true,
          value: req.legalHold as 'on' | 'off',
        },
      },
      data: found.stored.data,
    }
    return {
      status: 200,
      body: {
        fileName: req.fileName,
        fileId: req.fileId,
        legalHold: req.legalHold,
      },
    }
  }

  // --- Notifications ---

  private getBucketNotificationRules(req: { bucketId: string }): {
    status: number
    body: unknown
  } {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    const rules = this.notificationRules.get(req.bucketId) ?? []
    return { status: 200, body: { bucketId: req.bucketId, eventNotificationRules: rules } }
  }

  private setBucketNotificationRules(req: {
    bucketId: string
    eventNotificationRules: EventNotificationRule[]
  }): SimulatorJsonResponse {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    this.notificationRules.set(req.bucketId, req.eventNotificationRules)
    return {
      status: 200,
      body: { bucketId: req.bucketId, eventNotificationRules: req.eventNotificationRules },
    }
  }

  // --- Helpers ---

  /**
   * Locates a stored file version by its `fileId`, scanning every bucket.
   *
   * Returns enough context to support read-only inspection (`stored`,
   * `bucketId`) AND in-place mutation (`versions`, `index`) so callers
   * that need to splice the version out can do so without re-scanning.
   *
   * Real B2 fileIds embed the bucketId, so production lookups are O(1);
   * the simulator's flat ID generator (`this.genId('4_z')`) doesn't, so this
   * is O(buckets × files × versions). Acceptable for tests.
   *
   * @param fileId - The file version ID to locate.
   *
   * @returns The location of the matching version, or `null` if not found.
   */
  private findFile(fileId: string): {
    stored: StoredFile
    bucketId: string
    bucket: StoredBucket
    versions: StoredFile[]
    index: number
  } | null {
    for (const [bid, bucket] of this.buckets.entries()) {
      for (const versions of bucket.files.values()) {
        const idx = versions.findIndex((v) => v.fileVersion.fileId === fileId)
        if (idx !== -1) {
          // Non-null asserted via the findIndex guard above.
          const stored = versions[idx] as StoredFile
          return { stored, bucketId: bid, bucket, versions, index: idx }
        }
      }
    }
    return null
  }

  private makeFileVersion(params: {
    readonly bucketId: string
    readonly fileName: string
    readonly contentType: string
    readonly contentLength: number
    readonly contentSha1: string
    readonly action: FileAction
    readonly fileInfo?: Record<string, string>
    readonly fileRetention?: FileRetentionValue | null
    readonly legalHold?: LegalHoldValue | null
    readonly serverSideEncryption?: EncryptionSetting
  }): FileVersion {
    return {
      accountId: accountIdOf(this.accountId),
      action: params.action,
      bucketId: bucketIdOf(params.bucketId),
      contentLength: params.contentLength,
      contentMd5: null,
      contentSha1: params.contentSha1,
      contentType: params.contentType,
      fileId: fileIdOf(this.genId('4_z')),
      fileInfo: params.fileInfo ?? {},
      fileName: params.fileName,
      fileRetention: { isClientAuthorizedToRead: true, value: params.fileRetention ?? null },
      legalHold: { isClientAuthorizedToRead: true, value: params.legalHold ?? null },
      replicationStatus: null,
      serverSideEncryption: publicServerSideEncryption(
        params.serverSideEncryption ?? { mode: EncryptionMode.None },
      ),
      uploadTimestamp: this.monotonicTimestamp(),
    }
  }

  private error(status: number, code: string, message: string): SimulatorJsonResponse {
    return { status, body: { status, code, message } }
  }

  /**
   * Fire the pluggable post-upload hooks for a file that just landed in
   * a bucket: matching event-notification rules → `onWebhookDeliver`,
   * configured replication source rules → `onReplicate`. Errors thrown
   * from user-supplied hooks are swallowed so a buggy listener never
   * masks an otherwise-successful API response.
   *
   * Fired-and-forgotten (no await) by the handler so the synthetic
   * response is returned to the caller as fast as production B2 would
   * acknowledge the write.
   *
   * @param fileVersion - The freshly-stored file metadata.
   * @param bucketId - The bucket the upload landed in.
   * @param eventType - The B2 event-type tag (e.g. `'b2:ObjectCreated:Upload'`)
   *   used to match against `EventNotificationRule.eventTypes` globs.
   */
  private firePostUploadHooks(fileVersion: FileVersion, bucketId: string, eventType: string): void {
    const bucket = this.buckets.get(bucketId)
    if (!bucket) return
    if (this.onWebhookDeliver !== undefined) {
      const rules = this.notificationRules.get(bucketId) ?? []
      for (const rule of rules) {
        if (!rule.isEnabled) continue
        const matches = rule.eventTypes.some((pattern) => eventTypeMatches(pattern, eventType))
        if (!matches) continue
        const hook = this.onWebhookDeliver
        this.dispatchHook('webhook', () => hook({ rule, fileVersion, bucketId }))
      }
    }
    if (this.onReplicate !== undefined) {
      const replConfig = bucket.info.replicationConfiguration
      const sourceRules = replConfig.asReplicationSource?.replicationRules ?? []
      for (const rule of sourceRules) {
        if (!rule.isEnabled) continue
        if (rule.fileNamePrefix && !fileVersion.fileName.startsWith(rule.fileNamePrefix)) continue
        const hook = this.onReplicate
        this.dispatchHook('replication', () =>
          hook({
            sourceFileVersion: fileVersion,
            sourceBucketId: bucketId,
            destinationBucketId: rule.destinationBucketId,
          }),
        )
      }
    }
  }

  /**
   * Schedule a user-supplied hook callback. Errors are routed to
   * `onHookError` if configured, swallowed otherwise. The returned
   * promise is tracked in {@link pendingHooks} so `flushHooks()` can
   * wait for every dispatched hook to settle.
   *
   * @param kind - Which hook this is (`'webhook'` or `'replication'`).
   * @param fn - Thunk that performs the hook invocation.
   */
  private dispatchHook(kind: 'webhook' | 'replication', fn: () => Promise<void> | void): void {
    const task = Promise.resolve()
      .then(() => fn())
      .catch((err) => {
        if (this.onHookError !== undefined) {
          this.onHookError({ kind, error: toError(err) })
        }
      })
      .finally(() => {
        this.pendingHooks.delete(task)
      })
    this.pendingHooks.add(task)
  }
}

/**
 * Module-local cache of compiled glob regexes. Avoids recompiling the
 * same `eventTypes` pattern on every upload's hook dispatch — patterns
 * are stable for the lifetime of a `setBucketNotificationRules` call
 * and typically reused across thousands of uploads.
 */
const eventTypeRegexCache = new Map<string, RegExp>()

/**
 * Wildcard match for B2 event-type globs. Supports the prefix-glob form
 * the B2 docs document: `b2:ObjectCreated:*` matches
 * `b2:ObjectCreated:Upload`, `b2:ObjectCreated:Copy`, etc. Exact
 * matches without `*` match literally.
 *
 * @param pattern - Glob from an `EventNotificationRule.eventTypes` entry.
 * @param eventType - Concrete event type produced by the simulator.
 *
 * @returns `true` when the pattern matches the event type.
 */
function eventTypeMatches(pattern: string, eventType: string): boolean {
  if (!pattern.includes('*')) return pattern === eventType
  let compiled = eventTypeRegexCache.get(pattern)
  if (compiled === undefined) {
    // Escape regex metacharacters, then replace literal `*` with `.*`.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    compiled = new RegExp(`^${escaped}$`)
    eventTypeRegexCache.set(pattern, compiled)
  }
  return compiled.test(eventType)
}

/**
 * Build a synthetic {@link HttpResponse} from a consumed {@link FaultSpec}.
 * Mirrors the shape of real B2 error responses so the SDK's
 * `RetryTransport` / `classifyError` paths see realistic input.
 *
 * @param fault - The fault spec to render.
 *
 * @returns An `HttpResponse` ready to return from `transport.send`.
 */
function buildFaultResponse(fault: FaultSpec): HttpResponse {
  const status = fault.status ?? 503
  const code = fault.code ?? 'service_unavailable'
  const message = fault.message ?? 'simulated failure'
  const body = JSON.stringify({ status, code, message })
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (fault.retryAfter !== undefined) {
    headers.set('Retry-After', String(fault.retryAfter))
  }
  return {
    status,
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(utf8Encoder.encode(body))
        controller.close()
      },
    }),
    json: <T>() => Promise.resolve(JSON.parse(body) as T),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(utf8Encoder.encode(body).buffer as ArrayBuffer),
  }
}

class SimulatorTransport implements HttpTransport {
  constructor(private readonly sim: B2Simulator) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = request.url

    // Fault injection: synthetic failures registered via
    // `B2Simulator.injectFailure()` run BEFORE any real handler, so a
    // matched request never reaches in-memory state. This is what
    // exercises the SDK's retry / classification paths against
    // realistic error responses in tests.
    const fault = this.sim.consumeMatchingFault(url)
    if (fault !== null) {
      return buildFaultResponse(fault)
    }

    const headers: Record<string, string> = {}
    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k.toLowerCase()] = v
      }
    }

    const parsedUrl = new URL(url)
    const endpoint = parsedUrl.pathname.split('/').pop() ?? ''
    const isUpload = endpoint === 'b2_upload_file' || endpoint === 'b2_upload_part'
    const isDownload =
      parsedUrl.pathname.includes('b2_download_file_by_id') || parsedUrl.pathname.includes('/file/')

    if (isDownload) {
      const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
      const result = this.sim.handleDownload(parsedUrl.pathname + parsedUrl.search, headers, method)
      const data = result.data ?? new Uint8Array(0)
      const responseHeaders = new Headers(result.headers)
      responseHeaders.set(
        'Content-Type',
        result.headers['Content-Type'] ?? 'application/octet-stream',
      )

      // HEAD responses have no body but keep all headers (matches HTTP semantics).
      const body =
        method === 'HEAD' || result.data === null
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(data)
                controller.close()
              },
            })

      return {
        status: result.status,
        headers: responseHeaders,
        body,
        json: () => Promise.reject(new Error('Download response is not JSON')),
        text: () => Promise.resolve(utf8Decoder.decode(data)),
        arrayBuffer: () =>
          Promise.resolve(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
          ),
      }
    }

    let result: { status: number; body: unknown }

    if (isUpload && request.body) {
      const data = new Uint8Array(
        request.body instanceof ArrayBuffer
          ? request.body
          : request.body instanceof Uint8Array
            ? request.body.buffer.slice(
                request.body.byteOffset,
                request.body.byteOffset + request.body.byteLength,
              )
            : await new Response(request.body).arrayBuffer(),
      )
      result = await this.sim.handleUpload(url, headers, data)
    } else {
      let body: unknown = null
      if (request.body) {
        const text =
          typeof request.body === 'string' ? request.body : await new Response(request.body).text()
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      result = await this.sim.handleRequest(
        request.method,
        parsedUrl.origin,
        parsedUrl.pathname,
        headers,
        body,
      )
    }

    const responseBody = JSON.stringify(result.body)
    return {
      status: result.status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(utf8Encoder.encode(responseBody))
          controller.close()
        },
      }),
      json: <T>() => Promise.resolve(result.body as T),
      text: () => Promise.resolve(responseBody),
      arrayBuffer: () => Promise.resolve(utf8Encoder.encode(responseBody).buffer as ArrayBuffer),
    }
  }
}
