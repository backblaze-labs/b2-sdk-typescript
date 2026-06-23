import { describe, expect, it } from 'vitest'
import { compareCodeUnits, compareSyncPathNames, compareSyncRelativePaths } from './path-order.ts'

describe('sync path ordering', () => {
  it('orders paths by JavaScript code units', () => {
    expect(compareCodeUnits('a', 'b')).toBe(-1)
    expect(compareCodeUnits('b', 'a')).toBe(1)
    expect(compareCodeUnits('a', 'a')).toBe(0)
    expect(compareSyncRelativePaths('A', 'a')).toBe(-1)
    expect(compareSyncPathNames('folder/a', 'folder/b')).toBe(-1)
  })
})
