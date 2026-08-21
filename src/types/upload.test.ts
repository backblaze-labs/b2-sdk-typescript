import { describe, expectTypeOf, it } from 'vitest'
import type { BucketDefaultRetention, BucketInfo } from './bucket.ts'
import type { PublicEncryptionSetting } from './encryption.ts'
import type { ReadableFileRetention, ReadableLegalHold } from './lock.ts'
import type { StartLargeFileResponse, UnfinishedLargeFile } from './upload.ts'

describe('upload response types', () => {
  it('models large-file lock and encryption echo metadata', () => {
    expectTypeOf<StartLargeFileResponse['fileRetention']>().toEqualTypeOf<
      ReadableFileRetention | undefined
    >()
    expectTypeOf<StartLargeFileResponse['legalHold']>().toEqualTypeOf<
      ReadableLegalHold | undefined
    >()
    expectTypeOf<StartLargeFileResponse['serverSideEncryption']>().toEqualTypeOf<
      PublicEncryptionSetting | undefined
    >()

    expectTypeOf<UnfinishedLargeFile['fileRetention']>().toEqualTypeOf<
      ReadableFileRetention | undefined
    >()
    expectTypeOf<UnfinishedLargeFile['legalHold']>().toEqualTypeOf<ReadableLegalHold | undefined>()
    expectTypeOf<UnfinishedLargeFile['serverSideEncryption']>().toEqualTypeOf<
      PublicEncryptionSetting | undefined
    >()
  })

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
