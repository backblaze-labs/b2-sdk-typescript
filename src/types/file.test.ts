import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  Bucket,
  BucketListFileNamesMaybeDelimiterOptions,
  BucketListFileNamesOptions,
  BucketListFileNamesWithDelimiterOptions,
  BucketListFileVersionsMaybeDelimiterOptions,
  BucketListFileVersionsOptions,
  BucketListFileVersionsWithDelimiterOptions,
  BucketPaginateFileNamesMaybeDelimiterOptions,
  BucketPaginateFileNamesOptions,
  BucketPaginateFileNamesWithDelimiterOptions,
  BucketPaginateFileVersionsMaybeDelimiterOptions,
  BucketPaginateFileVersionsOptions,
  BucketPaginateFileVersionsWithDelimiterOptions,
} from '../bucket.ts'
import type { RawClient } from '../raw/index.ts'
import { EncryptionMode } from './encryption.ts'
import {
  FileAction,
  type FileNameListEntry,
  type FileVersionListEntry,
  HIDE_MARKER_CONTENT_TYPE,
  type ListedConcreteFileVersion,
  type ListedFileVersion,
  type ListFileNamesMaybeDelimiterRequest,
  type ListFileNamesResponse,
  type ListFileNamesWithDelimiterResponse,
  type ListFileVersionsMaybeDelimiterRequest,
  type ListFileVersionsResponse,
  type ListFileVersionsWithDelimiterResponse,
} from './file.ts'
import type { AccountId, BucketId, FileId } from './ids.ts'

const listedUpload: ListedConcreteFileVersion = {
  accountId: 'account' as unknown as AccountId,
  action: FileAction.Upload,
  bucketId: 'bucket' as unknown as BucketId,
  contentLength: 1,
  contentMd5: null,
  contentSha1: 'sha1',
  contentType: 'application/octet-stream',
  fileId: 'file' as unknown as FileId,
  fileInfo: {},
  fileName: 'file.txt',
  fileRetention: { isClientAuthorizedToRead: true, value: null },
  legalHold: { isClientAuthorizedToRead: true, value: null },
  serverSideEncryption: { mode: EncryptionMode.None },
  uploadTimestamp: 1,
}

const listedHide: ListedConcreteFileVersion = {
  accountId: 'account' as unknown as AccountId,
  action: FileAction.Hide,
  bucketId: 'bucket' as unknown as BucketId,
  contentLength: 0,
  contentMd5: null,
  contentSha1: null,
  contentType: HIDE_MARKER_CONTENT_TYPE,
  fileId: 'hide-file' as unknown as FileId,
  fileInfo: {},
  fileName: 'hidden.txt',
  uploadTimestamp: 2,
}

const listedFolder: FileVersionListEntry = {
  accountId: 'account' as unknown as AccountId,
  action: FileAction.Folder,
  bucketId: 'bucket' as unknown as BucketId,
  contentLength: 0,
  contentMd5: null,
  contentSha1: null,
  contentType: null,
  fileId: null,
  fileInfo: {},
  fileName: 'folder/',
  uploadTimestamp: 0,
}

const listedNameFolder: FileNameListEntry = listedFolder

function acceptListedConcrete(entry: ListedConcreteFileVersion): ListedConcreteFileVersion {
  return entry
}

function acceptListNamesResponse(response: ListFileNamesResponse): ListFileNamesResponse {
  return response
}

describe('file listing types', () => {
  it('models hide and folder rows as exclusive list branches', () => {
    expect(acceptListedConcrete(listedUpload).contentType).toBe('application/octet-stream')
    expect(acceptListedConcrete(listedHide).contentType).toBe(HIDE_MARKER_CONTENT_TYPE)

    // @ts-expect-error Hide list entries must use B2's marker content type.
    acceptListedConcrete({ ...listedUpload, action: FileAction.Hide })

    acceptListedConcrete({
      ...listedHide,
      // @ts-expect-error Hide list entries omit Object Lock and encryption metadata.
      fileRetention: { isClientAuthorizedToRead: true, value: null },
    })

    const concrete: ListFileNamesResponse = {
      files: [listedUpload],
      nextFileName: null,
    }
    expect(acceptListNamesResponse(concrete).files).toHaveLength(1)

    // @ts-expect-error Non-delimiter list responses cannot contain folder rows.
    acceptListNamesResponse({ files: [listedFolder], nextFileName: null })

    // @ts-expect-error b2_list_file_names does not return hide rows.
    acceptListNamesResponse({ files: [listedHide], nextFileName: null })

    const delimiter: ListFileNamesWithDelimiterResponse = {
      files: [listedUpload, listedNameFolder],
      nextFileName: null,
    }
    expect(delimiter.files.map((file) => file.action)).toEqual([
      FileAction.Upload,
      FileAction.Folder,
    ])

    const delimiterWithHide: ListFileNamesWithDelimiterResponse = {
      // @ts-expect-error b2_list_file_names delimiter responses do not include hide rows.
      files: [listedHide],
      nextFileName: null,
    }
    expect(delimiterWithHide.files).toHaveLength(1)

    const versions: ListFileVersionsResponse = {
      files: [listedUpload, listedHide],
      nextFileName: null,
      nextFileId: null,
    }
    expect(versions.files.map((file) => file.action)).toEqual([FileAction.Upload, FileAction.Hide])

    const versionsWithDelimiter: ListFileVersionsWithDelimiterResponse = {
      files: [listedUpload, listedHide, listedFolder],
      nextFileName: null,
      nextFileId: null,
    }
    expect(versionsWithDelimiter.files.map((file) => file.action)).toEqual([
      FileAction.Upload,
      FileAction.Hide,
      FileAction.Folder,
    ])
  })

  it('exposes dynamic delimiter overloads for list wrappers', () => {
    expectTypeOf<Bucket['listFileNames']>().toMatchTypeOf<{
      (
        options: BucketListFileNamesWithDelimiterOptions,
      ): Promise<ListFileNamesWithDelimiterResponse>
      (options?: BucketListFileNamesOptions): Promise<ListFileNamesResponse>
      (
        options: BucketListFileNamesMaybeDelimiterOptions,
      ): Promise<ListFileNamesResponse | ListFileNamesWithDelimiterResponse>
    }>()
    expectTypeOf<Bucket['listFileVersions']>().toMatchTypeOf<{
      (
        options: BucketListFileVersionsWithDelimiterOptions,
      ): Promise<ListFileVersionsWithDelimiterResponse>
      (options?: BucketListFileVersionsOptions): Promise<ListFileVersionsResponse>
      (
        options: BucketListFileVersionsMaybeDelimiterOptions,
      ): Promise<ListFileVersionsResponse | ListFileVersionsWithDelimiterResponse>
    }>()
    expectTypeOf<Bucket['paginateFileNames']>().toMatchTypeOf<{
      (
        options: BucketPaginateFileNamesWithDelimiterOptions,
      ): AsyncIterableIterator<FileNameListEntry>
      (options?: BucketPaginateFileNamesOptions): AsyncIterableIterator<ListedFileVersion>
      (
        options: BucketPaginateFileNamesMaybeDelimiterOptions,
      ): AsyncIterableIterator<ListedFileVersion | FileNameListEntry>
    }>()
    expectTypeOf<Bucket['paginateFileVersions']>().toMatchTypeOf<{
      (
        options: BucketPaginateFileVersionsWithDelimiterOptions,
      ): AsyncIterableIterator<FileVersionListEntry>
      (
        options?: BucketPaginateFileVersionsOptions,
      ): AsyncIterableIterator<ListedConcreteFileVersion>
      (
        options: BucketPaginateFileVersionsMaybeDelimiterOptions,
      ): AsyncIterableIterator<ListedConcreteFileVersion | FileVersionListEntry>
    }>()
    expectTypeOf<RawClient['listFileNames']>().toMatchTypeOf<
      (
        apiUrl: string,
        authToken: string,
        request: ListFileNamesMaybeDelimiterRequest,
      ) => Promise<ListFileNamesResponse | ListFileNamesWithDelimiterResponse>
    >()
    expectTypeOf<RawClient['listFileVersions']>().toMatchTypeOf<
      (
        apiUrl: string,
        authToken: string,
        request: ListFileVersionsMaybeDelimiterRequest,
      ) => Promise<ListFileVersionsResponse | ListFileVersionsWithDelimiterResponse>
    >()
  })
})
