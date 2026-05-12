import { describe, expect, it } from 'vitest'

import { VERSION } from '../version.js'
import { getUserAgent } from './user-agent.js'

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

  // These three tests probe the runtime-detection branches in detectRuntime().
  // They depend on what globals are present so the assertions are gated on the
  // current runtime (Bun exposes `Bun`, Deno exposes `Deno`, Node exposes
  // `process.versions.node`, browsers expose `navigator`).
  const g = globalThis as Record<string, unknown>
  const isBun = typeof g['Bun'] !== 'undefined'
  const isDeno = typeof g['Deno'] !== 'undefined'
  const isNode = typeof g['process'] !== 'undefined' && !isBun && !isDeno

  it.skipIf(!isNode)('detects node runtime when process.versions.node exists', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/\(node\/[\d.]+\)/)
  })

  it.skipIf(!isNode)('detects browser runtime when only navigator is present', () => {
    const savedProcess = globalThis.process
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      // Remove process so Node branch is skipped
      Reflect.deleteProperty(globalThis as object, 'process')
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
        Reflect.deleteProperty(globalThis as object, 'navigator')
      }
    }
  })

  it.skipIf(!isNode)('returns unknown when no runtime globals are present', () => {
    const savedProcess = globalThis.process
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      Reflect.deleteProperty(globalThis as object, 'process')
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

  it.skipIf(!isBun)('detects bun runtime when Bun global exists', () => {
    expect(getUserAgent()).toContain('(bun)')
  })

  it.skipIf(!isDeno)('detects deno runtime when Deno global exists', () => {
    expect(getUserAgent()).toContain('(deno)')
  })
})
