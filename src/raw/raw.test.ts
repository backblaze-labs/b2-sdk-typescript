import { describe, expect, it } from 'vitest'
import type { HttpTransport } from '../http/transport.ts'
import { RawClient } from './index.ts'

describe('RawClient authorizeAccount', () => {
  it('rejects non-absolute realm URLs before sending credentials', async () => {
    const seenUrls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenUrls.push(request.url)
        throw new Error('transport should not be called')
      },
    }
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', 'sandbox')).rejects.toThrow(
      'realm URL must be absolute for authorization',
    )
    expect(seenUrls).toEqual([])
  })

  it('rejects unsupported realm URL schemes before sending credentials', async () => {
    const seenUrls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenUrls.push(request.url)
        throw new Error('transport should not be called')
      },
    }
    const raw = new RawClient({ transport })

    await expect(
      raw.authorizeAccount('key-id', 'key-secret', 'ftp://attacker.example'),
    ).rejects.toThrow('realm URL must use HTTPS or loopback HTTP for authorization')
    expect(seenUrls).toEqual([])
  })

  it.each([
    'https:example.com',
    'https:///path',
  ])('rejects malformed realm URL %s before sending credentials', async (realmUrl) => {
    const seenUrls: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenUrls.push(request.url)
        throw new Error('transport should not be called')
      },
    }
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
      'realm URL must be an absolute HTTP(S) URL with a hostname for authorization',
    )
    expect(seenUrls).toEqual([])
  })
})
