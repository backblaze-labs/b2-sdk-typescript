import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.js'
import type { AuthorizeAccountResponse } from '../types/auth.js'
import type { BucketInfo, BucketType } from '../types/bucket.js'
import type { FileVersion } from '../types/file.js'
import type { AccountId, AuthToken, BucketId, FileId } from '../types/ids.js'

interface StoredFile {
  readonly fileVersion: FileVersion
  readonly data: Uint8Array
}

interface StoredBucket {
  readonly info: BucketInfo
  readonly files: Map<string, StoredFile[]>
}

let nextId = 1
function genId(prefix: string): string {
  return `${prefix}_${String(nextId++).padStart(12, '0')}`
}

export class B2Simulator {
  private readonly buckets = new Map<string, StoredBucket>()
  private readonly accountId = 'sim_account_0001'

  transport(): HttpTransport {
    return new SimulatorTransport(this)
  }

  handleRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown,
  ): { status: number; body: unknown } {
    const endpoint = path.split('/').pop() ?? ''

    if (endpoint === 'b2_authorize_account') {
      return this.authorize()
    }

    if (endpoint === 'b2_create_bucket') {
      return this.createBucket(
        body as { bucketName: string; bucketType: BucketType; accountId: string },
      )
    }

    if (endpoint === 'b2_list_buckets') {
      return this.listBuckets(body as { accountId: string })
    }

    if (endpoint === 'b2_delete_bucket') {
      return this.deleteBucket(body as { bucketId: string; accountId: string })
    }

    if (endpoint === 'b2_get_upload_url') {
      return this.getUploadUrl(body as { bucketId: string })
    }

    if (endpoint === 'b2_list_file_names') {
      return this.listFileNames(
        body as {
          bucketId: string
          maxFileCount?: number
          prefix?: string
          startFileName?: string
        },
      )
    }

    return {
      status: 400,
      body: { status: 400, code: 'bad_request', message: `Unknown endpoint: ${endpoint}` },
    }
  }

  handleUpload(
    url: string,
    headers: Record<string, string>,
    data: Uint8Array,
  ): { status: number; body: unknown } {
    const bucketId = new URL(url).searchParams.get('bucketId')
    if (!bucketId)
      return {
        status: 400,
        body: { status: 400, code: 'bad_request', message: 'Missing bucketId' },
      }

    const bucket = this.buckets.get(bucketId)
    if (!bucket)
      return {
        status: 400,
        body: { status: 400, code: 'bad_bucket_id', message: 'Bucket not found' },
      }

    const fileName = decodeURIComponent(headers['x-bz-file-name'] ?? '')
    const contentType = headers['content-type'] ?? 'application/octet-stream'
    const sha1 = headers['x-bz-content-sha1'] ?? 'none'

    const fid = genId('4_z') as unknown as FileId
    const fileVersion: FileVersion = {
      accountId: this.accountId as unknown as AccountId,
      action: 'upload',
      bucketId: bucketId as unknown as BucketId,
      contentLength: data.byteLength,
      contentMd5: null,
      contentSha1: sha1,
      contentType,
      fileId: fid,
      fileInfo: {},
      fileName,
      fileRetention: { isClientAuthorizedToRead: true, value: null },
      legalHold: { isClientAuthorizedToRead: true, value: null },
      replicationStatus: null,
      serverSideEncryption: { mode: 'none' },
      uploadTimestamp: Date.now(),
    }

    const stored: StoredFile = { fileVersion, data }
    const existing = bucket.files.get(fileName)
    if (existing) {
      existing.push(stored)
    } else {
      bucket.files.set(fileName, [stored])
    }

    return { status: 200, body: fileVersion }
  }

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
        return {
          status: 400,
          body: {
            status: 400,
            code: 'duplicate_bucket_name',
            message: 'Bucket name already in use',
          },
        }
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

  private listBuckets(req: { accountId: string }): { status: number; body: unknown } {
    const buckets = [...this.buckets.values()].map((b) => b.info)
    return { status: 200, body: { buckets } }
  }

  private deleteBucket(req: { bucketId: string; accountId: string }): {
    status: number
    body: unknown
  } {
    const bucket = this.buckets.get(req.bucketId)
    if (!bucket)
      return {
        status: 400,
        body: { status: 400, code: 'bad_bucket_id', message: 'Bucket not found' },
      }
    this.buckets.delete(req.bucketId)
    return { status: 200, body: bucket.info }
  }

  private getUploadUrl(req: { bucketId: string }): { status: number; body: unknown } {
    if (!this.buckets.has(req.bucketId)) {
      return {
        status: 400,
        body: { status: 400, code: 'bad_bucket_id', message: 'Bucket not found' },
      }
    }
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
    if (!bucket)
      return {
        status: 400,
        body: { status: 400, code: 'bad_bucket_id', message: 'Bucket not found' },
      }

    const max = req.maxFileCount ?? 1000
    const prefix = req.prefix ?? ''
    let allFiles = [...bucket.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .flatMap(([_, versions]) => versions.map((v) => v.fileVersion))
      .sort((a, b) => a.fileName.localeCompare(b.fileName))

    if (req.startFileName) {
      const start = req.startFileName
      allFiles = allFiles.filter((f) => f.fileName >= start)
    }

    const files = allFiles.slice(0, max)
    const nextFileName = allFiles.length > max ? allFiles[max]?.fileName : null

    return { status: 200, body: { files, nextFileName } }
  }
}

class SimulatorTransport implements HttpTransport {
  constructor(private readonly sim: B2Simulator) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = request.url
    const method = request.method
    const headers: Record<string, string> = {}
    if (request.headers) {
      for (const [k, v] of Object.entries(request.headers)) {
        headers[k.toLowerCase()] = v
      }
    }

    const isUpload = url.includes('b2_upload_file')

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
      result = this.sim.handleRequest(method, new URL(url).pathname, headers, body)
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
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(responseBody).buffer),
    }
  }
}
