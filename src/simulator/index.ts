import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.js'
import type { AuthorizeAccountResponse } from '../types/auth.js'
import type { BucketInfo, BucketType } from '../types/bucket.js'
import type { FileAction, FileVersion } from '../types/file.js'
import type { AccountId, AuthToken, BucketId, FileId } from '../types/ids.js'
import type { EventNotificationRule } from '../types/notifications.js'

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

export class B2Simulator {
  private readonly buckets = new Map<string, StoredBucket>()
  private readonly accountId = 'sim_account_0001'
  private readonly largeFiles = new Map<string, LargeFileInProgress>()
  private readonly keys = new Map<string, StoredKey>()
  private readonly notificationRules = new Map<string, EventNotificationRule[]>()

  transport(): HttpTransport {
    return new SimulatorTransport(this)
  }

  handleRequest(
    _method: string,
    path: string,
    _headers: Record<string, string>,
    body: unknown,
  ): { status: number; body: unknown } {
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
          },
        )
      case 'b2_get_file_info':
        return this.getFileInfo(body as { fileId: string })
      case 'b2_hide_file':
        return this.hideFile(body as { bucketId: string; fileName: string })
      case 'b2_delete_file_version':
        return this.deleteFileVersion(body as { fileId: string; fileName: string })
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
        return this.listUnfinishedLargeFiles(body as { bucketId: string })
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

  handleUpload(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): { status: number; body: unknown } {
    if (url.includes('b2_upload_part')) {
      return this.handleUploadPart(url, headers, data)
    }
    return this.handleUploadFile(url, headers, data)
  }

  handleDownload(
    path: string,
    headers: Record<string, string>,
  ): { status: number; headers: Record<string, string>; data: Uint8Array | null } {
    if (path.includes('b2_download_file_by_id')) {
      const url = new URL(`http://localhost${path}`)
      const fileId = url.searchParams.get('fileId') ?? ''
      return this.downloadById(fileId, headers['range'])
    }

    const fileMatch = path.match(/\/file\/([^/]+)\/(.+)/)
    if (fileMatch) {
      const bucketName = decodeURIComponent(fileMatch[1] ?? '')
      const fileName = decodeURIComponent(fileMatch[2] ?? '')
      return this.downloadByName(bucketName, fileName, headers['range'])
    }

    return { status: 404, headers: {}, data: null }
  }

  private handleUploadFile(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): { status: number; body: unknown } {
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
      'upload',
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
  ): { status: number; body: unknown } {
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
        serverSideEncryption: { mode: 'none' },
        uploadTimestamp: Date.now(),
      },
    }
  }

  private downloadById(
    fileId: string,
    range?: string,
  ): { status: number; headers: Record<string, string>; data: Uint8Array | null } {
    for (const bucket of this.buckets.values()) {
      for (const versions of bucket.files.values()) {
        for (const stored of versions) {
          if ((stored.fileVersion.fileId as string) === fileId) {
            return this.serveFile(stored, range)
          }
        }
      }
    }
    return { status: 404, headers: {}, data: null }
  }

  private downloadByName(
    bucketName: string,
    fileName: string,
    range?: string,
  ): { status: number; headers: Record<string, string>; data: Uint8Array | null } {
    for (const bucket of this.buckets.values()) {
      if (bucket.info.bucketName !== bucketName) continue
      const versions = bucket.files.get(fileName)
      if (!versions || versions.length === 0) break
      const latest = versions[versions.length - 1]
      if (!latest || latest.fileVersion.action === 'hide') {
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
        accountId: this.accountId as unknown as AccountId,
        authorizationToken: 'sim_auth_token' as unknown as AuthToken,
        apiInfo: {
          storageApi: {
            absoluteMinimumPartSize: 5_000_000,
            apiUrl: 'http://localhost:0',
            bucketId: null,
            bucketName: null,
            downloadUrl: 'http://localhost:0',
            infoType: 'storageApi',
            namePrefix: null,
            recommendedPartSize: 100_000_000,
            s3ApiUrl: 'http://localhost:0',
            allowed: {
              capabilities: [
                'listBuckets',
                'readBuckets',
                'writeBuckets',
                'deleteBuckets',
                'listFiles',
                'readFiles',
                'writeFiles',
                'deleteFiles',
                'listKeys',
                'writeKeys',
                'deleteKeys',
                'shareFiles',
                'readBucketNotifications',
                'writeBucketNotifications',
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
    const bid = genId('b2_bucket') as unknown as BucketId
    const info: BucketInfo = {
      accountId: req.accountId as unknown as AccountId,
      bucketId: bid,
      bucketName: req.bucketName,
      bucketType: req.bucketType,
      bucketInfo: {},
      corsRules: [],
      defaultServerSideEncryption: { mode: 'none' },
      fileLockConfiguration: {
        isClientAuthorizedToRead: true,
        value: { isFileLockEnabled: false, defaultRetention: { mode: 'none', period: null } },
      },
      lifecycleRules: [],
      options: [],
      revision: 1,
      defaultRetention: { mode: 'none', period: null },
      replicationConfiguration: { asReplicationSource: null, asReplicationDestination: null },
    }
    this.buckets.set(bid as string, { info, files: new Map() })
    return { status: 200, body: info }
  }

  private listBuckets(): { status: number; body: unknown } {
    const buckets = [...this.buckets.values()].map((b) => b.info)
    return { status: 200, body: { buckets } }
  }

  private deleteBucket(req: { bucketId: string }): { status: number; body: unknown } {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    this.buckets.delete(req.bucketId)
    return { status: 200, body: bucket.info }
  }

  private updateBucket(req: Record<string, unknown>): { status: number; body: unknown } {
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
      revision: bucket.info.revision + 1,
    }
    this.buckets.set(req['bucketId'] as string, { info: updated, files: bucket.files })
    return { status: 200, body: updated }
  }

  private getUploadUrl(req: { bucketId: string }): { status: number; body: unknown } {
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
  }): { status: number; body: unknown } {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    let allFiles = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([_, versions]) => versions[versions.length - 1])
      .filter((v): v is StoredFile => v !== undefined && v.fileVersion.action !== 'hide')
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
  }): { status: number; body: unknown } {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const max = req.maxFileCount ?? 1000
    let allVersions = [...bucket.files.entries()]
      .flatMap(([_, versions]) => versions.map((v) => v.fileVersion))
      .sort((a, b) => {
        const nameCmp = a.fileName.localeCompare(b.fileName)
        if (nameCmp !== 0) return nameCmp
        return b.uploadTimestamp - a.uploadTimestamp
      })

    if (req.startFileName) {
      const start = req.startFileName
      allVersions = allVersions.filter((f) => f.fileName >= start)
    }

    const files = allVersions.slice(0, max)
    const nextFileName = allVersions.length > max ? (allVersions[max]?.fileName ?? null) : null
    const nextFileId =
      allVersions.length > max ? ((allVersions[max]?.fileId as string) ?? null) : null

    return { status: 200, body: { files, nextFileName, nextFileId } }
  }

  private getFileInfo(req: { fileId: string }): { status: number; body: unknown } {
    for (const bucket of this.buckets.values()) {
      for (const versions of bucket.files.values()) {
        for (const stored of versions) {
          if ((stored.fileVersion.fileId as string) === req.fileId) {
            return { status: 200, body: stored.fileVersion }
          }
        }
      }
    }
    return this.error(404, 'file_not_present', 'File not found')
  }

  private hideFile(req: { bucketId: string; fileName: string }): { status: number; body: unknown } {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket) return this.error(400, 'bad_bucket_id', 'Bucket not found')

    const fileVersion = this.makeFileVersion(
      req.bucketId,
      req.fileName,
      'application/octet-stream',
      0,
      'none',
      'hide',
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

  private deleteFileVersion(req: { fileId: string; fileName: string }): {
    status: number
    body: unknown
  } {
    for (const bucket of this.buckets.values()) {
      const versions = bucket.files.get(req.fileName)
      if (!versions) continue
      const idx = versions.findIndex((v) => (v.fileVersion.fileId as string) === req.fileId)
      if (idx !== -1) {
        versions.splice(idx, 1)
        if (versions.length === 0) bucket.files.delete(req.fileName)
        return { status: 200, body: { fileId: req.fileId, fileName: req.fileName } }
      }
    }
    return this.error(400, 'file_not_present', 'File version not found')
  }

  private copyFile(req: { sourceFileId: string; fileName: string; destinationBucketId?: string }): {
    status: number
    body: unknown
  } {
    let sourceStored: StoredFile | undefined
    let sourceBucketId: string | undefined
    for (const [bid, bucket] of this.buckets.entries()) {
      for (const versions of bucket.files.values()) {
        for (const stored of versions) {
          if ((stored.fileVersion.fileId as string) === req.sourceFileId) {
            sourceStored = stored
            sourceBucketId = bid
          }
        }
      }
    }
    if (!sourceStored || !sourceBucketId)
      return this.error(404, 'file_not_present', 'Source file not found')

    const destBucketId = req.destinationBucketId ?? sourceBucketId
    const destBucket = this.buckets.get(destBucketId)
    if (!destBucket) return this.error(400, 'bad_bucket_id', 'Destination bucket not found')

    const fileVersion = this.makeFileVersion(
      destBucketId,
      req.fileName,
      sourceStored.fileVersion.contentType,
      sourceStored.data.byteLength,
      sourceStored.fileVersion.contentSha1 ?? 'none',
      'copy',
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
  }): { status: number; body: unknown } {
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

  private getUploadPartUrl(req: { fileId: string }): { status: number; body: unknown } {
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
      'upload',
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

  private cancelLargeFile(req: { fileId: string }): { status: number; body: unknown } {
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

  private listUnfinishedLargeFiles(req: { bucketId: string }): { status: number; body: unknown } {
    const files = [...this.largeFiles.values()]
      .filter((f) => f.bucketId === req.bucketId)
      .map((f) => ({
        fileId: f.fileId,
        fileName: f.fileName,
        accountId: this.accountId,
        bucketId: f.bucketId,
        contentType: f.contentType,
        fileInfo: f.fileInfo,
      }))
    return { status: 200, body: { files, nextFileId: null } }
  }

  private getDownloadAuthorization(req: {
    bucketId: string
    fileNamePrefix: string
    validDurationInSeconds: number
  }): { status: number; body: unknown } {
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
  }): { status: number; body: unknown } {
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
  }): { status: number; body: unknown } {
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

  private deleteKey(req: { applicationKeyId: string }): { status: number; body: unknown } {
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
  }): { status: number; body: unknown } {
    if (!this.buckets.has(req.bucketId)) return this.error(400, 'bad_bucket_id', 'Bucket not found')
    this.notificationRules.set(req.bucketId, req.eventNotificationRules)
    return {
      status: 200,
      body: { bucketId: req.bucketId, eventNotificationRules: req.eventNotificationRules },
    }
  }

  // --- Helpers ---

  private makeFileVersion(
    bucketId: string,
    fileName: string,
    contentType: string,
    contentLength: number,
    contentSha1: string,
    action: FileAction,
  ): FileVersion {
    return {
      accountId: this.accountId as unknown as AccountId,
      action,
      bucketId: bucketId as unknown as BucketId,
      contentLength,
      contentMd5: null,
      contentSha1,
      contentType,
      fileId: genId('4_z') as unknown as FileId,
      fileInfo: {},
      fileName,
      fileRetention: { isClientAuthorizedToRead: true, value: null },
      legalHold: { isClientAuthorizedToRead: true, value: null },
      replicationStatus: null,
      serverSideEncryption: { mode: 'none' },
      uploadTimestamp: Date.now(),
    }
  }

  private error(status: number, code: string, message: string): { status: number; body: unknown } {
    return { status, body: { status, code, message } }
  }
}

class SimulatorTransport implements HttpTransport {
  constructor(private readonly sim: B2Simulator) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = request.url
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
      const result = this.sim.handleDownload(parsedUrl.pathname + parsedUrl.search, headers)
      const data = result.data ?? new Uint8Array(0)
      const responseHeaders = new Headers(result.headers)
      responseHeaders.set(
        'Content-Type',
        result.headers['Content-Type'] ?? 'application/octet-stream',
      )

      return {
        status: result.status,
        headers: responseHeaders,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(data)
            controller.close()
          },
        }),
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
      result = this.sim.handleRequest(request.method, parsedUrl.pathname, headers, body)
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
