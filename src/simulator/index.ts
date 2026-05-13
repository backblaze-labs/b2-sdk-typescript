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
import { sha1Hex } from '../streams/hash.ts'
import { type AuthorizeAccountResponse, Capability } from '../types/auth.ts'
import { type BucketInfo, BucketRetentionMode, type BucketType } from '../types/bucket.ts'
import { EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import {
  type AuthToken,
  accountId as accountIdOf,
  bucketId as bucketIdOf,
  fileId as fileIdOf,
} from '../types/ids.ts'
import type { RetentionMode } from '../types/lock.ts'
import type { EventNotificationRule } from '../types/notifications.ts'

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
  readonly parts: Map<number, { data: Uint8Array; sha1: string }>
}

let nextId = 1
function genId(prefix: string): string {
  return `${prefix}_${String(nextId++).padStart(12, '0')}`
}

let lastTimestamp = 0
function monotonicTimestamp(): number {
  const now = Date.now()
  if (now <= lastTimestamp) {
    lastTimestamp += 1
  } else {
    lastTimestamp = now
  }
  return lastTimestamp
}

interface StoredKey {
  readonly applicationKeyId: string
  readonly keyName: string
  readonly capabilities: readonly string[]
  readonly accountId: string
  readonly applicationKey: string
  readonly bucketId: string | null
  readonly namePrefix: string | null
  readonly expirationTimestamp: number | null
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

  /**
   * Constructs a new in-memory B2 simulator.
   * @param options - Optional simulator overrides. See {@link B2SimulatorOptions}.
   */
  constructor(options: B2SimulatorOptions = {}) {
    this.minimumPartSize = options.minimumPartSize ?? 5_000_000
    this.recommendedPartSize = options.recommendedPartSize ?? 100_000_000
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
   * @param path - The request URL path containing the B2 endpoint name.
   * @param _headers - The HTTP request headers (unused).
   * @param body - The parsed JSON request body.
   *
   * @returns An object with HTTP status and JSON response body.
   */
  async handleRequest(
    _method: string,
    path: string,
    _headers: Record<string, string>,
    body: unknown,
  ): Promise<SimulatorJsonResponse> {
    const endpoint = path.split('/').pop() ?? ''

    switch (endpoint) {
      case 'b2_authorize_account':
        return this.authorize()
      case 'b2_create_bucket':
        return this.createBucket(
          body as { bucketName: string; bucketType: BucketType; accountId: string },
        )
      case 'b2_list_buckets':
        return this.listBuckets()
      case 'b2_delete_bucket':
        return this.deleteBucket(body as { bucketId: string })
      case 'b2_update_bucket':
        return this.updateBucket(body as Record<string, unknown>)
      case 'b2_get_upload_url':
        return this.getUploadUrl(body as { bucketId: string })
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
        return this.copyFile(
          body as { sourceFileId: string; fileName: string; destinationBucketId?: string },
        )
      case 'b2_start_large_file':
        return this.startLargeFile(
          body as {
            bucketId: string
            fileName: string
            contentType: string
            fileInfo?: Record<string, string>
          },
        )
      case 'b2_get_upload_part_url':
        return this.getUploadPartUrl(body as { fileId: string })
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
            bucketId?: string
            namePrefix?: string
          },
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
   * @returns An object with HTTP status and JSON response body.
   */
  handleUpload(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): SimulatorJsonResponse {
    if (url.includes('b2_upload_part')) {
      return this.handleUploadPart(url, headers, data)
    }
    return this.handleUploadFile(url, headers, data)
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
      const fileId = url.searchParams.get('fileId') ?? ''
      return this.finalizeDownload(this.downloadById(fileId, headers['range']), url, method)
    }

    const fileMatch = path.match(/^([^?]+)/)?.[1]?.match(/\/file\/([^/]+)\/(.+)/)
    if (fileMatch) {
      const bucketName = decodeURIComponent(fileMatch[1] ?? '')
      const fileName = decodeURIComponent(fileMatch[2] ?? '')
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

  private handleUploadFile(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): SimulatorJsonResponse {
    const bucketId = new URL(url).searchParams.get('bucketId')
    if (!bucketId) return this.error(400, 'bad_request', 'Missing bucketId')

    const bucket = this.buckets.get(bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const fileName = decodeURIComponent(headers['x-bz-file-name'] ?? '')
    const contentType = headers['content-type'] ?? 'application/octet-stream'
    const sha1 = headers['x-bz-content-sha1'] ?? 'none'

    const fileVersion = this.makeFileVersion(
      bucketId,
      fileName,
      contentType,
      data.byteLength,
      sha1,
      FileAction.Upload,
    )
    const stored: StoredFile = { fileVersion, data }
    const existing = bucket.files.get(fileName)
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(fileName, [stored])
    }

    return { status: 200, body: fileVersion }
  }

  private handleUploadPart(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): SimulatorJsonResponse {
    const fileId = new URL(url).searchParams.get('fileId')
    if (!fileId) return this.error(400, 'bad_request', 'Missing fileId')

    const large = this.largeFiles.get(fileId)
    if (!large) return this.error(400, 'bad_request', 'Large file not found')

    const partNumber = Number.parseInt(headers['x-bz-part-number'] ?? '0', 10)
    const sha1 = headers['x-bz-content-sha1'] ?? 'none'

    large.parts.set(partNumber, { data, sha1 })

    return {
      status: 200,
      body: {
        fileId: large.fileId,
        partNumber,
        contentLength: data.byteLength,
        contentSha1: sha1,
        serverSideEncryption: { mode: EncryptionMode.None },
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
    let data = stored.data
    let status = 200

    if (range) {
      const match = range.match(/bytes=(\d+)-(\d+)?/)
      if (match) {
        const start = Number.parseInt(match[1] ?? '0', 10)
        const end = match[2] !== undefined ? Number.parseInt(match[2], 10) : data.byteLength - 1
        data = data.slice(start, end + 1)
        status = 206
      }
    }

    const fv = stored.fileVersion
    return {
      status,
      headers: {
        'Content-Type': fv.contentType,
        'Content-Length': String(data.byteLength),
        'X-Bz-File-Id': fv.fileId as string,
        'X-Bz-File-Name': encodeURIComponent(fv.fileName),
        'X-Bz-Content-Sha1': fv.contentSha1 ?? 'none',
        'X-Bz-Upload-Timestamp': String(fv.uploadTimestamp),
        'X-Bz-Info-src_last_modified_millis': String(fv.uploadTimestamp),
      },
      data,
    }
  }

  // --- API handlers ---

  private authorize(): { status: number; body: AuthorizeAccountResponse } {
    return {
      status: 200,
      body: {
        accountId: accountIdOf(this.accountId),
        // `AuthToken` has no public factory by design — auth tokens are
        // minted by B2, not constructed by user code. The simulator is
        // the only legitimate place that needs to forge one.
        authorizationToken: 'sim_auth_token' as unknown as AuthToken,
        apiInfo: {
          storageApi: {
            absoluteMinimumPartSize: this.minimumPartSize,
            apiUrl: 'http://localhost:0',
            bucketId: null,
            bucketName: null,
            downloadUrl: 'http://localhost:0',
            infoType: 'storageApi',
            namePrefix: null,
            recommendedPartSize: this.recommendedPartSize,
            s3ApiUrl: 'http://localhost:0',
            allowed: {
              capabilities: [
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
              ],
              bucketId: null,
              bucketName: null,
              namePrefix: null,
            },
          },
        },
        applicationKeyExpirationTimestamp: null,
      },
    }
  }

  private createBucket(req: { bucketName: string; bucketType: BucketType; accountId: string }): {
    status: number
    body: unknown
  } {
    for (const b of this.buckets.values()) {
      if (b.info.bucketName === req.bucketName) {
        return this.error(400, 'duplicate_bucket_name', 'Bucket name already in use')
      }
    }
    const bid = bucketIdOf(genId('b2_bucket'))
    const info: BucketInfo = {
      accountId: accountIdOf(req.accountId),
      bucketId: bid,
      bucketName: req.bucketName,
      bucketType: req.bucketType,
      bucketInfo: {},
      corsRules: [],
      defaultServerSideEncryption: { mode: EncryptionMode.None },
      fileLockConfiguration: {
        isClientAuthorizedToRead: true,
        value: {
          isFileLockEnabled: false,
          defaultRetention: { mode: BucketRetentionMode.None, period: null },
        },
      },
      lifecycleRules: [],
      options: [],
      revision: 1,
      defaultRetention: { mode: BucketRetentionMode.None, period: null },
      replicationConfiguration: { asReplicationSource: null, asReplicationDestination: null },
    }
    this.buckets.set(bid as string, { info, files: new Map() })
    return { status: 200, body: info }
  }

  private listBuckets(): SimulatorJsonResponse {
    const buckets = [...this.buckets.values()].map((b) => b.info)
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

  private getUploadUrl(req: { bucketId: string }): SimulatorJsonResponse {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    return {
      status: 200,
      body: {
        bucketId: req.bucketId,
        uploadUrl: `http://localhost:0/b2api/v3/b2_upload_file?bucketId=${req.bucketId}`,
        authorizationToken: 'sim_upload_token',
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

    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    let allFiles = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([_, versions]) => versions[versions.length - 1])
      .filter((v): v is StoredFile => v !== undefined && v.fileVersion.action !== FileAction.Hide)
      .map((v) => v.fileVersion)
      .sort((a, b) => a.fileName.localeCompare(b.fileName))

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

    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    const allVersions = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([_, versions]) => versions.map((v) => v.fileVersion))
      .sort((a, b) => {
        const nameCmp = a.fileName.localeCompare(b.fileName)
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
        const exactIdx = allVersions.findIndex(
          (f, i) => i >= nameIdx && (f.fileId as string) === startId,
        )
        startIdx = exactIdx !== -1 ? exactIdx : nameIdx
      } else {
        startIdx = nameIdx
      }
    }

    const sliced = allVersions.slice(startIdx, startIdx + max)
    const hasMore = startIdx + max < allVersions.length
    const nextFileName = hasMore ? (allVersions[startIdx + max]?.fileName ?? null) : null
    const nextFileId = hasMore ? ((allVersions[startIdx + max]?.fileId as string) ?? null) : null

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

    const fileVersion = this.makeFileVersion(
      req.bucketId,
      req.fileName,
      'application/octet-stream',
      0,
      'none',
      FileAction.Hide,
    )
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

  private copyFile(req: { sourceFileId: string; fileName: string; destinationBucketId?: string }): {
    status: number
    body: unknown
  } {
    const found = this.findFile(req.sourceFileId)
    if (found === null) return this.error(404, 'file_not_present', 'Source file not found')
    const sourceStored = found.stored
    const destBucketId = req.destinationBucketId ?? found.bucketId
    const destBucket = this.buckets.get(destBucketId)
    if (!destBucket) return this.error(400, 'bad_bucket_id', 'Destination bucket not found')

    const fileVersion = this.makeFileVersion(
      destBucketId,
      req.fileName,
      sourceStored.fileVersion.contentType,
      sourceStored.data.byteLength,
      sourceStored.fileVersion.contentSha1 ?? 'none',
      FileAction.Copy,
    )
    const copied: StoredFile = { fileVersion, data: new Uint8Array(sourceStored.data) }
    const existing = destBucket.files.get(req.fileName)
    if (existing) {
      existing.push(copied)
    } else {
      destBucket.files.set(req.fileName, [copied])
    }

    return { status: 200, body: fileVersion }
  }

  private startLargeFile(req: {
    bucketId: string
    fileName: string
    contentType: string
    fileInfo?: Record<string, string>
  }): SimulatorJsonResponse {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const fid = genId('4_z')
    const large: LargeFileInProgress = {
      fileId: fid,
      bucketId: req.bucketId,
      fileName: req.fileName,
      contentType: req.contentType,
      fileInfo: req.fileInfo ?? {},
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
      },
    }
  }

  private getUploadPartUrl(req: { fileId: string }): SimulatorJsonResponse {
    if (!this.largeFiles.has(req.fileId))
      return this.error(400, 'bad_request', 'Large file not found')
    return {
      status: 200,
      body: {
        fileId: req.fileId,
        uploadUrl: `http://localhost:0/b2api/v3/b2_upload_part?fileId=${req.fileId}`,
        authorizationToken: 'sim_part_token',
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
    let totalSize = 0
    for (const [_, part] of sortedParts) totalSize += part.data.byteLength
    const combined = new Uint8Array(totalSize)
    let offset = 0
    for (const [_, part] of sortedParts) {
      combined.set(part.data, offset)
      offset += part.data.byteLength
    }

    const fileVersion = this.makeFileVersion(
      large.bucketId,
      large.fileName,
      large.contentType,
      totalSize,
      'none',
      FileAction.Upload,
    )
    const stored: StoredFile = { fileVersion, data: combined }
    const existing = bucket.files.get(large.fileName)
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(large.fileName, [stored])
    }

    this.largeFiles.delete(req.fileId)
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
    const prefix = req.namePrefix ?? ''
    const max = req.maxFileCount ?? 100

    // Real B2 orders unfinished large files by fileName ascending. Sort
    // here so pagination (via startFileId) is deterministic.
    const candidates = [...this.largeFiles.values()]
      .filter((f) => f.bucketId === req.bucketId)
      .filter((f) => f.fileName.startsWith(prefix))
      .sort((a, b) => a.fileName.localeCompare(b.fileName))

    // `startFileId` is the cursor returned from a prior page. Skip past
    // (and including) the entry with that fileId.
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
      fileInfo: f.fileInfo,
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
        authorizationToken: `sim_dl_auth_${genId('tok')}`,
      },
    }
  }

  // --- Keys ---

  private createKey(req: {
    accountId: string
    capabilities: string[]
    keyName: string
    validDurationInSeconds?: number
    bucketId?: string
    namePrefix?: string
  }): SimulatorJsonResponse {
    const kid = genId('sim_key')
    const appKey = genId('sim_secret')
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
      bucketId: req.bucketId ?? null,
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
        bucketId: stored.bucketId,
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
      bucketId: k.bucketId,
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
    return {
      status: 200,
      body: {
        keyName: key.keyName,
        applicationKeyId: key.applicationKeyId,
        capabilities: key.capabilities,
        accountId: key.accountId,
        expirationTimestamp: key.expirationTimestamp,
        bucketId: key.bucketId,
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
   * the simulator's flat ID generator (`genId('4_z')`) doesn't, so this
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
        const idx = versions.findIndex((v) => (v.fileVersion.fileId as string) === fileId)
        if (idx !== -1) {
          // Non-null asserted via the findIndex guard above.
          const stored = versions[idx] as StoredFile
          return { stored, bucketId: bid, bucket, versions, index: idx }
        }
      }
    }
    return null
  }

  private makeFileVersion(
    bucketId: string,
    fileName: string,
    contentType: string,
    contentLength: number,
    contentSha1: string,
    action: FileAction,
  ): FileVersion {
    return {
      accountId: accountIdOf(this.accountId),
      action,
      bucketId: bucketIdOf(bucketId),
      contentLength,
      contentMd5: null,
      contentSha1,
      contentType,
      fileId: fileIdOf(genId('4_z')),
      fileInfo: {},
      fileName,
      fileRetention: { isClientAuthorizedToRead: true, value: null },
      legalHold: { isClientAuthorizedToRead: true, value: null },
      replicationStatus: null,
      serverSideEncryption: { mode: EncryptionMode.None },
      uploadTimestamp: monotonicTimestamp(),
    }
  }

  private error(status: number, code: string, message: string): SimulatorJsonResponse {
    return { status, body: { status, code, message } }
  }
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
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    json: <T>() => Promise.resolve(JSON.parse(body) as T),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
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

    const isUpload = url.includes('b2_upload_file') || url.includes('b2_upload_part')
    const parsedUrl = new URL(url)
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
        text: () => Promise.resolve(new TextDecoder().decode(data)),
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
      result = this.sim.handleUpload(url, headers, data)
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
      result = await this.sim.handleRequest(request.method, parsedUrl.pathname, headers, body)
    }

    const responseBody = JSON.stringify(result.body)
    return {
      status: result.status,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(responseBody))
          controller.close()
        },
      }),
      json: <T>() => Promise.resolve(result.body as T),
      text: () => Promise.resolve(responseBody),
      arrayBuffer: () =>
        Promise.resolve(new TextEncoder().encode(responseBody).buffer as ArrayBuffer),
    }
  }
}
