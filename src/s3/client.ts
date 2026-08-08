import {
  assertSafeHeaderName,
  assertSafeHeaderValue,
  assertSafeQueryValue,
  cancelResponseBody,
  type S3RequestInput,
  type S3RequestResult,
  sendSignedS3Request,
} from './request.ts'
import { presignS3Request, type QueryParam, type SignedHeader } from './sigv4.ts'
import {
  completeMultipartUploadXml,
  lifecycleXml,
  parseBucketLocation,
  parseCompleteMultipartUpload,
  parseCreateMultipartUpload,
  parseListMultipartUploads,
  parseListObjectsV2,
  parseListParts,
  parseUploadPartCopy,
  responseXml,
} from './xml.ts'

export { S3CompatibleError } from './xml.ts'

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
  /**
   * Local root that confines `getObject({ saveToPath })` writes. When set,
   * `saveToPath` must be a relative path below this directory.
   */
  readonly downloadRoot?: string
  /**
   * Per-request and consumed-body timeout in milliseconds. Defaults to
   * 15 minutes. Set to `0` only when caller-owned AbortSignals enforce a
   * stricter deadline.
   */
  readonly requestTimeoutMs?: number
  /** Optional signing clock override for deterministic tests. */
  readonly signingDate?: Date | number
}

/** Common per-request controls accepted by every network S3 helper. */
export interface S3CompatibleRequestOptions {
  /** Abort signal for cancelling the in-flight request. */
  readonly signal?: AbortSignal
  /** Optional timeout override for this request; `0` disables the SDK timeout. */
  readonly requestTimeoutMs?: number
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
   * Optional local path to stream the response body to in Node.js. This path
   * must be relative to `downloadRoot`; absolute paths, traversal, symlink
   * parents, symlink leaves, and existing destinations are rejected.
   */
  readonly saveToPath?: string
  /** Optional per-call root for `saveToPath`, overriding the client root. */
  readonly downloadRoot?: string
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
  /** B2's S3 lifecycle API supports enabled rules only. */
  readonly status: 'Enabled'
  /** Prefix filter. B2 does not support speculative advanced S3 filters here. */
  readonly filter?: {
    /** Prefix to match. */
    readonly prefix?: string
  }
  /** Current-version expiration rule. */
  readonly expiration?: {
    /** Days after creation to expire the object. */
    readonly days?: number
    /** Whether expired delete markers are removed. B2 supports `true` only. */
    readonly expiredObjectDeleteMarker?: true
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
  /**
   * S3 ACL compatibility hint accepted by B2. `public-read` makes the object
   * world-readable; never populate this from untrusted request JSON.
   */
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
  /**
   * Expected upload body size. Strongly recommended for untrusted uploaders;
   * when supplied, the URL signs `Content-Length` and upload clients must send
   * the same value.
   */
  readonly contentLength?: number
  /**
   * Optional base64 SHA-256 checksum to sign as `x-amz-checksum-sha256`.
   * Use only when the target S3-compatible endpoint accepts that header.
   */
  readonly checksumSha256?: string
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
  readonly nextPartNumberMarker?: number
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
}

interface SignedRequestInput
  extends Pick<
    S3RequestInput,
    'body' | 'bucket' | 'expectedStatuses' | 'headers' | 'key' | 'method' | 'query'
  > {
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
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
  private readonly downloadRoot: string | undefined
  private readonly requestTimeoutMs: number | undefined
  private readonly signingDate: Date | number | undefined
  readonly multipart: S3CompatibleMultipart

  /**
   * Creates an S3-compatible helper client.
   *
   * @param config - Endpoint, region, and credentials from {@link createS3ClientConfig}.
   * @param options - Optional fetch, save root, timeout, and signing-clock controls.
   */
  constructor(config: S3CompatibleAuthConfig, options: S3CompatibleClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.downloadRoot = options.downloadRoot
    this.requestTimeoutMs = options.requestTimeoutMs
    this.signingDate = options.signingDate
    this.multipart = {
      create: (input) => this.#createMultipartUpload(input),
      complete: (input) => this.#completeMultipartUpload(input),
      abort: (input) => this.#abortMultipartUpload(input),
      listParts: (input) => this.#listParts(input),
      listUploads: (input) => this.#listMultipartUploads(input),
      uploadPartCopy: (input) => this.#uploadPartCopy(input),
    }
  }

  async headBucket(input: S3HeadBucketOptions): Promise<void> {
    const request = await this.request({
      method: 'HEAD',
      bucket: input.bucket,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      await request.race(cancelResponseBody(request.response))
    } finally {
      request.dispose()
    }
  }

  async getBucketLocation(input: S3GetBucketLocationOptions): Promise<S3GetBucketLocationResult> {
    const request = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query: [['location', '']],
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseBucketLocation(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
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

    const request = await this.request({
      method: 'GET',
      bucket: input.bucket,
      key: input.key,
      query,
      headers,
      expectedStatuses: [200, 206],
      ...requestControls(input),
    })
    try {
      const { response } = request
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
        const downloadRoot = input.downloadRoot ?? this.downloadRoot
        if (downloadRoot === undefined) {
          await cancelResponseBody(response)
          throw new TypeError('getObject({ saveToPath }) requires a configured downloadRoot.')
        }
        const { saveS3BodyToPath } = await import('./save-to-path.node.ts')
        const savedToPath = await saveS3BodyToPath({
          body: response.body,
          downloadRoot,
          relativePath: input.saveToPath,
          signal: request.signal,
          idleTimeoutMs: request.timeoutMs,
        }).catch(async (error: unknown) => {
          await cancelResponseBody(response)
          throw error
        })
        return {
          ...resultBase,
          body: null,
          savedToPath,
        }
      }

      return {
        ...resultBase,
        body: response.body,
      }
    } finally {
      request.dispose()
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

    const request = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseListObjectsV2(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  async putBucketLifecycle(input: S3PutBucketLifecycleOptions): Promise<void> {
    const body = lifecycleXml(input.rules)
    const request = await this.request({
      method: 'PUT',
      bucket: input.bucket,
      query: [['lifecycle', '']],
      headers: [['content-type', 'application/xml']],
      body,
      expectedStatuses: [200, 204],
      ...requestControls(input),
    })
    try {
      await request.race(cancelResponseBody(request.response))
    } finally {
      request.dispose()
    }
  }

  async presignUploadPart(input: S3PresignUploadPartOptions): Promise<S3PresignUploadPartResult> {
    const partNumber = assertS3PartNumber(input.partNumber)
    assertSafeQueryValue('uploadId', input.uploadId)
    const headers: SignedHeader[] = []
    if (input.contentLength !== undefined) {
      headers.push([
        'content-length',
        String(assertPositiveInteger('contentLength', input.contentLength)),
      ])
    }
    if (input.checksumSha256 !== undefined) {
      assertSafeHeaderValue('checksumSha256', input.checksumSha256)
      headers.push(['x-amz-checksum-sha256', input.checksumSha256])
    }
    const url = await presignS3Request(
      'PUT',
      {
        endpoint: this.config.endpoint,
        region: this.config.region,
        accessKeyId: this.config.credentials.accessKeyId,
        secretAccessKey: this.config.credentials.secretAccessKey,
        bucketName: input.bucket,
        fileName: input.key,
        ...(this.signingDate !== undefined ? { signingDate: this.signingDate } : {}),
        ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn } : {}),
      },
      [
        ['partNumber', String(partNumber)],
        ['uploadId', input.uploadId],
        ['x-id', 'UploadPart'],
      ],
      headers,
    )

    return { partNumber, url }
  }

  async #createMultipartUpload(
    input: S3CreateMultipartUploadOptions,
  ): Promise<S3CreateMultipartUploadResult> {
    const headers: SignedHeader[] = []
    if (input.contentType !== undefined) {
      assertSafeHeaderValue('contentType', input.contentType)
      headers.push(['content-type', input.contentType])
    }
    if (input.acl !== undefined) {
      headers.push(['x-amz-acl', assertS3Acl(input.acl)])
    }
    if (input.serverSideEncryption !== undefined) {
      headers.push([
        'x-amz-server-side-encryption',
        assertServerSideEncryption(input.serverSideEncryption),
      ])
    }
    headers.push(...metadataHeaders(input.metadata))

    const request = await this.request({
      method: 'POST',
      bucket: input.bucket,
      key: input.key,
      query: [['uploads', '']],
      headers,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseCreateMultipartUpload(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  async #completeMultipartUpload(
    input: S3CompleteMultipartUploadOptions,
  ): Promise<S3CompleteMultipartUploadResult> {
    const body = completeMultipartUploadXml(input.parts)
    const request = await this.request({
      method: 'POST',
      bucket: input.bucket,
      key: input.key,
      query: [['uploadId', input.uploadId]],
      headers: [['content-type', 'application/xml']],
      body,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseCompleteMultipartUpload(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  async #abortMultipartUpload(input: S3AbortMultipartUploadOptions): Promise<void> {
    assertSafeQueryValue('uploadId', input.uploadId)
    const request = await this.request({
      method: 'DELETE',
      bucket: input.bucket,
      key: input.key,
      query: [['uploadId', input.uploadId]],
      expectedStatuses: [204],
      ...requestControls(input),
    })
    try {
      await request.race(cancelResponseBody(request.response))
    } finally {
      request.dispose()
    }
  }

  async #listMultipartUploads(
    input: S3ListMultipartUploadsOptions,
  ): Promise<S3ListMultipartUploadsResult> {
    const query: QueryParam[] = [['uploads', '']]
    const maxUploads = input.maxUploads ?? 1000
    query.push(['max-uploads', String(assertS3PageSize('maxUploads', maxUploads))])
    pushOptionalQuery(query, 'prefix', input.prefix)
    pushOptionalQuery(query, 'delimiter', input.delimiter)
    pushOptionalQuery(query, 'key-marker', input.keyMarker)
    pushOptionalQuery(query, 'upload-id-marker', input.uploadIdMarker)

    const request = await this.request({
      method: 'GET',
      bucket: input.bucket,
      query,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseListMultipartUploads(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  async #listParts(input: S3ListPartsOptions): Promise<S3ListPartsResult> {
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

    const request = await this.request({
      method: 'GET',
      bucket: input.bucket,
      key: input.key,
      query,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseListParts(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  async #uploadPartCopy(input: S3UploadPartCopyOptions): Promise<S3UploadPartCopyResult> {
    const partNumber = assertS3PartNumber(input.partNumber)
    assertSafeQueryValue('uploadId', input.uploadId)
    assertSafeHeaderValue('copySource', input.copySource)
    const headers: SignedHeader[] = [['x-amz-copy-source', input.copySource]]
    if (input.copySourceRange !== undefined) {
      assertSafeHeaderValue('copySourceRange', input.copySourceRange)
      headers.push(['x-amz-copy-source-range', input.copySourceRange])
    }

    const request = await this.request({
      method: 'PUT',
      bucket: input.bucket,
      key: input.key,
      query: [
        ['partNumber', String(partNumber)],
        ['uploadId', input.uploadId],
      ],
      headers,
      expectedStatuses: [200],
      ...requestControls(input),
    })
    try {
      return parseUploadPartCopy(await request.race(responseXml(request.response)))
    } finally {
      request.dispose()
    }
  }

  private async request(input: SignedRequestInput): Promise<S3RequestResult> {
    const requestTimeoutMs = input.requestTimeoutMs ?? this.requestTimeoutMs
    return await sendSignedS3Request({
      config: this.config,
      fetchImpl: this.fetchImpl,
      method: input.method,
      bucket: input.bucket,
      expectedStatuses: input.expectedStatuses,
      ...(this.signingDate !== undefined ? { signingDate: this.signingDate } : {}),
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    })
  }
}

function requestControls(input: S3CompatibleRequestOptions): {
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
} {
  return {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
  }
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
    assertSafeHeaderName(key)
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

function assertS3Acl(value: unknown): 'private' | 'public-read' {
  if (value !== 'private' && value !== 'public-read') {
    throw new TypeError('acl must be "private" or "public-read".')
  }
  return value
}

function assertServerSideEncryption(value: unknown): 'AES256' {
  if (value !== 'AES256') {
    throw new TypeError('serverSideEncryption must be "AES256".')
  }
  return value
}
