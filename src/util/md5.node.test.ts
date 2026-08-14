import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { md5Base64, md5Base64Sync } from './md5.ts'

const originalGetBuiltinModuleDescriptor = Object.getOwnPropertyDescriptor(
  process,
  'getBuiltinModule',
)
const originalBufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
const hasVitestModuleMocks = typeof vi.doMock === 'function' && typeof vi.doUnmock === 'function'

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property)
    return
  }
  Object.defineProperty(target, property, descriptor)
}

function restoreGlobals() {
  restoreProperty(process, 'getBuiltinModule', originalGetBuiltinModuleDescriptor)
  restoreProperty(globalThis, 'Buffer', originalBufferDescriptor)
}

describe('md5Base64Sync', () => {
  afterEach(() => {
    if (hasVitestModuleMocks) vi.doUnmock('node:crypto')
    restoreGlobals()
    if (typeof vi.resetModules === 'function') vi.resetModules()
  })

  it('matches Node crypto base64 MD5 output', () => {
    const bytes = new Uint8Array(32).fill(0x61)

    expect(md5Base64Sync(bytes)).toBe(createHash('md5').update(bytes).digest('base64'))
  })

  it('falls back to pure JS when sync Node crypto is unavailable', () => {
    Object.defineProperty(process, 'getBuiltinModule', {
      configurable: true,
      value: undefined,
      writable: true,
    })
    Object.defineProperty(globalThis, 'Buffer', {
      configurable: true,
      value: undefined,
      writable: true,
    })

    expect(md5Base64Sync(new Uint8Array(32).fill(0x61))).toBe('Xsqb0+sHwAbNQ65I395/0w==')
    expect(md5Base64Sync(new Uint8Array(32))).toBe('cLyPS3KoaSFGi/joRB3OUQ==')
    expect(md5Base64Sync(new Uint8Array(32).fill(0xff))).toBe('DX3EJmSXEA5IMfWzG2snTw==')
  })

  it.skipIf(!hasVitestModuleMocks)(
    'falls back when dynamic Node crypto import has no createHash function',
    async () => {
      vi.doMock('node:crypto', () => ({}))

      await expect(md5Base64(new Uint8Array(32).fill(0x61))).resolves.toBe(
        'Xsqb0+sHwAbNQ65I395/0w==',
      )
    },
  )
})
