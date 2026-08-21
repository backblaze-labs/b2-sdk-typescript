import { describe, expectTypeOf, it } from 'vitest'
import type { BucketDefaultRetention, BucketInfo } from './bucket.ts'

describe('bucket response types', () => {
  it('keeps bucket default retention nested under fileLockConfiguration', () => {
    expectTypeOf<
      NonNullable<BucketInfo['fileLockConfiguration']['value']>['defaultRetention']
    >().toEqualTypeOf<BucketDefaultRetention>()

    // @ts-expect-error Regression for #41: BucketInfo has no phantom top-level retention field.
    expectTypeOf<BucketInfo['defaultRetention']>().toEqualTypeOf<
      BucketDefaultRetention | undefined
    >()
  })
})
