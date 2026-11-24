import { describe, expect, it } from 'vitest'
import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator } from '../simulator/index.ts'
import { BufferSource } from '../streams/source.ts'
import { BucketType } from '../types/bucket.ts'

describe('upload file-name header guard', () => {
  it('a name containing & and , is sent verbatim and round-trips exactly', async () => {
    const sim = new B2Simulator()
    const inner = sim.transport()
    const sentNames: string[] = []
    const transport: HttpTransport = {
      async send(req: HttpRequest): Promise<HttpResponse> {
        const name = req.headers?.['X-Bz-File-Name']
        if (name !== undefined) sentNames.push(name)
        return inner.send(req)
      },
    }
    const client = new B2Client({ applicationKeyId: 'k', applicationKey: 'k', transport })
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'upload-header-encoding',
      bucketType: BucketType.AllPrivate,
    })

    const name = 'reports/a&b,c d.txt'
    await bucket.upload({ fileName: name, source: new BufferSource(new TextEncoder().encode('x')) })

    // B2 treats & and , as safe characters: they stay raw; the space is percent-encoded.
    expect(sentNames).toEqual(['reports/a&b,c%20d.txt'])
    const listed = await bucket.listFileNames()
    expect(JSON.stringify(listed)).toContain(JSON.stringify(name).slice(1, -1))
  })
})
