import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { deterministicBytes } from '../test-utils/index.ts'
import { BucketType } from '../types/bucket.ts'
import { B2Folder } from './scanners/b2.ts'
import { LocalFolder } from './scanners/local.ts'
import type {
  SynchronizerConfig,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from './synchronizer.ts'
import { synchronize } from './synchronizer.ts'
import type { SyncEvent } from './types.ts'

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

describe('synchronize large local files', () => {
  it('uploads via multipart from disk and downloads back without whole-file buffering', async () => {
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
