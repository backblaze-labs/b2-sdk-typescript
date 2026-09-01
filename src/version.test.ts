import { describe, expect, it } from 'vitest'

import {
  isPublishedRelease,
  productVersion,
  RELEASE_CHANNEL,
  resolveVersion,
  VERSION,
} from './version.ts'

describe('version resolver', () => {
  it('keeps the public VERSION export as package semver', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  })

  it('keeps module-level release metadata internally consistent', () => {
    expect(isPublishedRelease).toBe(RELEASE_CHANNEL === 'published')
    expect(productVersion()).toBe(RELEASE_CHANNEL === 'published' ? VERSION : 'dev')
  })

  it('resolves source builds to the dev User-Agent version without a publish signal', () => {
    expect(resolveVersion('1.2.3')).toEqual({
      version: '1.2.3',
      releaseChannel: 'dev',
      isPublishedRelease: false,
      productVersion: 'dev',
    })
  })

  it('resolves stable published releases to the package semver', () => {
    expect(resolveVersion('1.2.3', 'published')).toEqual({
      version: '1.2.3',
      releaseChannel: 'published',
      isPublishedRelease: true,
      productVersion: '1.2.3',
    })
  })

  it('treats semver build metadata as stable for published releases', () => {
    expect(resolveVersion('1.2.3+build-1', 'published')).toEqual({
      version: '1.2.3+build-1',
      releaseChannel: 'published',
      isPublishedRelease: true,
      productVersion: '1.2.3+build-1',
    })
  })

  it('resolves missing or non-published signals to dev', () => {
    for (const signal of [undefined, 'dev', 'ci', 'source']) {
      expect(resolveVersion('1.2.3', signal).productVersion).toBe('dev')
    }
  })

  it('keeps prerelease builds on the dev channel even with a publish signal', () => {
    expect(resolveVersion('1.2.3-rc.0', 'published')).toEqual({
      version: '1.2.3-rc.0',
      releaseChannel: 'dev',
      isPublishedRelease: false,
      productVersion: 'dev',
    })
  })
})
