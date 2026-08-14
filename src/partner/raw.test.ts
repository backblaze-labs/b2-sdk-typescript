import { describe, expect, it } from 'vitest'
import { B2RealmConfigurationError } from '../errors/index.ts'
import type { HttpRequest, HttpTransport } from '../http/transport.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import type { PartnerToken } from '../types/ids.ts'
import { accountId } from '../types/ids.ts'
import { PartnerCapability } from '../types/partner.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient } from './raw.ts'

describe('PartnerRawClient authorizePartner', () => {
  it('normalizes Partner authorize response and stores it in PartnerAccountInfo', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.example.com',
              capabilities: [PartnerCapability.All],
              infoType: 'groupsApi',
            },
            backupApi: {
              backupApiUrl: 'https://backup.example.com',
              capabilities: [PartnerCapability.All],
              infoType: 'backupApi',
            },
          },
          applicationKeyExpirationTimestamp: 1_786_662_000_000,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner(
      'master-key-id',
      'master-key',
      'https://api.example.com',
    )

    expect(seenRequests).toEqual([
      {
        url: 'https://api.example.com/b2api/v3/b2_authorize_account',
        method: 'GET',
        headers: {
          Authorization: `Basic ${btoa('master-key-id:master-key')}`,
        },
      },
    ])
    expect(auth).toEqual({
      accountId: accountId('partner-account'),
      authorizationToken: 'partner-token',
      groupsApiUrl: 'https://groups.example.com',
      backupApiUrl: 'https://backup.example.com',
      groupsCapabilities: [PartnerCapability.All],
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: 1_786_662_000_000,
    })

    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(accountInfo.getAuth()).toBe(auth)
    expect(accountInfo.getPartnerToken()).toBe('partner-token')
    expect(accountInfo.getGroupsApiUrl()).toBe('https://groups.example.com')
    expect(accountInfo.getBackupApiUrl()).toBe('https://backup.example.com')
    expect(accountInfo.getAccountId()).toBe(accountId('partner-account'))
    expect(accountInfo.getGroupsCapabilities()).toEqual([PartnerCapability.All])
    expect(accountInfo.getBackupCapabilities()).toEqual([PartnerCapability.All])
  })

  it('supports Partner-only authorize responses without Backup fields', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.example.com',
              capabilities: [PartnerCapability.All],
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')
    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(auth.backupApiUrl).toBeUndefined()
    expect(auth.backupCapabilities).toBeUndefined()
    expect(accountInfo.getBackupApiUrl()).toBeNull()
    expect(accountInfo.getBackupCapabilities()).toBeNull()
  })

  it('rejects authorize responses without the requested Partner suite', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            backupApi: {
              backupApiUrl: 'https://backup.example.com',
              capabilities: [PartnerCapability.All],
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key')).rejects.toThrow(
      'Partner authorize response did not include apiInfo.groupsApi',
    )
  })

  it('rejects insecure realm URLs before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key', 'sandbox')).rejects.toThrow(
      B2RealmConfigurationError,
    )
    expect(seenUrls).toEqual([])
  })
})

describe('InMemoryPartnerAccountInfo', () => {
  it('throws from getters before authorization and after clear', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow('Not authorized')
    expect(() => accountInfo.getGroupsApiUrl()).toThrow('Not authorized')
    expect(() => accountInfo.getBackupApiUrl()).toThrow('Not authorized')
    expect(() => accountInfo.getAccountId()).toThrow('Not authorized')
    expect(() => accountInfo.getGroupsCapabilities()).toThrow('Not authorized')
    expect(() => accountInfo.getBackupCapabilities()).toThrow('Not authorized')

    accountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: 'partner-token' as PartnerToken,
      groupsApiUrl: 'https://groups.example.com',
      groupsCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    })
    accountInfo.clear()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow('Not authorized')
  })
})
