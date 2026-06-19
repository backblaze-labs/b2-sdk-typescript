import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { deterministicBytes } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { EncryptionMode } from '../types/encryption.ts'
import { FileAction, type FileVersion } from '../types/file.ts'
import type { AccountId, BucketId, FileId } from '../types/ids.ts'
import { B2Folder } from './scanners/b2.ts'
import { LocalFolder } from './scanners/local.ts'
import type {
  B2SyncFolder,
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize } from './synchronizer.ts'
import type { B2SyncPath, SyncEvent } from './types.ts'

async function collectEvents(config: SynchronizerConfig): Promise<SyncEvent[]> {
  const events: SyncEvent[] = []
  for await (const event of synchronize(config)) {
    events.push(event)
  }
  return events
}

function recordingTransport(inner: HttpTransport, urls: string[]): HttpTransport {
  return {
    send(request: HttpRequest): Promise<HttpResponse> {
      urls.push(request.url)
      return inner.send(request)
    },
  }
}

function makeB2Path(relativePath: string, size: number, fileName = relativePath): B2SyncPath {
  const version: FileVersion = {
    accountId: 'acc' as unknown as AccountId,
    action: FileAction.Upload,
    bucketId: 'bucket' as unknown as BucketId,
    contentLength: size,
    contentMd5: null,
    contentSha1: 'sha1',
    contentType: 'application/octet-stream',
    fileId: `fid_${relativePath}` as unknown as FileId,
    fileInfo: {},
    fileName,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    replicationStatus: null,
    serverSideEncryption: { mode: EncryptionMode.None },
    uploadTimestamp: 1_000,
  }
  return {
    relativePath,
    modTimeMillis: version.uploadTimestamp,
    size,
    selectedVersion: version,
    allVersions: [version],
  }
}

function makeB2MemoryFolder(paths: readonly B2SyncPath[]): B2SyncFolder {
  return {
    type: 'b2',
    async *scan() {
      for (const path of paths) {
        yield path
      }
    },
  }
}

describe('synchronize large local files', () => {
  it('routes large sync uploads through multipart and round-trips downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-large-'))
    try {
      const sourceRoot = join(root, 'source')
      const destRoot = join(root, 'dest')
      await mkdir(sourceRoot)
      await mkdir(destRoot)

      const filePath = join(sourceRoot, 'large.bin')
      const payload = deterministicBytes(1024 * 3 + 123)
      await writeFile(filePath, payload)

      const urls: string[] = []
      const sim = new B2Simulator({ minimumPartSize: 1024, recommendedPartSize: 1024 })
      const client = new B2Client({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        transport: recordingTransport(sim.transport(), urls),
      })
      await client.authorize()
      const bucket = await client.createBucket({
        bucketName: 'sync-large',
        bucketType: BucketType.AllPrivate,
      })

      const uploadConfig: SynchronizerUpConfig = {
        source: new LocalFolder(sourceRoot),
        dest: new B2Folder(bucket, 'mirror/'),
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket,
        prefix: 'mirror/',
      }

      const uploadEvents = await collectEvents(uploadConfig)
      expect(uploadEvents.some((event) => event.type === 'upload-done')).toBe(true)
      expect(uploadEvents.some((event) => event.type === 'error')).toBe(false)
      expect(urls.some((url) => url.includes('b2_start_large_file'))).toBe(true)
      expect(urls.some((url) => url.includes('b2_upload_file'))).toBe(false)
      expect(urls.filter((url) => url.includes('b2_upload_part?fileId=')).length).toBeGreaterThan(1)
      expect(urls.some((url) => url.includes('b2_finish_large_file'))).toBe(true)

      const downloadConfig: SynchronizerDownConfig = {
        source: new B2Folder(bucket, 'mirror/'),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket,
      }

      const downloadEvents = await collectEvents(downloadConfig)
      expect(downloadEvents.some((event) => event.type === 'download-done')).toBe(true)
      expect(downloadEvents.some((event) => event.type === 'error')).toBe(false)
      expect(new Uint8Array(await readFile(join(destRoot, 'large.bin')))).toEqual(payload)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('synchronize download safety', () => {
  it('keeps the existing destination when the response body errors mid-stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-fail-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      const destPath = join(destRoot, 'keep.txt')
      await writeFile(destPath, 'valid')

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('partial'))
              controller.error(new Error('simulated body failure'))
            },
          }),
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('keep.txt', 99)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(destPath))).toBe('valid')
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates nested destination directories inside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-nested-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('ok'))
              controller.close()
            },
          }),
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('nested/ok.txt', 2)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'download-done')).toBe(true)
      expect(new TextDecoder().decode(await readFile(join(destRoot, 'nested', 'ok.txt')))).toBe(
        'ok',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects destination parents that are not directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-file-parent-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      await writeFile(join(destRoot, 'sub'), 'not a directory')

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('bad'))
              controller.close()
            },
          }),
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('sub/escape.txt', 3)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(join(destRoot, 'sub')))).toBe(
        'not a directory',
      )
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal paths before creating files inside or outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-traversal-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)

      for (const relPath of ['../escape-posix.txt', '..\\escape-win.txt']) {
        const bucket = {
          download: vi.fn().mockResolvedValue({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('bad'))
                controller.close()
              },
            }),
          }),
        } as unknown as Bucket

        const config: SynchronizerDownConfig = {
          source: makeB2MemoryFolder([makeB2Path(relPath, 3)]),
          dest: new LocalFolder(destRoot),
          options: { compareMode: 'size', keepMode: 'no-delete' },
          bucket,
        }

        const events = await collectEvents(config)
        expect(events.some((event) => event.type === 'error')).toBe(true)
        expect(bucket.download).not.toHaveBeenCalled()
      }

      expect(await readdir(destRoot)).toEqual([])
      await expect(readFile(join(root, 'escape-posix.txt'))).rejects.toThrow()
      await expect(readFile(join(root, 'escape-win.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects destination directory symlinks that resolve outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-symlink-'))
    try {
      const destRoot = join(root, 'dest')
      const outsideRoot = join(root, 'outside')
      await mkdir(destRoot)
      await mkdir(outsideRoot)
      await symlink(outsideRoot, join(destRoot, 'sub'), 'dir')

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('bad'))
              controller.close()
            },
          }),
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('sub/escape.txt', 3)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(await readdir(outsideRoot)).toEqual([])
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial-'))).toEqual([])
      await expect(readFile(join(outsideRoot, 'escape.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('synchronize upload safety', () => {
  it('does not upload bytes from a symlink swapped in after FileSource validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-symlink-'))
    try {
      const sourceRoot = join(root, 'source')
      await mkdir(sourceRoot)
      const filePath = join(sourceRoot, 'leak.bin')
      const secretPath = join(root, 'secret.bin')
      await writeFile(filePath, new TextEncoder().encode('safe'))
      await writeFile(secretPath, new TextEncoder().encode('secret'))

      let uploaded: Uint8Array | null = null
      const bucket = {
        upload: vi
          .fn()
          .mockImplementation(
            async (options: { source: { toArrayBuffer(): Promise<ArrayBuffer> } }) => {
              await rm(filePath)
              await symlink(secretPath, filePath)
              uploaded = new Uint8Array(await options.source.toArrayBuffer())
            },
          ),
      } as unknown as Bucket

      const config: SynchronizerUpConfig = {
        source: new LocalFolder(sourceRoot),
        dest: makeB2MemoryFolder([]),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
        prefix: '',
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(uploaded).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
