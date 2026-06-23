import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import { ChecksumMismatchError } from '../errors/index.ts'
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

const isBun = typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined'

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

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
  reject(reason?: unknown): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function delayedBody(
  text: string,
  ready: Deferred,
  release: Promise<void>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      ready.resolve()
      release.then(
        () => controller.close(),
        (err: unknown) => controller.error(err),
      )
    },
  })
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
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the existing destination when an abort interrupts the stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-abort-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      const destPath = join(destRoot, 'keep.txt')
      await writeFile(destPath, 'valid')
      const controller = new AbortController()

      const bucket = {
        download: vi.fn().mockImplementation(() => {
          return Promise.resolve({
            body: new ReadableStream<Uint8Array>({
              start(streamController) {
                streamController.enqueue(new TextEncoder().encode('partial'))
                controller.abort()
                streamController.close()
              },
            }),
          })
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('keep.txt', 8)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete', signal: controller.signal },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(destPath))).toBe('valid')
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the existing destination when checksum verification rejects at end', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-checksum-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      const destPath = join(destRoot, 'keep.txt')
      await writeFile(destPath, 'valid')

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('attacker'))
              controller.error(
                new ChecksumMismatchError({
                  status: 400,
                  code: 'bad_sha1_checksum',
                  message: 'Downloaded content SHA-1 mismatch',
                }),
              )
            },
          }),
        }),
      } as unknown as Bucket

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('keep.txt', 8)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(destPath))).toBe('valid')
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects short completed downloads before replacing the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-short-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      const destPath = join(destRoot, 'keep.txt')
      await writeFile(destPath, 'valid')

      const bucket = {
        download: vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('short'))
              controller.close()
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
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects oversized downloads before replacing the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-long-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      const destPath = join(destRoot, 'keep.txt')
      await writeFile(destPath, 'valid')

      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('too-long'))
              controller.close()
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('keep.txt', 3)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(destPath))).toBe('valid')
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses independent temp files for overlapping downloads to the same destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-overlap-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)

      const firstReady = deferred()
      const secondReady = deferred()
      const firstRelease = deferred()
      const secondRelease = deferred()

      const firstBucket = {
        download: vi.fn().mockResolvedValue({
          body: delayedBody('first', firstReady, firstRelease.promise),
        }),
      } as unknown as Bucket
      const secondBucket = {
        download: vi.fn().mockResolvedValue({
          body: delayedBody('other', secondReady, secondRelease.promise),
        }),
      } as unknown as Bucket

      const source = makeB2MemoryFolder([makeB2Path('same.txt', 5)])
      const baseConfig = {
        source,
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
      } satisfies Omit<SynchronizerDownConfig, 'bucket'>

      const firstConfig: SynchronizerDownConfig = { ...baseConfig, bucket: firstBucket }
      const secondConfig: SynchronizerDownConfig = { ...baseConfig, bucket: secondBucket }

      const firstEventsPromise = collectEvents(firstConfig)
      await firstReady.promise
      const secondEventsPromise = collectEvents(secondConfig)
      await secondReady.promise

      secondRelease.resolve()
      const secondEvents = await secondEventsPromise
      firstRelease.resolve()
      const firstEvents = await firstEventsPromise

      expect(firstEvents.some((event) => event.type === 'error')).toBe(false)
      expect(secondEvents.some((event) => event.type === 'error')).toBe(false)
      expect(['first', 'other']).toContain(
        new TextDecoder().decode(await readFile(join(destRoot, 'same.txt'))),
      )
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isBun)('uses the initially resolved destination root for downloads', async () => {
    const originalCwd = process.cwd()
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-cwd-'))
    try {
      const destRoot = join(root, 'dest')
      const otherRoot = join(root, 'other')
      await mkdir(destRoot)
      await mkdir(otherRoot)
      process.chdir(root)

      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('ok'))
              controller.close()
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('file.txt', 2)]),
        dest: {
          type: 'local',
          root: 'dest',
          async *scan() {
            process.chdir(otherRoot)
            yield* []
          },
        },
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'download-done')).toBe(true)
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(new TextDecoder().decode(await readFile(join(destRoot, 'file.txt')))).toBe('ok')
      await expect(readFile(join(otherRoot, 'dest', 'file.txt'))).rejects.toThrow()
    } finally {
      process.chdir(originalCwd)
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
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cancels a download body when destination validation fails after download starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-cancel-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      await writeFile(join(destRoot, 'sub'), 'not a directory')

      let canceled = false
      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('bad'))
            },
            cancel() {
              canceled = true
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('sub/escape.txt', 3)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(canceled).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails a stalled download and cleans up the temp file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-stall-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)
      let canceled = false

      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('x'))
            },
            cancel() {
              canceled = true
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('stall.txt', 2)]),
        dest: new LocalFolder(destRoot),
        options: {
          compareMode: 'size',
          keepMode: 'no-delete',
          downloadInactivityTimeoutMs: 10,
        },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(events.some((event) => event.type === 'download-done')).toBe(false)
      expect(canceled).toBe(true)
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
      await expect(readFile(join(destRoot, 'stall.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(isBun)(
    'removes a temp file when post-open validation fails before identity capture',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-open-fail-'))
      const destRoot = join(root, 'dest')
      let removedTemp = false
      let statFailed = false

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          open: async (...args: unknown[]) => {
            const handle = await actual.open(...(args as Parameters<typeof actual.open>))
            const targetPath = String(args[0])
            if (targetPath.includes('.b2sdk-') && targetPath.endsWith('.partial')) {
              return {
                async close() {
                  await handle.close()
                },
                async stat() {
                  statFailed = true
                  throw new Error('simulated temp stat failure')
                },
              }
            }
            return handle
          },
          rm: async (...args: unknown[]) => {
            const targetPath = String(args[0])
            if (targetPath.includes('.b2sdk-') && targetPath.endsWith('.partial')) {
              removedTemp = true
            }
            return actual.rm(...(args as Parameters<typeof actual.rm>))
          },
        }
      })

      try {
        await mkdir(destRoot)

        const bucket = makeMockDownloadBucket(
          vi.fn().mockResolvedValue({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('bad'))
                controller.close()
              },
            }),
          }),
        )

        const config: SynchronizerDownConfig = {
          source: makeB2MemoryFolder([makeB2Path('fail.txt', 3)]),
          dest: new LocalFolder(destRoot),
          options: { compareMode: 'size', keepMode: 'no-delete' },
          bucket,
        }

        const events = await collectEvents(config)
        expect(statFailed).toBe(true)
        expect(removedTemp).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(true)
        expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
      } finally {
        vi.doUnmock('node:fs/promises')
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(isBun)(
    'does not write outside the root when a destination parent is swapped before temp open',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-swap-'))
      const destRoot = join(root, 'dest')
      const outsideRoot = join(root, 'outside')
      const subDir = join(destRoot, 'sub')
      let swapped = false

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          open: async (...args: unknown[]) => {
            const targetPath = String(args[0])
            if (!swapped && targetPath.includes('.b2sdk-') && targetPath.endsWith('.partial')) {
              swapped = true
              await actual.rm(subDir, { recursive: true, force: true })
              await actual.symlink(outsideRoot, subDir, 'dir')
            }
            return actual.open(...(args as Parameters<typeof actual.open>))
          },
        }
      })

      try {
        await mkdir(subDir, { recursive: true })
        await mkdir(outsideRoot)

        const bucket = makeMockDownloadBucket(
          vi.fn().mockResolvedValue({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('bad'))
                controller.close()
              },
            }),
          }),
        )

        const config: SynchronizerDownConfig = {
          source: makeB2MemoryFolder([makeB2Path('sub/authorized_keys', 3)]),
          dest: new LocalFolder(destRoot),
          options: { compareMode: 'size', keepMode: 'no-delete' },
          bucket,
        }

        const events = await collectEvents(config)
        expect(swapped).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(true)
        expect(await readdir(outsideRoot)).toEqual([])
        await expect(readFile(join(outsideRoot, 'authorized_keys'))).rejects.toThrow()
      } finally {
        vi.doUnmock('node:fs/promises')
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(isBun)('keeps the destination when the final rename fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-rename-fail-'))
    const destRoot = join(root, 'dest')
    const destPath = join(destRoot, 'keep.txt')
    let renameFailed = false

    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      return {
        ...actual,
        rename: async (...args: unknown[]) => {
          if (String(args[1]) === destPath) {
            renameFailed = true
            throw new Error('simulated rename failure')
          }
          return actual.rename(...(args as Parameters<typeof actual.rename>))
        },
      }
    })

    try {
      await mkdir(destRoot, { recursive: true })
      await writeFile(destPath, 'old')

      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('newer'))
              controller.close()
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('keep.txt', 5)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(renameFailed).toBe(true)
      expect(events.some((event) => event.type === 'error')).toBe(true)
      expect(new TextDecoder().decode(await readFile(destPath))).toBe('old')
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
    } finally {
      vi.doUnmock('node:fs/promises')
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal paths before creating files inside or outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-traversal-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)

      const absoluteEscapePath = join(root, 'escape-absolute.txt')
      for (const relPath of [
        '',
        '.',
        'dir//file.txt',
        'dir\\file.txt',
        'file.txt:payload',
        'NUL',
        'CON.txt',
        'COM1',
        'LPT9.log',
        'trailing.',
        'trailing ',
        'dir/trailing. ',
        '../escape-posix.txt',
        '..\\escape-win.txt',
        absoluteEscapePath,
        'C:\\escape-drive.txt',
      ]) {
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
      await expect(readFile(absoluteEscapePath)).rejects.toThrow()
      await expect(readFile(join(root, 'escape-drive.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not alias backslash object names to slash object names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-dl-backslash-alias-'))
    try {
      const destRoot = join(root, 'dest')
      await mkdir(destRoot)

      const bucket = makeMockDownloadBucket(
        vi.fn().mockResolvedValue({
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('ok'))
              controller.close()
            },
          }),
        }),
      )

      const config: SynchronizerDownConfig = {
        source: makeB2MemoryFolder([makeB2Path('dir/file.txt', 2), makeB2Path('dir\\file.txt', 2)]),
        dest: new LocalFolder(destRoot),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
      }

      const events = await collectEvents(config)
      expect(events.some((event) => event.type === 'download-done')).toBe(true)
      expect(events.some((event) => event.type === 'error' && event.path === 'dir\\file.txt')).toBe(
        true,
      )
      expect(bucket.downloadById).toHaveBeenCalledTimes(1)
      expect(new TextDecoder().decode(await readFile(join(destRoot, 'dir', 'file.txt')))).toBe('ok')
      if (process.platform !== 'win32') {
        await expect(readFile(join(destRoot, 'dir\\file.txt'))).rejects.toThrow()
      }
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
      expect((await readdir(destRoot)).filter((name) => name.includes('.partial'))).toEqual([])
      await expect(readFile(join(outsideRoot, 'escape.txt'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('synchronize upload safety', () => {
  it('does not upload a file replaced after scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-upload-replaced-'))
    try {
      const sourceRoot = join(root, 'source')
      await mkdir(sourceRoot)
      const filePath = join(sourceRoot, 'file.txt')
      const replacementPath = join(root, 'replacement.txt')
      await writeFile(filePath, 'safe')
      await writeFile(replacementPath, 'evil')

      const bucket = {
        upload: vi.fn(),
      } as unknown as Bucket

      const config: SynchronizerUpConfig = {
        source: new LocalFolder(sourceRoot),
        dest: makeB2MemoryFolder([]),
        options: { compareMode: 'size', keepMode: 'no-delete' },
        bucket,
        prefix: '',
      }

      const gen = synchronize(config)
      const first = await gen.next()
      expect(first.done).toBe(false)
      expect(first.value?.type).toBe('compare')

      await rm(filePath)
      await rename(replacementPath, filePath)

      const rest: SyncEvent[] = []
      for await (const event of gen) rest.push(event)
      expect(rest.some((event) => event.type === 'error')).toBe(true)
      expect(bucket.upload).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it.skipIf(isBun)(
    'does not upload bytes from a parent directory swapped outside the source root',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-sync-parent-symlink-'))
      const sourceRoot = join(root, 'source')
      const sourceSubDir = join(sourceRoot, 'sub')
      const outsideRoot = join(root, 'outside')
      const filePath = join(sourceSubDir, 'leak.bin')
      let swapped = false

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          open: async (...args: unknown[]) => {
            if (!swapped && String(args[0]) === filePath) {
              swapped = true
              await actual.rm(sourceSubDir, { recursive: true, force: true })
              await actual.symlink(outsideRoot, sourceSubDir, 'dir')
            }
            return actual.open(...(args as Parameters<typeof actual.open>))
          },
        }
      })

      try {
        await mkdir(sourceSubDir, { recursive: true })
        await mkdir(outsideRoot)
        await writeFile(filePath, new TextEncoder().encode('safe'))
        await writeFile(join(outsideRoot, 'leak.bin'), new TextEncoder().encode('secret'))

        let uploaded: Uint8Array | null = null
        const bucket = {
          upload: vi
            .fn()
            .mockImplementation(
              async (options: { source: { toArrayBuffer(): Promise<ArrayBuffer> } }) => {
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
        expect(swapped).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(true)
        expect(bucket.upload).not.toHaveBeenCalled()
        expect(uploaded).toBeNull()
      } finally {
        vi.doUnmock('node:fs/promises')
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
