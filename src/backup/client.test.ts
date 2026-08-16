import { describe, expect, it } from 'vitest'
import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { HttpRequest, HttpTransport } from '../http/transport.ts'
import { InMemoryPartnerAccountInfo } from '../partner/in-memory.ts'
import { B2Simulator } from '../simulator/index.ts'
import { jsonErrorResponse, jsonResponse, recordingTransport } from '../test-utils/index.ts'
import type { ComputerBackup } from '../types/backup.ts'
import { accountId, partnerToken } from '../types/ids.ts'
import { type PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'
import { BackupClient, type BackupClientOptions } from './client.ts'

function apiEndpointName(request: HttpRequest): string {
  return new URL(request.url).pathname.split('/').at(-1) ?? ''
}

function makeBackupClient(options?: {
  readonly client?: Partial<Omit<BackupClientOptions, 'masterKeyId' | 'masterKey' | 'transport'>>
}): {
  readonly client: BackupClient
  readonly seenRequests: HttpRequest[]
} {
  const sim = new B2Simulator({ partnerAuthorize: true })
  const inner = sim.transport()
  const seenRequests: HttpRequest[] = []
  const transport: HttpTransport = {
    async send(request) {
      seenRequests.push(request)
      return inner.send(request)
    },
  }
  return {
    client: new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      ...(options?.client ?? {}),
    }),
    seenRequests,
  }
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

describe('BackupClient facade', () => {
  it('authorizes, lists, paginates, and deletes simulator backup computers', async () => {
    const { client, seenRequests } = makeBackupClient()

    const auth = await client.authorize()
    const firstPage = await client.listComputers({ pageSize: 1 })
    const computers: ComputerBackup[] = []
    for await (const computer of client.paginateComputers({ pageSize: 1 })) {
      computers.push(computer)
    }
    const computersWithoutOptions: ComputerBackup[] = []
    for await (const computer of client.paginateComputers()) {
      computersWithoutOptions.push(computer)
    }
    const firstComputer = computers[0]
    if (firstComputer === undefined) throw new Error('expected at least one backup computer')
    const deleted = await client.deleteComputer({ computerId: firstComputer.computerId })
    const afterDelete = await client.listComputers()

    expect(auth.backupApiUrl).toBeDefined()
    expect(firstPage.computers).toHaveLength(1)
    expect(firstPage.nextComputerId).not.toBeNull()
    expect(computers.map((computer) => computer.computerName)).toEqual([
      'sim-computer-1',
      'sim-computer-2',
      'sim-computer-3',
    ])
    expect(computersWithoutOptions).toHaveLength(3)
    expect(deleted[0]?.computerId).toBe(firstComputer.computerId)
    expect(afterDelete.computers.map((computer) => computer.computerId)).not.toContain(
      firstComputer.computerId,
    )
    expect(seenRequests.map(apiEndpointName)).toContain('b2_authorize_account')
    expect(seenRequests.map(apiEndpointName)).toContain('bz_list_computers')
    expect(seenRequests.map(apiEndpointName)).toContain('bz_delete_computer')
  })

  it('uses cached Partner authorization state without a fresh authorize call', async () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth(partnerAuthorizeResponse('cached-partner-token'))
    const sim = new B2Simulator()
    const inner = sim.transport()
    const seenRequests: HttpRequest[] = []
    const transport: HttpTransport = {
      async send(request) {
        seenRequests.push(request)
        return inner.send(request)
      },
    }
    const client = new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      transport,
      retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
      partnerAccountInfo,
    })

    await client.listComputers({ pageSize: 2 })

    expect(seenRequests.map(apiEndpointName)).toEqual(['bz_list_computers'])
    expect(seenRequests[0]?.headers?.['Authorization']).toBe('cached-partner-token')
  })

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

  it('clears unsafe cached Partner authorization during construction', () => {
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

    new BackupClient({
      masterKeyId: 'master-key-id',
      masterKey: 'master-key',
      partnerAccountInfo,
    })

    expect(partnerAccountInfo.getAuth()).toBeNull()
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

  it('redacts Master Application Key credentials and Partner tokens in diagnostics', async () => {
    const { client } = makeBackupClient()

    expect(JSON.stringify(client)).toContain('[unauthorized]')
    expect(client.toString()).toBe('[BackupClient [redacted Master Application Key]]')

    await client.authorize()

    expect(JSON.stringify(client)).not.toContain('master-key')
    expect(JSON.stringify(client)).not.toContain(client.partnerAccountInfo.getPartnerToken())
    expect(JSON.stringify(client)).toContain('[redacted Partner token]')
    const inspectSymbol = Symbol.for('nodejs.util.inspect.custom')
    expect((client as unknown as Record<symbol, () => string>)[inspectSymbol]?.()).toBe(
      client.toString(),
    )
  })
})
