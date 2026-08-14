import { describe, expect, it, vi } from 'vitest'
import { B2PartnerAuthorizationError, B2RealmConfigurationError } from '../errors/index.ts'
import { FetchTransport, type HttpRequest, type HttpTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import type { PartnerToken } from '../types/ids.ts'
import { accountId, partnerToken } from '../types/ids.ts'
import { PartnerCapability } from '../types/partner.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient } from './raw.ts'

function partnerAuthorizeResponse(
  overrides: { readonly groupsApiUrl?: string; readonly backupApiUrl?: string } = {},
) {
  const groupsApiUrl = overrides.groupsApiUrl ?? 'https://groups.backblazeb2.com/partner'
  const backupApiUrl = overrides.backupApiUrl ?? 'https://backup.backblazeb2.com/backup'
  return {
    accountId: accountId('partner-account'),
    authorizationToken: 'partner-token',
    apiInfo: {
      groupsApi: {
        groupsApiUrl,
        capabilities: [PartnerCapability.All],
        infoType: 'groupsApi',
      },
      backupApi: {
        backupApiUrl,
        capabilities: [PartnerCapability.All],
        infoType: 'backupApi',
      },
    },
    applicationKeyExpirationTimestamp: 1_786_662_000_000,
  }
}

describe('PartnerRawClient authorizePartner', () => {
  it('normalizes Partner authorize response and stores it in PartnerAccountInfo', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(partnerAuthorizeResponse())
      },
    }
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')

    expect(seenRequests).toEqual([
      {
        url: 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
        method: 'GET',
        headers: {
          Authorization: `Basic ${btoa('master-key-id:master-key')}`,
        },
      },
    ])
    expect(auth).toMatchObject({
      accountId: accountId('partner-account'),
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
        backupApi: {
          backupApiUrl: 'https://backup.backblazeb2.com/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      backupApiUrl: 'https://backup.backblazeb2.com/backup',
      groupsCapabilities: [PartnerCapability.All],
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: 1_786_662_000_000,
    })
    expect(auth.authorizationToken).toBe(partnerToken('partner-token'))

    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth(auth)

    expect(accountInfo.getAuth()).toBe(auth)
    expect(accountInfo.getPartnerToken()).toBe('partner-token')
    expect(accountInfo.getGroupsApiUrl()).toBe('https://groups.backblazeb2.com/partner')
    expect(accountInfo.getBackupApiUrl()).toBe('https://backup.backblazeb2.com/backup')
    expect(accountInfo.getAccountId()).toBe(accountId('partner-account'))
    expect(accountInfo.getGroupsCapabilities()).toEqual([PartnerCapability.All])
    expect(accountInfo.getBackupCapabilities()).toEqual([PartnerCapability.All])
    expect(JSON.stringify(auth)).not.toContain('partner-token')
    expect(JSON.stringify(accountInfo)).not.toContain('partner-token')
    expect(accountInfo.toString()).not.toContain('partner-token')
  })

  it('supports Partner-only authorize responses without Backup fields', async () => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse({
          accountId: accountId('partner-account'),
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.backblazeb2.com/partner',
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
              backupApiUrl: 'https://backup.backblazeb2.com/backup',
              capabilities: [PartnerCapability.All],
            },
          },
          applicationKeyExpirationTimestamp: null,
        })
      },
    }
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key')).rejects.toThrow(
      B2PartnerAuthorizationError,
    )
  })

  it.each([
    ['malformed groupsApiUrl', { groupsApiUrl: 'not a url' }],
    ['plaintext groupsApiUrl', { groupsApiUrl: 'http://groups.backblazeb2.com/partner' }],
    ['literal-IP groupsApiUrl', { groupsApiUrl: 'https://169.254.169.254/latest/meta-data' }],
    ['localhost groupsApiUrl', { groupsApiUrl: 'https://localhost/partner' }],
    [
      'userinfo groupsApiUrl',
      { groupsApiUrl: 'https://user:secret@groups.backblazeb2.com/partner' },
    ],
    ['off-realm groupsApiUrl', { groupsApiUrl: 'https://evil.example/collect' }],
    ['plaintext backupApiUrl', { backupApiUrl: 'http://backup.backblazeb2.com/backup' }],
    ['literal-IP backupApiUrl', { backupApiUrl: 'https://169.254.169.254/latest/meta-data' }],
    ['localhost backupApiUrl', { backupApiUrl: 'https://localhost/backup' }],
    [
      'userinfo backupApiUrl',
      { backupApiUrl: 'https://user:secret@backup.backblazeb2.com/backup' },
    ],
    ['off-realm backupApiUrl', { backupApiUrl: 'https://evil.example/collect' }],
  ])('rejects unsafe Partner endpoint payloads: %s', async (_label, overrides) => {
    const transport: HttpTransport = {
      async send() {
        return jsonResponse(partnerAuthorizeResponse(overrides))
      },
    }
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key')).rejects.toThrow(
      B2PartnerAuthorizationError,
    )
  })

  it('locks a default FetchTransport UrlGuard to Partner endpoint hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partnerAuthorizeResponse()), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const urlGuard = new UrlGuard()
    const transport = new FetchTransport({ urlGuard })
    const raw = new PartnerRawClient({ transport })

    const auth = await raw.authorizePartner('master-key-id', 'master-key')

    expect(auth.groupsApiUrl).toBe('https://groups.backblazeb2.com/partner')
    expect(urlGuard.getAllowedSuffixes()).toEqual(['backblazeb2.com'])
    expect(() => urlGuard.check('https://evil.example/collect')).toThrow()
    fetchMock.mockRestore()
  })

  it('rejects insecure realm URLs before sending credentials', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new PartnerRawClient({ transport })

    await expect(raw.authorizePartner('master-key-id', 'master-key', 'sandbox')).rejects.toThrow(
      B2RealmConfigurationError,
    )
    expect(seenUrls).toEqual([])
  })

  it('rejects arbitrary HTTPS authorize realms unless explicitly allowed', async () => {
    const { seenUrls, transport } = recordingTransport()
    const raw = new PartnerRawClient({ transport })

    await expect(
      raw.authorizePartner('master-key-id', 'master-key', 'https://attacker.example'),
    ).rejects.toThrow(B2RealmConfigurationError)
    expect(seenUrls).toEqual([])
  })

  it('allows custom authorize realms only with explicit opt-in', async () => {
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(
          partnerAuthorizeResponse({
            groupsApiUrl: 'https://groups.auth.custom.example/partner',
            backupApiUrl: 'https://backup.auth.custom.example/backup',
          }),
        )
      },
    }
    const raw = new PartnerRawClient({ transport, allowCustomAuthorizeRealm: true })

    const auth = await raw.authorizePartner(
      'master-key-id',
      'master-key',
      'https://auth.custom.example',
    )

    expect(seenRequests[0]?.url).toBe('https://auth.custom.example/b2api/v3/b2_authorize_account')
    expect(auth.groupsApiUrl).toBe('https://groups.auth.custom.example/partner')
    expect(auth.backupApiUrl).toBe('https://backup.auth.custom.example/backup')
  })
})

describe('InMemoryPartnerAccountInfo', () => {
  it('throws from getters before authorization and after clear', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getGroupsApiUrl()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getBackupApiUrl()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getAccountId()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getGroupsCapabilities()).toThrow(B2PartnerAuthorizationError)
    expect(() => accountInfo.getBackupCapabilities()).toThrow(B2PartnerAuthorizationError)

    accountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: 'partner-token' as PartnerToken,
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      groupsCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    })
    accountInfo.clear()

    expect(accountInfo.getAuth()).toBeNull()
    expect(() => accountInfo.getPartnerToken()).toThrow(B2PartnerAuthorizationError)
  })
})
