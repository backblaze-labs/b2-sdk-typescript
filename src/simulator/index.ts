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
import { type B2ApiVersion, b2Url, isB2ApiVersion } from '../raw/url.ts'
import { sha1Hex } from '../streams/hash.ts'
import { Capability } from '../types/auth.ts'
import { type BucketInfo, BucketRetentionMode, type BucketType } from '../types/bucket.ts'
import { DownloadClientUnauthorizedToReadMarker, DownloadHeaderName } from '../types/download.ts'
import {
  EncryptionAlgorithm,
  EncryptionMode,
  type EncryptionSetting,
  type PublicEncryptionSetting,
} from '../types/encryption.ts'
import { FileAction, type FileVersion, type ReplicationStatus } from '../types/file.ts'
import {
  type AuthToken,
  accountId as accountIdOf,
  type BucketId,
  bucketId as bucketIdOf,
  fileId as fileIdOf,
} from '../types/ids.ts'
import { type FileRetentionValue, LegalHoldValue, RetentionMode } from '../types/lock.ts'
import type { EventNotificationRule } from '../types/notifications.ts'
import type { ReplicationRule } from '../types/replication.ts'
import { hexEncode, hmacSha256 } from '../util/crypto.ts'
import { md5Base64, md5Base64Sync } from '../util/md5.ts'
import { utf8Decoder, utf8Encoder } from '../util/text-codec.ts'
import { toError } from '../util/to-error.ts'
import { isPartnerQueryEndpoint, PartnerSimulator } from './partner.ts'

const UPLOAD_TOKEN_SIGNING_KEY = ['b2 sdk typescript', 'simulator upload authorization', 'v1'].join(
  ':',
)
const SIMULATOR_MASTER_APPLICATION_KEY_ID = 'master-key-id'
const SIMULATOR_MASTER_APPLICATION_KEY = 'master-key'
const SIMULATOR_TEST_APPLICATION_KEY_ID = 'test-key-id'
const SIMULATOR_TEST_APPLICATION_KEY = 'test-key'
const SIMULATOR_APPLICATION_KEY_ID_PREFIX = 'sim_key_'
// Master capabilities granted to the simulator's implicit storage credentials.
// Object Lock capabilities are intentionally omitted: real B2 does not
// auto-grant them; tests that need them create an explicit key.
const SIMULATOR_MASTER_CAPABILITIES: readonly Capability[] = [
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
]

function apiPathParts(path: string): { endpoint: string; version: B2ApiVersion } {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  const candidate = segments.at(-2)
  return {
    endpoint: segments.at(-1) ?? '',
    version: candidate !== undefined && isB2ApiVersion(candidate) ? candidate : 'v3',
  }
}

interface BasicCredentials {
  readonly applicationKeyId: string
  readonly applicationKey: string
}

function parseBasicAuthorizationHeader(authzHeader: string | undefined): BasicCredentials | null {
  if (!authzHeader?.startsWith('Basic ')) return null
  const decoded = (() => {
    try {
      return atob(authzHeader.slice(6))
    } catch {
      return null
    }
  })()
  if (decoded === null) return null
  const idx = decoded.indexOf(':')
  if (idx <= 0 || idx === decoded.length - 1) return null
  return {
    applicationKeyId: decoded.slice(0, idx),
    applicationKey: decoded.slice(idx + 1),
  }
}

const B2_MIN_PART_NUMBER = 1
const B2_MAX_PART_NUMBER = 10_000

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(encoded: string): Uint8Array | null {
  const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/')
  const padding = (4 - (base64.length % 4)) % 4
  try {
    const binary = atob(base64.padEnd(base64.length + padding, '='))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length)
  let mismatch = left.length === right.length ? 0 : 1
  for (let i = 0; i < max; i++) {
    mismatch |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  }
  return mismatch === 0
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_JS_DATE_MS = 8.64e15

function isValidRetentionTimestamp(timestamp: number, now = Date.now()): boolean {
  return Number.isFinite(timestamp) && timestamp <= MAX_JS_DATE_MS && timestamp > now
}

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
  normalizeCreateKeyCapabilities,
  type ValidationError,
  validateBucketInfo,
  validateBucketName,
  validateBucketTypes,
  validateCorsRules,
  validateCreateKeyCapabilities,
  validateCreateKeyName,
  validateDefaultRetention,
  validateDownloadAuthorizationDuration,
  validateDownloadAuthorizationPrefix,
  validateFileInfo,
  validateFileName,
  validateLifecycleRules,
  validateMaxCount,
  validateNotificationRules,
  validateReplicationConfiguration,
} from './validation.ts'

// Re-export the documented B2 spec limit constants so callers of
// `@backblaze-labs/b2-sdk/simulator` can parameterise tests against the
// real caps without reaching into the validation submodule.
export {
  BUCKET_INFO_MAX_KEYS,
  BUCKET_INFO_VALUE_MAX,
  BUCKET_NAME_MAX,
  BUCKET_NAME_MIN,
  DOWNLOAD_AUTH_DURATION_MAX_SECONDS,
  DOWNLOAD_AUTH_DURATION_MIN_SECONDS,
  FILE_INFO_TOTAL_MAX,
  FILE_INFO_VALUE_MAX,
  FILE_NAME_MAX_BYTES,
  KEY_NAME_MAX,
  KEY_NAME_MIN,
  LIST_ENDPOINT_CAPS,
} from './validation.ts'

const DOWNLOAD_AUTH_TOKEN_BYTES = 32
const DOWNLOAD_AUTH_TOKEN_PREFIX = 'sim_dl_auth_'
const DOWNLOAD_AUTH_PURGE_BATCH_SIZE = 128

const DOWNLOAD_RESPONSE_OVERRIDE_PARAMS = [
  'b2ContentDisposition',
  'b2ContentLanguage',
  'b2ContentEncoding',
  'b2ContentType',
  'b2CacheControl',
  'b2Expires',
] as const

type DownloadResponseOverrideParam = (typeof DOWNLOAD_RESPONSE_OVERRIDE_PARAMS)[number]
type DownloadResponseOverrides = Partial<Record<DownloadResponseOverrideParam, string>>

const DOWNLOAD_RESPONSE_OVERRIDE_HEADERS: Record<DownloadResponseOverrideParam, string> = {
  b2ContentDisposition: DownloadHeaderName.ContentDisposition,
  b2ContentLanguage: DownloadHeaderName.ContentLanguage,
  b2ContentEncoding: DownloadHeaderName.ContentEncoding,
  b2ContentType: DownloadHeaderName.ContentType,
  b2CacheControl: DownloadHeaderName.CacheControl,
  b2Expires: DownloadHeaderName.Expires,
}

type DownloadAuthorizationRequestBody = {
  bucketId: string
  fileNamePrefix: string
  validDurationInSeconds: number
} & Partial<Record<DownloadResponseOverrideParam, unknown>>

function randomDownloadAuthorizationToken(): string {
  const crypto = globalThis.crypto
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('Download authorization tokens require globalThis.crypto.getRandomValues')
  }
  const bytes = new Uint8Array(DOWNLOAD_AUTH_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return `${DOWNLOAD_AUTH_TOKEN_PREFIX}${hexEncode(bytes)}`
}

function pickDownloadResponseOverrides(
  req: Partial<Record<DownloadResponseOverrideParam, unknown>>,
): DownloadResponseOverrides {
  const overrides: DownloadResponseOverrides = {}
  for (const param of DOWNLOAD_RESPONSE_OVERRIDE_PARAMS) {
    const value = req[param]
    if (typeof value === 'string') overrides[param] = value
  }
  return overrides
}

function validateDownloadResponseOverrides(
  req: Partial<Record<DownloadResponseOverrideParam, unknown>>,
): ValidationError | null {
  for (const param of DOWNLOAD_RESPONSE_OVERRIDE_PARAMS) {
    const value = req[param]
    if (value === undefined || typeof value === 'string') continue
    return { code: 'bad_request', message: `${param} must be a string` }
  }
  return null
}

interface StoredFile {
  readonly fileVersion: FileVersion
  readonly data: Uint8Array
  readonly serverSideEncryption: StoredServerSideEncryption
}

type StoredServerSideEncryption =
  | { readonly mode: 'none' }
  | { readonly mode: 'SSE-B2'; readonly algorithm: EncryptionAlgorithm }
  | {
      readonly mode: 'SSE-C'
      readonly algorithm: EncryptionAlgorithm
      readonly customerKeyDigest: string
      readonly customerKeyMd5: string
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
  readonly replicationStatus?: ReplicationStatus
  readonly serverSideEncryption: StoredServerSideEncryption
  readonly uploadTimestamp: number
  readonly parts: Map<number, StoredLargeFilePart>
}

interface StoredLargeFilePart {
  readonly data: Uint8Array
  readonly sha1: string
  readonly contentMd5: string | null
  readonly uploadTimestamp: number
}

interface StoredKey {
  readonly applicationKeyId: string
  readonly keyName: string
  readonly capabilities: readonly Capability[]
  readonly accountId: string
  readonly applicationKey: string
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly expirationTimestamp: number | null
}

interface AuthorizationGrant {
  readonly accountId: string
  readonly capabilities: readonly Capability[]
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly applicationKeyId: string | null
  readonly expirationTimestamp: number | null
}

type AuthorizationGrantResolution =
  | { readonly kind: 'ok'; readonly grant: AuthorizationGrant }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'expired' }

interface IssuedToken {
  readonly accountId: string
  readonly capabilities: readonly Capability[]
  readonly bucketIds: readonly string[] | null
  readonly namePrefix: string | null
  readonly expiresAt: number
  /**
   * The application-key ID this token was minted for, or `null`
   * for tokens minted from the implicit master credential. Set so
   * {@link B2Simulator.deleteKey} can evict every outstanding token whose
   * underlying key was just revoked — without this back-pointer
   * deleted keys keep working until the token TTL expires.
   */
  readonly applicationKeyId: string | null
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

interface DownloadAuthorizationToken {
  readonly bucketId: string
  readonly fileNamePrefix: string
  readonly expiresAt: number
  readonly responseHeaderOverrides: DownloadResponseOverrides
}

interface DownloadAuthorizationExpiry {
  readonly token: string
  readonly expiresAt: number
}

interface RequestScope {
  readonly bucketIds: readonly string[]
  readonly fileNames?: readonly string[]
  readonly requiresBucketScope: boolean
  readonly requiresAccountLevelBucketAccess?: boolean
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

function cloneCapabilities(capabilities: readonly Capability[]): readonly Capability[] {
  return [...capabilities]
}

function isImplicitStorageMasterCredential(credentials: BasicCredentials): boolean {
  return (
    (credentials.applicationKeyId === SIMULATOR_MASTER_APPLICATION_KEY_ID &&
      credentials.applicationKey === SIMULATOR_MASTER_APPLICATION_KEY) ||
    (credentials.applicationKeyId === SIMULATOR_TEST_APPLICATION_KEY_ID &&
      credentials.applicationKey === SIMULATOR_TEST_APPLICATION_KEY)
  )
}

function isImplicitPartnerMasterCredential(credentials: BasicCredentials): boolean {
  return (
    credentials.applicationKeyId === SIMULATOR_MASTER_APPLICATION_KEY_ID &&
    credentials.applicationKey === SIMULATOR_MASTER_APPLICATION_KEY
  )
}

function isSimulatorApplicationKeyId(applicationKeyId: string): boolean {
  return applicationKeyId.startsWith(SIMULATOR_APPLICATION_KEY_ID_PREFIX)
}

function hasOwnField(body: unknown, field: string): boolean {
  return typeof body === 'object' && body !== null && Object.hasOwn(body, field)
}

function requestStringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

function requestRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

function replicationDestinationBucketIds(body: unknown): readonly string[] {
  const req = requestRecord(body)
  const replicationConfiguration = requestRecord(req?.['replicationConfiguration'])
  const source = requestRecord(replicationConfiguration?.['asReplicationSource'])
  const rules = source?.['replicationRules']
  if (!Array.isArray(rules)) return []

  const bucketIds: string[] = []
  for (const rule of rules) {
    const destinationBucketId = requestRecord(rule)?.['destinationBucketId']
    if (typeof destinationBucketId === 'string') bucketIds.push(destinationBucketId)
  }
  return [...new Set(bucketIds)]
}

function normalizeReplicationConfiguration(
  config: BucketInfo['replicationConfiguration'],
): BucketInfo['replicationConfiguration'] {
  return {
    asReplicationSource: config.asReplicationSource ?? null,
    asReplicationDestination: config.asReplicationDestination ?? null,
  }
}

interface BucketConfigurationFields {
  readonly bucketInfo?: unknown
  readonly corsRules?: unknown
  readonly defaultRetention?: unknown
  readonly lifecycleRules?: unknown
  readonly replicationConfiguration?: unknown
}

function validateBucketConfigurationFields(
  fields: BucketConfigurationFields,
  options: { readonly objectLockEnabled: boolean },
): ValidationError | null {
  if (fields.bucketInfo !== undefined) {
    const infoError = validateBucketInfo(fields.bucketInfo as Record<string, string>)
    if (infoError) return infoError
  }
  if (fields.corsRules !== undefined) {
    const corsError = validateCorsRules(fields.corsRules)
    if (corsError) return corsError
  }
  if (fields.lifecycleRules !== undefined) {
    const lifecycleError = validateLifecycleRules(fields.lifecycleRules)
    if (lifecycleError) return lifecycleError
  }
  if (fields.replicationConfiguration !== undefined) {
    const replicationError = validateReplicationConfiguration(fields.replicationConfiguration)
    if (replicationError) return replicationError
  }
  if (fields.defaultRetention !== undefined) {
    const retentionError = validateDefaultRetention(fields.defaultRetention)
    if (retentionError) return retentionError
    if (
      requestRecord(fields.defaultRetention)?.['mode'] !== BucketRetentionMode.None &&
      !options.objectLockEnabled
    ) {
      return {
        code: 'file_lock_not_enabled',
        message: 'Bucket must have Object Lock enabled to set defaultRetention',
      }
    }
  }
  return null
}

function nextObjectLockEnabled(current: boolean, requested: unknown): boolean | ValidationError {
  if (requested === undefined) return current
  if (typeof requested !== 'boolean') {
    return { code: 'bad_request', message: 'fileLockEnabled must be a boolean' }
  }
  if (current && requested === false) {
    return { code: 'file_lock_conflict', message: 'Object Lock cannot be disabled' }
  }
  return current || requested
}

function requestHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const exact = headers[name]
  if (exact !== undefined) return exact
  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value
  }
  return undefined
}

type ContentLengthHeader =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly expectedLength: number }
  | { readonly kind: 'error'; readonly message: string }

function parseContentLengthHeader(headers: Record<string, string>): ContentLengthHeader {
  const header = requestHeaderValue(headers, 'content-length')
  if (header === undefined) return { kind: 'absent' }
  if (!/^\d+$/.test(header)) {
    return { kind: 'error', message: `Content-Length must be a byte count: ${header}` }
  }
  const expectedLength = Number(header)
  if (!Number.isSafeInteger(expectedLength)) {
    return { kind: 'error', message: `Content-Length is too large: ${header}` }
  }
  return { kind: 'ok', expectedLength }
}

function contentLengthMismatchMessage(expectedLength: number, actualLength: number): string {
  return `Content-Length ${expectedLength} does not match request body length ${actualLength}`
}

function fileNames(...names: readonly (string | undefined)[]): readonly string[] | undefined {
  const present = names.filter((name): name is string => name !== undefined)
  return present.length > 0 ? present : undefined
}

function queryParamsBody(params: URLSearchParams): Record<string, string> | null {
  const body = Object.create(null) as Record<string, string>
  let hasParams = false
  for (const [key, value] of params) {
    if (body[key] !== undefined) continue
    body[key] = value
    hasParams = true
  }
  return hasParams ? body : null
}

const JSON_GET_ENDPOINTS = new Set<string>([
  'b2_authorize_account',
  'b2_list_groups',
  'b2_list_group_members',
  'bz_list_computers',
])

const JSON_POST_ENDPOINTS = new Set<string>([
  'b2_create_group_member',
  'b2_eject_group_member',
  'b2_reserve_trial_create_account',
  'bz_delete_computer',
  'b2_create_bucket',
  'b2_list_buckets',
  'b2_delete_bucket',
  'b2_update_bucket',
  'b2_get_upload_url',
  'b2_list_file_names',
  'b2_list_file_versions',
  'b2_get_file_info',
  'b2_hide_file',
  'b2_delete_file_version',
  'b2_copy_file',
  'b2_start_large_file',
  'b2_get_upload_part_url',
  'b2_finish_large_file',
  'b2_cancel_large_file',
  'b2_list_unfinished_large_files',
  'b2_list_parts',
  'b2_copy_part',
  'b2_get_download_authorization',
  'b2_create_key',
  'b2_list_keys',
  'b2_delete_key',
  'b2_update_file_retention',
  'b2_update_file_legal_hold',
  'b2_get_bucket_notification_rules',
  'b2_set_bucket_notification_rules',
])

function jsonEndpointAllowsMethod(method: string, endpoint: string): boolean {
  const normalizedMethod = method.toUpperCase()
  if (JSON_GET_ENDPOINTS.has(endpoint)) return normalizedMethod === 'GET'
  if (JSON_POST_ENDPOINTS.has(endpoint)) return normalizedMethod === 'POST'
  return true
}

function notificationRulePrefixes(body: unknown): readonly string[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const rules = (body as Record<string, unknown>)['eventNotificationRules']
  if (!Array.isArray(rules)) return undefined
  return rules.map((rule) => {
    if (typeof rule !== 'object' || rule === null) return ''
    const objectNamePrefix = (rule as Record<string, unknown>)['objectNamePrefix']
    return typeof objectNamePrefix === 'string' ? objectNamePrefix : ''
  })
}

function storedNotificationRulePrefixes(
  rules: readonly EventNotificationRule[] | undefined,
): readonly string[] {
  return (rules ?? []).map((rule) =>
    typeof rule.objectNamePrefix === 'string' ? rule.objectNamePrefix : '',
  )
}

function hasKeyManagementCapability(capabilities: readonly Capability[]): boolean {
  return capabilities.some(
    (capability) =>
      capability === Capability.ListKeys ||
      capability === Capability.WriteKeys ||
      capability === Capability.DeleteKeys,
  )
}

function missingStoredKeyCapabilities(
  key: StoredKey,
  required: readonly Capability[],
): readonly Capability[] {
  const capabilities = new Set(key.capabilities)
  return required.filter((capability) => !capabilities.has(capability))
}

function storedKeyAllowsBucket(key: StoredKey, bucketId: string): boolean {
  return key.bucketIds === null || key.bucketIds.includes(bucketId)
}

function publicServerSideEncryption(
  encryption: EncryptionSetting | StoredServerSideEncryption,
): PublicEncryptionSetting {
  if (encryption.mode === EncryptionMode.SseC) {
    return { mode: encryption.mode, algorithm: encryption.algorithm }
  }
  if (encryption.mode === EncryptionMode.None) {
    return { mode: null, algorithm: null }
  }
  return encryption
}

function customerKeyDigest(customerKey: Uint8Array): string {
  let first = 0x811c9dc5
  let second = 0x27d4eb2d
  for (const byte of customerKey) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+$/

function normalizeSizedBase64(value: string, decodedByteLength: number): string | null {
  const paddedLength = Math.ceil(decodedByteLength / 3) * 4
  const noPaddingLength = Math.ceil((decodedByteLength * 8) / 6)
  const padding = '='.repeat(paddedLength - noPaddingLength)

  if (value.length === noPaddingLength && BASE64_ALPHABET.test(value)) {
    return value.padEnd(paddedLength, '=')
  }

  if (
    value.length === paddedLength &&
    value.endsWith(padding) &&
    BASE64_ALPHABET.test(value.slice(0, noPaddingLength))
  ) {
    return value
  }

  return null
}

function base64ToBytes(value: string, decodedByteLength: number): Uint8Array | null {
  const normalized = normalizeSizedBase64(value, decodedByteLength)
  if (normalized === null) return null
  try {
    const decoded = atob(normalized)
    if (decoded.length !== decodedByteLength) return null
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function encryptionValidationError(message: string): SimulatorJsonResponse {
  return { status: 400, body: { status: 400, code: 'bad_request', message } }
}

function sameStoredServerSideEncryption(
  a: StoredServerSideEncryption,
  b: StoredServerSideEncryption,
): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode === EncryptionMode.None) return true
  if (a.mode === EncryptionMode.SseB2 && b.mode === EncryptionMode.SseB2) {
    return a.algorithm === b.algorithm
  }
  if (a.mode === EncryptionMode.SseC && b.mode === EncryptionMode.SseC) {
    return (
      a.algorithm === b.algorithm &&
      a.customerKeyDigest === b.customerKeyDigest &&
      a.customerKeyMd5 === b.customerKeyMd5
    )
  }
  return false
}

function hasCustomerEncryptionFields(encryption: Record<string, unknown>): boolean {
  return (
    encryption['customerKey'] !== undefined ||
    encryption['customerKeyMd5'] !== undefined ||
    encryption['customerAlgorithm'] !== undefined
  )
}

function hasCustomerEncryptionHeaders(headers: Record<string, string>): boolean {
  return (
    headers['x-bz-server-side-encryption-customer-algorithm'] !== undefined ||
    headers['x-bz-server-side-encryption-customer-key'] !== undefined ||
    headers['x-bz-server-side-encryption-customer-key-md5'] !== undefined
  )
}

async function storedServerSideEncryption(
  encryption: EncryptionSetting,
): Promise<StoredServerSideEncryption | SimulatorJsonResponse> {
  const runtimeEncryption = encryption as unknown as Record<string, unknown>
  if (encryption.mode === EncryptionMode.SseC) {
    if (runtimeEncryption['algorithm'] === undefined) {
      return encryptionValidationError('SSE-C customer algorithm is required')
    }
    if (encryption.algorithm !== EncryptionAlgorithm.Aes256) {
      return encryptionValidationError('SSE-C customer algorithm must be AES256')
    }
    const customerKey = encryption.customerKey
    const customerKeyMd5 = encryption.customerKeyMd5
    if (typeof customerKey !== 'string' || customerKey === '') {
      return encryptionValidationError('SSE-C customer key is required')
    }
    if (typeof customerKeyMd5 !== 'string' || customerKeyMd5 === '') {
      return encryptionValidationError('SSE-C customer key MD5 is required')
    }
    const customerKeyBytes = base64ToBytes(customerKey, 32)
    if (customerKeyBytes === null) {
      return encryptionValidationError('SSE-C customer key must be a base64-encoded 256-bit key')
    }
    const normalizedCustomerKeyMd5 = normalizeSizedBase64(customerKeyMd5, 16)
    if (normalizedCustomerKeyMd5 === null) {
      return encryptionValidationError(
        'SSE-C customer key MD5 must be a base64-encoded 128-bit digest',
      )
    }
    const actualMd5 = await md5Base64(customerKeyBytes)
    if (actualMd5 !== normalizedCustomerKeyMd5) {
      return encryptionValidationError('SSE-C customer key MD5 does not match the key')
    }
    return {
      mode: encryption.mode,
      algorithm: encryption.algorithm,
      customerKeyDigest: customerKeyDigest(customerKeyBytes),
      customerKeyMd5: normalizedCustomerKeyMd5,
    }
  }
  if (encryption.mode === EncryptionMode.SseB2) {
    if (hasCustomerEncryptionFields(runtimeEncryption)) {
      return encryptionValidationError('SSE-B2 settings must not include SSE-C customer keys')
    }
    if (encryption.algorithm !== EncryptionAlgorithm.Aes256) {
      return encryptionValidationError('SSE-B2 algorithm must be AES256')
    }
    return { mode: encryption.mode, algorithm: encryption.algorithm }
  }
  if (encryption.mode === EncryptionMode.None) {
    if (hasCustomerEncryptionFields(runtimeEncryption)) {
      return encryptionValidationError(
        'No-encryption settings must not include SSE-C customer keys',
      )
    }
    return { mode: EncryptionMode.None }
  }

  return encryptionValidationError(
    `Unsupported server-side encryption mode: ${String(runtimeEncryption['mode'])}`,
  )
}

async function uploadServerSideEncryption(
  headers: Record<string, string>,
  fallback: EncryptionSetting,
): Promise<StoredServerSideEncryption | SimulatorJsonResponse> {
  const customerAlgorithm = headers['x-bz-server-side-encryption-customer-algorithm']
  const customerKey = headers['x-bz-server-side-encryption-customer-key']
  const customerKeyMd5 = headers['x-bz-server-side-encryption-customer-key-md5']
  const managedEncryption = headers['x-bz-server-side-encryption']
  if (hasCustomerEncryptionHeaders(headers)) {
    if (managedEncryption !== undefined) {
      return encryptionValidationError('SSE-B2 settings must not include SSE-C customer keys')
    }
    if (customerAlgorithm === undefined) {
      return encryptionValidationError('SSE-C customer algorithm is required')
    }
    if (customerAlgorithm !== EncryptionAlgorithm.Aes256) {
      return encryptionValidationError('SSE-C customer algorithm must be AES256')
    }
    if (!customerKey || !customerKeyMd5) {
      return encryptionValidationError('SSE-C customer key and MD5 are required')
    }
    return await storedServerSideEncryption({
      mode: EncryptionMode.SseC,
      algorithm: EncryptionAlgorithm.Aes256,
      customerKey,
      customerKeyMd5,
    })
  }

  if (managedEncryption !== undefined) {
    if (managedEncryption !== EncryptionAlgorithm.Aes256) {
      return encryptionValidationError('SSE-B2 algorithm must be AES256')
    }
    return { mode: EncryptionMode.SseB2, algorithm: EncryptionAlgorithm.Aes256 }
  }

  return await storedServerSideEncryption(fallback)
}

function defaultFileRetention(
  policy: BucketInfo['defaultRetention'],
  uploadTimestamp: number,
): FileRetentionValue | null {
  if (policy.mode === BucketRetentionMode.None || policy.period === null) return null
  const days = policy.period.unit === 'days' ? policy.period.duration : policy.period.duration * 365
  const retainUntilTimestamp = uploadTimestamp + days * MS_PER_DAY
  if (!isValidRetentionTimestamp(retainUntilTimestamp, uploadTimestamp)) return null
  return {
    mode: policy.mode as RetentionMode,
    retainUntilTimestamp,
  }
}

function isRetentionMode(value: unknown): value is RetentionMode {
  return value === RetentionMode.Compliance || value === RetentionMode.Governance
}

function parseFileRetentionValue(value: unknown, now: number): FileRetentionValue | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  const mode = candidate['mode']
  const retainUntilTimestamp = candidate['retainUntilTimestamp']

  if (mode === null && retainUntilTimestamp === null) {
    return { mode, retainUntilTimestamp }
  }
  if (isRetentionMode(mode) && typeof retainUntilTimestamp === 'number') {
    if (!isValidRetentionTimestamp(retainUntilTimestamp, now)) return null
    return { mode, retainUntilTimestamp }
  }
  return null
}

function isRetentionWeakened(
  current: FileRetentionValue | null | undefined,
  next: FileRetentionValue,
): boolean {
  if (current === null || current === undefined) return false
  if (current.mode === null) return false
  if (next.mode === null) return true
  if (current.mode === RetentionMode.Compliance && next.mode !== RetentionMode.Compliance) {
    return true
  }
  if (current.retainUntilTimestamp === null) return next.mode !== current.mode
  if (next.retainUntilTimestamp === null) return true
  return next.retainUntilTimestamp < current.retainUntilTimestamp
}

function requiresGovernanceBypass(
  current: FileRetentionValue | null | undefined,
  next: FileRetentionValue,
): boolean {
  if (current?.mode !== RetentionMode.Governance) return false
  if (next.mode === RetentionMode.Compliance) return true
  return isRetentionWeakened(current, next)
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
   * long-standing behaviour): any well-formed Basic credential whose
   * applicationKeyId is not a simulator-created key receives the
   * implicit master grant, so tests do not have to set up keys with
   * the right capabilities. Created keys always authorize with their
   * stored capabilities, bucket scope, name prefix, and expiration;
   * a wrong or expired created-key secret is rejected.
   *
   * Upload authorization tokens returned by `b2_get_upload_url` and
   * `b2_get_upload_part_url` are always enforced, regardless of this
   * option. Upload handlers reject missing, unknown, expired, or
   * wrong-URL upload tokens in both permissive and strict modes.
   *
   * In strict mode:
   *
   * - `b2_authorize_account` still accepts the documented implicit
   *   master credentials `test-key-id:test-key` and
   *   `master-key-id:master-key`.
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
  /**
   * When `true`, v3 `b2_authorize_account` responses include Partner and
   * Computer Backup suites and issue Partner authorization tokens. Partner
   * and Backup endpoint calls then require one of those issued tokens, even
   * when `strictAuth` is otherwise disabled, so SDK auth-error paths can test
   * documented 401 responses.
   *
   * Defaults to `false`: direct Partner/Backup endpoint tests remain
   * permissive and accept any non-empty, whitespace-free Partner token without
   * requiring an authorize call first.
   */
  partnerAuthorize?: boolean
  /**
   * Whether Partner API endpoints should accept issued Partner authorization
   * tokens. Defaults to `true`. Set to `false` to exercise documented
   * `403 access_denied` prerequisite failures.
   */
  partnerApiEnabled?: boolean
  /**
   * Whether the simulated partner administrator has a valid phone number.
   * Defaults to `true`; `false` produces Partner prerequisite failures
   * such as `403 access_denied` or `401 invalid_sms_phone` depending on
   * the endpoint's documented error shape.
   */
  partnerAccountHasValidPhone?: boolean
  /**
   * Whether the simulated partner administrator account is in good standing.
   * Defaults to `true`; `false` produces `403 access_denied` on Partner calls.
   */
  partnerAccountInGoodStanding?: boolean
  /**
   * Whether the simulated account may set custom upload timestamps on
   * `b2_upload_file` and `b2_start_large_file`. Defaults to `false`, matching
   * production accounts without the restricted feature enabled.
   */
  customUploadTimestampsEnabled?: boolean
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
 *
 * `test-key-id:test-key` is the documented implicit full-access
 * storage credential. `master-key-id:master-key` is also accepted for
 * tests that share storage and Partner simulator credentials. In the
 * default permissive mode, other well-formed Basic credentials whose
 * applicationKeyId was not minted by `b2_create_key` receive the same
 * implicit master grant for backward compatibility. A simulator-created
 * key always authorizes with its own capabilities, bucket restrictions,
 * name prefix, and expiration.
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
  private readonly customUploadTimestampsEnabled: boolean
  private readonly partner: PartnerSimulator
  /**
   * Issued auth tokens with their associated grant scope + expiry. In
   * permissive mode (`strictAuth: false`) this is still populated by
   * `authorize` but never consulted on subsequent requests. In strict
   * mode each request looks up its `Authorization` header here.
   */
  private readonly issuedTokens = new Map<string, IssuedToken>()
  /**
   * Mutable upload-token overrides for tokens minted by `b2_get_upload_url`
   * and `b2_get_upload_part_url`. The token string is self-describing
   * and signed so another simulator instance can validate issued-token
   * state, while this map records local invalidation / forced-expiry
   * state for tests.
   */
  private readonly uploadTokens = new Map<string, StoredUploadToken>()
  private readonly downloadAuthorizationTokens = new Map<string, DownloadAuthorizationToken>()
  private readonly downloadAuthorizationExpiryHeap: DownloadAuthorizationExpiry[] = []
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
    this.customUploadTimestampsEnabled = options.customUploadTimestampsEnabled ?? false
    // Real B2 tokens last 24h. Default matches production; tests that
    // want to exercise the reauth path can lower this knob.
    this.authTokenTtlMs = options.authTokenTtlMs ?? 24 * 60 * 60 * 1000
    this.partner = new PartnerSimulator(
      {
        accountId: this.accountId,
        authTokenTtlMs: this.authTokenTtlMs,
        minimumPartSize: this.minimumPartSize,
        recommendedPartSize: this.recommendedPartSize,
        canAuthorize: (authzHeader) => this.canAuthorizePartner(authzHeader),
        createBucket: (req) => this.createBucket(req),
        error: (status, code, message) => this.error(status, code, message),
        genId: (prefix) => this.genId(prefix),
        monotonicTimestamp: () => this.monotonicTimestamp(),
        now: () => this.now(),
        storeKey: (key) => {
          this.keys.set(key.applicationKeyId, key)
        },
      },
      options,
    )
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
    const token = this.uploadTokens.get(authorizationToken)
    if (token === undefined || now >= token.cleanupAt) return false
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
    const token = this.uploadTokens.get(authorizationToken)
    if (token === undefined || now >= token.cleanupAt) {
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

  private isStoredKeyExpired(key: StoredKey): boolean {
    return key.expirationTimestamp !== null && key.expirationTimestamp <= this.now()
  }

  private pruneExpiredUploadTokens(now = this.now()): void {
    for (const [authorizationToken, token] of this.uploadTokens.entries()) {
      if (now >= token.cleanupAt) {
        this.uploadTokens.delete(authorizationToken)
      }
    }
  }

  private async uploadTokenState(authorizationToken: string): Promise<StoredUploadToken | null> {
    const stored = this.uploadTokens.get(authorizationToken)
    if (stored !== undefined) return stored
    return await this.decodeUploadAuthorizationToken(authorizationToken)
  }

  private async encodeUploadAuthorizationToken(token: StoredUploadToken): Promise<string> {
    const payload: UploadTokenPayload = {
      v: 1,
      kind: token.kind,
      fileName: token.fileName,
      uploadUrl: token.uploadUrl,
      namePrefix: token.namePrefix,
      applicationKeyId: token.applicationKeyId,
      expiresAt: token.expiresAt,
    }
    const encoded = base64UrlEncode(utf8Encoder.encode(JSON.stringify(payload)))
    const signature = await this.signUploadTokenPayload(encoded)
    const prefix = token.kind === 'file' ? 'sim_upload_auth' : 'sim_part_auth'
    return `${prefix}_${encoded}.${signature}`
  }

  private async decodeUploadAuthorizationToken(
    authorizationToken: string,
  ): Promise<StoredUploadToken | null> {
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
    const tokenParts = encoded.split('.')
    if (tokenParts.length !== 2) return null
    const [payloadBytes, signature] = tokenParts as [string, string]
    const expectedSignature = await this.signUploadTokenPayload(payloadBytes)
    if (!timingSafeStringEqual(signature, expectedSignature)) return null

    let parsed: unknown
    try {
      const bytes = base64UrlDecode(payloadBytes)
      if (bytes === null) return null
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
      !(payload['namePrefix'] === null || typeof payload['namePrefix'] === 'string') ||
      !(payload['applicationKeyId'] === null || typeof payload['applicationKeyId'] === 'string')
    ) {
      return null
    }
    let fileName: string | null
    if (expectedKind === 'part') {
      if (typeof payload['fileName'] !== 'string') return null
      fileName = payload['fileName']
    } else {
      if (payload['fileName'] !== null) return null
      fileName = null
    }
    return {
      kind: expectedKind,
      fileName,
      uploadUrl: payload['uploadUrl'],
      namePrefix: payload['namePrefix'],
      applicationKeyId: payload['applicationKeyId'],
      expiresAt: payload['expiresAt'],
      cleanupAt: payload['expiresAt'],
      invalidated: false,
    }
  }

  private async signUploadTokenPayload(encodedPayload: string): Promise<string> {
    return base64UrlEncode(await hmacSha256(UPLOAD_TOKEN_SIGNING_KEY, encodedPayload))
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
    if (token.applicationKeyId !== null) {
      const key = this.keys.get(token.applicationKeyId)
      if (key === undefined) {
        return this.error(401, 'bad_auth_token', 'application key has been deleted; reauthorize')
      }
      if (this.isStoredKeyExpired(key)) {
        return this.error(401, 'expired_auth_token', 'application key has expired; reauthorize')
      }
    }
    const missing = missingCapabilitiesFor(endpoint, token.capabilities)
    if (missing.length > 0) {
      return this.error(
        403,
        'unauthorized',
        `application key lacks required capabilities: ${missing.join(', ')}`,
      )
    }
    return this.authorizeScopeGrant(scope, {
      bucketIds: token.bucketIds,
      namePrefix: token.namePrefix,
      bucketScopeRequiredMessage: () =>
        `application key is scoped to buckets ${token.bucketIds?.join(', ')}; bucket scope is required`,
      bucketMismatchMessage: (bucketId) =>
        `application key is scoped to buckets ${token.bucketIds?.join(', ')}; cannot access ${bucketId}`,
      prefixMismatchMessage: (fileName) =>
        `application key is scoped to prefix "${token.namePrefix}"; "${fileName}" is outside scope`,
    })
  }

  private authorizeScopeGrant(
    scope: RequestScope | undefined,
    grant: {
      readonly bucketIds: readonly string[] | null
      readonly namePrefix: string | null
      readonly bucketScopeRequiredMessage: () => string
      readonly bucketMismatchMessage: (bucketId: string) => string
      readonly prefixMismatchMessage: (fileName: string) => string
    },
  ): SimulatorJsonResponse | null {
    if (grant.bucketIds !== null) {
      if (scope?.requiresAccountLevelBucketAccess === true) {
        return this.error(403, 'unauthorized', grant.bucketScopeRequiredMessage())
      }
      if ((scope?.bucketIds.length ?? 0) === 0 && scope?.requiresBucketScope === true) {
        return this.error(403, 'unauthorized', grant.bucketScopeRequiredMessage())
      }
      for (const bucketId of scope?.bucketIds ?? []) {
        if (grant.bucketIds.includes(bucketId)) continue
        return this.error(403, 'unauthorized', grant.bucketMismatchMessage(bucketId))
      }
    }
    if (grant.namePrefix !== null) {
      for (const fileName of scope?.fileNames ?? []) {
        if (fileName.startsWith(grant.namePrefix)) continue
        return this.error(403, 'unauthorized', grant.prefixMismatchMessage(fileName))
      }
    }
    return null
  }

  private authorizeDownloadRequest(
    authToken: string | undefined,
    endpoint: 'b2_download_file_by_id' | 'b2_download_file_by_name',
    scope: RequestScope,
    url: URL,
  ): SimulatorJsonResponse | null {
    if (authToken === undefined || authToken === '') {
      return this.error(401, 'bad_auth_token', 'missing authorization token')
    }

    const downloadAuth = this.downloadAuthorizationTokens.get(authToken)
    if (downloadAuth === undefined) {
      this.purgeExpiredDownloadAuthorizationTokens()
      return this.authorizeRequest(authToken, endpoint, scope)
    }
    if (this.isExpiredDownloadAuthorizationToken(downloadAuth)) {
      this.downloadAuthorizationTokens.delete(authToken)
      this.purgeExpiredDownloadAuthorizationTokens()
      return this.error(401, 'expired_auth_token', 'download authorization token has expired')
    }
    if (endpoint === 'b2_download_file_by_id') {
      return this.error(
        403,
        'unauthorized',
        'download authorization tokens cannot be used with b2_download_file_by_id',
      )
    }
    const overrideError = this.authorizeDownloadResponseOverrides(downloadAuth, url)
    if (overrideError !== null) return overrideError
    return this.authorizeScopeGrant(scope, {
      bucketIds: [downloadAuth.bucketId],
      namePrefix: downloadAuth.fileNamePrefix,
      bucketScopeRequiredMessage: () =>
        `download authorization is scoped to bucket ${downloadAuth.bucketId}; bucket scope is required`,
      bucketMismatchMessage: (bucketId) =>
        `download authorization is scoped to bucket ${downloadAuth.bucketId}; cannot access ${bucketId}`,
      prefixMismatchMessage: (fileName) =>
        `download authorization is scoped to prefix "${downloadAuth.fileNamePrefix}"; "${fileName}" is outside scope`,
    })
  }

  private isExpiredDownloadAuthorizationToken(
    token: DownloadAuthorizationToken,
    now = this.now(),
  ): boolean {
    return now >= token.expiresAt
  }

  private purgeExpiredDownloadAuthorizationTokens(): void {
    const now = this.now()
    for (let i = 0; i < DOWNLOAD_AUTH_PURGE_BATCH_SIZE; i++) {
      const next = this.downloadAuthorizationExpiryHeap[0]
      if (next === undefined || next.expiresAt > now) return
      this.popDownloadAuthorizationExpiry()
      const current = this.downloadAuthorizationTokens.get(next.token)
      if (current?.expiresAt === next.expiresAt) {
        this.downloadAuthorizationTokens.delete(next.token)
      }
    }
  }

  private pushDownloadAuthorizationExpiry(entry: DownloadAuthorizationExpiry): void {
    const heap = this.downloadAuthorizationExpiryHeap
    heap.push(entry)
    let idx = heap.length - 1
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2)
      const parent = heap[parentIdx] as DownloadAuthorizationExpiry
      if (parent.expiresAt <= entry.expiresAt) break
      heap[idx] = parent
      idx = parentIdx
    }
    heap[idx] = entry
  }

  private popDownloadAuthorizationExpiry(): DownloadAuthorizationExpiry | undefined {
    const heap = this.downloadAuthorizationExpiryHeap
    const root = heap[0]
    const last = heap.pop()
    if (root === undefined || last === undefined || heap.length === 0) return root

    let idx = 0
    while (true) {
      const leftIdx = idx * 2 + 1
      const rightIdx = leftIdx + 1
      const left = heap[leftIdx]
      const right = heap[rightIdx]
      if (left === undefined) break

      const childIdx = right !== undefined && right.expiresAt < left.expiresAt ? rightIdx : leftIdx
      const child = heap[childIdx] as DownloadAuthorizationExpiry
      if (child.expiresAt >= last.expiresAt) break
      heap[idx] = child
      idx = childIdx
    }
    heap[idx] = last
    return root
  }

  private authorizeDownloadResponseOverrides(
    downloadAuth: DownloadAuthorizationToken,
    url: URL,
  ): SimulatorJsonResponse | null {
    for (const param of DOWNLOAD_RESPONSE_OVERRIDE_PARAMS) {
      const expected = downloadAuth.responseHeaderOverrides[param]
      if (expected === undefined) continue
      const actual = url.searchParams.get(param)
      if (actual === expected) continue
      const expectedText = JSON.stringify(expected)
      const actualText = actual === null ? 'absent' : JSON.stringify(actual)
      return this.error(
        403,
        'unauthorized',
        `download authorization requires ${param}=${expectedText}; got ${actualText}`,
      )
    }
    return null
  }

  private downloadAuthorizationFromRequest(
    headers: Record<string, string>,
    url: URL,
    options: { readonly allowQueryAuthorization?: boolean } = {},
  ): string | undefined {
    const headerToken = requestHeaderValue(headers, 'authorization')
    if (headerToken !== undefined) return headerToken
    if (options.allowQueryAuthorization !== true) return undefined
    const queryToken =
      url.searchParams.get('Authorization') ?? url.searchParams.get('authorization')
    return queryToken?.startsWith(DOWNLOAD_AUTH_TOKEN_PREFIX) ? queryToken : undefined
  }

  private requestHasCapability(authToken: string | undefined, capability: Capability): boolean {
    if (!this.strictAuth) return true
    if (authToken === undefined) return false
    return this.issuedTokens.get(authToken)?.capabilities.includes(capability) === true
  }

  private requireFileLockEnabled(bucket: StoredBucket): SimulatorJsonResponse | null {
    if (bucket.info.fileLockConfiguration.value?.isFileLockEnabled === true) return null
    return this.error(400, 'file_lock_not_enabled', 'Bucket does not have file lock enabled')
  }

  private requireGovernanceBypass(
    req: { bypassGovernance?: boolean },
    authToken: string | undefined,
    message: string,
  ): SimulatorJsonResponse | null {
    if (req.bypassGovernance !== true) {
      return this.error(400, 'file_lock_governance_protected', message)
    }
    if (!this.requestHasCapability(authToken, Capability.BypassGovernance)) {
      return this.error(
        403,
        'unauthorized',
        `application key lacks required capabilities: ${Capability.BypassGovernance}`,
      )
    }
    return null
  }

  private validateReplicationApplicationKey(
    applicationKeyId: string,
    requiredCapabilities: readonly Capability[],
    options: { readonly bucketId?: string | undefined; readonly role: string },
  ): SimulatorJsonResponse | null {
    const key = this.keys.get(applicationKeyId)
    if (key === undefined) {
      return this.invalidReplicationApplicationKey(options.role)
    }
    const missing = missingStoredKeyCapabilities(key, requiredCapabilities)
    if (missing.length > 0) {
      return this.invalidReplicationApplicationKey(options.role)
    }
    if (options.bucketId !== undefined && !storedKeyAllowsBucket(key, options.bucketId)) {
      return this.invalidReplicationApplicationKey(options.role)
    }
    return null
  }

  private invalidReplicationApplicationKey(role: string): SimulatorJsonResponse {
    return this.error(
      400,
      'bad_request',
      `${role} application key is invalid or not authorized for this replication configuration`,
    )
  }

  private invalidReplicationDestinationBucket(): SimulatorJsonResponse {
    return this.error(
      400,
      'bad_request',
      'replication destination bucket is invalid or not configured for this source application key',
    )
  }

  private validateReplicationDestinationBuckets(
    sourceApplicationKeyId: string,
    rules: readonly unknown[],
  ): SimulatorJsonResponse | null {
    for (const rule of rules) {
      const destinationBucketId = requestRecord(rule)?.['destinationBucketId']
      if (typeof destinationBucketId !== 'string') continue

      const destinationBucket = this.buckets.get(destinationBucketId)
      const destinationApplicationKeyId =
        destinationBucket?.info.replicationConfiguration.asReplicationDestination
          ?.sourceToDestinationKeyMapping[sourceApplicationKeyId]
      if (destinationApplicationKeyId === undefined) {
        return this.invalidReplicationDestinationBucket()
      }

      const destinationKeyError = this.validateReplicationApplicationKey(
        destinationApplicationKeyId,
        [Capability.WriteFiles],
        { bucketId: destinationBucketId, role: 'replication destination' },
      )
      if (destinationKeyError !== null) return destinationKeyError
    }
    return null
  }

  private validateReplicationApplicationKeys(
    config: unknown,
    bucketId: string | undefined,
  ): SimulatorJsonResponse | null {
    if (!this.strictAuth || config === undefined) return null

    const replicationConfiguration = requestRecord(config)
    const source = requestRecord(replicationConfiguration?.['asReplicationSource'])
    if (source !== null) {
      const sourceApplicationKeyId = source['sourceApplicationKeyId']
      if (typeof sourceApplicationKeyId === 'string') {
        const sourceKeyError = this.validateReplicationApplicationKey(
          sourceApplicationKeyId,
          [Capability.ReadFiles, Capability.ListFiles],
          { bucketId, role: 'replication source' },
        )
        if (sourceKeyError !== null) return sourceKeyError
      }
      const rules = source['replicationRules']
      if (typeof sourceApplicationKeyId === 'string' && Array.isArray(rules)) {
        const destinationError = this.validateReplicationDestinationBuckets(
          sourceApplicationKeyId,
          rules,
        )
        if (destinationError !== null) return destinationError
      }
    }

    const destination = requestRecord(replicationConfiguration?.['asReplicationDestination'])
    const mapping = requestRecord(destination?.['sourceToDestinationKeyMapping'])
    if (mapping !== null) {
      for (const [sourceApplicationKeyId, destinationApplicationKeyId] of Object.entries(mapping)) {
        const sourceKeyError = this.validateReplicationApplicationKey(
          sourceApplicationKeyId,
          [Capability.ReadFiles, Capability.ListFiles],
          { role: 'replication source' },
        )
        if (sourceKeyError !== null) return sourceKeyError

        if (typeof destinationApplicationKeyId === 'string') {
          const destinationKeyError = this.validateReplicationApplicationKey(
            destinationApplicationKeyId,
            [Capability.WriteFiles],
            { bucketId, role: 'replication destination' },
          )
          if (destinationKeyError !== null) return destinationKeyError
        }
      }
    }

    return null
  }

  private requestScope(endpoint: string, body: unknown): RequestScope | undefined {
    const directBucketId = requestStringField(body, 'bucketId')
    const directFileName = requestStringField(body, 'fileName')

    switch (endpoint) {
      case 'b2_create_bucket':
        return this.createBucketScope(body)
      case 'b2_list_buckets':
        return this.listBucketsScope(body, directBucketId)
      case 'b2_list_file_names':
      case 'b2_list_file_versions':
        return {
          bucketIds: directBucketId === undefined ? [] : [directBucketId],
          fileNames: [requestStringField(body, 'prefix') ?? ''],
          requiresBucketScope: true,
        }
      case 'b2_get_file_info':
        return (
          this.fileIdScope(requestStringField(body, 'fileId')) ?? {
            bucketIds: [],
            requiresBucketScope: true,
          }
        )
      case 'b2_delete_file_version':
      case 'b2_update_file_retention':
      case 'b2_update_file_legal_hold':
        return this.fileVersionScope(body, directFileName)
      case 'b2_get_upload_part_url':
      case 'b2_finish_large_file':
      case 'b2_cancel_large_file':
      case 'b2_list_parts':
        return (
          this.largeFileScope(requestStringField(body, 'fileId')) ?? {
            bucketIds: [],
            requiresBucketScope: true,
          }
        )
      case 'b2_copy_file':
        return this.copyFileScope(body, directFileName)
      case 'b2_copy_part':
        return this.copyPartScope(body)
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
      case 'b2_get_bucket_notification_rules':
        return this.notificationRulesScope(body, directBucketId, false)
      case 'b2_set_bucket_notification_rules':
        return this.notificationRulesScope(body, directBucketId, true)
      case 'b2_update_bucket':
        return this.updateBucketScope(body, directBucketId)
      default:
        return this.defaultRequestScope(directBucketId, directFileName)
    }
  }

  private createBucketScope(body: unknown): RequestScope {
    return {
      bucketIds: replicationDestinationBucketIds(body),
      requiresBucketScope: true,
      requiresAccountLevelBucketAccess: true,
    }
  }

  private updateBucketScope(body: unknown, directBucketId: string | undefined): RequestScope {
    return {
      bucketIds: [
        ...(directBucketId === undefined ? [] : [directBucketId]),
        ...replicationDestinationBucketIds(body),
      ],
      requiresBucketScope: true,
    }
  }

  private listBucketsScope(body: unknown, directBucketId: string | undefined): RequestScope {
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

  private fileVersionScope(body: unknown, directFileName: string | undefined): RequestScope {
    const fileScope = this.fileIdScope(requestStringField(body, 'fileId'))
    if (fileScope !== undefined) return fileScope
    return {
      bucketIds: [],
      ...(directFileName !== undefined ? { fileNames: [directFileName] } : {}),
      requiresBucketScope: true,
    }
  }

  private copyFileScope(body: unknown, directFileName: string | undefined): RequestScope {
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

  private copyPartScope(body: unknown): RequestScope {
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

  private notificationRulesScope(
    body: unknown,
    directBucketId: string | undefined,
    includeRequestRules: boolean,
  ): RequestScope {
    const existingPrefixes =
      directBucketId === undefined
        ? []
        : storedNotificationRulePrefixes(this.notificationRules.get(directBucketId))
    const requestPrefixes = includeRequestRules ? (notificationRulePrefixes(body) ?? []) : []
    const prefixes = [...existingPrefixes, ...requestPrefixes]
    return {
      bucketIds: directBucketId === undefined ? [] : [directBucketId],
      ...(prefixes.length > 0 ? { fileNames: prefixes } : {}),
      requiresBucketScope: true,
    }
  }

  private defaultRequestScope(
    directBucketId: string | undefined,
    directFileName: string | undefined,
  ): RequestScope | undefined {
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

  private async issueUploadAuthorization(
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
  ): Promise<{ uploadUrl: string; authorizationToken: string }> {
    const now = this.now()
    this.pruneExpiredUploadTokens(now)
    const endpoint = options.kind === 'file' ? 'b2_upload_file' : 'b2_upload_part'
    const idParam = options.kind === 'file' ? 'bucketId' : 'fileId'
    const scopedId = options.kind === 'file' ? options.bucketId : options.fileId
    const uploadId = this.genId(options.kind === 'file' ? 'upload_file' : 'upload_part')
    const uploadUrl = new URL(b2Url('http://localhost:0', { version: 'v3', endpoint }))
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
    const authorizationToken = await this.encodeUploadAuthorizationToken(token)
    this.uploadTokens.set(authorizationToken, token)
    return { uploadUrl: uploadUrl.toString(), authorizationToken }
  }

  private async validateUploadAuthorization(
    kind: UploadTokenKind,
    uploadUrl: string,
    authToken: string | undefined,
    fileName: string | undefined,
  ): Promise<SimulatorJsonResponse | null> {
    if (authToken === undefined || authToken === '') {
      return this.error(401, 'bad_auth_token', 'missing upload Authorization header')
    }

    const token = await this.uploadTokenState(authToken)
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
   * Resolve the application key matching the `Authorization` header on
   * an `authorize_account` request. The header is in the form
   * `Basic base64(applicationKeyId:applicationKey)`.
   *
   * The simulator has two implicit full-access storage credentials:
   * the documented `test-key-id:test-key` pair used by SDK tests and
   * `master-key-id:master-key`. In default permissive mode, any other
   * well-formed Basic credential whose applicationKeyId is not a stored
   * key also receives that implicit master grant for backward
   * compatibility. A credential whose applicationKeyId matches a stored
   * key must use the stored secret and must not be expired.
   *
   * @param authzHeader - Raw HTTP `Authorization` header value.
   *
   * @returns The authorizing key's grant scope or the rejection reason.
   */
  private findAuthorizationGrant(authzHeader: string | undefined): AuthorizationGrantResolution {
    const credentials = parseBasicAuthorizationHeader(authzHeader)
    if (credentials === null) return { kind: 'invalid' }
    const stored = this.keys.get(credentials.applicationKeyId)
    if (stored !== undefined) {
      if (!timingSafeStringEqual(stored.applicationKey, credentials.applicationKey)) {
        return { kind: 'invalid' }
      }
      if (this.isStoredKeyExpired(stored)) return { kind: 'expired' }
      return {
        kind: 'ok',
        grant: {
          capabilities: stored.capabilities,
          bucketIds: stored.bucketIds,
          namePrefix: stored.namePrefix,
          applicationKeyId: credentials.applicationKeyId,
          accountId: stored.accountId,
          expirationTimestamp: stored.expirationTimestamp,
        },
      }
    }
    if (isSimulatorApplicationKeyId(credentials.applicationKeyId)) return { kind: 'invalid' }
    if (isImplicitStorageMasterCredential(credentials) || !this.strictAuth) {
      return {
        kind: 'ok',
        grant: {
          capabilities: SIMULATOR_MASTER_CAPABILITIES,
          bucketIds: null,
          namePrefix: null,
          applicationKeyId: null,
          accountId: this.accountId,
          expirationTimestamp: null,
        },
      }
    }
    return { kind: 'invalid' }
  }

  private canAuthorizePartner(authzHeader: string | undefined): boolean {
    const credentials = parseBasicAuthorizationHeader(authzHeader)
    if (credentials === null) return false
    if (isImplicitPartnerMasterCredential(credentials)) return true
    const stored = this.keys.get(credentials.applicationKeyId)
    return (
      stored !== undefined &&
      stored.accountId === this.accountId &&
      !this.isStoredKeyExpired(stored) &&
      timingSafeStringEqual(stored.applicationKey, credentials.applicationKey)
    )
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
   * @param method - The HTTP method.
   * @param origin - The request URL origin used for simulator-issued endpoints.
   * @param path - The request URL path containing the B2 endpoint name.
   * @param headers - The HTTP request headers; consulted by the
   *   strict-auth gate to look up the issued auth token.
   * @param body - The parsed JSON request body.
   *
   * @returns An object with HTTP status and JSON response body.
   */
  async handleRequest(
    method: string,
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<SimulatorJsonResponse> {
    const { endpoint, version } = apiPathParts(path)
    if (!jsonEndpointAllowsMethod(method, endpoint)) {
      return this.error(
        405,
        'method_not_allowed',
        `${endpoint} does not support ${method.toUpperCase()}`,
      )
    }

    // Strict-mode auth gate runs BEFORE the dispatch so even endpoints
    // that don't otherwise consult headers (e.g. b2_list_buckets) get
    // capability and scope checks.
    if (this.strictAuth && !this.partner.isEndpoint(endpoint)) {
      const authError = this.authorizeRequest(
        headers['authorization'],
        endpoint,
        this.requestScope(endpoint, body),
      )
      if (authError !== null) return authError
    }

    switch (endpoint) {
      case 'b2_authorize_account':
        if (version === 'v3' && this.partner.isAuthorizeEnabled()) {
          return this.partner.authorize(headers['authorization'], origin)
        }
        return this.authorize(headers['authorization'], origin)
      case 'b2_create_group_member':
        return this.partner.createGroupMember(body, headers['authorization'])
      case 'b2_eject_group_member':
        return this.partner.ejectGroupMember(body, headers['authorization'])
      case 'b2_list_groups':
        return this.partner.listGroups(body, headers['authorization'])
      case 'b2_list_group_members':
        return this.partner.listGroupMembers(body, headers['authorization'])
      case 'b2_reserve_trial_create_account':
        return this.partner.reserveTrialCreateAccount(body, headers['authorization'])
      case 'bz_list_computers':
        return this.partner.listComputers(body, headers['authorization'])
      case 'bz_delete_computer':
        return this.partner.deleteComputer(body, headers['authorization'])
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
        return await this.getUploadUrl(body as { bucketId: string }, headers['authorization'])
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
          headers['authorization'],
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
            sourceServerSideEncryption?: EncryptionSetting
            destinationServerSideEncryption?: EncryptionSetting
          },
        )
      case 'b2_start_large_file':
        return await this.startLargeFile(
          body as {
            bucketId: string
            fileName: string
            contentType: string
            customUploadTimestamp?: string | null
            fileInfo?: Record<string, string>
            fileRetention?: FileRetentionValue
            legalHold?: LegalHoldValue
            serverSideEncryption?: EncryptionSetting
          },
        )
      case 'b2_get_upload_part_url':
        return await this.getUploadPartUrl(body as { fileId: string }, headers['authorization'])
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
            sourceServerSideEncryption?: EncryptionSetting
            destinationServerSideEncryption?: EncryptionSetting
          },
        )
      case 'b2_get_download_authorization':
        return this.getDownloadAuthorization(body as DownloadAuthorizationRequestBody)
      case 'b2_create_key':
        return this.createKey(
          body as {
            accountId: string
            capabilities: unknown
            keyName: unknown
            validDurationInSeconds?: number
            bucketIds?: readonly string[] | null
            bucketId?: string
            namePrefix?: string
          },
          version,
          headers['authorization'],
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
              mode?: unknown
              retainUntilTimestamp?: unknown
            }
            bypassGovernance?: boolean
          },
          headers['authorization'],
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
    const authError = await this.validateUploadAuthorization(
      kind,
      url,
      headers['authorization'],
      fileName,
    )
    if (authError !== null) return authError

    const contentLengthError = this.validateContentLength(headers, data.byteLength)
    if (contentLengthError !== null) return contentLengthError

    if (kind === 'part') {
      return await this.handleUploadPart(url, headers, data)
    }
    return await this.handleUploadFile(url, headers, data)
  }

  private validateContentLength(
    headers: Record<string, string>,
    actualLength: number,
  ): SimulatorJsonResponse | null {
    const parsed = parseContentLengthHeader(headers)
    if (parsed.kind === 'absent') return null
    if (parsed.kind === 'error') return this.error(400, 'bad_request', parsed.message)
    if (parsed.expectedLength !== actualLength) {
      return this.error(
        400,
        'bad_request',
        contentLengthMismatchMessage(parsed.expectedLength, actualLength),
      )
    }
    return null
  }

  private parseCustomUploadTimestamp(
    value: unknown,
  ): { readonly timestamp: number | null } | SimulatorJsonResponse {
    if (value === undefined || value === null) return { timestamp: null }
    if (!this.customUploadTimestampsEnabled) {
      return this.error(
        400,
        'custom_timestamp_not_allowed',
        'Custom upload timestamps are not enabled for this account.',
      )
    }
    const timestamp = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN

    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > this.now()) {
      return this.error(
        400,
        'custom_timestamp_invalid',
        'The request has an invalid custom upload timestamp.',
      )
    }
    return { timestamp }
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
      const url = new URL(`http://localhost${path}`)
      // Strict-mode auth gate for download-by-id. Mirrors the gate in
      // `handleRequest`. Returns a synthetic JSON error body in the
      // download response shape so the transport renders the right
      // status code.
      if (this.strictAuth) {
        const authError = this.authorizeDownloadRequest(
          this.downloadAuthorizationFromRequest(headers, url, { allowQueryAuthorization: false }),
          'b2_download_file_by_id',
          this.fileIdScope(url.searchParams.get('fileId') ?? undefined) ?? {
            bucketIds: [],
            requiresBucketScope: true,
          },
          url,
        )
        if (authError !== null) return this.errorAsDownload(authError)
      }
      const fileId = url.searchParams.get('fileId') ?? ''
      return this.finalizeDownload(
        this.downloadById(fileId, headers, requestHeaderValue(headers, 'range')),
        url,
        method,
      )
    }

    const fileMatch = path.match(/^([^?]+)/)?.[1]?.match(/\/file\/([^/]+)\/(.+)/)
    if (fileMatch) {
      const bucketName = decodeURIComponent(fileMatch[1] ?? '')
      const fileName = decodeURIComponent(fileMatch[2] ?? '')
      const url = new URL(`http://localhost${path}`)
      if (this.strictAuth) {
        const bucket = [...this.buckets.values()].find((b) => b.info.bucketName === bucketName)
        const authError = this.authorizeDownloadRequest(
          this.downloadAuthorizationFromRequest(headers, url, { allowQueryAuthorization: true }),
          'b2_download_file_by_name',
          {
            bucketIds: bucket === undefined ? [] : [bucket.info.bucketId as string],
            fileNames: [fileName],
            requiresBucketScope: true,
          },
          url,
        )
        if (authError !== null) return this.errorAsDownload(authError)
      }
      return this.finalizeDownload(
        this.downloadByName(bucketName, fileName, headers, requestHeaderValue(headers, 'range')),
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
    const newHeaders = { ...response.headers }
    for (const [param, header] of Object.entries(DOWNLOAD_RESPONSE_OVERRIDE_HEADERS)) {
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

    const serverSideEncryption = await uploadServerSideEncryption(
      headers,
      bucket.info.defaultServerSideEncryption,
    )
    if ('status' in serverSideEncryption) return serverSideEncryption
    const customUploadTimestamp = this.parseCustomUploadTimestamp(
      requestHeaderValue(headers, 'x-bz-custom-upload-timestamp'),
    )
    if ('status' in customUploadTimestamp) {
      return customUploadTimestamp
    }
    const fileVersion = this.makeFileVersion({
      bucketId,
      fileName,
      contentType,
      contentLength: storedData.byteLength,
      contentSha1,
      fileInfo,
      action: FileAction.Upload,
      serverSideEncryption,
      ...this.newReplicationStatusField(bucketId, fileName),
      ...(customUploadTimestamp.timestamp !== null
        ? { uploadTimestamp: customUploadTimestamp.timestamp }
        : {}),
    })
    const stored: StoredFile = { fileVersion, data: storedData, serverSideEncryption }
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

  private async validateUploadPartEncryption(
    large: LargeFileInProgress,
    headers: Record<string, string>,
  ): Promise<SimulatorJsonResponse | null> {
    if (large.serverSideEncryption.mode !== EncryptionMode.SseC) {
      if (!hasCustomerEncryptionHeaders(headers)) return null
      return this.error(400, 'bad_request', 'SSE-C upload part headers require an SSE-C large file')
    }

    const supplied = await storedServerSideEncryption({
      mode: EncryptionMode.SseC,
      algorithm: headers['x-bz-server-side-encryption-customer-algorithm'] as EncryptionAlgorithm,
      customerKey: headers['x-bz-server-side-encryption-customer-key'] as string,
      customerKeyMd5: headers['x-bz-server-side-encryption-customer-key-md5'] as string,
    })
    if ('status' in supplied) return supplied
    if (!sameStoredServerSideEncryption(large.serverSideEncryption, supplied)) {
      return this.error(
        400,
        'bad_request',
        'SSE-C upload parts require matching customer encryption headers',
      )
    }

    return null
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

    const partNumber = this.parsePartNumberHeader(requestHeaderValue(headers, 'x-bz-part-number'))
    if (typeof partNumber !== 'number') return partNumber

    const encryptionError = await this.validateUploadPartEncryption(large, headers)
    if (encryptionError !== null) return encryptionError

    // Verify the part bytes against X-Bz-Content-Sha1, same as b2_upload_file.
    // Parts are always sent with a real (or unverified:) sha1 by the SDK.
    const resolved = await this.resolveUploadSha1(headers['x-bz-content-sha1'], data)
    if ('status' in resolved) return resolved
    const { sha1, data: partData } = resolved

    const uploadTimestamp = this.monotonicTimestamp()
    large.parts.set(partNumber, { data: partData, sha1, contentMd5: null, uploadTimestamp })

    return {
      status: 200,
      body: {
        fileId: large.fileId,
        partNumber,
        contentLength: partData.byteLength,
        contentSha1: sha1,
        contentMd5: null,
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp,
      },
    }
  }

  private parsePartNumberHeader(header: string | undefined): number | SimulatorJsonResponse {
    if (header === undefined) {
      return this.error(400, 'bad_request', 'X-Bz-Part-Number header is required')
    }
    if (!/^\d+$/.test(header)) {
      return this.error(
        400,
        'bad_request',
        `X-Bz-Part-Number must be an integer between ${B2_MIN_PART_NUMBER} and ${B2_MAX_PART_NUMBER}; received ${header}`,
      )
    }
    const partNumber = Number(header)
    return this.validatePartNumber(partNumber) ?? partNumber
  }

  private validatePartNumber(partNumber: number): SimulatorJsonResponse | null {
    if (
      Number.isInteger(partNumber) &&
      partNumber >= B2_MIN_PART_NUMBER &&
      partNumber <= B2_MAX_PART_NUMBER
    ) {
      return null
    }
    return this.error(
      400,
      'bad_request',
      `partNumber must be an integer between ${B2_MIN_PART_NUMBER} and ${B2_MAX_PART_NUMBER}; received ${String(partNumber)}`,
    )
  }

  private downloadById(
    fileId: string,
    headers: Record<string, string>,
    range?: string,
  ): SimulatorDownloadResponse {
    const found = this.findFile(fileId)
    if (found === null) return { status: 404, headers: {}, data: null }
    return this.serveFile(found.stored, headers, range)
  }

  private downloadByName(
    bucketName: string,
    fileName: string,
    headers: Record<string, string>,
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
      return this.serveFile(latest, headers, range)
    }
    return { status: 404, headers: {}, data: null }
  }

  private validateDownloadEncryption(
    stored: StoredFile,
    headers: Record<string, string>,
  ): SimulatorDownloadResponse | null {
    const encryption = stored.serverSideEncryption
    if (encryption.mode !== EncryptionMode.SseC) return null

    const algorithm = headers['x-bz-server-side-encryption-customer-algorithm']
    const customerKey = headers['x-bz-server-side-encryption-customer-key']
    const customerKeyMd5 = headers['x-bz-server-side-encryption-customer-key-md5']
    const customerKeyBytes = customerKey === undefined ? null : base64ToBytes(customerKey, 32)
    const normalizedCustomerKeyMd5 =
      customerKeyMd5 === undefined ? null : normalizeSizedBase64(customerKeyMd5, 16)
    if (
      algorithm !== encryption.algorithm ||
      customerKeyBytes === null ||
      normalizedCustomerKeyMd5 === null ||
      md5Base64Sync(customerKeyBytes) !== normalizedCustomerKeyMd5
    ) {
      return this.errorAsDownload(
        this.error(
          400,
          'bad_request',
          'SSE-C downloads require matching customer encryption headers',
        ),
      )
    }
    if (
      normalizedCustomerKeyMd5 !== encryption.customerKeyMd5 ||
      customerKeyDigest(customerKeyBytes) !== encryption.customerKeyDigest
    ) {
      return this.errorAsDownload(
        this.error(
          403,
          'access_denied',
          'SSE-C customer encryption key does not match the stored file',
        ),
      )
    }

    return null
  }

  private async validateSourceServerSideEncryption(
    stored: StoredFile,
    encryption: EncryptionSetting | undefined,
  ): Promise<SimulatorJsonResponse | null> {
    const expected = stored.serverSideEncryption
    if (expected.mode !== EncryptionMode.SseC) return null
    if (encryption?.mode !== EncryptionMode.SseC) {
      return this.error(400, 'bad_request', 'SSE-C source copies require customer encryption')
    }

    const supplied = await storedServerSideEncryption(encryption)
    if ('status' in supplied) return supplied
    if (!sameStoredServerSideEncryption(expected, supplied)) {
      return this.error(400, 'bad_request', 'SSE-C source customer encryption does not match')
    }
    return null
  }

  private async resolveCopyDestinationEncryption(
    destinationBucket: StoredBucket,
    requested: EncryptionSetting | undefined,
  ): Promise<StoredServerSideEncryption | SimulatorJsonResponse> {
    if (requested !== undefined) return await storedServerSideEncryption(requested)
    return await storedServerSideEncryption(destinationBucket.info.defaultServerSideEncryption)
  }

  private async validateCopyPartDestinationEncryption(
    large: LargeFileInProgress,
    encryption: EncryptionSetting | undefined,
  ): Promise<SimulatorJsonResponse | null> {
    if (encryption === undefined) {
      return large.serverSideEncryption.mode === EncryptionMode.SseC
        ? this.error(400, 'bad_request', 'SSE-C destination copies require customer encryption')
        : null
    }

    const supplied = await storedServerSideEncryption(encryption)
    if ('status' in supplied) return supplied
    if (!sameStoredServerSideEncryption(large.serverSideEncryption, supplied)) {
      return this.error(400, 'bad_request', 'Destination server-side encryption does not match')
    }
    return null
  }

  private serveFile(
    stored: StoredFile,
    requestHeaders: Record<string, string>,
    range?: string,
  ): SimulatorDownloadResponse {
    const encryptionError = this.validateDownloadEncryption(stored, requestHeaders)
    if (encryptionError !== null) return encryptionError

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
    const unauthorizedToRead: DownloadClientUnauthorizedToReadMarker[] = []
    this.addDownloadEncryptionHeaders(
      headers,
      stored.serverSideEncryption,
      requestHeaders,
      unauthorizedToRead,
    )
    this.addDownloadObjectLockHeaders(headers, fv, requestHeaders, unauthorizedToRead)
    if (unauthorizedToRead.length > 0) {
      headers[DownloadHeaderName.ClientUnauthorizedToRead] = unauthorizedToRead.join(',')
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

  private addDownloadEncryptionHeaders(
    headers: Record<string, string>,
    encryption: StoredServerSideEncryption,
    requestHeaders: Record<string, string>,
    unauthorizedToRead: DownloadClientUnauthorizedToReadMarker[],
  ): void {
    if (encryption.mode === EncryptionMode.None) return
    if (
      !this.requestHasCapability(
        requestHeaderValue(requestHeaders, 'authorization'),
        Capability.ReadBucketEncryption,
      )
    ) {
      if (encryption.mode === EncryptionMode.SseB2) {
        unauthorizedToRead.push(DownloadClientUnauthorizedToReadMarker.ServerSideEncryption)
      } else {
        unauthorizedToRead.push(
          DownloadClientUnauthorizedToReadMarker.ServerSideEncryptionCustomerAlgorithm,
          DownloadClientUnauthorizedToReadMarker.ServerSideEncryptionCustomerKeyMd5,
        )
      }
      return
    }

    if (encryption.mode === EncryptionMode.SseB2) {
      headers[DownloadHeaderName.ServerSideEncryption] = encryption.algorithm
      return
    }
    headers[DownloadHeaderName.ServerSideEncryptionCustomerAlgorithm] = encryption.algorithm
    headers[DownloadHeaderName.ServerSideEncryptionCustomerKeyMd5] = encryption.customerKeyMd5
  }

  private addDownloadObjectLockHeaders(
    headers: Record<string, string>,
    fileVersion: FileVersion,
    requestHeaders: Record<string, string>,
    unauthorizedToRead: DownloadClientUnauthorizedToReadMarker[],
  ): void {
    const authToken = requestHeaderValue(requestHeaders, 'authorization')
    const retention = fileVersion.fileRetention.value
    if (retention !== null && retention.mode !== null && retention.retainUntilTimestamp !== null) {
      if (this.requestHasCapability(authToken, Capability.ReadFileRetentions)) {
        headers[DownloadHeaderName.FileRetentionMode] = retention.mode
        headers[DownloadHeaderName.FileRetentionRetainUntilTimestamp] = String(
          retention.retainUntilTimestamp,
        )
      } else {
        unauthorizedToRead.push(
          DownloadClientUnauthorizedToReadMarker.FileRetentionMode,
          DownloadClientUnauthorizedToReadMarker.FileRetentionRetainUntilTimestamp,
        )
      }
    }

    const legalHold = fileVersion.legalHold.value
    if (legalHold === null) return
    if (this.requestHasCapability(authToken, Capability.ReadFileLegalHolds)) {
      headers[DownloadHeaderName.FileLegalHold] = legalHold
      return
    }
    unauthorizedToRead.push(DownloadClientUnauthorizedToReadMarker.FileLegalHold)
  }

  // --- API handlers ---

  private authorize(authzHeader?: string, origin = 'http://localhost:0'): SimulatorJsonResponse {
    // Token validity: real B2 = 24h; configurable via `authTokenTtlMs`.
    // The issued token and response body both inherit the exact grant
    // resolved from the Basic credentials used for this authorize call.
    const resolution = this.findAuthorizationGrant(authzHeader)
    if (resolution.kind === 'invalid') {
      return this.error(401, 'unauthorized', 'application key is not valid')
    }
    if (resolution.kind === 'expired') {
      return this.error(401, 'unauthorized', 'application key is expired')
    }
    const { grant } = resolution
    const allowedBuckets = this.allowedBuckets(grant.bucketIds)
    const legacyBucketId = singleBucketId(grant.bucketIds)
    const legacyBucketName =
      legacyBucketId === null ? null : (this.buckets.get(legacyBucketId)?.info.bucketName ?? null)
    const tokenStr = `sim_auth_token_${this.nextId++}`
    this.issuedTokens.set(tokenStr, {
      accountId: grant.accountId,
      capabilities: grant.capabilities,
      bucketIds: grant.bucketIds,
      namePrefix: grant.namePrefix,
      expiresAt: this.now() + this.authTokenTtlMs,
      applicationKeyId: grant.applicationKeyId,
    })
    return {
      status: 200,
      body: {
        accountId: accountIdOf(grant.accountId),
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
            namePrefix: grant.namePrefix,
            recommendedPartSize: this.recommendedPartSize,
            s3ApiUrl: origin,
            allowed: {
              capabilities: cloneCapabilities(grant.capabilities),
              buckets: allowedBuckets,
              bucketId: legacyBucketId === null ? null : bucketIdOf(legacyBucketId),
              bucketName: legacyBucketName,
              namePrefix: grant.namePrefix,
            },
          },
        },
        applicationKeyExpirationTimestamp: grant.expirationTimestamp,
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
    const objectLockEnabled = nextObjectLockEnabled(false, req.fileLockEnabled)
    if (typeof objectLockEnabled !== 'boolean') {
      return this.error(400, objectLockEnabled.code, objectLockEnabled.message)
    }
    const configError = validateBucketConfigurationFields(req, { objectLockEnabled })
    if (configError) return this.error(400, configError.code, configError.message)
    const replicationKeyError = this.validateReplicationApplicationKeys(
      req.replicationConfiguration,
      undefined,
    )
    if (replicationKeyError !== null) return replicationKeyError
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
          isFileLockEnabled: objectLockEnabled,
          defaultRetention,
        },
      },
      lifecycleRules: req.lifecycleRules ?? [],
      options: [],
      revision: 1,
      defaultRetention,
      replicationConfiguration:
        req.replicationConfiguration === undefined
          ? { asReplicationSource: null, asReplicationDestination: null }
          : normalizeReplicationConfiguration(req.replicationConfiguration),
    }
    this.buckets.set(bid, { info, files: new Map() })
    return { status: 200, body: info }
  }

  private listBuckets(req: {
    bucketId?: string
    bucketName?: string
    bucketTypes?: readonly BucketType[]
  }): SimulatorJsonResponse {
    const bucketTypesError = validateBucketTypes(req.bucketTypes)
    if (bucketTypesError) return this.error(400, bucketTypesError.code, bucketTypesError.message)
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
    if (this.bucketHasContents(bucket)) {
      return this.error(
        400,
        'cannot_delete_non_empty_bucket',
        'Bucket is not empty and cannot be deleted',
      )
    }
    this.buckets.delete(req.bucketId)
    return { status: 200, body: bucket.info }
  }

  private bucketHasContents(bucket: StoredBucket): boolean {
    for (const versions of bucket.files.values()) {
      if (versions.length > 0) return true
    }
    for (const large of this.largeFiles.values()) {
      if (large.bucketId === bucket.info.bucketId) return true
    }
    return false
  }

  private updateBucket(req: Record<string, unknown>): SimulatorJsonResponse {
    const bucket = this.buckets.get(req['bucketId'] as string)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    const revisionGuard = req['ifRevisionIs']
    if (revisionGuard !== undefined) {
      if (typeof revisionGuard !== 'number' || !Number.isInteger(revisionGuard)) {
        return this.error(400, 'bad_request', 'ifRevisionIs must be an integer')
      }
      if (revisionGuard !== bucket.info.revision) {
        return this.error(409, 'conflict', 'ifRevisionIs test failed')
      }
    }
    const currentObjectLockEnabled =
      bucket.info.fileLockConfiguration.value?.isFileLockEnabled ?? false
    const objectLockEnabled = nextObjectLockEnabled(
      currentObjectLockEnabled,
      req['fileLockEnabled'],
    )
    if (typeof objectLockEnabled !== 'boolean') {
      return this.error(400, objectLockEnabled.code, objectLockEnabled.message)
    }
    const configError = validateBucketConfigurationFields(
      {
        bucketInfo: req['bucketInfo'],
        corsRules: req['corsRules'],
        defaultRetention: req['defaultRetention'],
        lifecycleRules: req['lifecycleRules'],
        replicationConfiguration: req['replicationConfiguration'],
      },
      { objectLockEnabled },
    )
    if (configError) return this.error(400, configError.code, configError.message)
    const replicationKeyError = this.validateReplicationApplicationKeys(
      req['replicationConfiguration'],
      req['bucketId'] as string,
    )
    if (replicationKeyError !== null) return replicationKeyError
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
            replicationConfiguration: normalizeReplicationConfiguration(
              req['replicationConfiguration'] as BucketInfo['replicationConfiguration'],
            ),
          }
        : {}),
      ...(req['defaultRetention'] !== undefined
        ? {
            defaultRetention: req['defaultRetention'] as BucketInfo['defaultRetention'],
            fileLockConfiguration: {
              isClientAuthorizedToRead: true,
              value: {
                isFileLockEnabled: objectLockEnabled,
                defaultRetention: req['defaultRetention'] as BucketInfo['defaultRetention'],
              },
            },
          }
        : {}),
      ...(req['fileLockEnabled'] !== undefined && req['defaultRetention'] === undefined
        ? {
            fileLockConfiguration: {
              isClientAuthorizedToRead: true,
              value: {
                isFileLockEnabled: objectLockEnabled,
                defaultRetention: bucket.info.defaultRetention,
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

  private async getUploadUrl(
    req: { bucketId: string },
    authToken?: string,
  ): Promise<SimulatorJsonResponse> {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    const uploadAuth = await this.issueUploadAuthorization({
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
    const stored: StoredFile = {
      fileVersion,
      data: new Uint8Array(0),
      serverSideEncryption: { mode: EncryptionMode.None },
    }
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(req.fileName, [stored])
    }
    return { status: 200, body: fileVersion }
  }

  private deleteFileVersion(
    req: {
      fileId: string
      fileName: string
      bypassGovernance?: boolean
    },
    authToken?: string,
  ): {
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

    if (legalHold === LegalHoldValue.On) {
      return this.error(
        400,
        'file_lock_legal_hold_protected',
        'File is on legal hold and cannot be deleted',
      )
    }
    if (
      retention?.mode === RetentionMode.Compliance &&
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
      retention?.mode === RetentionMode.Governance &&
      retention.retainUntilTimestamp !== null &&
      retention.retainUntilTimestamp > now
    ) {
      const bypassError = this.requireGovernanceBypass(
        req,
        authToken,
        'File is under governance-mode retention; pass bypassGovernance: true to delete',
      )
      if (bypassError !== null) return bypassError
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
    sourceServerSideEncryption?: EncryptionSetting
    destinationServerSideEncryption?: EncryptionSetting
  }): Promise<{ status: number; body: unknown }> {
    const nameError = validateFileName(req.fileName)
    if (nameError) return this.error(400, nameError.code, nameError.message)
    const found = this.findFile(req.sourceFileId)
    if (found === null) return this.error(404, 'file_not_present', 'Source file not found')
    const sourceStored = found.stored
    const destBucketId = req.destinationBucketId ?? found.bucketId
    const destBucket = this.buckets.get(destBucketId)
    if (!destBucket) return this.error(400, 'bad_bucket_id', 'Destination bucket not found')

    const sourceEncryptionError = await this.validateSourceServerSideEncryption(
      sourceStored,
      req.sourceServerSideEncryption,
    )
    if (sourceEncryptionError !== null) return sourceEncryptionError

    const destinationEncryption = await this.resolveCopyDestinationEncryption(
      destBucket,
      req.destinationServerSideEncryption,
    )
    if ('status' in destinationEncryption) return destinationEncryption

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
      serverSideEncryption: destinationEncryption,
      ...this.newReplicationStatusField(destBucketId, req.fileName),
    })
    const copied: StoredFile = {
      fileVersion,
      data: new Uint8Array(data),
      serverSideEncryption: destinationEncryption,
    }
    const existing = destBucket.files.get(req.fileName)
    if (existing) {
      existing.push(copied)
    } else {
      destBucket.files.set(req.fileName, [copied])
    }

    this.firePostUploadHooks(fileVersion, destBucketId, 'b2:ObjectCreated:Copy')
    return { status: 200, body: fileVersion }
  }

  private async startLargeFile(req: {
    bucketId: string
    fileName: string
    contentType: string
    customUploadTimestamp?: string | null
    fileInfo?: Record<string, string>
    fileRetention?: FileRetentionValue
    legalHold?: LegalHoldValue
    serverSideEncryption?: EncryptionSetting
  }): Promise<SimulatorJsonResponse> {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const nameError = validateFileName(req.fileName)
    if (nameError) return this.error(400, nameError.code, nameError.message)
    if (req.fileInfo !== undefined) {
      const infoError = validateFileInfo(req.fileInfo)
      if (infoError) return this.error(400, infoError.code, infoError.message)
    }

    const customUploadTimestamp = this.parseCustomUploadTimestamp(req.customUploadTimestamp)
    if ('status' in customUploadTimestamp) return customUploadTimestamp

    const fid = this.genId('4_z')
    const uploadTimestamp = customUploadTimestamp.timestamp ?? this.monotonicTimestamp()
    const serverSideEncryption = await storedServerSideEncryption(
      req.serverSideEncryption ?? bucket.info.defaultServerSideEncryption,
    )
    if ('status' in serverSideEncryption) return serverSideEncryption
    const replicationStatus = this.replicationStatusForNewFile(req.bucketId, req.fileName)
    const large: LargeFileInProgress = {
      fileId: fid,
      bucketId: req.bucketId,
      fileName: req.fileName,
      contentType: req.contentType,
      fileInfo: req.fileInfo ?? {},
      fileRetention:
        req.fileRetention ?? defaultFileRetention(bucket.info.defaultRetention, uploadTimestamp),
      legalHold: req.legalHold ?? null,
      ...this.replicationStatusMetadataFor(replicationStatus),
      serverSideEncryption,
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
        ...this.replicationStatusMetadataFor(large.replicationStatus),
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp: large.uploadTimestamp,
      },
    }
  }

  private async getUploadPartUrl(
    req: { fileId: string },
    authToken?: string,
  ): Promise<SimulatorJsonResponse> {
    const large = this.largeFiles.get(req.fileId)
    if (large === undefined) return this.error(400, 'bad_request', 'Large file not found')
    const uploadAuth = await this.issueUploadAuthorization({
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
    if (sortedParts.length > B2_MAX_PART_NUMBER) {
      return this.error(
        400,
        'bad_request',
        `multipart upload has ${sortedParts.length} parts; B2 caps at ${B2_MAX_PART_NUMBER}`,
      )
    }
    // B2 spec-compliance: every part number must be in [1, 10000].
    // Real B2 rejects a part upload with an out-of-range partNumber
    // server-side; we enforce here at finish time as a backstop in case
    // a caller bypassed the upload-side validation or older simulator
    // state already contains invalid part numbers.
    for (const [partNumber] of sortedParts) {
      if (
        !Number.isInteger(partNumber) ||
        partNumber < B2_MIN_PART_NUMBER ||
        partNumber > B2_MAX_PART_NUMBER
      ) {
        return this.error(
          400,
          'bad_request',
          `partNumber ${partNumber} is outside the [${B2_MIN_PART_NUMBER}, ${B2_MAX_PART_NUMBER}] range B2 accepts`,
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
    for (const [i, [partNumber, part]] of sortedParts.entries()) {
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
    for (const [partNumber, part] of sortedParts.slice(0, -1)) {
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
      uploadTimestamp: large.uploadTimestamp,
      ...this.replicationStatusMetadataFor(large.replicationStatus),
    })
    const stored: StoredFile = {
      fileVersion,
      data: combined,
      serverSideEncryption: large.serverSideEncryption,
    }
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
      ...this.replicationStatusMetadataFor(f.replicationStatus),
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
        contentMd5: part.contentMd5,
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp: part.uploadTimestamp,
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
    sourceServerSideEncryption?: EncryptionSetting
    destinationServerSideEncryption?: EncryptionSetting
  }): Promise<SimulatorJsonResponse> {
    const large = this.largeFiles.get(req.largeFileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')
    const partNumberError = this.validatePartNumber(req.partNumber)
    if (partNumberError !== null) return partNumberError

    const found = this.findFile(req.sourceFileId)
    if (found === null) return this.error(404, 'file_not_present', 'Source file not found')
    const sourceStored = found.stored

    const sourceEncryptionError = await this.validateSourceServerSideEncryption(
      sourceStored,
      req.sourceServerSideEncryption,
    )
    if (sourceEncryptionError !== null) return sourceEncryptionError

    const destinationEncryptionError = await this.validateCopyPartDestinationEncryption(
      large,
      req.destinationServerSideEncryption,
    )
    if (destinationEncryptionError !== null) return destinationEncryptionError

    let partData = sourceStored.data
    if (req.range !== undefined) {
      const parsed = parseRangeHeader(req.range, sourceStored.data.byteLength)
      if (parsed.kind === 'malformed') {
        return this.error(400, 'bad_request', `Malformed copy range: ${req.range}`)
      }
      if (parsed.kind === 'unsatisfiable') {
        return this.error(416, 'range_not_satisfiable', `Unsatisfiable copy range: ${req.range}`)
      }
      partData = sourceStored.data.subarray(parsed.start, parsed.end + 1)
    }

    // Hash the part data so list_parts can return a real SHA-1.
    // sha1Hex is isomorphic (node:crypto in Node, WebCrypto in browsers).
    const sha1 = await sha1Hex(partData)
    const uploadTimestamp = this.monotonicTimestamp()
    large.parts.set(req.partNumber, {
      data: new Uint8Array(partData),
      sha1,
      contentMd5: null,
      uploadTimestamp,
    })

    return {
      status: 200,
      body: {
        fileId: req.largeFileId,
        partNumber: req.partNumber,
        contentLength: partData.byteLength,
        contentSha1: sha1,
        contentMd5: null,
        serverSideEncryption: publicServerSideEncryption(large.serverSideEncryption),
        uploadTimestamp,
      },
    }
  }

  private getDownloadAuthorization(req: DownloadAuthorizationRequestBody): SimulatorJsonResponse {
    this.purgeExpiredDownloadAuthorizationTokens()
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    const prefixError = validateDownloadAuthorizationPrefix(req.fileNamePrefix)
    if (prefixError) return this.error(400, prefixError.code, prefixError.message)
    const durationError = validateDownloadAuthorizationDuration(req.validDurationInSeconds)
    if (durationError) return this.error(400, durationError.code, durationError.message)
    const overrideError = validateDownloadResponseOverrides(req)
    if (overrideError) return this.error(400, overrideError.code, overrideError.message)
    let authorizationToken = randomDownloadAuthorizationToken()
    while (this.downloadAuthorizationTokens.has(authorizationToken)) {
      authorizationToken = randomDownloadAuthorizationToken()
    }
    const expiresAt = this.now() + req.validDurationInSeconds * 1000
    this.downloadAuthorizationTokens.set(authorizationToken, {
      bucketId: req.bucketId,
      fileNamePrefix: req.fileNamePrefix,
      expiresAt,
      responseHeaderOverrides: pickDownloadResponseOverrides(req),
    })
    this.pushDownloadAuthorizationExpiry({ token: authorizationToken, expiresAt })
    return {
      status: 200,
      body: {
        bucketId: req.bucketId,
        fileNamePrefix: req.fileNamePrefix,
        authorizationToken,
      },
    }
  }

  // --- Keys ---

  private createKeyCapabilitiesOutsideGrant(
    authToken: string | undefined,
    requested: readonly Capability[],
  ): readonly Capability[] {
    // In default mode, unknown auth tokens keep the simulator permissive. When the
    // token is known, preserve the creator's real grant so delegated keys cannot
    // exceed it even without full strict-auth request enforcement.
    const creator = authToken === undefined ? undefined : this.issuedTokens.get(authToken)
    if (creator === undefined) return this.strictAuth ? requested : []
    // The simulator's implicit master credential may mint any valid capability.
    if (creator.applicationKeyId === null) return []
    const granted = new Set(creator.capabilities)
    return requested.filter((capability) => !granted.has(capability))
  }

  private createKeyCreatorAccountId(authToken: string | undefined): string {
    const creator = authToken === undefined ? undefined : this.issuedTokens.get(authToken)
    return creator?.accountId ?? this.accountId
  }

  private createKey(
    req: {
      accountId: string
      capabilities: unknown
      keyName: unknown
      validDurationInSeconds?: number
      bucketIds?: readonly string[] | null
      bucketId?: string
      namePrefix?: string
    },
    version: B2ApiVersion,
    authToken: string | undefined,
  ): SimulatorJsonResponse {
    if (version === 'v4' && hasOwnField(req, 'bucketId')) {
      return this.error(
        400,
        'bad_request',
        'bucketId is not accepted by v4 b2_create_key; use bucketIds',
      )
    }
    if (version !== 'v4' && req.bucketId !== undefined && req.bucketIds !== undefined) {
      return this.error(400, 'bad_request', 'b2_create_key accepts either bucketIds or bucketId')
    }
    const bucketIds =
      version !== 'v4' && req.bucketId !== undefined
        ? Object.freeze([req.bucketId])
        : normalizeKeyBucketIds(req)
    const namePrefix = req.namePrefix === undefined || req.namePrefix === '' ? null : req.namePrefix
    const creatorAccountId = this.createKeyCreatorAccountId(authToken)
    if (req.accountId !== creatorAccountId) {
      return this.error(400, 'bad_request', 'accountId must match authorized account')
    }
    const keyNameError = validateCreateKeyName(req.keyName)
    if (keyNameError) return this.error(400, keyNameError.code, keyNameError.message)
    const keyName = req.keyName as string
    const capabilitiesError = validateCreateKeyCapabilities(req.capabilities)
    if (capabilitiesError) return this.error(400, capabilitiesError.code, capabilitiesError.message)
    const capabilities = normalizeCreateKeyCapabilities(req.capabilities as readonly Capability[])
    const unauthorizedCapabilities = this.createKeyCapabilitiesOutsideGrant(authToken, capabilities)
    if (unauthorizedCapabilities.length > 0) {
      return this.error(
        400,
        'bad_request',
        `requested capabilities exceed creator grant: ${unauthorizedCapabilities.join(', ')}`,
      )
    }
    if (hasKeyManagementCapability(capabilities) && (bucketIds !== null || namePrefix !== null)) {
      return this.error(
        400,
        'bad_request',
        'key-management capabilities are account-level and cannot be bucket or name-prefix scoped',
      )
    }
    const kid = this.genId('sim_key')
    const appKey = this.genId('sim_secret')
    const expiration =
      req.validDurationInSeconds !== undefined
        ? this.now() + req.validDurationInSeconds * 1000
        : null
    const stored: StoredKey = {
      applicationKeyId: kid,
      keyName,
      capabilities,
      accountId: creatorAccountId,
      applicationKey: appKey,
      bucketIds,
      namePrefix,
      expirationTimestamp: expiration,
    }
    this.keys.set(kid, stored)

    return {
      status: 200,
      body: {
        keyName: stored.keyName,
        applicationKeyId: stored.applicationKeyId,
        applicationKey: stored.applicationKey,
        capabilities: cloneCapabilities(stored.capabilities),
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
      capabilities: cloneCapabilities(k.capabilities),
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
        capabilities: cloneCapabilities(key.capabilities),
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

  private updateFileRetention(
    req: {
      fileName: string
      fileId: string
      fileRetention: unknown
      bypassGovernance?: boolean
    },
    authToken?: string,
  ): SimulatorJsonResponse {
    const found = this.findFile(req.fileId)
    if (found === null || found.stored.fileVersion.fileName !== req.fileName) {
      return this.error(404, 'file_not_present', 'File not found')
    }
    const fileLockError = this.requireFileLockEnabled(found.bucket)
    if (fileLockError !== null) return fileLockError

    const fileRetention = parseFileRetentionValue(req.fileRetention, Date.now())
    if (fileRetention === null) {
      return this.error(
        400,
        'bad_request',
        'fileRetention must use a valid mode and retainUntilTimestamp pair',
      )
    }

    const current = found.stored.fileVersion.fileRetention?.value
    if (
      current?.mode === RetentionMode.Compliance &&
      (fileRetention.mode !== RetentionMode.Compliance ||
        isRetentionWeakened(current, fileRetention))
    ) {
      return this.error(
        400,
        'file_lock_compliance_protected',
        'Compliance-mode retention cannot be shortened or removed',
      )
    }
    if (requiresGovernanceBypass(current, fileRetention)) {
      const bypassError = this.requireGovernanceBypass(
        req,
        authToken,
        'Governance-mode retention cannot be shortened, removed, or converted without bypassGovernance',
      )
      if (bypassError !== null) return bypassError
    }

    found.versions[found.index] = {
      fileVersion: {
        ...found.stored.fileVersion,
        fileRetention: { isClientAuthorizedToRead: true, value: fileRetention },
      },
      data: found.stored.data,
      serverSideEncryption: found.stored.serverSideEncryption,
    }
    return {
      status: 200,
      body: {
        fileName: req.fileName,
        fileId: req.fileId,
        fileRetention,
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
    const fileLockError = this.requireFileLockEnabled(found.bucket)
    if (fileLockError !== null) return fileLockError

    if (req.legalHold !== LegalHoldValue.On && req.legalHold !== LegalHoldValue.Off) {
      return this.error(400, 'bad_request', 'legalHold must be "on" or "off"')
    }
    found.versions[found.index] = {
      fileVersion: {
        ...found.stored.fileVersion,
        legalHold: {
          isClientAuthorizedToRead: true,
          value: req.legalHold,
        },
      },
      data: found.stored.data,
      serverSideEncryption: found.stored.serverSideEncryption,
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
    const rulesError = validateNotificationRules(req.eventNotificationRules)
    if (rulesError) return this.error(400, rulesError.code, rulesError.message)
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
    readonly replicationStatus?: ReplicationStatus
    readonly serverSideEncryption?: EncryptionSetting | StoredServerSideEncryption
    readonly uploadTimestamp?: number
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
      ...this.replicationStatusMetadataFor(params.replicationStatus),
      serverSideEncryption: publicServerSideEncryption(
        params.serverSideEncryption ?? { mode: EncryptionMode.None },
      ),
      uploadTimestamp: params.uploadTimestamp ?? this.monotonicTimestamp(),
    }
  }

  private newReplicationStatusField(
    bucketId: string,
    fileName: string,
  ): { readonly replicationStatus?: ReplicationStatus } {
    return this.replicationStatusMetadataFor(this.replicationStatusForNewFile(bucketId, fileName))
  }

  private replicationStatusMetadataFor(replicationStatus: ReplicationStatus | undefined): {
    readonly replicationStatus?: ReplicationStatus
  } {
    return replicationStatus === undefined ? {} : { replicationStatus }
  }

  private replicationStatusForNewFile(
    bucketId: string,
    fileName: string,
  ): ReplicationStatus | undefined {
    return this.matchingEnabledReplicationRules(bucketId, fileName).length > 0
      ? 'PENDING'
      : undefined
  }

  private matchingEnabledReplicationRules(
    bucketId: string,
    fileName: string,
  ): readonly ReplicationRule[] {
    const bucket = this.buckets.get(bucketId)
    const sourceRules = bucket?.info.replicationConfiguration.asReplicationSource?.replicationRules
    return (
      sourceRules?.filter((rule) => rule.isEnabled && fileName.startsWith(rule.fileNamePrefix)) ??
      []
    )
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
      for (const rule of this.matchingEnabledReplicationRules(bucketId, fileVersion.fileName)) {
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

function rawUrlPathContainsLiteralBackslash(rawUrl: string): boolean {
  const schemeEnd = rawUrl.indexOf('://')
  const authorityStart = schemeEnd === -1 ? 0 : schemeEnd + 3

  const queryStart = rawUrl.indexOf('?', authorityStart)
  const hashStart = rawUrl.indexOf('#', authorityStart)
  const urlEndCandidates = [queryStart, hashStart].filter((index) => index !== -1)
  const urlEnd = urlEndCandidates.length === 0 ? rawUrl.length : Math.min(...urlEndCandidates)

  const slashStart = rawUrl.indexOf('/', authorityStart)
  const backslashStart = rawUrl.indexOf('\\', authorityStart)
  const pathStartCandidates = [slashStart, backslashStart].filter(
    (index) => index !== -1 && index < urlEnd,
  )
  if (pathStartCandidates.length === 0) return false

  const pathStart = Math.min(...pathStartCandidates)
  const queryStartAfterPath = rawUrl.indexOf('?', pathStart)
  const hashStartAfterPath = rawUrl.indexOf('#', pathStart)
  const pathEndCandidates = [queryStartAfterPath, hashStartAfterPath].filter(
    (index) => index !== -1,
  )
  const pathEnd = pathEndCandidates.length === 0 ? rawUrl.length : Math.min(...pathEndCandidates)
  return rawUrl.slice(pathStart, pathEnd).includes('\\')
}

function badRequestJson(message: string): SimulatorJsonResponse {
  return { status: 400, body: { status: 400, code: 'bad_request', message } }
}

type UploadBodyReadResult =
  | { readonly data: Uint8Array }
  | { readonly error: SimulatorJsonResponse }

function checkedUploadBody(data: Uint8Array, expectedLength: number | null): UploadBodyReadResult {
  if (expectedLength !== null && data.byteLength !== expectedLength) {
    return { error: badRequestJson(contentLengthMismatchMessage(expectedLength, data.byteLength)) }
  }
  return { data }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function concatenateChunks(chunks: readonly Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return copyBytes(chunks[0] as Uint8Array)
  const data = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

async function readStreamingUploadBody(
  stream: ReadableStream<Uint8Array>,
  expectedLength: number | null,
): Promise<UploadBodyReadResult> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      totalLength += chunk.byteLength
      if (expectedLength !== null && totalLength > expectedLength) {
        await reader.cancel().catch(() => undefined)
        return {
          error: badRequestJson(contentLengthMismatchMessage(expectedLength, totalLength)),
        }
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  if (expectedLength !== null && totalLength !== expectedLength) {
    return { error: badRequestJson(contentLengthMismatchMessage(expectedLength, totalLength)) }
  }
  return { data: concatenateChunks(chunks, totalLength) }
}

async function readUploadBody(
  body: BodyInit,
  expectedLength: number | null,
): Promise<UploadBodyReadResult> {
  if (body instanceof ReadableStream) return readStreamingUploadBody(body, expectedLength)
  if (body instanceof ArrayBuffer) {
    return checkedUploadBody(new Uint8Array(body), expectedLength)
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView
    return checkedUploadBody(
      copyBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)),
      expectedLength,
    )
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (expectedLength !== null && body.size !== expectedLength) {
      return { error: badRequestJson(contentLengthMismatchMessage(expectedLength, body.size)) }
    }
  }
  return checkedUploadBody(new Uint8Array(await new Response(body).arrayBuffer()), expectedLength)
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

    if (rawUrlPathContainsLiteralBackslash(url)) {
      return buildFaultResponse({
        on: '\\',
        status: 400,
        code: 'bad_request',
        message: 'URL path must not contain literal backslashes',
      })
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
      const result = await this.sim.handleDownload(
        parsedUrl.pathname + parsedUrl.search,
        headers,
        method,
      )
      const data = result.data ?? new Uint8Array(0)
      const responseHeaders = new Headers(result.headers)
      responseHeaders.set(
        'Content-Type',
        result.headers['Content-Type'] ?? 'application/octet-stream',
      )
      let decodedText: string | null = null
      const text = () => {
        decodedText ??= utf8Decoder.decode(data)
        return decodedText
      }

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
        json: <T>() => {
          try {
            return Promise.resolve(JSON.parse(text()) as T)
          } catch {
            return Promise.reject(new Error('Download response is not JSON'))
          }
        },
        text: () => Promise.resolve(text()),
        arrayBuffer: () =>
          Promise.resolve(
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
          ),
      }
    }

    let result: { status: number; body: unknown }

    if (isUpload) {
      const parsedContentLength = parseContentLengthHeader(headers)
      if (parsedContentLength.kind === 'error') {
        result = badRequestJson(parsedContentLength.message)
      } else {
        const uploadBody = await readUploadBody(
          request.body ?? new Uint8Array(0),
          parsedContentLength.kind === 'ok' ? parsedContentLength.expectedLength : null,
        )
        result =
          'error' in uploadBody
            ? uploadBody.error
            : await this.sim.handleUpload(url, headers, uploadBody.data)
      }
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
      } else if (
        request.method.toUpperCase() === 'GET' &&
        isPartnerQueryEndpoint(apiPathParts(parsedUrl.pathname).endpoint)
      ) {
        body = queryParamsBody(parsedUrl.searchParams)
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
