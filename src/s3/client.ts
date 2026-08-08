import { redactUrlForError } from '../internal/url-redaction.ts'
import { hexEncode, hmacSha256, sha256Hex } from '../util/crypto.ts'
import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import { presignS3Request, type QueryParam, type SignedHeader } from './sigv4.ts'
import { assertSafeBucketName, assertValidB2FileName } from './validation.ts'

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const SERVICE = 's3'
const TERMINATOR = 'aws4_request'
const HTTP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

type S3HttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'POST' | 'PUT'

/** Fetch-compatible function used by {@link S3CompatibleClient}. */
export type S3CompatibleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

/** S3 client configuration derived by {@link createS3ClientConfig}. */
export interface S3CompatibleAuthConfig {
  /** The S3-compatible endpoint URL. */
  readonly endpoint: string
  /** The S3 signing region. */
  readonly region: string
  /** AWS-style credentials backed by the B2 application key pair. */
  readonly credentials: {
    /** The B2 application key ID, used as the S3 access key ID. */
    readonly accessKeyId: string
    /** The B2 application key, used as the S3 secret access key. */
    readonly secretAccessKey: string
  }
  /** B2 requires path-style bucket addressing. */
  readonly forcePathStyle: boolean
}

/** Constructor options for {@link S3CompatibleClient}. */
export interface S3CompatibleClientOptions {
  /**
   * Optional fetch implementation. Defaults to `globalThis.fetch`.
   * Tests and controlled runtimes can inject their own implementation.
   */
  readonly fetch?: S3CompatibleFetch
}

/** Common per-request controls accepted by every network S3 helper. */
export interface S3CompatibleRequestOptions {
  /** Abort signal for cancelling the in-flight request. */
  readonly signal?: AbortSignal
}

/** Common input for bucket-level S3 helpers. */
export interface S3BucketRequestOptions extends S3CompatibleRequestOptions {
  /** Bucket name. */
  readonly bucket: string
}

/** Input for {@link S3Compatible.headBucket}. */
export type S3HeadBucketOptions = S3BucketRequestOptions

/** Input for {@link S3Compatible.getBucketLocation}. */
export type S3GetBucketLocationOptions = S3BucketRequestOptions

/** Result from {@link S3Compatible.getBucketLocation}. */
export interface S3GetBucketLocationResult {
  /** The S3 location constraint returned by B2, when present. */
  readonly locationConstraint?: string
}

/** Input for {@link S3Compatible.getObject}. */
export interface S3GetObjectOptions extends S3BucketRequestOptions {
  /** Object key / B2 file name. */
  readonly key: string
  /** Optional S3 Range header, for example `bytes=0-1048575`. */
  readonly range?: string
  /** Optional S3 version ID. */
  readonly versionId?: string
  /**
   * Optional local path to stream the response body to in Node.js.
   * When set, the returned `body` is `null` because the stream has been consumed.
   */
  readonly saveToPath?: string
}

/** Result from {@link S3Compatible.getObject}. */
export interface S3GetObjectResult {
  /** Response body stream, or `null` when `saveToPath` consumed it. */
  readonly body: ReadableStream<Uint8Array> | null
  /** Local path written when `saveToPath` was provided. */
  readonly savedToPath?: string
  /** Object content type, when returned by S3. */
  readonly contentType?: string
  /** Object content length, when returned by S3. */
  readonly contentLength?: number
  /** Byte range returned by S3, when a range request was satisfied. */
  readonly contentRange?: string
  /** Last-modified timestamp, when returned by S3. */
  readonly lastModified?: Date
  /** Object ETag, when returned by S3. */
  readonly etag?: string
  /** Object version ID, when returned by S3. */
  readonly versionId?: string
  /** User metadata from `x-amz-meta-*` response headers. */
  readonly metadata: Record<string, string>
  /** Server-side encryption algorithm, when returned by S3. */
  readonly serverSideEncryption?: string
}

/** Input for {@link S3Compatible.listObjectsV2}. */
export interface S3ListObjectsV2Options extends S3BucketRequestOptions {
  /** Only return keys with this prefix. */
  readonly prefix?: string
  /** Delimiter for folder-like listings, commonly `/`. */
  readonly delimiter?: string
  /** Maximum keys to return, 1 through 1000. Defaults to 1000. */
  readonly maxKeys?: number
  /** Continuation token from a prior response. */
  readonly continuationToken?: string
  /** Return keys after this key, exclusive. */
  readonly startAfter?: string
}

/** Object summary returned by {@link S3Compatible.listObjectsV2}. */
export interface S3ObjectSummary {
  /** Object key. */
  readonly key?: string
  /** Last-modified timestamp. */
  readonly lastModified?: Date
  /** Object ETag. */
  readonly etag?: string
  /** Object size in bytes. */
  readonly size?: number
  /** S3 storage class, when returned by B2. */
  readonly storageClass?: string
}

/** Result from {@link S3Compatible.listObjectsV2}. */
export interface S3ListObjectsV2Result {
  /** Object summaries from `Contents`. */
  readonly objects: readonly S3ObjectSummary[]
  /** Folder-like prefixes from `CommonPrefixes`. */
  readonly commonPrefixes: readonly string[]
  /** Whether another page is available. */
  readonly isTruncated: boolean
  /** Next continuation token, when truncated. */
  readonly nextContinuationToken?: string
  /** Number of keys returned, when supplied by S3. */
  readonly keyCount?: number
}

/** Supported S3 lifecycle rule shape for B2. */
export interface S3LifecycleRule {
  /** Unique rule identifier. */
  readonly id: string
  /** Rule status. */
  readonly status: 'Disabled' | 'Enabled'
  /** Prefix filter. B2 does not support speculative advanced S3 filters here. */
  readonly filter?: {
    /** Prefix to match. */
    readonly prefix?: string
  }
  /** Current-version expiration rule. */
  readonly expiration?: {
    /** Days after creation to expire the object. */
    readonly days?: number
    /** Whether expired delete markers are removed. */
    readonly expiredObjectDeleteMarker?: boolean
  }
  /** Noncurrent-version expiration rule. */
  readonly noncurrentVersionExpiration?: {
    /** Days after becoming noncurrent to expire the version. */
    readonly noncurrentDays: number
  }
  /** Incomplete multipart upload cleanup rule. */
  readonly abortIncompleteMultipartUpload?: {
    /** Days after initiation before an incomplete multipart upload is aborted. */
    readonly daysAfterInitiation: number
  }
}

/** Input for {@link S3Compatible.putBucketLifecycle}. */
export interface S3PutBucketLifecycleOptions extends S3BucketRequestOptions {
  /** Complete replacement lifecycle rule set. */
  readonly rules: readonly S3LifecycleRule[]
}

/** Input for {@link S3CompatibleMultipart.create}. */
export interface S3CreateMultipartUploadOptions extends S3BucketRequestOptions {
  /** Object key / B2 file name. */
  readonly key: string
  /** Optional object content type. */
  readonly contentType?: string
  /** Optional user metadata. */
  readonly metadata?: Record<string, string>
  /** S3 ACL compatibility hint accepted by B2. */
  readonly acl?: 'private' | 'public-read'
  /** B2 supports the S3 `AES256` server-side encryption value. */
  readonly serverSideEncryption?: 'AES256'
}

/** Result from {@link S3CompatibleMultipart.create}. */
export interface S3CreateMultipartUploadResult {
  /** Multipart upload ID. */
  readonly uploadId?: string
  /** Bucket returned by S3. */
  readonly bucket?: string
  /** Key returned by S3. */
  readonly key?: string
}

/** Completed multipart part descriptor. */
export interface S3CompletedMultipartPart {
  /** 1-based part number. */
  readonly partNumber: number
  /** ETag returned by the part upload. */
  readonly etag: string
}

/** Input for {@link S3CompatibleMultipart.complete}. */
export interface S3CompleteMultipartUploadOptions extends S3BucketRequestOptions {
  /** Object key / B2 file name. */
  readonly key: string
  /** Multipart upload ID. */
  readonly uploadId: string
  /** Completed parts in ascending part-number order. */
  readonly parts: readonly S3CompletedMultipartPart[]
}

/** Result from {@link S3CompatibleMultipart.complete}. */
export interface S3CompleteMultipartUploadResult {
  /** Object location returned by S3. */
  readonly location?: string
  /** Bucket returned by S3. */
  readonly bucket?: string
  /** Key returned by S3. */
  readonly key?: string
  /** Final multipart object ETag. */
  readonly etag?: string
}

/** Common input for multipart upload operations targeting an existing upload. */
export interface S3MultipartUploadTargetOptions extends S3BucketRequestOptions {
  /** Object key / B2 file name. */
  readonly key: string
  /** Multipart upload ID. */
  readonly uploadId: string
}

/** Input for {@link S3CompatibleMultipart.abort}. */
export type S3AbortMultipartUploadOptions = S3MultipartUploadTargetOptions

/** Input for {@link S3Compatible.presignUploadPart}. */
export interface S3PresignUploadPartOptions extends S3MultipartUploadTargetOptions {
  /** 1-based part number, 1 through 10000. */
  readonly partNumber: number
  /**
   * URL validity duration in seconds. Defaults to 3600. Must be an integer
   * from 1 to 604800.
   */
  readonly expiresIn?: number
}

/** Result from {@link S3Compatible.presignUploadPart}. */
export interface S3PresignUploadPartResult {
  /** 1-based part number that was signed. */
  readonly partNumber: number
  /** Presigned PUT URL for this part. Treat as a bearer credential. */
  readonly url: string
}

/** Input for {@link S3CompatibleMultipart.listUploads}. */
export interface S3ListMultipartUploadsOptions extends S3BucketRequestOptions {
  /** Only return uploads whose keys start with this prefix. */
  readonly prefix?: string
  /** Delimiter for folder-like upload listings. */
  readonly delimiter?: string
  /** Maximum uploads to return, 1 through 1000. Defaults to 1000. */
  readonly maxUploads?: number
  /** Key pagination cursor. */
  readonly keyMarker?: string
  /** Upload ID pagination cursor. */
  readonly uploadIdMarker?: string
}

/** S3 owner summary. */
export interface S3Owner {
  /** Owner ID. */
  readonly id?: string
  /** Owner display name. */
  readonly displayName?: string
}

/** Multipart upload summary. */
export interface S3MultipartUploadSummary {
  /** Object key. */
  readonly key?: string
  /** Multipart upload ID. */
  readonly uploadId?: string
  /** Initiation timestamp. */
  readonly initiated?: Date
  /** S3 storage class, when returned by B2. */
  readonly storageClass?: string
  /** Owner summary, when returned by S3. */
  readonly owner?: S3Owner
}

/** Result from {@link S3CompatibleMultipart.listUploads}. */
export interface S3ListMultipartUploadsResult {
  /** In-progress uploads. */
  readonly uploads: readonly S3MultipartUploadSummary[]
  /** Folder-like prefixes from `CommonPrefixes`. */
  readonly commonPrefixes: readonly string[]
  /** Whether another page is available. */
  readonly isTruncated: boolean
  /** Next key marker. */
  readonly nextKeyMarker?: string
  /** Next upload ID marker. */
  readonly nextUploadIdMarker?: string
}

/** Input for {@link S3CompatibleMultipart.listParts}. */
export interface S3ListPartsOptions extends S3MultipartUploadTargetOptions {
  /** Maximum parts to return, 1 through 1000. Defaults to 1000. */
  readonly maxParts?: number
  /** Part-number pagination cursor. */
  readonly partNumberMarker?: number
}

/** Uploaded part summary. */
export interface S3PartSummary {
  /** 1-based part number. */
  readonly partNumber?: number
  /** Last-modified timestamp. */
  readonly lastModified?: Date
  /** Part ETag. */
  readonly etag?: string
  /** Part size in bytes. */
  readonly size?: number
}

/** Result from {@link S3CompatibleMultipart.listParts}. */
export interface S3ListPartsResult {
  /** Uploaded parts. */
  readonly parts: readonly S3PartSummary[]
  /** Whether another page is available. */
  readonly isTruncated: boolean
  /** Next part-number marker. */
  readonly nextPartNumberMarker?: string
}

/** Input for {@link S3CompatibleMultipart.uploadPartCopy}. */
export interface S3UploadPartCopyOptions extends S3MultipartUploadTargetOptions {
  /** Destination part number, 1 through 10000. */
  readonly partNumber: number
  /** S3 CopySource header value, for example `source-bucket/path/to/source`. */
  readonly copySource: string
  /** Optional S3 CopySourceRange header, for example `bytes=0-104857599`. */
  readonly copySourceRange?: string
}

/** Result from {@link S3CompatibleMultipart.uploadPartCopy}. */
export interface S3UploadPartCopyResult {
  /** Copied part ETag. */
  readonly etag?: string
  /** Copied part last-modified timestamp. */
  readonly lastModified?: Date
}

/** Multipart operation group exposed by {@link S3Compatible}. */
export interface S3CompatibleMultipart {
  /** Start a multipart upload. */
  create(input: S3CreateMultipartUploadOptions): Promise<S3CreateMultipartUploadResult>
  /** Complete a multipart upload. */
  complete(input: S3CompleteMultipartUploadOptions): Promise<S3CompleteMultipartUploadResult>
  /** Abort a multipart upload. */
  abort(input: S3AbortMultipartUploadOptions): Promise<void>
  /** List uploaded parts for an in-progress multipart upload. */
  listParts(input: S3ListPartsOptions): Promise<S3ListPartsResult>
  /** List in-progress multipart uploads in a bucket. */
  listUploads(input: S3ListMultipartUploadsOptions): Promise<S3ListMultipartUploadsResult>
  /** Copy a source object range into one multipart upload part. */
  uploadPartCopy(input: S3UploadPartCopyOptions): Promise<S3UploadPartCopyResult>
}

/** Stable S3-compatible helper surface scoped to B2 SDK parity needs. */
export interface S3Compatible {
  /** Multipart operation group. */
  readonly multipart: S3CompatibleMultipart
  /** Check bucket reachability on the S3-compatible endpoint. */
  headBucket(input: S3HeadBucketOptions): Promise<void>
  /** Fetch a bucket's S3 location constraint. */
  getBucketLocation(input: S3GetBucketLocationOptions): Promise<S3GetBucketLocationResult>
  /** Get an object stream or save it to a local path. */
  getObject(input: S3GetObjectOptions): Promise<S3GetObjectResult>
  /** List objects with S3 ListObjectsV2 semantics. */
  listObjectsV2(input: S3ListObjectsV2Options): Promise<S3ListObjectsV2Result>
  /** Replace the bucket's S3 lifecycle configuration. */
  putBucketLifecycle(input: S3PutBucketLifecycleOptions): Promise<void>
  /** Presign one multipart UploadPart PUT URL. */
  presignUploadPart(input: S3PresignUploadPartOptions): Promise<S3PresignUploadPartResult>
  /** Flat alias for `multipart.create`. */
  createMultipartUpload(
    input: S3CreateMultipartUploadOptions,
  ): Promise<S3CreateMultipartUploadResult>
  /** Flat alias for `multipart.complete`. */
  completeMultipartUpload(
    input: S3CompleteMultipartUploadOptions,
  ): Promise<S3CompleteMultipartUploadResult>
  /** Flat alias for `multipart.abort`. */
  abortMultipartUpload(input: S3AbortMultipartUploadOptions): Promise<void>
  /** Flat alias for `multipart.listUploads`. */
  listMultipartUploads(input: S3ListMultipartUploadsOptions): Promise<S3ListMultipartUploadsResult>
  /** Flat alias for `multipart.listParts`. */
  listParts(input: S3ListPartsOptions): Promise<S3ListPartsResult>
  /** Flat alias for `multipart.uploadPartCopy`. */
  uploadPartCopy(input: S3UploadPartCopyOptions): Promise<S3UploadPartCopyResult>
}

/** Error thrown for non-successful S3-compatible responses. */
export class S3CompatibleError extends Error {
  /** HTTP status code. */
  readonly status: number
  /** S3 error code, when supplied by the service. */
  readonly code: string
  /** S3 request ID, when supplied by the service. */
  readonly requestId?: string
  /** S3 extended request ID, when supplied by the service. */
  readonly extendedRequestId?: string

  /**
   * Creates an S3-compatible response error.
   *
   * @param options - HTTP status and parsed S3 error details.
   */
  constructor(options: {
    status: number
    code: string
    message: string
    requestId?: string
    extendedRequestId?: string
  }) {
    super(options.message)
    this.name = 'S3CompatibleError'
    this.status = options.status
    this.code = options.code
    if (options.requestId !== undefined) this.requestId = options.requestId
    if (options.extendedRequestId !== undefined) this.extendedRequestId = options.extendedRequestId
  }
}

interface SignedRequestInput {
  readonly method: S3HttpMethod
  readonly bucket: string
  readonly key?: string
  readonly query?: readonly QueryParam[]
  readonly headers?: readonly SignedHeader[]
  readonly body?: BodyInit
  readonly signal?: AbortSignal
  readonly expectedStatuses: readonly number[]
}

/**
 * First-party S3-compatible helper client for B2-specific parity gaps.
 *
 * The client signs and sends exactly one HTTP request per network helper and
 * does not retry automatically. That keeps multipart start/complete/abort and
 * upload-part-copy idempotency under caller control: retry `create` only when
 * duplicate in-progress uploads are acceptable or reconciled, retry `complete`
 * only after checking whether the object was committed, retry `abort` as a
 * best-effort cleanup operation, and retry `uploadPartCopy` only when replacing
 * the same part number is acceptable.
 */
export class S3CompatibleClient implements S3Compatible {
  private readonly config: S3CompatibleAuthConfig
  private readonly fetchImpl: S3CompatibleFetch
  readonly multipart: S3CompatibleMultipart

  /**
   * Creates an S3-compatible helper client.
   *
   * @param config - Endpoint, region, and credentials from {@link createS3ClientConfig}.
   * @param options - Optional fetch override for controlled runtimes and tests.
   */
  constructor(config: S3CompatibleAuthConfig, options: S3CompatibleClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.multipart = {
      create: (input) => this.createMultipartUpload(input),
      complete: (input) => this.completeMultipartUpload(input),
      abort: (input) => this.abortMultipartUpload(input),
      listParts: (input) => this.listParts(input),
      listUploads: (input) => this.listMultipartUploads(input),
      uploadPartCopy: (input) => this.uploadPartCopy(input),
    }
  }

  async headBucket(input: S3HeadBucketOptions): Promise<void> {
    await this.request({
      method: 'HEAD',
      bucket: input.bucket,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
  }

  async getBucketLocation(input: S3GetBucketLocationOptions): Promise<S3GetBucketLocationResult> {
    const response = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query: [['location', '']],
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    const xml = await responseXml(response)
    const locationConstraint = xmlElementText(xml, 'LocationConstraint')
    return {
      ...(locationConstraint !== undefined ? { locationConstraint } : {}),
    }
  }

  async getObject(input: S3GetObjectOptions): Promise<S3GetObjectResult> {
    const query: QueryParam[] = []
    if (input.versionId !== undefined) {
      assertSafeQueryValue('versionId', input.versionId)
      query.push(['versionId', input.versionId])
    }

    const headers: SignedHeader[] = []
    if (input.range !== undefined) {
      assertSafeHeaderValue('range', input.range)
      headers.push(['range', input.range])
    }

    const response = await this.request({
      method: 'GET',
      bucket: input.bucket,
      key: input.key,
      query,
      headers,
      expectedStatuses: [200, 206],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    const metadata = responseMetadata(response.headers)
    const resultBase = {
      metadata,
      ...optionalHeader(response.headers, 'content-type', 'contentType'),
      ...optionalHeader(response.headers, 'content-range', 'contentRange'),
      ...optionalHeader(response.headers, 'etag', 'etag'),
      ...optionalHeader(response.headers, 'x-amz-version-id', 'versionId'),
      ...optionalHeader(response.headers, 'x-amz-server-side-encryption', 'serverSideEncryption'),
      ...optionalNumberHeader(response.headers, 'content-length', 'contentLength'),
      ...optionalDateHeader(response.headers, 'last-modified', 'lastModified'),
    } satisfies Omit<S3GetObjectResult, 'body' | 'savedToPath'>

    if (input.saveToPath !== undefined) {
      if (response.body === null) {
        throw new Error('S3 GetObject response did not include a body to save.')
      }
      await writeBodyToPath(response.body, input.saveToPath)
      return {
        ...resultBase,
        body: null,
        savedToPath: input.saveToPath,
      }
    }

    return {
      ...resultBase,
      body: response.body,
    }
  }

  async listObjectsV2(input: S3ListObjectsV2Options): Promise<S3ListObjectsV2Result> {
    const query: QueryParam[] = [['list-type', '2']]
    const maxKeys = input.maxKeys ?? 1000
    query.push(['max-keys', String(assertS3PageSize('maxKeys', maxKeys))])
    pushOptionalQuery(query, 'prefix', input.prefix)
    pushOptionalQuery(query, 'delimiter', input.delimiter)
    pushOptionalQuery(query, 'continuation-token', input.continuationToken)
    pushOptionalQuery(query, 'start-after', input.startAfter)

    const response = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    return parseListObjectsV2(await responseXml(response))
  }

  async putBucketLifecycle(input: S3PutBucketLifecycleOptions): Promise<void> {
    const body = lifecycleXml(input.rules)
    await this.request({
      method: 'PUT',
      bucket: input.bucket,
      query: [['lifecycle', '']],
      headers: [['content-type', 'application/xml']],
      body,
      expectedStatuses: [200, 204],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
  }

  async presignUploadPart(input: S3PresignUploadPartOptions): Promise<S3PresignUploadPartResult> {
    const partNumber = assertS3PartNumber(input.partNumber)
    assertSafeQueryValue('uploadId', input.uploadId)
    const url = await presignS3Request(
      'PUT',
      {
        endpoint: this.config.endpoint,
        region: this.config.region,
        accessKeyId: this.config.credentials.accessKeyId,
        secretAccessKey: this.config.credentials.secretAccessKey,
        bucketName: input.bucket,
        fileName: input.key,
        ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn } : {}),
      },
      [
        ['partNumber', String(partNumber)],
        ['uploadId', input.uploadId],
        ['x-id', 'UploadPart'],
      ],
      [],
    )

    return { partNumber, url }
  }

  async createMultipartUpload(
    input: S3CreateMultipartUploadOptions,
  ): Promise<S3CreateMultipartUploadResult> {
    const headers: SignedHeader[] = []
    if (input.contentType !== undefined) {
      assertSafeHeaderValue('contentType', input.contentType)
      headers.push(['content-type', input.contentType])
    }
    if (input.acl !== undefined) {
      headers.push(['x-amz-acl', input.acl])
    }
    if (input.serverSideEncryption !== undefined) {
      headers.push(['x-amz-server-side-encryption', input.serverSideEncryption])
    }
    headers.push(...metadataHeaders(input.metadata))

    const response = await this.request({
      method: 'POST',
      bucket: input.bucket,
      key: input.key,
      query: [['uploads', '']],
      headers,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    const xml = await responseXml(response)
    return {
      ...optionalXmlElement(xml, 'UploadId', 'uploadId'),
      ...optionalXmlElement(xml, 'Bucket', 'bucket'),
      ...optionalXmlElement(xml, 'Key', 'key'),
    }
  }

  async completeMultipartUpload(
    input: S3CompleteMultipartUploadOptions,
  ): Promise<S3CompleteMultipartUploadResult> {
    const body = completeMultipartUploadXml(input.parts)
    const response = await this.request({
      method: 'POST',
      bucket: input.bucket,
      key: input.key,
      query: [['uploadId', input.uploadId]],
      headers: [['content-type', 'application/xml']],
      body,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    const xml = await responseXml(response)
    return {
      ...optionalXmlElement(xml, 'Location', 'location'),
      ...optionalXmlElement(xml, 'Bucket', 'bucket'),
      ...optionalXmlElement(xml, 'Key', 'key'),
      ...optionalXmlElement(xml, 'ETag', 'etag'),
    }
  }

  async abortMultipartUpload(input: S3AbortMultipartUploadOptions): Promise<void> {
    assertSafeQueryValue('uploadId', input.uploadId)
    await this.request({
      method: 'DELETE',
      bucket: input.bucket,
      key: input.key,
      query: [['uploadId', input.uploadId]],
      expectedStatuses: [204],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
  }

  async listMultipartUploads(
    input: S3ListMultipartUploadsOptions,
  ): Promise<S3ListMultipartUploadsResult> {
    const query: QueryParam[] = [['uploads', '']]
    const maxUploads = input.maxUploads ?? 1000
    query.push(['max-uploads', String(assertS3PageSize('maxUploads', maxUploads))])
    pushOptionalQuery(query, 'prefix', input.prefix)
    pushOptionalQuery(query, 'delimiter', input.delimiter)
    pushOptionalQuery(query, 'key-marker', input.keyMarker)
    pushOptionalQuery(query, 'upload-id-marker', input.uploadIdMarker)

    const response = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    return parseListMultipartUploads(await responseXml(response))
  }

  async listParts(input: S3ListPartsOptions): Promise<S3ListPartsResult> {
    assertSafeQueryValue('uploadId', input.uploadId)
    const query: QueryParam[] = [
      ['uploadId', input.uploadId],
      ['max-parts', String(assertS3PageSize('maxParts', input.maxParts ?? 1000))],
    ]
    if (input.partNumberMarker !== undefined) {
      query.push([
        'part-number-marker',
        String(assertNonNegativeInteger('partNumberMarker', input.partNumberMarker)),
      ])
    }

    const response = await this.request({
      method: 'GET',
      bucket: input.bucket,
      key: input.key,
      query,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    return parseListParts(await responseXml(response))
  }

  async uploadPartCopy(input: S3UploadPartCopyOptions): Promise<S3UploadPartCopyResult> {
    const partNumber = assertS3PartNumber(input.partNumber)
    assertSafeQueryValue('uploadId', input.uploadId)
    assertSafeHeaderValue('copySource', input.copySource)
    const headers: SignedHeader[] = [['x-amz-copy-source', input.copySource]]
    if (input.copySourceRange !== undefined) {
      assertSafeHeaderValue('copySourceRange', input.copySourceRange)
      headers.push(['x-amz-copy-source-range', input.copySourceRange])
    }

    const response = await this.request({
      method: 'PUT',
      bucket: input.bucket,
      key: input.key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', input.uploadId],
      ],
      headers,
      expectedStatuses: [200],
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
    const xml = await responseXml(response)
    return {
      ...optionalXmlElement(xml, 'ETag', 'etag'),
      ...optionalXmlDateElement(xml, 'LastModified', 'lastModified'),
    }
  }

  private async request(input: SignedRequestInput): Promise<Response> {
    const signed = await this.signRequest(input)
    const response = await this.fetchImpl(signed.url, {
      method: input.method,
      headers: signed.headers,
      redirect: 'manual',
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })

    if (!input.expectedStatuses.includes(response.status)) {
      throw await s3ResponseError(response)
    }

    return response
  }

  private async signRequest(input: SignedRequestInput): Promise<{
    readonly url: string
    readonly headers: Headers
  }> {
    const endpoint = parseHttpsEndpoint(this.config.endpoint)
    assertSafeBucketName(input.bucket)
    if (input.key !== undefined) assertValidB2FileName(input.key)

    const canonicalUri = buildCanonicalUri(endpoint.pathname, input.bucket, input.key)
    const canonicalQuery = canonicalQueryString(input.query ?? [])
    const url = `${endpoint.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`
    const payloadHash = await s3PayloadHash(input.body)
    const { shortDate, longDate } = formatSigningDate(new Date())
    const headers = new Headers()
    for (const [name, value] of input.headers ?? []) {
      assertSafeHeaderName(name)
      assertSafeHeaderValue(name, value)
      headers.set(name, value)
    }
    headers.set('x-amz-content-sha256', payloadHash)
    headers.set('x-amz-date', longDate)

    const signedHeaders = normalizeSignedHeaders([
      ['host', canonicalHostHeader(endpoint)],
      ...[...headers.entries()],
    ])
    const signedHeaderNames = signedHeaders.map(([name]) => name).join(';')
    const canonicalHeaders = signedHeaders.map(([name, value]) => `${name}:${value}\n`).join('')
    const credentialScope = `${shortDate}/${this.config.region}/${SERVICE}/${TERMINATOR}`
    const canonicalRequest = [
      input.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join('\n')
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      longDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n')
    const signingKey = await deriveSigningKey(
      this.config.credentials.secretAccessKey,
      shortDate,
      this.config.region,
    )
    const signature = hexEncode(await hmacSha256(signingKey, stringToSign))
    headers.set(
      'authorization',
      [
        'AWS4-HMAC-SHA256',
        `Credential=${this.config.credentials.accessKeyId}/${credentialScope},`,
        `SignedHeaders=${signedHeaderNames},`,
        `Signature=${signature}`,
      ].join(' '),
    )

    return { url, headers }
  }
}

function parseHttpsEndpoint(endpoint: string): URL {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch (cause) {
    throw new TypeError(
      `S3-compatible requests require a valid endpoint URL; received "${redactUrlForError(
        endpoint,
        { invalidUrlLabel: '<invalid S3 endpoint URL>' },
      )}".`,
      { cause },
    )
  }

  if (parsed.protocol !== 'https:') {
    throw new TypeError(
      `S3-compatible requests require an https: endpoint; received "${redactUrlForError(parsed)}".`,
    )
  }

  return parsed
}

function buildCanonicalUri(
  endpointPath: string,
  bucketName: string,
  key: string | undefined,
): string {
  const basePath =
    endpointPath === '' || endpointPath === '/' ? '' : endpointPath.replace(/\/+$/, '')
  if (key === undefined) return `${basePath}/${awsPercentEncode(bucketName)}`
  return `${basePath}/${awsPercentEncode(bucketName)}/${encodePath(key)}`
}

function encodePath(path: string): string {
  return path.split('/').map(awsPercentEncode).join('/')
}

function canonicalHostHeader(endpoint: URL): string {
  const host = endpoint.host
  if (endpoint.protocol === 'https:' && host.endsWith(':443')) {
    return host.slice(0, -4)
  }
  return host
}

function canonicalQueryString(query: readonly QueryParam[]): string {
  return query
    .map(([name, value]) => [awsPercentEncode(name), awsPercentEncode(value)] as const)
    .sort(([aName, aValue], [bName, bValue]) => {
      if (aName < bName) return -1
      if (aName > bName) return 1
      if (aValue < bValue) return -1
      if (aValue > bValue) return 1
      return 0
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
}

function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function normalizeSignedHeaders(headers: readonly SignedHeader[]): SignedHeader[] {
  const combinedHeaders = new Map<string, string[]>()
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase()
    const values = combinedHeaders.get(normalizedName)
    if (values) {
      values.push(normalizeHeaderValue(value))
    } else {
      combinedHeaders.set(normalizedName, [normalizeHeaderValue(value)])
    }
  }

  return [...combinedHeaders.entries()]
    .map(([name, values]) => [name, values.join(',')] as const)
    .sort(([a], [b]) => {
      if (a < b) return -1
      if (a > b) return 1
      return 0
    })
}

function normalizeHeaderValue(value: string): string {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError('signed header values must not contain control characters.')
  }

  return value.trim().replace(/ +/g, ' ')
}

function formatSigningDate(date: Date): {
  readonly shortDate: string
  readonly longDate: string
} {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  const second = String(date.getUTCSeconds()).padStart(2, '0')
  const shortDate = `${year}${month}${day}`
  return {
    shortDate,
    longDate: `${shortDate}T${hour}${minute}${second}Z`,
  }
}

async function deriveSigningKey(
  secretAccessKey: string,
  shortDate: string,
  region: string,
): Promise<Uint8Array> {
  const dateKey = await hmacSha256(`AWS4${secretAccessKey}`, shortDate)
  const dateRegionKey = await hmacSha256(dateKey, region)
  const dateRegionServiceKey = await hmacSha256(dateRegionKey, SERVICE)
  return await hmacSha256(dateRegionServiceKey, TERMINATOR)
}

async function s3PayloadHash(body: BodyInit | undefined): Promise<string> {
  if (body === undefined) return await sha256Hex('')
  if (typeof body === 'string') return await sha256Hex(body)
  return UNSIGNED_PAYLOAD
}

function assertSafeHeaderName(name: string): void {
  if (!HTTP_HEADER_TOKEN.test(name)) {
    throw new TypeError(`S3 header name "${name}" must be a valid HTTP header token.`)
  }
}

function assertSafeHeaderValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(`${name} must not contain control characters.`)
  }
}

function assertSafeQueryValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(`${name} must not contain control characters.`)
  }
}

function assertS3PartNumber(partNumber: number): number {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new RangeError(`partNumber must be an integer from 1 to 10000; received ${partNumber}.`)
  }
  return partNumber
}

function assertS3PageSize(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new RangeError(`${name} must be an integer from 1 to 1000; received ${value}.`)
  }
  return value
}

function assertNonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer; received ${value}.`)
  }
  return value
}

function assertPositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; received ${value}.`)
  }
  return value
}

function pushOptionalQuery(query: QueryParam[], name: string, value: string | undefined): void {
  if (value === undefined) return
  assertSafeQueryValue(name, value)
  query.push([name, value])
}

function metadataHeaders(metadata: Record<string, string> | undefined): SignedHeader[] {
  const headers: SignedHeader[] = []
  const seenKeys = new Set<string>()
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!HTTP_HEADER_TOKEN.test(key)) {
      throw new TypeError(`metadata key "${key}" must be a non-empty valid HTTP header token.`)
    }
    if (typeof value !== 'string') {
      throw new TypeError(`metadata value for "${key}" must be a string.`)
    }
    assertSafeHeaderValue(`metadata value for "${key}"`, value)

    const lowerKey = key.toLowerCase()
    if (seenKeys.has(lowerKey)) {
      throw new TypeError(`metadata key "${key}" must not differ only by case.`)
    }
    seenKeys.add(lowerKey)
    headers.push([`x-amz-meta-${lowerKey}`, value])
  }
  return headers
}

function optionalHeader<K extends string>(
  headers: Headers,
  headerName: string,
  key: K,
): { readonly [P in K]?: string } {
  const value = headers.get(headerName)
  return value === null ? {} : ({ [key]: value } as { readonly [P in K]?: string })
}

function optionalNumberHeader<K extends string>(
  headers: Headers,
  headerName: string,
  key: K,
): { readonly [P in K]?: number } {
  const value = headers.get(headerName)
  if (value === null) return {}
  const numberValue = Number(value)
  return Number.isFinite(numberValue)
    ? ({ [key]: numberValue } as { readonly [P in K]?: number })
    : {}
}

function optionalDateHeader<K extends string>(
  headers: Headers,
  headerName: string,
  key: K,
): { readonly [P in K]?: Date } {
  const value = headers.get(headerName)
  if (value === null) return {}
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? ({ [key]: date } as { readonly [P in K]?: Date }) : {}
}

function responseMetadata(headers: Headers): Record<string, string> {
  const metadata: Record<string, string> = {}
  for (const [name, value] of headers.entries()) {
    if (name.startsWith('x-amz-meta-')) {
      metadata[name.slice('x-amz-meta-'.length)] = value
    }
  }
  return metadata
}

async function writeBodyToPath(body: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const [fs, pathModule, stream, streamPromises] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:stream'),
    import('node:stream/promises'),
  ])
  await fs.promises.mkdir(pathModule.dirname(path), { recursive: true })
  const nodeReadable = stream.Readable.fromWeb(
    body as Parameters<typeof stream.Readable.fromWeb>[0],
  )
  try {
    await streamPromises.pipeline(nodeReadable, fs.createWriteStream(path))
  } catch (err) {
    await fs.promises.unlink(path).catch(() => undefined)
    throw err
  }
}

async function s3ResponseError(response: Response): Promise<S3CompatibleError> {
  const text = await response.text().catch(() => '')
  const code = xmlElementText(text, 'Code') ?? `S3Status${response.status}`
  const message = xmlElementText(text, 'Message') ?? response.statusText
  const requestId =
    response.headers.get('x-amz-request-id') ?? xmlElementText(text, 'RequestId') ?? undefined
  const extendedRequestId = response.headers.get('x-amz-id-2') ?? undefined
  return new S3CompatibleError({
    status: response.status,
    code,
    message,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(extendedRequestId !== undefined ? { extendedRequestId } : {}),
  })
}

async function responseXml(response: Response): Promise<string> {
  const xml = await response.text()
  throwIfEmbeddedS3Error(xml, response.status)
  return xml
}

function throwIfEmbeddedS3Error(xml: string, status: number): void {
  if (xmlElementRaw(xml, 'Error') === undefined) return
  const code = xmlElementText(xml, 'Code')
  if (code === undefined) return
  throw new S3CompatibleError({
    status,
    code,
    message: xmlElementText(xml, 'Message') ?? code,
    ...optionalXmlElement(xml, 'RequestId', 'requestId'),
    ...optionalXmlElement(xml, 'HostId', 'extendedRequestId'),
  })
}

function lifecycleXml(rules: readonly S3LifecycleRule[]): string {
  return [
    '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    ...rules.map(lifecycleRuleXml),
    '</LifecycleConfiguration>',
  ].join('')
}

function lifecycleRuleXml(rule: S3LifecycleRule): string {
  const prefix = rule.filter?.prefix ?? ''
  const parts = [
    '<Rule>',
    `<ID>${escapeXml(rule.id)}</ID>`,
    `<Filter><Prefix>${escapeXml(prefix)}</Prefix></Filter>`,
    `<Status>${escapeXml(rule.status)}</Status>`,
  ]
  if (rule.expiration !== undefined) {
    parts.push('<Expiration>')
    if (rule.expiration.days !== undefined) {
      parts.push(`<Days>${assertPositiveInteger('expiration.days', rule.expiration.days)}</Days>`)
    }
    if (rule.expiration.expiredObjectDeleteMarker !== undefined) {
      parts.push(
        `<ExpiredObjectDeleteMarker>${String(
          rule.expiration.expiredObjectDeleteMarker,
        )}</ExpiredObjectDeleteMarker>`,
      )
    }
    parts.push('</Expiration>')
  }
  if (rule.noncurrentVersionExpiration !== undefined) {
    parts.push(
      '<NoncurrentVersionExpiration>',
      `<NoncurrentDays>${assertPositiveInteger(
        'noncurrentVersionExpiration.noncurrentDays',
        rule.noncurrentVersionExpiration.noncurrentDays,
      )}</NoncurrentDays>`,
      '</NoncurrentVersionExpiration>',
    )
  }
  if (rule.abortIncompleteMultipartUpload !== undefined) {
    parts.push(
      '<AbortIncompleteMultipartUpload>',
      `<DaysAfterInitiation>${assertPositiveInteger(
        'abortIncompleteMultipartUpload.daysAfterInitiation',
        rule.abortIncompleteMultipartUpload.daysAfterInitiation,
      )}</DaysAfterInitiation>`,
      '</AbortIncompleteMultipartUpload>',
    )
  }
  parts.push('</Rule>')
  return parts.join('')
}

function completeMultipartUploadXml(parts: readonly S3CompletedMultipartPart[]): string {
  let previousPartNumber = 0
  const partXml = parts.map((part) => {
    const partNumber = assertS3PartNumber(part.partNumber)
    if (partNumber <= previousPartNumber) {
      throw new RangeError('multipart completion parts must be in ascending partNumber order.')
    }
    previousPartNumber = partNumber
    assertSafeHeaderValue('etag', part.etag)
    return [
      '<Part>',
      `<PartNumber>${partNumber}</PartNumber>`,
      `<ETag>${escapeXml(part.etag)}</ETag>`,
      '</Part>',
    ].join('')
  })

  return ['<CompleteMultipartUpload>', ...partXml, '</CompleteMultipartUpload>'].join('')
}

function parseListObjectsV2(xml: string): S3ListObjectsV2Result {
  return {
    objects: xmlElements(xml, 'Contents').map((entry) => ({
      ...optionalInnerXmlElement(entry, 'Key', 'key'),
      ...optionalInnerXmlDateElement(entry, 'LastModified', 'lastModified'),
      ...optionalInnerXmlElement(entry, 'ETag', 'etag'),
      ...optionalInnerXmlNumberElement(entry, 'Size', 'size'),
      ...optionalInnerXmlElement(entry, 'StorageClass', 'storageClass'),
    })),
    commonPrefixes: xmlElements(xml, 'CommonPrefixes').flatMap((entry) => {
      const prefix = xmlElementText(entry, 'Prefix')
      return prefix === undefined ? [] : [prefix]
    }),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlElement(xml, 'NextContinuationToken', 'nextContinuationToken'),
    ...optionalXmlNumberElement(xml, 'KeyCount', 'keyCount'),
  }
}

function parseListMultipartUploads(xml: string): S3ListMultipartUploadsResult {
  return {
    uploads: xmlElements(xml, 'Upload').map((entry) => ({
      ...optionalInnerXmlElement(entry, 'Key', 'key'),
      ...optionalInnerXmlElement(entry, 'UploadId', 'uploadId'),
      ...optionalInnerXmlDateElement(entry, 'Initiated', 'initiated'),
      ...optionalInnerXmlElement(entry, 'StorageClass', 'storageClass'),
      ...optionalOwner(entry),
    })),
    commonPrefixes: xmlElements(xml, 'CommonPrefixes').flatMap((entry) => {
      const prefix = xmlElementText(entry, 'Prefix')
      return prefix === undefined ? [] : [prefix]
    }),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlElement(xml, 'NextKeyMarker', 'nextKeyMarker'),
    ...optionalXmlElement(xml, 'NextUploadIdMarker', 'nextUploadIdMarker'),
  }
}

function parseListParts(xml: string): S3ListPartsResult {
  return {
    parts: xmlElements(xml, 'Part').map((entry) => ({
      ...optionalInnerXmlNumberElement(entry, 'PartNumber', 'partNumber'),
      ...optionalInnerXmlDateElement(entry, 'LastModified', 'lastModified'),
      ...optionalInnerXmlElement(entry, 'ETag', 'etag'),
      ...optionalInnerXmlNumberElement(entry, 'Size', 'size'),
    })),
    isTruncated: xmlElementText(xml, 'IsTruncated') === 'true',
    ...optionalXmlElement(xml, 'NextPartNumberMarker', 'nextPartNumberMarker'),
  }
}

function optionalOwner(xml: string): { readonly owner?: S3Owner } {
  const ownerXml = xmlElementRaw(xml, 'Owner')
  if (ownerXml === undefined) return {}
  const owner = {
    ...optionalInnerXmlElement(ownerXml, 'ID', 'id'),
    ...optionalInnerXmlElement(ownerXml, 'DisplayName', 'displayName'),
  }
  return Object.keys(owner).length === 0 ? {} : { owner }
}

function optionalXmlElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: string } {
  return optionalInnerXmlElement(xml, element, key)
}

function optionalInnerXmlElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: string } {
  const value = xmlElementText(xml, element)
  return value === undefined ? {} : ({ [key]: value } as { readonly [P in K]?: string })
}

function optionalXmlNumberElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: number } {
  return optionalInnerXmlNumberElement(xml, element, key)
}

function optionalInnerXmlNumberElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: number } {
  const value = xmlElementText(xml, element)
  if (value === undefined) return {}
  const numberValue = Number(value)
  return Number.isFinite(numberValue)
    ? ({ [key]: numberValue } as { readonly [P in K]?: number })
    : {}
}

function optionalXmlDateElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: Date } {
  return optionalInnerXmlDateElement(xml, element, key)
}

function optionalInnerXmlDateElement<K extends string>(
  xml: string,
  element: string,
  key: K,
): { readonly [P in K]?: Date } {
  const value = xmlElementText(xml, element)
  if (value === undefined) return {}
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? ({ [key]: date } as { readonly [P in K]?: Date }) : {}
}

function xmlElements(xml: string, element: string): string[] {
  const pattern = elementPattern(element, 'g')
  const matches: string[] = []
  for (const match of xml.matchAll(pattern)) {
    const value = match[1]
    if (value !== undefined) matches.push(value)
  }
  return matches
}

function xmlElementRaw(xml: string, element: string): string | undefined {
  return elementPattern(element).exec(xml)?.[1]
}

function xmlElementText(xml: string, element: string): string | undefined {
  const raw = xmlElementRaw(xml, element)
  if (raw === undefined) return undefined
  return decodeXml(raw.replace(/<[^>]*>/g, ''))
}

function elementPattern(element: string, flags = ''): RegExp {
  const tag = escapeRegExp(element)
  return new RegExp(
    `<(?:[^:>/\\s]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[^:>/\\s]+:)?${tag}>`,
    flags,
  )
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    )
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
