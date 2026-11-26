import { describe, expect, it } from 'vitest'
import { liveRealmOptionsFor } from './live-b2.ts'

describe('liveRealmOptionsFor (B2_REALM for the live suites)', () => {
  it('leaves the client on production with the SSRF host allow-list when unset', () => {
    expect(liveRealmOptionsFor(undefined)).toEqual({})
    expect(liveRealmOptionsFor('')).toEqual({})
    expect(liveRealmOptionsFor('   ')).toEqual({})
  })

  it('turns the host allow-list off only for a loopback realm URL', () => {
    for (const realm of [
      'http://127.0.0.1:8180',
      'http://localhost:8180',
      'http://[::1]:8180',
      'https://localhost',
    ]) {
      expect(liveRealmOptionsFor(realm)).toEqual({ realm, allowedHostSuffixes: [] })
    }
  })

  it('keeps the host allow-list for a named or non-loopback realm', () => {
    for (const realm of [
      'production',
      'staging',
      'https://api.backblazeb2.com',
      'https://simulator.example.com',
      'http://127.0.0.1.example.com',
      'http://localhost.example.com',
      'http://10.0.0.5:8180',
    ]) {
      const options = liveRealmOptionsFor(realm)
      expect(options).toEqual({ realm })
      expect(options).not.toHaveProperty('allowedHostSuffixes')
    }
  })
})
