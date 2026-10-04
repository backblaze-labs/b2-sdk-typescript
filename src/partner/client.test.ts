import { describe, expect, it, vi } from 'vitest'
import {
  B2PartnerAuthorizationError,
  B2SsrfError,
  BadAuthTokenError,
  ExpiredAuthTokenError,
  InvalidEmailError,
  InvalidGroupIdError,
  InvalidRegionError,
  InvalidSmsPhoneError,
  MethodFailureError,
  OutOfRangeError,
  ServiceUnavailableError,
  TooManyMembersError,
} from '../errors/index.ts'
import type { HttpRequest, HttpTransport } from '../http/transport.ts'
import { jsonErrorResponse, jsonResponse } from '../test-utils/index.ts'
import { accountId, partnerToken } from '../types/ids.ts'
import { type PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'
import type { PartnerAccountInfo } from './account-info.ts'
import { PartnerClient } from './client.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PARTNER_TOKEN_REDACTED } from './redaction.ts'

function apiEndpointName(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

function partnerAuthorizeResponse(
  token: string,
  overrides: { readonly groupsApiUrl?: string; readonly backupApiUrl?: string } = {},
): PartnerAuthorizeResponse {
  const groupsApiUrl = overrides.groupsApiUrl ?? 'https://groups.backblazeb2.com/partner'
  const backupApiUrl = overrides.backupApiUrl ?? 'https://backup.backblazeb2.com/backup'
  return {
    accountId: accountId('partner-account'),
    authorizationToken: partnerToken(token),
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
    groupsApiUrl,
    backupApiUrl,
    groupsCapabilities: [PartnerCapability.All],
    backupCapabilities: [PartnerCapability.All],
    applicationKeyExpirationTimestamp: null,
  }
}

function make401ListGroupsClient(code: string): {
  readonly client: PartnerClient
  readonly listAuthorizations: readonly string[]
  authorizeCount(): number
} {
  let authorizeCount = 0
  const listAuthorizations: string[] = []
  const transport: HttpTransport = {
    async send(request) {
      const endpoint = apiEndpointName(request)
      if (endpoint === 'b2_authorize_account') {
        authorizeCount += 1
        return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
      }
      if (endpoint === 'b2_list_groups') {
        listAuthorizations.push(request.headers?.['Authorization'] ?? '')
        if (listAuthorizations.length === 1) {
          return jsonErrorResponse(401, code, 'simulated 401')
        }
        return jsonResponse({
          accountId: accountId('partner-account'),
          groups: [],
          nextGroupId: null,
        })
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    },
  }

  return {
    client: new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    }),
    listAuthorizations,
    authorizeCount: () => authorizeCount,
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition was not met')
}

describe('PartnerClient facade', () => {
  it('redacts credentials and tokens from JSON serialization paths', () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token-secret'))
    const client = new PartnerClient({
      masterKeyId: 'master-key-id-secret',
      masterKey: 'master-key-secret',
      partnerAccountInfo,
      transport: {
        async send() {
          throw new Error('unexpected request')
        },
      },
    })

    const rendered = [
      JSON.stringify(client),
      JSON.stringify({ client }),
      JSON.stringify({ client: { ...client } }),
      String(client),
    ].join('\n')

    expect(rendered).not.toContain('master-key-id-secret')
    expect(rendered).not.toContain('master-key-secret')
    expect(rendered).not.toContain('masterKey')
    expect(rendered).not.toContain('masterKeyId')
    expect(rendered).not.toContain('partner-token-secret')
    expect(rendered).not.toContain('application-key-secret')
    expect(rendered).toContain('[redacted')
  })

  it('rejects cached auth rehydrated from redacted JSON before requests', async () => {
    const poisonedAuth = partnerAuthorizeResponse(PARTNER_TOKEN_REDACTED)
    const partnerAccountInfo: PartnerAccountInfo = {
      setAuth() {},
      getAuth() {
        return poisonedAuth
      },
      clear() {},
      getPartnerToken() {
        return poisonedAuth.authorizationToken
      },
      getGroupsApiUrl() {
        return poisonedAuth.groupsApiUrl ?? null
      },
      getBackupApiUrl() {
        return poisonedAuth.backupApiUrl ?? null
      },
      getAccountId() {
        return poisonedAuth.accountId
      },
      getGroupsCapabilities() {
        return poisonedAuth.groupsCapabilities ?? null
      },
      getBackupCapabilities() {
        return poisonedAuth.backupCapabilities ?? null
      },
    }
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          throw new Error('unexpected request')
        },
      },
    })

    await expect(client.listGroups()).rejects.toThrow(B2PartnerAuthorizationError)
    await expect(client.listGroups()).rejects.toThrow('Partner authorization token was redacted')
    expect(seenRequests).toHaveLength(0)
  })

  it('rejects calls when Partner authorization has no groups API suite', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: partnerToken('partner-token'),
      apiInfo: {
        backupApi: {
          backupApiUrl: 'https://backup.backblazeb2.com/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      backupApiUrl: 'https://backup.backblazeb2.com/backup',
      backupCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    })
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        },
      },
    })

    await expect(client.listGroups()).rejects.toThrow('Partner API is not available')
    await expect(
      (async () => {
        for await (const group of client.paginateGroups()) {
          void group
        }
      })(),
    ).rejects.toThrow('Partner API is not available')
    expect(seenRequests).toEqual([])
  })

  it('reauthorizes and retries list requests on expired auth token errors', async () => {
    const { client, listAuthorizations, authorizeCount } =
      make401ListGroupsClient('expired_auth_token')

    await client.authorize()
    const page = await client.listGroups()

    expect(page.groups).toEqual([])
    expect(authorizeCount()).toBe(2)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('collapses concurrent expired-token reauthorization into one authorize call', async () => {
    let authorizeCount = 0
    let releaseReauth: (() => void) | undefined
    const reauthGate = new Promise<void>((resolve) => {
      releaseReauth = resolve
    })
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount > 1) await reauthGate
          return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    const calls = Array.from({ length: 5 }, () => client.listGroups())
    await waitUntil(() => authorizeCount === 2)
    releaseReauth?.()
    const pages = await Promise.all(calls)

    expect(pages.every((page) => page.groups.length === 0)).toBe(true)
    expect(authorizeCount).toBe(2)
    expect(listAuthorizations).toEqual([
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-1',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
      'partner-token-2',
    ])
  })

  it('keeps cached auth when expired-token reauthorization fails', async () => {
    let authorizeCount = 0
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          return jsonErrorResponse(503, 'service_unavailable', 'try again')
        }
        if (endpoint === 'b2_list_groups') {
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    await expect(client.listGroups()).rejects.toThrow(ServiceUnavailableError)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')

    await expect(client.listGroups()).rejects.toThrow(ServiceUnavailableError)
    expect(authorizeCount).toBe(3)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')
  })

  it('cancels expired-token reauthorization with the original list signal', async () => {
    let authorizeCount = 0
    let reauthorizeSignal: AbortSignal | undefined
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          reauthorizeSignal = request.signal
          return new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          })
        }
        if (endpoint === 'b2_list_groups') {
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const controller = new AbortController()

    await client.authorize()
    const pending = client.listGroups({ signal: controller.signal })
    await waitUntil(() => authorizeCount === 2)
    controller.abort(new DOMException('caller canceled', 'AbortError'))

    await expect(pending).rejects.toThrow('caller canceled')
    expect(reauthorizeSignal?.aborted).toBe(true)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')
  })

  it('clears shared expired-token reauthorization when the final waiter aborts', async () => {
    let authorizeCount = 0
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          if (authorizeCount === 2) {
            return new Promise(() => {})
          }
          return jsonResponse(partnerAuthorizeResponse('partner-token-2'))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const controller = new AbortController()

    await client.authorize()
    const first = client.listGroups({ signal: controller.signal })
    await waitUntil(() => authorizeCount === 2)
    controller.abort(new DOMException('caller canceled', 'AbortError'))

    await expect(first).rejects.toThrow('caller canceled')
    const page = await client.listGroups()

    expect(page.groups).toEqual([])
    expect(authorizeCount).toBe(3)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('keeps shared expired-token reauthorization alive for non-aborted waiters', async () => {
    let authorizeCount = 0
    let releaseReauth: (() => void) | undefined
    let reauthorizeSignal: AbortSignal | undefined
    const reauthGate = new Promise<void>((resolve) => {
      releaseReauth = resolve
    })
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 1) {
            return jsonResponse(partnerAuthorizeResponse('partner-token-1'))
          }
          reauthorizeSignal = request.signal
          await reauthGate
          return jsonResponse(partnerAuthorizeResponse('partner-token-2'))
        }
        if (endpoint === 'b2_list_groups') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            return jsonErrorResponse(401, 'expired_auth_token', 'expired')
          }
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    await client.authorize()
    const first = client.listGroups({ signal: firstController.signal })
    const second = client.listGroups({ signal: secondController.signal })
    await waitUntil(() => authorizeCount === 2 && listAuthorizations.length === 2)
    firstController.abort(new DOMException('first caller canceled', 'AbortError'))

    await expect(first).rejects.toThrow('first caller canceled')
    expect(reauthorizeSignal?.aborted).toBe(false)

    releaseReauth?.()
    const page = await second

    expect(page.groups).toEqual([])
    expect(authorizeCount).toBe(2)
    expect(reauthorizeSignal?.aborted).toBe(false)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('does not reauthorize recursively when authorize returns expired_auth_token', async () => {
    let authorizeCount = 0
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport: {
        async send(request) {
          if (apiEndpointName(request) !== 'b2_authorize_account') {
            throw new Error('unexpected non-authorize request')
          }
          authorizeCount += 1
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        },
      },
      retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await expect(client.authorize()).rejects.toThrow(ExpiredAuthTokenError)
    expect(authorizeCount).toBe(1)
  })

  it('does not reauthorize for partner 401 non-expired auth codes', async () => {
    const { client, listAuthorizations, authorizeCount } = make401ListGroupsClient('unauthorized')

    await client.authorize()
    await expect(client.listGroups()).rejects.toThrow(BadAuthTokenError)

    expect(authorizeCount()).toBe(1)
    expect(listAuthorizations).toEqual(['partner-token-1'])
  })

  it.each([
    ['too_many_members', TooManyMembersError],
    ['invalid_group_id', InvalidGroupIdError],
    ['invalid_email', InvalidEmailError],
    ['invalid_region', InvalidRegionError],
    ['invalid_sms_phone', InvalidSmsPhoneError],
    ['out_of_range', OutOfRangeError],
    ['method_failure', MethodFailureError],
  ] as const)(
    'does not reauthorize for Partner 401 validation code %s',
    async (code, errorClass) => {
      const { client, listAuthorizations, authorizeCount } = make401ListGroupsClient(code)

      await client.authorize()
      await expect(client.listGroups()).rejects.toThrow(errorClass)

      expect(authorizeCount()).toBe(1)
      expect(listAuthorizations).toEqual(['partner-token-1'])
    },
  )

  it.each([
    ['off-realm HTTPS', { groupsApiUrl: 'https://attacker.example/partner' }],
    ['plaintext HTTP', { groupsApiUrl: 'http://groups.backblazeb2.com/partner' }],
    ['userinfo', { groupsApiUrl: 'https://user:secret@groups.backblazeb2.com/partner' }],
    ['query string', { groupsApiUrl: 'https://groups.backblazeb2.com/partner?token=secret' }],
    ['fragment', { groupsApiUrl: 'https://groups.backblazeb2.com/partner#token' }],
    ['internal host', { groupsApiUrl: 'https://metadata.google.internal/partner' }],
  ])(
    'rejects unsafe cached auth before Partner tokens can leave: %s',
    async (_label, overrides) => {
      const partnerAccountInfo = new InMemoryPartnerAccountInfo()
      partnerAccountInfo.setAuth(partnerAuthorizeResponse('victim-partner-token', overrides))
      const seenRequests: HttpRequest[] = []
      const client = new PartnerClient({
        masterKeyId: 'master-key-id',
        masterKey: 'master-key',
        partnerAccountInfo,
        transport: {
          async send(request) {
            seenRequests.push(request)
            return jsonResponse({ accountId: accountId('partner-account'), groups: [] })
          },
        },
      })

      expect(partnerAccountInfo.getPartnerToken()).toBe('victim-partner-token')
      await expect(client.listGroups()).rejects.toThrow(B2PartnerAuthorizationError)

      expect(seenRequests).toEqual([])
    },
  )

  it('rejects cached auth whose endpoint mirror points away from apiInfo', async () => {
    const cachedAuth = {
      ...partnerAuthorizeResponse('victim-partner-token'),
      groupsApiUrl: 'https://attacker.example/partner',
    }
    let cleared = false
    const partnerAccountInfo: PartnerAccountInfo = {
      setAuth() {},
      getAuth: () => cachedAuth,
      clear() {
        cleared = true
      },
      getPartnerToken: () => cachedAuth.authorizationToken,
      getGroupsApiUrl: () => cachedAuth.groupsApiUrl ?? null,
      getBackupApiUrl: () => cachedAuth.backupApiUrl ?? null,
      getAccountId: () => cachedAuth.accountId,
      getGroupsCapabilities: () => cachedAuth.groupsCapabilities ?? null,
      getBackupCapabilities: () => cachedAuth.backupCapabilities ?? null,
    }
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({ accountId: accountId('partner-account'), groups: [] })
        },
      },
    })

    expect(cleared).toBe(false)
    await expect(client.listGroups()).rejects.toThrow(B2PartnerAuthorizationError)

    expect(seenRequests).toEqual([])
  })

  it('uses validated cached auth with a custom transport without reauthorizing', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('cached-partner-token'))
    const seenRequests: HttpRequest[] = []
    const client = new PartnerClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          return jsonResponse({
            accountId: accountId('partner-account'),
            groups: [],
            nextGroupId: null,
          })
        },
      },
    })

    await client.listGroups()

    expect(seenRequests.map((request) => apiEndpointName(request))).toEqual(['b2_list_groups'])
    expect(seenRequests[0]?.headers?.['Authorization']).toBe('cached-partner-token')
  })

  it('locks the default URL guard from Partner authorize response hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accountId: 'partner-account',
          authorizationToken: 'partner-token',
          apiInfo: {
            groupsApi: {
              groupsApiUrl: 'https://groups.backblaze.com/partner',
              capabilities: [PartnerCapability.All],
              infoType: 'groupsApi',
            },
            backupApi: {
              backupApiUrl: 'https://backup.backblazeb2.com/backup',
              capabilities: [PartnerCapability.All],
              infoType: 'backupApi',
            },
          },
          applicationKeyExpirationTimestamp: null,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    )
    try {
      const client = new PartnerClient({
        masterKeyId: 'master-key-id',
        masterKey: 'master-key',
        additionalAllowedHostSuffixes: [],
      })

      await client.authorize()

      expect(client.urlGuard?.getAllowedSuffixes()).toEqual(['backblaze.com', 'backblazeb2.com'])
      expect(() => client.urlGuard?.check('https://evil.example/collect')).toThrow(B2SsrfError)
    } finally {
      fetchMock.mockRestore()
    }
  })

  it('disables the default URL guard only through disableSsrfGuard', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(partnerAuthorizeResponse('partner-token')), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    try {
      const client = new PartnerClient({
        masterKeyId: 'master-key-id',
        masterKey: 'master-key',
        disableSsrfGuard: true,
      })

      await client.authorize()

      expect(client.urlGuard?.getAllowedSuffixes()).toEqual([])
    } finally {
      fetchMock.mockRestore()
    }
  })
})
