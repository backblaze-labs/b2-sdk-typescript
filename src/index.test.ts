import { describe, expect, it } from 'vitest'
import { FileSource, toContentSource } from './index.ts'

describe('root stream exports', () => {
  it('keeps FileSource available without touching Node filesystem APIs on import', () => {
    expect(FileSource).toBeTypeOf('function')
    expect(toContentSource).toBeTypeOf('function')
  })
})
