import { describe, expect, it } from 'vitest'
import { planRanges } from './plan-ranges.ts'

/**
 * Run `fn` with a runaway guard: planRanges with a non-advancing chunk size
 * pushes to an array forever (until OOM), so a plain `expect().toThrow()` would
 * hang the whole test process instead of failing. The guard turns a runaway
 * array into an ordinary test failure.
 */
function withRunawayGuard<T>(fn: () => T, limit = 100_000): T {
  const originalPush = Array.prototype.push
  Array.prototype.push = function guardedPush(this: unknown[], ...items: unknown[]): number {
    if (this.length > limit) {
      Array.prototype.push = originalPush
      throw new Error(`runaway array: more than ${limit} elements pushed`)
    }
    return originalPush.apply(this, items)
  }
  try {
    return fn()
  } finally {
    Array.prototype.push = originalPush
  }
}

describe('planRanges', () => {
  it('splits a total into contiguous ranges with a short last range', () => {
    const plans = planRanges(10, 4)
    expect(plans.map((p) => [p.offset, p.length, p.start, p.end, p.partNumber])).toEqual([
      [0, 4, 0, 3, 1],
      [4, 4, 4, 7, 2],
      [8, 2, 8, 9, 3],
    ])
  })

  it('returns no ranges for an empty total', () => {
    expect(planRanges(0, 4)).toEqual([])
  })

  it('rejects a zero chunk size instead of looping forever', () => {
    expect(() => withRunawayGuard(() => planRanges(10, 0))).toThrow(RangeError)
  })

  it('rejects a negative chunk size instead of looping forever', () => {
    expect(() => withRunawayGuard(() => planRanges(10, -5))).toThrow(RangeError)
  })

  it('rejects a NaN chunk size', () => {
    expect(() => withRunawayGuard(() => planRanges(10, Number.NaN))).toThrow(RangeError)
  })
})
