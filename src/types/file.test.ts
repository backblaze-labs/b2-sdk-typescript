import { describe, expect, it } from 'vitest'
import { EncryptionMode } from './encryption.ts'
import {
  FileAction,
  type FileVersionListEntry,
  type ListedConcreteFileVersion,
  type ListFileNamesResponse,
  type ListFileNamesWithDelimiterResponse,
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
  contentType: null,
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

function acceptListedConcrete(entry: ListedConcreteFileVersion): ListedConcreteFileVersion {
  return entry
}

function acceptListNamesResponse(response: ListFileNamesResponse): ListFileNamesResponse {
  return response
}

describe('file listing types', () => {
  it('models hide and folder rows as exclusive list branches', () => {
    expect(acceptListedConcrete(listedUpload).contentType).toBe('application/octet-stream')
    expect(acceptListedConcrete(listedHide).contentType).toBeNull()

    // @ts-expect-error Hide list entries must use `contentType: null`.
    acceptListedConcrete({ ...listedUpload, action: FileAction.Hide })

    acceptListedConcrete({
      ...listedHide,
      // @ts-expect-error Hide list entries omit Object Lock and encryption metadata.
      fileRetention: { isClientAuthorizedToRead: true, value: null },
    })

    const concrete: ListFileNamesResponse = {
      files: [listedUpload, listedHide],
      nextFileName: null,
    }
    expect(acceptListNamesResponse(concrete).files).toHaveLength(2)

    // @ts-expect-error Non-delimiter list responses cannot contain folder rows.
    acceptListNamesResponse({ files: [listedFolder], nextFileName: null })

    const delimiter: ListFileNamesWithDelimiterResponse = {
      files: [listedUpload, listedHide, listedFolder],
      nextFileName: null,
    }
    expect(delimiter.files.map((file) => file.action)).toEqual([
      FileAction.Upload,
      FileAction.Hide,
      FileAction.Folder,
    ])
  })
})
