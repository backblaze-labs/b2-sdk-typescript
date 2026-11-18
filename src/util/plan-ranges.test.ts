import { describe, expect, it } from 'vitest'
import { planRanges } from './plan-ranges.ts'

describe('planRanges', () => {
  it('covers [0, total) exactly with positive chunk sizes', () => {
    const plans = planRanges(10, 4)
    expect(plans).toEqual([
      { partNumber: 1, index: 0, offset: 0, length: 4, start: 0, end: 3 },
      { partNumber: 2, index: 1, offset: 4, length: 4, start: 4, end: 7 },
      { partNumber: 3, index: 2, offset: 8, length: 2, start: 8, end: 9 },
    ])
  })

  it('returns no ranges for an empty total', () => {
    expect(planRanges(0, 4)).toEqual([])
  })

  it('returns a single range when the chunk size equals the total', () => {
    expect(planRanges(10, 10).map((p) => [p.start, p.end])).toEqual([[0, 9]])
  })

  it('returns a single range when the chunk size exceeds the total', () => {
    expect(planRanges(10, 25).map((p) => [p.start, p.end])).toEqual([[0, 9]])
  })
})
