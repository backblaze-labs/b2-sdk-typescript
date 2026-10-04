import { describe, expect, it } from 'vitest'
import {
  B2PartnerAuthorizationError,
  BadJsonError,
  ServiceUnavailableError,
} from '../errors/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { InMemoryPartnerAccountInfo } from '../partner/in-memory.ts'
import {
  deferred,
  jsonErrorResponse,
  jsonResponse,
  recordingTransport,
} from '../test-utils/index.ts'
import type { ComputerBackup } from '../types/backup.ts'
import { accountId, computerId, partnerToken } from '../types/ids.ts'
import { type PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'
import { BackupClient } from './client.ts'

function apiEndpointName(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

function partnerAuthorizeResponse(
  token: string,
  options: { readonly includeBackupApi?: boolean } = {},
): PartnerAuthorizeResponse {
  const includeBackupApi = options.includeBackupApi ?? true
  return {
    accountId: accountId('partner-account'),
    authorizationToken: partnerToken(token),
    apiInfo: {
      groupsApi: {
        groupsApiUrl: 'https://groups.backblazeb2.com/partner',
        capabilities: [PartnerCapability.All],
        infoType: 'groupsApi',
      },
      ...(includeBackupApi
        ? {
            backupApi: {
              backupApiUrl: 'https://backup.backblazeb2.com/backup',
              capabilities: [PartnerCapability.All],
              infoType: 'backupApi' as const,
            },
          }
        : {}),
    },
    groupsApiUrl: 'https://groups.backblazeb2.com/partner',
    ...(includeBackupApi ? { backupApiUrl: 'https://backup.backblazeb2.com/backup' } : {}),
    groupsCapabilities: [PartnerCapability.All],
    ...(includeBackupApi ? { backupCapabilities: [PartnerCapability.All] } : {}),
    applicationKeyExpirationTimestamp: null,
  }
}

function makeCachedBackupClient(body: unknown): BackupClient {
  const partnerAccountInfo = new InMemoryPartnerAccountInfo()
  partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token'))
  return new BackupClient({
    masterKeyId: 'master-key-id',
    masterKey: 'master-key',
    partnerAccountInfo,
    transport: {
      async send(request) {
        if (apiEndpointName(request) !== 'bz_list_computers') {
          throw new Error(`unexpected endpoint: ${apiEndpointName(request)}`)
        }
        return jsonResponse(body)
      },
    },
  })
}

function inMemoryJsonResponse<T>(data: T): HttpResponse {
  return {
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: null,
    json: <U>() => Promise.resolve(data as unknown as U),
    text: () => Promise.resolve(''),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  }
}

describe('BackupClient facade', () => {
  it('reauthorizes and retries listComputers on an expired Partner token', async () => {
    let authorizeCount = 0
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
        }
        if (endpoint === 'bz_list_computers') {
          listAuthorizations.push(request.headers?.['Authorization'] ?? '')
          if (listAuthorizations.length === 1) {
            return jsonErrorResponse(401, 'expired_auth_token', 'simulated expiry')
          }
          return jsonResponse({ nextComputerId: null, computers: [] })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    await client.listComputers()

    expect(authorizeCount).toBe(2)
    expect(listAuthorizations).toEqual(['partner-token-1', 'partner-token-2'])
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-2')
  })

  it('keeps cached auth when expired-token backup reauthorization fails', async () => {
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
        if (endpoint === 'bz_list_computers') {
          return jsonErrorResponse(401, 'expired_auth_token', 'expired')
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    await expect(client.listComputers()).rejects.toThrow(ServiceUnavailableError)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')

    await expect(client.listComputers()).rejects.toThrow(ServiceUnavailableError)
    expect(authorizeCount).toBe(3)
    expect(client.partnerAccountInfo.getPartnerToken()).toBe('partner-token-1')
  })

  it('coalesces concurrent expired-token backup reauthorization', async () => {
    let authorizeCount = 0
    let expiredListCount = 0
    const reauthStarted = deferred<void>()
    const releaseReauth = deferred<void>()
    const allExpiredLists = deferred<void>()
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 2) {
            reauthStarted.resolve()
            await releaseReauth.promise
          }
          return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
        }
        if (endpoint === 'bz_list_computers') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            expiredListCount += 1
            if (expiredListCount === 3) allExpiredLists.resolve()
            return jsonErrorResponse(401, 'expired_auth_token', 'simulated expiry')
          }
          return jsonResponse({ nextComputerId: null, computers: [] })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })

    await client.authorize()
    const lists = [client.listComputers(), client.listComputers(), client.listComputers()]
    await allExpiredLists.promise
    await reauthStarted.promise
    releaseReauth.resolve()

    await expect(Promise.all(lists)).resolves.toEqual([
      { nextComputerId: null, computers: [] },
      { nextComputerId: null, computers: [] },
      { nextComputerId: null, computers: [] },
    ])
    expect(authorizeCount).toBe(2)
    expect(listAuthorizations.filter((token) => token === 'partner-token-1')).toHaveLength(3)
    expect(listAuthorizations.filter((token) => token === 'partner-token-2')).toHaveLength(3)
  })

  it('does not cancel shared backup reauthorization when one waiter aborts', async () => {
    let authorizeCount = 0
    let expiredListCount = 0
    const reauthStarted = deferred<void>()
    const releaseReauth = deferred<void>()
    const allExpiredLists = deferred<void>()
    const listAuthorizations: string[] = []
    const transport: HttpTransport = {
      async send(request) {
        const endpoint = apiEndpointName(request)
        if (endpoint === 'b2_authorize_account') {
          authorizeCount += 1
          if (authorizeCount === 2) {
            reauthStarted.resolve()
            await releaseReauth.promise
          }
          return jsonResponse(partnerAuthorizeResponse(`partner-token-${authorizeCount}`))
        }
        if (endpoint === 'bz_list_computers') {
          const authorization = request.headers?.['Authorization'] ?? ''
          listAuthorizations.push(authorization)
          if (authorization === 'partner-token-1') {
            expiredListCount += 1
            if (expiredListCount === 2) allExpiredLists.resolve()
            return jsonErrorResponse(401, 'expired_auth_token', 'simulated expiry')
          }
          return jsonResponse({ nextComputerId: null, computers: [] })
        }
        throw new Error(`unexpected endpoint: ${endpoint}`)
      },
    }
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    })
    const controller = new AbortController()
    const abortReason = new DOMException('stop waiting', 'AbortError')

    await client.authorize()
    const abortedList = client.listComputers({ signal: controller.signal })
    const survivingList = client.listComputers()
    await allExpiredLists.promise
    await reauthStarted.promise
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(abortReason)
    releaseReauth.resolve()

    await expect(abortedList).rejects.toBe(abortReason)
    await expect(survivingList).resolves.toEqual({ nextComputerId: null, computers: [] })
    expect(authorizeCount).toBe(2)
    expect(listAuthorizations.filter((token) => token === 'partner-token-2')).toHaveLength(1)
  })

  it.each([
    ['array body', [{ nextComputerId: null, computers: [] }]],
    ['null body', null],
    ['missing computers', { nextComputerId: null }],
    ['non-array computers', { nextComputerId: null, computers: {} }],
    ['non-string cursor', { nextComputerId: 5, computers: [] }],
  ])('rejects malformed bz_list_computers response shape: %s', async (_name, body) => {
    const client = makeCachedBackupClient(body)

    await expect(client.listComputers()).rejects.toThrow(BadJsonError)
  })

  it('paginates computer lists across requests without losing the cursor', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token'))
    const computerA: ComputerBackup = {
      computerId: computerId('computer-1'),
      computerName: 'alpha',
      lastFileUploadedTimestamp: 100,
    }
    const computerB: ComputerBackup = {
      computerId: computerId('computer-2'),
      computerName: 'bravo',
      lastFileUploadedTimestamp: 200,
    }
    const computerC: ComputerBackup = {
      computerId: computerId('computer-3'),
      computerName: 'charlie',
      lastFileUploadedTimestamp: 300,
    }
    const seenRequests: HttpRequest[] = []
    let listCount = 0
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          seenRequests.push(request)
          if (apiEndpointName(request) !== 'bz_list_computers') {
            throw new Error(`unexpected endpoint: ${apiEndpointName(request)}`)
          }
          listCount += 1
          if (listCount === 1) {
            return jsonResponse({
              nextComputerId: computerC.computerId,
              computers: [computerA, computerB],
            })
          }
          return jsonResponse({ nextComputerId: null, computers: [computerC] })
        },
      },
    })

    const computers: ComputerBackup[] = []
    for await (const computer of client.paginateComputers()) {
      computers.push(computer)
    }

    expect(computers.map((computer) => computer.computerName)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ])
    expect(listCount).toBe(2)
    expect(new URL(seenRequests[1]?.url ?? '').searchParams.get('startComputerId')).toBe(
      computerC.computerId,
    )
  })

  it('returns very large computer list results intact', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token'))
    const computer: ComputerBackup = {
      computerId: computerId('computer-1'),
      computerName: 'large-fleet-computer',
      lastFileUploadedTimestamp: 100,
    }
    const computers = Array.from({ length: 200_001 }, () => computer)
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport: {
        async send(request) {
          if (apiEndpointName(request) !== 'bz_list_computers') {
            throw new Error(`unexpected endpoint: ${apiEndpointName(request)}`)
          }
          return inMemoryJsonResponse({ nextComputerId: null, computers })
        },
      },
    })

    const page = await client.listComputers()

    expect(page.computers).toHaveLength(computers.length)
    expect(page.computers[0]).toBe(computer)
    expect(page.computers.at(-1)).toBe(computer)
  })

  it('rejects calls before authorization', async () => {
    const { transport, seenRequests } = recordingTransport()
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
    })

    await expect(client.listComputers()).rejects.toThrow(B2PartnerAuthorizationError)
    expect(seenRequests).toHaveLength(0)
  })

  it('rejects calls when Partner authorization has no backup API suite', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(
      partnerAuthorizeResponse('partner-token', { includeBackupApi: false }),
    )
    const { transport, seenRequests } = recordingTransport()
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      partnerAccountInfo,
    })

    await expect(client.listComputers()).rejects.toThrow('Computer Backup API is not available')
    expect(seenRequests).toHaveLength(0)
  })

  it('ignores unsafe cached Partner authorization without clearing shared state', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    const auth = partnerAuthorizeResponse('partner-token')
    partnerAccountInfo.setAuth({
      ...auth,
      apiInfo: {
        ...auth.apiInfo,
        backupApi: {
          backupApiUrl: 'https://attacker.example/backup',
          capabilities: [PartnerCapability.All],
          infoType: 'backupApi',
        },
      },
      backupApiUrl: 'https://attacker.example/backup',
    })
    const { transport, seenRequests } = recordingTransport()

    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      transport,
    })

    expect(partnerAccountInfo.getPartnerToken()).toBe('partner-token')
    await expect(client.listComputers()).rejects.toThrow(B2PartnerAuthorizationError)
    expect(seenRequests).toHaveLength(0)
  })

  it('can explicitly disable the default URL guard for controlled tests', () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('partner-token'))

    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
      disableSsrfGuard: true,
    })

    expect(client.urlGuard?.getAllowedSuffixes()).toEqual([])
  })
})
