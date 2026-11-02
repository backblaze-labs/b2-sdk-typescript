import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { EncryptionKey, SSE_C_KEY_REDACTION } from '../types/encryption.ts'
import { bucketId, fileId } from '../types/ids.ts'
import { RawClient } from './index.ts'

describe('RawClient SSE-C diagnostics', () => {
  it('does not leak SSE-C key material through the caller objects or thrown errors', async () => {
    const key = await EncryptionKey.fromBytes(new Uint8Array(32).fill(5))
    const secrets = [key.customerKey, key.customerKeyMd5]
    const transport: HttpTransport = {
      async send(request: HttpRequest): Promise<HttpResponse> {
        return {
          status: 500,
          headers: new Headers(),
          body: null,
          json: async () => {
            throw new Error(`forced JSON failure for ${request.url}`)
          },
          text: () => Promise.resolve('forced failure'),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }
      },
    }
    const raw = new RawClient({ transport })
    const copyFileOptions = {
      sourceFileId: fileId('4_z_source'),
      fileName: 'copy.bin',
      sourceServerSideEncryption: key,
      destinationServerSideEncryption: key,
    }
    const copyPartOptions = {
      sourceFileId: fileId('4_z_source'),
      largeFileId: fileId('4_z_large'),
      partNumber: 1,
      sourceServerSideEncryption: key,
      destinationServerSideEncryption: key,
    }
    const startOptions = {
      bucketId: bucketId('bucket'),
      fileName: 'large.bin',
      contentType: 'application/octet-stream',
      serverSideEncryption: key,
    }
    const caught: unknown[] = []
    for (const call of [
      () => raw.copyFile('https://api.example.test', 'auth', copyFileOptions),
      () => raw.copyPart('https://api.example.test', 'auth', copyPartOptions),
      () => raw.startLargeFile('https://api.example.test', 'auth', startOptions),
    ]) {
      try {
        await call()
      } catch (err) {
        caught.push(err)
      }
    }
    expect(caught).toHaveLength(3)

    // Real surfaces: the caller's option bags (what applications log), the
    // client itself, and the thrown errors with every own and hidden property.
    const surfaces = [
      JSON.stringify([copyFileOptions, copyPartOptions, startOptions]),
      inspect([copyFileOptions, copyPartOptions, startOptions], { depth: null, showHidden: true }),
      inspect(raw, { depth: null, showHidden: true }),
      ...caught.map((err) => inspect(err, { depth: null, showHidden: true })),
      ...caught.map((err) => JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))),
    ]
    for (const surface of surfaces) {
      for (const secret of secrets) expect(surface).not.toContain(secret)
    }
    // The wrapper still redacts explicitly after the calls.
    expect(JSON.stringify(startOptions)).toContain(SSE_C_KEY_REDACTION)
  })
})
