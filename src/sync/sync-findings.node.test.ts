import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Bucket } from '../bucket.ts'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { BucketType } from '../types/bucket.ts'
import { B2Folder } from './scanners/b2.ts'
import { LocalFolder } from './scanners/local.ts'
import type {
  SynchronizerB2Config,
  SynchronizerConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize } from './synchronizer.ts'
import type { SyncEvent } from './types.ts'

async function collect(config: SynchronizerConfig): Promise<SyncEvent[]> {
  const events: SyncEvent[] = []
  for await (const event of synchronize(config)) events.push(event)
  return events
}

async function makeBucket(
  name: string,
  wrap?: (inner: HttpTransport) => HttpTransport,
  simOptions: ConstructorParameters<typeof B2Simulator>[0] = {},
): Promise<{ client: B2Client; bucket: Bucket }> {
  const sim = new B2Simulator(simOptions)
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: wrap ? wrap(sim.transport()) : sim.transport(),
    retry: { maxRetries: 0 },
  })
  await client.authorize()
  const bucket = await client.createBucket({ bucketName: name, bucketType: BucketType.AllPrivate })
  return { client, bucket }
}

function bytes(text: string): BufferSource {
  return new BufferSource(new TextEncoder().encode(text))
}

describe('sync findings', () => {
  it('Finding C29: a second modtime sync of an unchanged local file uploads nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c29-'))
    try {
      const { bucket } = await makeBucket('sync-c29')
      const file = join(root, 'a.txt')
      await writeFile(file, 'stable content')
      const old = new Date('2021-03-04T05:06:07Z')
      await utimes(file, old, old)

      const config: SynchronizerUpConfig = {
        source: new LocalFolder(root),
        dest: new B2Folder(bucket, ''),
        options: { compareMode: 'modtime', keepMode: 'no-delete' },
        bucket,
        prefix: '',
      }
      const first = await collect(config)
      expect(
        first.filter((e) => e.type === 'upload-done'),
        'precondition: the first run uploads the file once',
      ).toHaveLength(1)

      const second = await collect(config)
      expect(
        second.filter((e) => e.type === 'upload-done'),
        'unchanged file was uploaded again on the second run',
      ).toHaveLength(0)
      expect(second.filter((event) => event.type === 'error')).toEqual([])
      const changed = new Date('2021-03-04T05:06:08Z')
      await utimes(file, changed, changed)
      const third = await collect(config)
      expect(third.filter((event) => event.type === 'upload-done')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([undefined, '', 'not-a-time', 'Infinity', '-1', '123oops'])(
    'uses upload time when source modtime metadata is %s',
    async (modtime) => {
      const { bucket } = await makeBucket('sync-c29-fallback')
      const uploaded = await bucket.upload({
        fileName: 'a.txt',
        source: bytes('content'),
        fileInfo: modtime === undefined ? {} : { src_last_modified_millis: modtime },
      })
      const entries = []
      for await (const entry of new B2Folder(bucket).scan()) entries.push(entry)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.modTimeMillis).toBe(uploaded.uploadTimestamp)
    },
  )

  it.each(['0', '1614834367000'])(
    'uses valid source modtime metadata %s for B2 comparisons',
    async (modtime) => {
      const { bucket } = await makeBucket('sync-c29-metadata')
      await bucket.upload({
        fileName: 'a.txt',
        source: bytes('content'),
        fileInfo: { src_last_modified_millis: modtime },
      })
      const entries = []
      for await (const entry of new B2Folder(bucket).scan()) entries.push(entry)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.modTimeMillis).toBe(Number(modtime))
    },
  )

  it('keeps a newly uploaded orphan with an old source modtime for keep-days', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c29-keep-'))
    try {
      const { bucket } = await makeBucket('sync-c29-keep')
      const uploaded = await bucket.upload({
        fileName: 'orphan.txt',
        source: bytes('recent upload'),
        lastModifiedMillis: 0,
      })
      const config: SynchronizerUpConfig = {
        source: new LocalFolder(root),
        dest: new B2Folder(bucket),
        options: { compareMode: 'modtime', keepMode: 'keep-days', keepDays: 1 },
        bucket,
        prefix: '',
      }
      const events = await collect(config)
      expect(events.filter((event) => event.type === 'error')).toEqual([])
      const listing = await bucket.listFileVersions()
      expect(listing.files.map((file) => file.fileId)).toEqual([uploaded.fileId])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['local', 'b2'] as const)(
    'Finding C30: orphan delete removes every version of a multi-version file (%s source)',
    async (sourceType) => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-c30-'))
      try {
        const { bucket } = await makeBucket('sync-c30')
        await bucket.upload({ fileName: 'dst/orphan.txt', source: bytes('version one') })
        await bucket.upload({ fileName: 'dst/orphan.txt', source: bytes('version two!') })
        await bucket.hideFile('dst/orphan.txt')
        await bucket.upload({ fileName: 'dst/orphan.txt', source: bytes('visible version') })
        const outside = await bucket.upload({ fileName: 'outside.txt', source: bytes('outside') })
        const kept = await bucket.upload({ fileName: 'dst/keep.txt', source: bytes('keep') })
        await writeFile(join(root, 'keep.txt'), 'keep')
        await bucket.upload({ fileName: 'src/keep.txt', source: bytes('keep') })
        const config = {
          source: sourceType === 'local' ? new LocalFolder(root) : new B2Folder(bucket, 'src/'),
          dest: new B2Folder(bucket, 'dst/'),
          options: { compareMode: 'size', keepMode: 'delete' } as const,
          bucket,
          prefix: 'dst/',
        }
        const events = await collect(config)
        expect(events.filter((event) => event.type === 'error')).toEqual([])
        const listing = await bucket.listFileVersions()
        expect(
          listing.files.filter((file) => file.fileName === 'dst/orphan.txt'),
          'all orphan versions and hide markers must be removed',
        ).toHaveLength(0)
        expect(listing.files.map((file) => file.fileId)).toEqual(
          expect.arrayContaining([outside.fileId, kept.fileId]),
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it.each([
    { locked: true, dryRun: false },
    { locked: false, dryRun: true },
  ])(
    'preserves orphan versions with locked=$locked and dryRun=$dryRun',
    async ({ locked, dryRun }) => {
      const root = await mkdtemp(join(tmpdir(), 'b2sdk-c30-preserve-'))
      try {
        const { client } = await makeBucket('sync-c30-control')
        const bucket = await client.createBucket({
          bucketName: 'sync-c30-preserve',
          bucketType: BucketType.AllPrivate,
          fileLockEnabled: locked,
        })
        const first = await bucket.upload({ fileName: 'orphan.txt', source: bytes('first') })
        const second = await bucket.upload({ fileName: 'orphan.txt', source: bytes('second') })
        const config: SynchronizerUpConfig = {
          source: new LocalFolder(root),
          dest: new B2Folder(bucket),
          options: { compareMode: 'size', keepMode: 'delete', dryRun },
          bucket,
          prefix: '',
        }
        const events = await collect(config)
        expect(events.filter((event) => event.type === 'error')).toEqual([])
        const listing = await bucket.listFileVersions()
        expect(
          listing.files.filter((file) => file.action !== 'hide').map((file) => file.fileId),
        ).toEqual([second.fileId, first.fileId])
        expect(listing.files.filter((file) => file.action === 'hide')).toHaveLength(locked ? 1 : 0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('Finding C24: b2-to-b2 sync of a source above the 5 GB single-copy limit uses multipart copy', async () => {
    const requested = await probeCopySize(5_000_000_001)
    expect(requested.filter((u) => u.includes('b2_start_large_file'))).toHaveLength(1)
    expect(requested.filter((u) => u.includes('b2_copy_file'))).toHaveLength(0)
  })

  it('keeps a source at the 5 GB single-copy limit on the single-call path', async () => {
    const requested = await probeCopySize(5_000_000_000)
    expect(requested.filter((u) => u.includes('b2_copy_file'))).toHaveLength(1)
    expect(requested.filter((u) => u.includes('b2_start_large_file'))).toHaveLength(0)
  })
})

function jsonError(status: number, code: string, message: string): HttpResponse {
  const body = { status, code, message }
  return {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: async () => body as never,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

async function probeCopySize(size: number): Promise<string[]> {
  const requested: string[] = []
  const inflate = (inner: HttpTransport): HttpTransport => ({
    async send(req: HttpRequest): Promise<HttpResponse> {
      requested.push(req.url)
      if (req.url.includes('b2_start_large_file') || req.url.includes('b2_copy_file')) {
        // Stop at the mutation boundary; the fixture never allocates a 5 GB body.
        return jsonError(400, 'bad_request', 'copy size probe stopped here')
      }
      const resp = await inner.send(req)
      if (req.url.includes('b2_list_file_versions') || req.url.includes('b2_list_file_names')) {
        const body = (await resp.json()) as { files: { contentLength: number }[] }
        for (const f of body.files) f.contentLength = size
        return { ...resp, json: async <T>() => body as T, text: async () => JSON.stringify(body) }
      }
      if (req.url.includes('b2_get_file_info')) {
        const body = { ...(await resp.json<Record<string, unknown>>()), contentLength: size }
        return { ...resp, json: async <T>() => body as T, text: async () => JSON.stringify(body) }
      }
      return resp
    },
  })
  const { bucket } = await makeBucket('sync-c24', inflate)
  await bucket.upload({
    fileName: 'src/big.bin',
    source: bytes('tiny stand-in for a huge object'),
  })
  requested.length = 0
  const config: SynchronizerB2Config = {
    source: new B2Folder(bucket, 'src/'),
    dest: new B2Folder(bucket, 'dst/'),
    options: { compareMode: 'none', keepMode: 'no-delete' },
    bucket,
    prefix: 'dst/',
  }
  const events = await collect(config)
  expect(events.filter((event) => event.type === 'copy-done')).toHaveLength(0)
  expect(events.filter((event) => event.type === 'error' && event.path === 'big.bin')).toEqual([
    expect.objectContaining({ message: 'bad_request', path: 'big.bin' }),
  ])
  return requested
}
