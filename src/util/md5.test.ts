import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { md5Base64Sync } from './md5.ts'

describe('md5Base64Sync', () => {
  it('matches Node crypto base64 MD5 output', () => {
    const bytes = new Uint8Array(32).fill(0x61)

    expect(md5Base64Sync(bytes)).toBe(createHash('md5').update(bytes).digest('base64'))
  })
})
