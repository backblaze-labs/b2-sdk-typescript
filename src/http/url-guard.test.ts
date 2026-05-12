/**
 * Tests for the SSRF / URL-substitution guard.
 *
 * The threat model these tests pin down:
 *
 *   1. Before authorize() runs, the guard is permissive (the very first
 *      authorize-account request, whose URL the *user* supplied via realm,
 *      must succeed).
 *   2. After authorize() locks the guard, hosts outside the realm's parent
 *      domain are rejected, including literal IPs and well-known internal
 *      hostnames.
 *   3. Multiple authorize() calls update the allow-list to the latest realm.
 *   4. The B2 upload-pod parent (`backblaze.com`) is always trusted because
 *      `b2_get_upload_url` returns hosts like `pod-000-1024-08.backblaze.com`
 *      that are not subdomains of `backblazeb2.com`.
 */

import { describe, expect, it } from 'vitest'
import { B2SsrfError } from '../errors/index.ts'
import { UrlGuard, deriveAllowedSuffixes } from './url-guard.ts'

describe('UrlGuard', () => {
  it('is permissive before any suffix is set', () => {
    const guard = new UrlGuard()
    expect(() => guard.check('http://anywhere.example/x')).not.toThrow()
    expect(() => guard.check('http://169.254.169.254/latest/meta-data/')).not.toThrow()
  })

  it('allows hosts matching a configured suffix', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('https://api.backblazeb2.com/x')).not.toThrow()
    expect(() => guard.check('https://s3.us-west-004.backblazeb2.com/bucket/key')).not.toThrow()
    expect(() => guard.check('https://backblazeb2.com')).not.toThrow()
  })

  it('rejects hosts outside the allow-list', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('https://attacker.example/x')).toThrow(B2SsrfError)
    expect(() => guard.check('https://malicious-backblazeb2.com.evil/x')).toThrow(B2SsrfError)
  })

  it('rejects superstring suffix attacks (suffix matching is anchored at a dot)', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    // "evilbackblazeb2.com" should NOT match — it'd be a string-endsWith
    // false positive without the dot anchor.
    expect(() => guard.check('https://evilbackblazeb2.com/steal')).toThrow(B2SsrfError)
  })

  it('rejects literal IPv4 hosts even when the suffix list is locked', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('http://169.254.169.254/latest/meta-data/')).toThrow(B2SsrfError)
    expect(() => guard.check('http://10.0.0.1/admin')).toThrow(B2SsrfError)
    expect(() => guard.check('http://127.0.0.1/x')).toThrow(B2SsrfError)
  })

  it('rejects IPv6 literal hosts', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('http://[::1]/x')).toThrow(B2SsrfError)
    expect(() => guard.check('http://[fe80::1]/x')).toThrow(B2SsrfError)
  })

  it('rejects well-known internal hostnames', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('http://localhost/x')).toThrow(B2SsrfError)
    expect(() => guard.check('http://my.localhost/x')).toThrow(B2SsrfError)
    expect(() => guard.check('http://metadata.google.internal/x')).toThrow(B2SsrfError)
    expect(() => guard.check('http://metadata/computeMetadata/v1/')).toThrow(B2SsrfError)
    expect(() => guard.check('http://svc.internal/x')).toThrow(B2SsrfError)
    expect(() => guard.check('http://svc.local/x')).toThrow(B2SsrfError)
  })

  it('rejects malformed URLs as a defense against parser-confusion attacks', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('not a url')).toThrow(B2SsrfError)
    expect(() => guard.check('javascript:alert(1)')).toThrow(B2SsrfError)
  })

  it('attaches the offending URL to thrown errors for triage', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    try {
      guard.check('https://attacker.example/foo?x=1')
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(B2SsrfError)
      const ssrf = err as B2SsrfError
      expect(ssrf.url).toBe('https://attacker.example/foo?x=1')
      expect(ssrf.retryable).toBe(false)
    }
  })

  it('hostname matching is case-insensitive', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['BackBlazeB2.com'])
    expect(() => guard.check('https://API.BackBlazeB2.com/x')).not.toThrow()
  })

  it('setAllowedSuffixes([]) returns the guard to permissive mode', () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com'])
    expect(() => guard.check('http://anywhere.example/x')).toThrow(B2SsrfError)
    guard.setAllowedSuffixes([])
    expect(() => guard.check('http://anywhere.example/x')).not.toThrow()
  })

  it('getAllowedSuffixes() reflects the current configuration', () => {
    const guard = new UrlGuard()
    expect(guard.getAllowedSuffixes()).toEqual([])
    guard.setAllowedSuffixes(['a.com', 'b.com'])
    expect(guard.getAllowedSuffixes()).toEqual(['a.com', 'b.com'])
  })
})

describe('deriveAllowedSuffixes', () => {
  it('extracts the parent domain from each realm URL and always includes backblaze.com', () => {
    const suffixes = deriveAllowedSuffixes({
      apiUrl: 'https://api.us-west-004.backblazeb2.com',
      downloadUrl: 'https://f004.backblazeb2.com',
      s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
    })
    expect(suffixes).toContain('backblazeb2.com')
    expect(suffixes).toContain('backblaze.com')
  })

  it('deduplicates suffixes derived from multiple realm URLs', () => {
    const suffixes = deriveAllowedSuffixes({
      apiUrl: 'https://api.backblazeb2.com',
      downloadUrl: 'https://download.backblazeb2.com',
      s3ApiUrl: 'https://s3.backblazeb2.com',
    })
    // backblazeb2.com appears three times in the inputs; should appear once.
    expect(suffixes.filter((s) => s === 'backblazeb2.com')).toHaveLength(1)
  })

  it('returns at minimum [backblaze.com] when given garbage URLs', () => {
    const suffixes = deriveAllowedSuffixes({
      apiUrl: 'not-a-url',
      downloadUrl: 'also-bad',
      s3ApiUrl: '://broken',
    })
    expect(suffixes).toEqual(['backblaze.com'])
  })

  it('handles realms with different parent domains gracefully', () => {
    // Hypothetical alternate realm. The derived list should include both.
    const suffixes = deriveAllowedSuffixes({
      apiUrl: 'https://api.b2-staging.io',
      downloadUrl: 'https://f001.b2-staging.io',
      s3ApiUrl: 'https://s3.b2-staging.io',
    })
    expect(suffixes).toContain('b2-staging.io')
    expect(suffixes).toContain('backblaze.com')
  })

  it('the allow-list lets through the canonical upload-pod hostname pattern', () => {
    const suffixes = deriveAllowedSuffixes({
      apiUrl: 'https://api.us-west-004.backblazeb2.com',
      downloadUrl: 'https://f004.backblazeb2.com',
      s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
    })
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(suffixes)
    // Real upload pod hostname from B2's getUploadUrl response.
    expect(() =>
      guard.check('https://pod-000-1024-08.backblaze.com/b2api/v3/b2_upload_file?bucketId=abc'),
    ).not.toThrow()
  })
})
