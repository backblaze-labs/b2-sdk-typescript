// Known-defect test: asserts the CORRECT behaviour and currently fails because the defect
// is still present. Not part of `pnpm test`; run on demand with `pnpm test:known-defects`.
// When the defect is fixed, move the test next to the code it covers (src/**/*.test.ts) so it
// joins the default suite (see tests/known-defects/README.md).
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Bucket } from '../../src/bucket.ts'
import { B2Client } from '../../src/client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { B2Simulator } from '../../src/simulator/index.ts'
import { BufferSource } from '../../src/streams/source.ts'
import { B2Folder } from '../../src/sync/scanners/b2.ts'
import { LocalFolder } from '../../src/sync/scanners/local.ts'
import type {
  SynchronizerB2Config,
  SynchronizerConfig,
  SynchronizerUpConfig,
} from '../../src/sync/synchronizer.ts'
import { synchronize } from '../../src/sync/synchronizer.ts'
import type { SyncEvent } from '../../src/sync/types.ts'
import { BucketType } from '../../src/types/bucket.ts'

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

describe('synchronize known defects', () => {
  it('keep-days without keepDays does not delete a just-uploaded orphan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c19-'))
    try {
      const { bucket } = await makeBucket('sync-c19')
      await bucket.upload({ fileName: 'orphan.txt', source: bytes('recent orphan') })

      const config: SynchronizerUpConfig = {
        source: new LocalFolder(root),
        dest: new B2Folder(bucket, ''),
        options: { compareMode: 'size', keepMode: 'keep-days' },
        bucket,
        prefix: '',
      }
      const events = await collect(config)

      const deleted = events.filter((e) => e.type === 'delete-remote' || e.type === 'hide')
      expect(deleted, 'a file uploaded moments ago was removed as an orphan').toHaveLength(0)
      const names = await bucket.listFileNames()
      expect(JSON.stringify(names), 'orphan.txt is missing from the bucket').toContain('orphan.txt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a second modtime sync of an unchanged local file uploads nothing', async () => {
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('orphan delete removes every version of a multi-version file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b2sdk-c30-'))
    try {
      const { client, bucket } = await makeBucket('sync-c30')
      await bucket.upload({ fileName: 'orphan.txt', source: bytes('version one') })
      await bucket.upload({ fileName: 'orphan.txt', source: bytes('version two!') })

      const config: SynchronizerUpConfig = {
        source: new LocalFolder(root),
        dest: new B2Folder(bucket, ''),
        options: { compareMode: 'size', keepMode: 'delete' },
        bucket,
        prefix: '',
      }
      await collect(config)

      const listing = await client.raw.listFileVersions(
        client.accountInfo.getApiUrl(),
        client.accountInfo.getAuthToken(),
        { bucketId: bucket.id },
      )
      const remaining = listing.files.filter(
        (f) => f.fileName === 'orphan.txt' && f.action === 'upload',
      )
      expect(remaining, 'an older version of the deleted orphan survived').toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('b2-to-b2 sync of a source above the 5 GB single-copy limit uses multipart copy', async () => {
    const requested: string[] = []
    const inflate = (inner: HttpTransport): HttpTransport => ({
      async send(req: HttpRequest): Promise<HttpResponse> {
        requested.push(req.url)
        if (req.url.includes('b2_start_large_file') || req.url.includes('b2_copy_file')) {
          // Stop after recording which API the synchronizer chose.
          return jsonError(400, 'bad_request', 'stop here')
        }
        const resp = await inner.send(req)
        if (req.url.includes('b2_list_file_versions') || req.url.includes('b2_list_file_names')) {
          const body = (await resp.json()) as { files: { contentLength: number }[] }
          for (const f of body.files) f.contentLength = 5_000_000_001
          return { ...resp, json: async <T>() => body as T, text: async () => JSON.stringify(body) }
        }
        return resp
      },
    })
    const { bucket } = await makeBucket('sync-c24', inflate)
    // Seed through the real simulator state: upload bypasses the wrapper's stop rules.
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
    await collect(config)

    expect(
      requested.some((u) => u.includes('b2_start_large_file')),
      `a 5 GB+ source was copied with: ${requested.filter((u) => /copy|large/.test(u)).join(', ')}`,
    ).toBe(true)
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
