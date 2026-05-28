import { describe, expect, it } from 'vitest'

import { VERSION } from '../version.ts'
import { SDK_PACKAGE, SDK_PRODUCT, getUserAgent } from './user-agent.ts'

describe('getUserAgent', () => {
  it('starts with the SDK product token + version', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(new RegExp(`^${SDK_PRODUCT}\\/${VERSION}\\s\\(`))
  })

  it('includes the typescript language token and npm package name in the comment', () => {
    const ua = getUserAgent()
    // Both tokens are part of the documented contract so log queries can grep
    // on either one and find every SDK request.
    expect(ua).toContain('typescript')
    expect(ua).toContain(SDK_PACKAGE)
  })

  it('prepends a custom prefix verbatim and keeps the SDK identifiers intact', () => {
    const ua = getUserAgent('my-app/1.0')
    expect(ua).toMatch(/^my-app\/1\.0 /)
    expect(ua).toContain(`${SDK_PRODUCT}/${VERSION}`)
    expect(ua).toContain(SDK_PACKAGE)
  })

  it('uses semicolon-separated tokens inside the comment', () => {
    const ua = getUserAgent()
    // Format: b2-sdk-typescript/<v> (typescript; @backblaze-labs/b2-sdk; <runtime>; [os; ][arch])
    const match = /^[^\s]+\s\(([^)]+)\)$/.exec(ua)
    expect(match).not.toBeNull()
    const inside = match?.[1]
    expect(inside).toBeTruthy()
    const tokens = (inside ?? '').split('; ')
    expect(tokens[0]).toBe('typescript')
    expect(tokens[1]).toBe(SDK_PACKAGE)
    // Runtime is always third.
    expect(tokens[2]).toBeTruthy()
    expect(tokens.length).toBeGreaterThanOrEqual(3)
  })

  // Probe runtime-specific tokens. Each block is gated on the corresponding
  // runtime so the assertions hold across the test matrix (Node, Bun, Deno,
  // and browsers via the Vitest browser config).
  const g = globalThis as Record<string, unknown>
  const isBun = typeof g['Bun'] !== 'undefined'
  const isDeno = typeof g['Deno'] !== 'undefined'
  const isNode = typeof g['process'] !== 'undefined' && !isBun && !isDeno

  it.skipIf(!isNode)('emits node/<version>; <platform>; <arch> on Node', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/; node\/\d+\.\d+\.\d+;/)
    // process.platform values include linux, darwin, win32; process.arch
    // includes x64, arm64. Just check both are present as non-empty tokens.
    const inside = /\(([^)]+)\)/.exec(ua)?.[1] ?? ''
    const tokens = inside.split('; ')
    // Tokens: [typescript, @backblaze-labs/b2-sdk, node/<v>, <os>, <arch>]
    expect(tokens[3]).toMatch(/^\w+$/)
    expect(tokens[4]).toMatch(/^\w+$/)
  })

  it.skipIf(!isBun)('emits bun/<version>; <platform>; <arch> on Bun', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/; bun(\/\d|;)/)
  })

  it.skipIf(!isDeno)('emits deno/<version>; <os>; <arch> on Deno', () => {
    const ua = getUserAgent()
    expect(ua).toMatch(/; deno(\/\d|;)/)
  })

  // The two tests above only run inside their respective runtimes, so when CI
  // executes the suite under Node those branches go uncovered and the global
  // coverage threshold can drift below 95%. The two tests below mock the Bun
  // and Deno globals from within Node so the detection branches in
  // `detectPlatform()` run regardless of where the suite is executing.
  it.skipIf(!isNode)('detects Deno when the Deno global is present (Node-side mock)', () => {
    const g = globalThis as Record<string, unknown>
    try {
      g['Deno'] = { version: { deno: '2.7.14' }, build: { os: 'darwin', arch: 'aarch64' } }
      const ua = getUserAgent()
      expect(ua).toContain('; deno/2.7.14;')
      expect(ua).toContain('; darwin;')
      expect(ua).toContain('; aarch64)')
    } finally {
      Reflect.deleteProperty(g, 'Deno')
    }
  })

  it.skipIf(!isNode)('detects Deno without version/build metadata (defensive fallback)', () => {
    const g = globalThis as Record<string, unknown>
    try {
      // Some Deno-compat shims expose `Deno` but no version/build info.
      g['Deno'] = {}
      const ua = getUserAgent()
      expect(ua).toContain('; deno)')
    } finally {
      Reflect.deleteProperty(g, 'Deno')
    }
  })

  it.skipIf(!isNode)('detects Bun when the Bun global is present (Node-side mock)', () => {
    const g = globalThis as Record<string, unknown>
    try {
      g['Bun'] = { version: '1.3.13' }
      const ua = getUserAgent()
      expect(ua).toContain('; bun/1.3.13;')
      // Bun is Node-compat: process.platform / process.arch are real.
      expect(ua).toMatch(/; (linux|darwin|win32|freebsd|openbsd|sunos|aix);/)
    } finally {
      Reflect.deleteProperty(g, 'Bun')
    }
  })

  it.skipIf(!isNode)('detects Bun without process available (no os/arch tokens emitted)', () => {
    const g = globalThis as Record<string, unknown>
    const savedProcess = globalThis.process
    try {
      g['Bun'] = { version: '1.3.13' }
      Reflect.deleteProperty(g, 'process')
      const ua = getUserAgent()
      expect(ua).toContain('; bun/1.3.13)')
    } finally {
      Reflect.deleteProperty(g, 'Bun')
      globalThis.process = savedProcess
    }
  })

  it.skipIf(!isNode)('falls back to browser when only navigator is present', () => {
    const savedProcess = globalThis.process
    const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      // Strip process so the Node branch is skipped, leaving only navigator.
      Reflect.deleteProperty(globalThis as object, 'process')
      if (!navDescriptor) {
        Object.defineProperty(globalThis, 'navigator', {
          value: { userAgent: 'test' },
          configurable: true,
        })
      }
      const ua = getUserAgent()
      expect(ua).toContain('; browser)')
      // Browser branch has no OS/arch by design (navigator parsing is noisy).
      expect(ua).not.toMatch(/; browser;/)
    } finally {
      globalThis.process = savedProcess
      if (!navDescriptor) {
        Reflect.deleteProperty(globalThis as object, 'navigator')
      }
    }
  })

  it.skipIf(!isNode)('falls back to "unknown" when no runtime globals are present', () => {
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
      expect(ua).toContain('; unknown)')
    } finally {
      globalThis.process = savedProcess
      if (navDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navDescriptor)
      }
    }
  })
})
