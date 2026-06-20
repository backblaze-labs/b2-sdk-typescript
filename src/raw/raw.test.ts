import { describe, expect, it } from 'vitest'
import { B2RealmConfigurationError } from '../errors/index.ts'
import { recordingTransport } from '../test-utils/index.ts'
import { RawClient } from './index.ts'

describe('RawClient authorizeAccount', () => {
  it('rejects non-absolute realm URLs before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', 'sandbox')).rejects.toThrow(
      B2RealmConfigurationError,
    )
    expect(seenUrls).toEqual([])
  })

  it('rejects unsupported realm URL schemes before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(
      raw.authorizeAccount('key-id', 'key-secret', 'ftp://attacker.example'),
    ).rejects.toThrow('realm URL must use HTTPS or loopback IP HTTP for authorization')
    expect(seenUrls).toEqual([])
  })

  it.each([
    'https:example.com',
    'https:///path',
  ])('rejects malformed realm URL %s before sending credentials', async (realmUrl) => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
      'realm URL must be an absolute HTTP(S) URL with a hostname for authorization',
    )
    expect(seenUrls).toEqual([])
  })

  it.each([
    'https://user:secret@api.example.com',
    'https://api.example.com?token=query-secret',
    'https://api.example.com#fragment-secret',
  ])('rejects realm URL with non-base components %s before sending credentials', async (realmUrl) => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new RawClient({ transport })

    await expect(raw.authorizeAccount('key-id', 'key-secret', realmUrl)).rejects.toThrow(
      'realm URL must not include credentials, query, or fragment for authorization',
    )
    expect(seenUrls).toEqual([])
  })
})
