import { describe, expect, it } from 'vitest'

import { getUserAgent } from './user-agent.js'
import { VERSION } from '../version.js'

describe('getUserAgent', () => {
  it('returns a string containing the version and runtime', () => {
    const ua = getUserAgent()

    expect(ua).toContain(`b2-sdk-ts/${VERSION}`)
    expect(ua).toMatch(/\(.+\)/)
  })

  it('includes custom prefix when provided', () => {
    const ua = getUserAgent('my-app/1.0')

    expect(ua).toMatch(/^my-app\/1\.0 /)
    expect(ua).toContain(`b2-sdk-ts/${VERSION}`)
  })

  it('default format matches b2-sdk-ts/{version} ({runtime})', () => {
    const ua = getUserAgent()

    expect(ua).toMatch(/^b2-sdk-ts\/[\w.]+\s\([^)]+\)$/)
  })

  it('detects node runtime when process.versions.node exists', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/\(node\/[\d.]+\)/)
  })

  it('detects browser runtime when only navigator is present', () => {
    const savedProcess = globalThis.process
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      // Remove process so Node branch is skipped
      delete (globalThis as Record<string, unknown>)['process']
      // Ensure navigator is present (Node 21+ has it as a getter)
      if (!navDescriptor) {
        Object.defineProperty(globalThis, 'navigator', {
          value: { userAgent: 'test' },
          configurable: true,
        })
      }

      const ua = getUserAgent()
      expect(ua).toContain('(browser)')
    } finally {
      globalThis.process = savedProcess
      if (!navDescriptor) {
        delete (globalThis as Record<string, unknown>)['navigator']
      }
    }
  })

  it('returns unknown when no runtime globals are present', () => {
    const savedProcess = globalThis.process
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      delete (globalThis as Record<string, unknown>)['process']
      if (navDescriptor) {
        Object.defineProperty(globalThis, 'navigator', {
          value: undefined,
          configurable: true,
          writable: true,
        })
      }

      const ua = getUserAgent()
      expect(ua).toContain('(unknown)')
    } finally {
      globalThis.process = savedProcess
      if (navDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navDescriptor)
      }
    }
  })
})
