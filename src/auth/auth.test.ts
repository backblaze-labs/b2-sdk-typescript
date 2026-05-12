import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthorizeAccountResponse } from '../types/auth.js'
import { bucketId } from '../types/ids.js'
import type { UploadUrlEntry } from './account-info.js'
import { InMemoryAccountInfo } from './in-memory.js'
import { REALM_URLS, getRealmUrl } from './realms.js'
import { UploadUrlPool } from './upload-url-pool.js'

const mockAuth: AuthorizeAccountResponse = {
  accountId: 'acct123' as AuthorizeAccountResponse['accountId'],
  authorizationToken: 'token123' as AuthorizeAccountResponse['authorizationToken'],
  applicationKeyExpirationTimestamp: null,
  apiInfo: {
    storageApi: {
      apiUrl: 'https://api.example.com',
      downloadUrl: 'https://dl.example.com',
      s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
      recommendedPartSize: 100_000_000,
      absoluteMinimumPartSize: 5_000_000,
      infoType: 'storageApi',
      bucketId: null,
      bucketName: null,
      namePrefix: null,
      allowed: {
        capabilities: ['listBuckets', 'readFiles'],
        bucketId: null,
        bucketName: null,
        namePrefix: null,
      },
    },
  },
}

// -- InMemoryAccountInfo ------------------------------------------------

describe('InMemoryAccountInfo', () => {
  let info: InMemoryAccountInfo

  beforeEach(() => {
    info = new InMemoryAccountInfo()
  })

  it('getAuth returns null before setAuth', () => {
    expect(info.getAuth()).toBeNull()
  })

  it('setAuth stores response and getAuth returns it', () => {
    info.setAuth(mockAuth)
    expect(info.getAuth()).toBe(mockAuth)
  })

  describe('after authorization', () => {
    beforeEach(() => {
      info.setAuth(mockAuth)
    })

    it('getApiUrl returns the correct value', () => {
      expect(info.getApiUrl()).toBe('https://api.example.com')
    })

    it('getDownloadUrl returns the correct value', () => {
      expect(info.getDownloadUrl()).toBe('https://dl.example.com')
    })

    it('getAuthToken returns the correct value', () => {
      expect(info.getAuthToken()).toBe('token123')
    })

    it('getAccountId returns the correct value', () => {
      expect(info.getAccountId()).toBe('acct123')
    })

    it('getRecommendedPartSize returns the correct value', () => {
      expect(info.getRecommendedPartSize()).toBe(100_000_000)
    })

    it('getAbsoluteMinimumPartSize returns the correct value', () => {
      expect(info.getAbsoluteMinimumPartSize()).toBe(5_000_000)
    })

    it('getS3ApiUrl returns the correct value', () => {
      expect(info.getS3ApiUrl()).toBe('https://s3.us-west-004.backblazeb2.com')
    })

    it('getAllowedBucketId returns null when unrestricted', () => {
      expect(info.getAllowedBucketId()).toBeNull()
    })
  })

  describe('getters throw before authorization', () => {
    it('getApiUrl throws', () => {
      expect(() => info.getApiUrl()).toThrow('Not authorized')
    })

    it('getDownloadUrl throws', () => {
      expect(() => info.getDownloadUrl()).toThrow('Not authorized')
    })

    it('getAuthToken throws', () => {
      expect(() => info.getAuthToken()).toThrow('Not authorized')
    })

    it('getAccountId throws', () => {
      expect(() => info.getAccountId()).toThrow('Not authorized')
    })

    it('getRecommendedPartSize throws', () => {
      expect(() => info.getRecommendedPartSize()).toThrow('Not authorized')
    })

    it('getAbsoluteMinimumPartSize throws', () => {
      expect(() => info.getAbsoluteMinimumPartSize()).toThrow('Not authorized')
    })

    it('getS3ApiUrl throws', () => {
      expect(() => info.getS3ApiUrl()).toThrow('Not authorized')
    })

    it('getAllowedBucketId throws', () => {
      expect(() => info.getAllowedBucketId()).toThrow('Not authorized')
    })
  })

  describe('clear resets state', () => {
    it('getAuth returns null after clear', () => {
      info.setAuth(mockAuth)
      info.clear()
      expect(info.getAuth()).toBeNull()
    })

    it('getters throw after clear', () => {
      info.setAuth(mockAuth)
      info.clear()
      expect(() => info.getApiUrl()).toThrow('Not authorized')
      expect(() => info.getDownloadUrl()).toThrow('Not authorized')
      expect(() => info.getAuthToken()).toThrow('Not authorized')
      expect(() => info.getAccountId()).toThrow('Not authorized')
    })
  })

  describe('upload URL pool (small files)', () => {
    const bid = bucketId('bucket1')
    const entry: UploadUrlEntry = {
      uploadUrl: 'https://upload.example.com/bucket1',
      authorizationToken: 'upload-token-1',
    }

    beforeEach(() => {
      info.setAuth(mockAuth)
    })

    it('checkoutUploadUrl returns null when pool is empty', () => {
      expect(info.checkoutUploadUrl(bid)).toBeNull()
    })

    it('returnUploadUrl then checkoutUploadUrl round-trips', () => {
      info.returnUploadUrl(bid, entry)
      expect(info.checkoutUploadUrl(bid)).toBe(entry)
    })

    it('evictUploadUrl removes the entry', () => {
      info.returnUploadUrl(bid, entry)
      info.evictUploadUrl(bid, entry)
      expect(info.checkoutUploadUrl(bid)).toBeNull()
    })
  })

  describe('part upload URL pool (large files)', () => {
    const fid = 'file-large-001'
    const entry: UploadUrlEntry = {
      uploadUrl: 'https://upload.example.com/part1',
      authorizationToken: 'part-token-1',
    }

    beforeEach(() => {
      info.setAuth(mockAuth)
    })

    it('checkoutPartUploadUrl returns null when pool is empty', () => {
      expect(info.checkoutPartUploadUrl(fid)).toBeNull()
    })

    it('returnPartUploadUrl then checkoutPartUploadUrl round-trips', () => {
      info.returnPartUploadUrl(fid, entry)
      expect(info.checkoutPartUploadUrl(fid)).toBe(entry)
    })

    it('evictPartUploadUrl removes the entry', () => {
      info.returnPartUploadUrl(fid, entry)
      info.evictPartUploadUrl(fid, entry)
      expect(info.checkoutPartUploadUrl(fid)).toBeNull()
    })
  })

  describe('setAuth clears upload URL pools', () => {
    it('small-file upload URLs are cleared on re-authorization', () => {
      info.setAuth(mockAuth)
      const bid = bucketId('bucket1')
      const entry: UploadUrlEntry = {
        uploadUrl: 'https://upload.example.com/bucket1',
        authorizationToken: 'upload-token-1',
      }
      info.returnUploadUrl(bid, entry)

      // Re-authorize should clear pools
      info.setAuth(mockAuth)
      expect(info.checkoutUploadUrl(bid)).toBeNull()
    })

    it('part upload URLs are cleared on re-authorization', () => {
      info.setAuth(mockAuth)
      const fid = 'file-large-002'
      const entry: UploadUrlEntry = {
        uploadUrl: 'https://upload.example.com/part2',
        authorizationToken: 'part-token-2',
      }
      info.returnPartUploadUrl(fid, entry)

      // Re-authorize should clear pools
      info.setAuth(mockAuth)
      expect(info.checkoutPartUploadUrl(fid)).toBeNull()
    })
  })
})

// -- UploadUrlPool ------------------------------------------------------

describe('UploadUrlPool', () => {
  let pool: UploadUrlPool

  const entryA: UploadUrlEntry = {
    uploadUrl: 'https://upload.example.com/a',
    authorizationToken: 'token-a',
  }
  const entryB: UploadUrlEntry = {
    uploadUrl: 'https://upload.example.com/b',
    authorizationToken: 'token-b',
  }
  const entryC: UploadUrlEntry = {
    uploadUrl: 'https://upload.example.com/c',
    authorizationToken: 'token-c',
  }

  beforeEach(() => {
    pool = new UploadUrlPool()
  })

  it('checkout returns null for an unknown key', () => {
    expect(pool.checkout('no-such-key')).toBeNull()
  })

  it('checkin then checkout returns the entry', () => {
    pool.checkin('key1', entryA)
    expect(pool.checkout('key1')).toBe(entryA)
  })

  it('evict removes the specific entry', () => {
    pool.checkin('key1', entryA)
    pool.evict('key1', entryA)
    expect(pool.checkout('key1')).toBeNull()
  })

  it('evict is a no-op for an unknown key', () => {
    // Should not throw
    pool.evict('no-such-key', entryA)
  })

  it('evict only removes the matching entry', () => {
    pool.checkin('key1', entryA)
    pool.checkin('key1', entryB)
    pool.evict('key1', entryA)
    // entryB should still be available
    expect(pool.checkout('key1')).toBe(entryB)
    // Pool is now empty for this key
    expect(pool.checkout('key1')).toBeNull()
  })

  describe('multiple entries per key (LIFO checkout)', () => {
    it('returns the most recently checked-in entry first', () => {
      pool.checkin('key1', entryA)
      pool.checkin('key1', entryB)
      pool.checkin('key1', entryC)

      // pop() returns last-in first (LIFO)
      expect(pool.checkout('key1')).toBe(entryC)
      expect(pool.checkout('key1')).toBe(entryB)
      expect(pool.checkout('key1')).toBe(entryA)
      expect(pool.checkout('key1')).toBeNull()
    })
  })

  it('clear removes all entries from every key', () => {
    pool.checkin('key1', entryA)
    pool.checkin('key2', entryB)
    pool.clear()
    expect(pool.checkout('key1')).toBeNull()
    expect(pool.checkout('key2')).toBeNull()
  })

  it('checkout returns null after all entries have been checked out', () => {
    pool.checkin('key1', entryA)
    pool.checkout('key1')
    expect(pool.checkout('key1')).toBeNull()
  })
})

// -- getRealmUrl --------------------------------------------------------

describe('getRealmUrl', () => {
  it('returns the well-known URL for the production realm', () => {
    expect(getRealmUrl('production')).toBe('https://api.backblazeb2.com')
  })

  it('returns the well-known URL for the staging realm', () => {
    expect(getRealmUrl('staging')).toBe('https://api.backblazeb2.com')
  })

  it('returns a custom URL as-is when it is not a known realm name', () => {
    const customUrl = 'https://custom.b2.example.com'
    expect(getRealmUrl(customUrl)).toBe(customUrl)
  })

  it('returns an unknown realm name as-is (fallback behavior)', () => {
    expect(getRealmUrl('dev')).toBe('dev')
  })

  it('REALM_URLS contains the expected known realms', () => {
    expect(Object.keys(REALM_URLS)).toContain('production')
    expect(Object.keys(REALM_URLS)).toContain('staging')
  })
})
