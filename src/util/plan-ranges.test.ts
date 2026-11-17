import { describe, expect, it } from 'vitest'
import { planRanges } from './plan-ranges.ts'

describe('planRanges', () => {
  it('covers [0, total) exactly with positive chunk sizes', () => {
    const plans = planRanges(10, 4)
    expect(plans.map((p) => [p.start, p.end])).toEqual([
      [0, 3],
      [4, 7],
      [8, 9],
    ])
  })

  it('returns a single range when the chunk size equals the total', () => {
    expect(planRanges(10, 10).map((p) => [p.start, p.end])).toEqual([[0, 9]])
  })

  it('returns a single range when the chunk size exceeds the total', () => {
    expect(planRanges(10, 25).map((p) => [p.start, p.end])).toEqual([[0, 9]])
  })
})
