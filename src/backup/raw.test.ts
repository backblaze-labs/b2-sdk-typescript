import { describe, expect, it, vi } from 'vitest'
import {
  AccessDeniedError,
  B2PartnerAuthorizationError,
  ExpiredAuthTokenError,
  InvalidAccountIdError,
  InvalidComputerIdError,
  OutOfRangeError,
} from '../errors/index.ts'
import {
  FetchTransport,
  type HttpRequest,
  type HttpTransport,
  RetryTransport,
  type UrlGuardedTransport,
} from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { derivePartnerAllowedSuffixes, PartnerRawClient } from '../partner/raw.ts'
import { B2Simulator } from '../simulator/index.ts'
import { jsonErrorResponse, jsonResponse, recordingTransport } from '../test-utils/index.ts'
import { accountId, computerId, partnerToken } from '../types/ids.ts'
import { BackupRawClient } from './raw.ts'

const noSleep = (_ms: number, _signal?: AbortSignal): Promise<void> => Promise.resolve()

function okTransport(body: unknown = { nextComputerId: null, computers: [] }): {
  readonly transport: HttpTransport
  readonly seenRequests: HttpRequest[]
} {
  const seenRequests: HttpRequest[] = []
  return {
    transport: {
      async send(request) {
        seenRequests.push(request)
        return jsonResponse(body)
      },
    },
    seenRequests,
  }
}

function requestJsonBody(request: HttpRequest): unknown {
  if (typeof request.body !== 'string') throw new Error('expected JSON request body')
  return JSON.parse(request.body) as unknown
}

function authorizedRawClient(
  transport: HttpTransport,
  suffixes: readonly string[] = ['backblazeb2.com', 'backblaze.com'],
): BackupRawClient {
  return new BackupRawClient({ transport, authorizedBackupEndpointSuffixes: suffixes })
}

function makeRecordingSimulatorTransport(sim: B2Simulator): {
  readonly transport: HttpTransport
  readonly seenRequests: HttpRequest[]
} {
  const seenRequests: HttpRequest[] = []
  const inner = sim.transport()
  return {
    seenRequests,
    transport: {
      async send(request) {
        seenRequests.push(request)
        return inner.send(request)
      },
    },
  }
}

async function makeSimulatorBackupRawClient(): Promise<{
  readonly raw: BackupRawClient
  readonly seenRequests: HttpRequest[]
  readonly backupApiUrl: string
  readonly authToken: string
  readonly accountId: ReturnType<typeof accountId>
}> {
  const sim = new B2Simulator({ partnerAuthorize: true })
  const { seenRequests, transport } = makeRecordingSimulatorTransport(sim)
  const retryTransport = new RetryTransport({
    transport,
    retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
    sleepImpl: noSleep,
  })
  const partnerRaw = new PartnerRawClient({ transport: retryTransport })
  const auth = await partnerRaw.authorizePartner('master-key-id', 'master-key')
  if (auth.backupApiUrl === undefined) throw new Error('expected simulator Backup API URL')
  const raw = new BackupRawClient({
    transport: retryTransport,
    authorizedBackupEndpointSuffixes: derivePartnerAllowedSuffixes(
      auth,
      'https://api.backblazeb2.com',
    ),
  })
  return {
    raw,
    seenRequests,
    backupApiUrl: auth.backupApiUrl,
    authToken: auth.authorizationToken,
    accountId: auth.accountId,
  }
}

describe('BackupRawClient', () => {
  it('builds bz_list_computers GET requests under the backup API path', async () => {
    const controller = new AbortController()
    const { transport, seenRequests } = okTransport({
      nextComputerId: computerId('computer-2'),
      computers: [
        {
          computerId: computerId('computer-1'),
          computerName: 'laptop',
          lastFileUploadedTimestamp: 123,
        },
      ],
    })
    const raw = authorizedRawClient(transport)

    const response = await raw.listComputers(
      'https://backup.backblazeb2.com/backup',
      partnerToken('partner-token'),
      {
        accountId: accountId('account-1'),
        startComputerId: computerId('computer-1'),
        maxComputerCount: 2,
      },
      { signal: controller.signal, retry: { maxRetries: 3 } },
    )

    expect(response.nextComputerId).toBe('computer-2')
    expect(response.computers).toHaveLength(1)
    expect(seenRequests).toHaveLength(1)
    const request = seenRequests[0]
    expect(request?.method).toBe('GET')
    expect(request?.headers?.['Authorization']).toBe('partner-token')
    expect(request?.signal).toBe(controller.signal)
    expect(request?.retry).toEqual({ maxRetries: 3 })
    const url = new URL(request?.url ?? '')
    expect(url.origin).toBe('https://backup.backblazeb2.com')
    expect(url.pathname).toBe('/backup/api/backup/v1/bz_list_computers')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      accountId: 'account-1',
      startComputerId: 'computer-1',
      maxComputerCount: '2',
    })
  })

  it('round-trips backup endpoints through B2Simulator with documented shapes and cursors', async () => {
    const {
      raw,
      seenRequests,
      backupApiUrl,
      authToken,
      accountId: adminAccountId,
    } = await makeSimulatorBackupRawClient()

    const firstPage = await raw.listComputers(backupApiUrl, authToken, {
      accountId: adminAccountId,
      maxComputerCount: 1,
    })
    expect(firstPage.computers).toHaveLength(1)
    expect(firstPage.nextComputerId).toEqual(expect.any(String))
    const firstComputer = firstPage.computers[0]
    const nextComputerId = firstPage.nextComputerId
    if (firstComputer === undefined || nextComputerId === null) {
      throw new Error('expected simulator computer page with a next cursor')
    }

    const secondPage = await raw.listComputers(backupApiUrl, authToken, {
      accountId: adminAccountId,
      startComputerId: nextComputerId,
      maxComputerCount: 1,
    })
    expect(secondPage.computers[0]?.computerId).toBe(nextComputerId)

    const deleted = await raw.deleteComputer(backupApiUrl, authToken, {
      accountId: adminAccountId,
      computerId: firstComputer.computerId,
    })
    expect(Array.isArray(deleted)).toBe(true)
    expect(deleted).toEqual([firstComputer])
    expect(seenRequests.map((request) => new URL(request.url).pathname.split('/').at(-1))).toEqual([
      'b2_authorize_account',
      'bz_list_computers',
      'bz_list_computers',
      'bz_delete_computer',
    ])
  })

  it('maps simulator backup endpoint error codes to typed SDK errors', async () => {
    const {
      raw,
      backupApiUrl,
      authToken,
      accountId: adminAccountId,
    } = await makeSimulatorBackupRawClient()
    const page = await raw.listComputers(backupApiUrl, authToken, { accountId: adminAccountId })
    const computer = page.computers[0]
    if (computer === undefined) throw new Error('expected simulator computer')

    await expect(
      raw.listComputers(backupApiUrl, authToken, {
        accountId: adminAccountId,
        startComputerId: computerId('missing-computer'),
      }),
    ).rejects.toThrow(InvalidComputerIdError)
    await expect(
      raw.listComputers(backupApiUrl, authToken, {
        accountId: adminAccountId,
        maxComputerCount: 0,
      }),
    ).rejects.toThrow(OutOfRangeError)
    await expect(
      raw.listComputers(backupApiUrl, authToken, {
        accountId: accountId(''),
      }),
    ).rejects.toThrow(InvalidAccountIdError)
    await expect(
      raw.deleteComputer(backupApiUrl, authToken, {
        accountId: adminAccountId,
        computerId: computerId('missing-computer'),
      }),
    ).rejects.toThrow(InvalidComputerIdError)
    await expect(
      raw.listComputers(backupApiUrl, '', { accountId: adminAccountId }),
    ).rejects.toThrow(AccessDeniedError)
  })

  it('builds bz_delete_computer POST requests under the backup API path', async () => {
    const deleted = [
      {
        computerId: computerId('computer-1'),
        computerName: 'laptop',
        lastFileUploadedTimestamp: 123,
      },
    ]
    const { transport, seenRequests } = okTransport(deleted)
    const raw = authorizedRawClient(transport)

    const response = await raw.deleteComputer(
      'https://backup.backblazeb2.com/backup',
      partnerToken('partner-token'),
      {
        accountId: accountId('account-1'),
        computerId: computerId('computer-1'),
      },
    )

    expect(response).toEqual(deleted)
    const request = seenRequests[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(
      'https://backup.backblazeb2.com/backup/api/backup/v1/bz_delete_computer',
    )
    expect(request?.headers).toMatchObject({
      Authorization: 'partner-token',
      'Content-Type': 'application/json',
    })
    expect(request?.idempotent).toBe(false)
    expect(request?.retry).toEqual({ maxRetries: 0 })
    expect(request === undefined ? null : requestJsonBody(request)).toEqual({
      accountId: 'account-1',
      computerId: 'computer-1',
    })
  })

  it('keeps delete retries disabled when the caller passes maxRetries', async () => {
    const retry = { maxRetries: 4, requestTimeoutMs: 1000 }
    const { transport, seenRequests } = okTransport([])
    const raw = authorizedRawClient(transport)

    await raw.deleteComputer(
      'https://backup.backblazeb2.com/backup',
      partnerToken('partner-token'),
      {
        accountId: accountId('account-1'),
        computerId: computerId('computer-1'),
      },
      { retry },
    )

    expect(seenRequests[0]?.retry).toEqual({ maxRetries: 0, requestTimeoutMs: 1000 })
    expect(seenRequests[0]?.idempotent).toBe(false)
  })

  it('does not retry delete POSTs through RetryTransport by default', async () => {
    const responseFailureRequests: HttpRequest[] = []
    const responseFailureGuard = new UrlGuard()
    responseFailureGuard.setAllowedSuffixes(['backblazeb2.com'])
    const responseFailureTransport: UrlGuardedTransport = {
      urlGuard: responseFailureGuard,
      async send(request) {
        responseFailureRequests.push(request)
        return jsonErrorResponse(503, 'service_unavailable', 'try again')
      },
    }
    const responseFailureRaw = new BackupRawClient({
      transport: new RetryTransport({
        transport: responseFailureTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      responseFailureRaw.deleteComputer(
        'https://backup.backblazeb2.com/backup',
        partnerToken('partner-token'),
        {
          accountId: accountId('account-1'),
          computerId: computerId('computer-1'),
        },
      ),
    ).rejects.toThrow()
    expect(responseFailureRequests).toHaveLength(1)
    expect(responseFailureRequests[0]?.idempotent).toBe(false)

    const networkFailureRequests: HttpRequest[] = []
    const networkFailureGuard = new UrlGuard()
    networkFailureGuard.setAllowedSuffixes(['backblazeb2.com'])
    const networkFailureTransport: UrlGuardedTransport = {
      urlGuard: networkFailureGuard,
      async send(request) {
        networkFailureRequests.push(request)
        throw new TypeError('network down')
      },
    }
    const networkFailureRaw = new BackupRawClient({
      transport: new RetryTransport({
        transport: networkFailureTransport,
        retry: { maxRetries: 5, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    })

    await expect(
      networkFailureRaw.deleteComputer(
        'https://backup.backblazeb2.com/backup',
        partnerToken('partner-token'),
        {
          accountId: accountId('account-1'),
          computerId: computerId('computer-1'),
        },
      ),
    ).rejects.toThrow()
    expect(networkFailureRequests).toHaveLength(1)
    expect(networkFailureRequests[0]?.idempotent).toBe(false)
  })

  it('does not reauthorize and replay delete POSTs on expired auth token', async () => {
    const seenRequests: HttpRequest[] = []
    const urlGuard = new UrlGuard()
    urlGuard.setAllowedSuffixes(['backblazeb2.com'])
    const transport: UrlGuardedTransport = {
      urlGuard,
      async send(request) {
        seenRequests.push(request)
        return jsonErrorResponse(401, 'expired_auth_token', 'expired')
      },
    }
    const onReauth = vi.fn().mockResolvedValue('fresh-token')
    const raw = authorizedRawClient(
      new RetryTransport({
        transport,
        onReauth,
        retry: { maxRetries: 0, initialRetryDelayMs: 1, maxRetryDelayMs: 1 },
        sleepImpl: noSleep,
      }),
    )

    await expect(
      raw.deleteComputer('https://backup.backblazeb2.com/backup', partnerToken('partner-token'), {
        accountId: accountId('account-1'),
        computerId: computerId('computer-1'),
      }),
    ).rejects.toThrow(ExpiredAuthTokenError)

    expect(onReauth).not.toHaveBeenCalled()
    expect(seenRequests).toHaveLength(1)
    expect(seenRequests[0]?.idempotent).toBe(false)
  })

  it('accepts a locked transport URL guard when explicit suffixes are omitted', async () => {
    const guard = new UrlGuard()
    guard.setAllowedSuffixes(['backblazeb2.com', 'backblaze.com'])
    const { transport, seenRequests } = okTransport()
    const guardedTransport: HttpTransport & { readonly urlGuard: UrlGuard } = {
      ...transport,
      urlGuard: guard,
    }
    const raw = new BackupRawClient({ transport: guardedTransport })

    await raw.listComputers(
      'https://backup.backblazeb2.com/backup',
      partnerToken('partner-token'),
      { accountId: accountId('account-1') },
    )

    expect(seenRequests[0]?.url).toBe(
      'https://backup.backblazeb2.com/backup/api/backup/v1/bz_list_computers?accountId=account-1',
    )
  })

  it('accepts loopback HTTP backup URLs when the authorized suffix matches', async () => {
    const { transport, seenRequests } = okTransport()
    const raw = authorizedRawClient(transport, ['127.0.0.1'])

    await raw.listComputers('http://127.0.0.1:12345/backup', partnerToken('partner-token'), {
      accountId: accountId('account-1'),
    })

    expect(seenRequests[0]?.url).toBe(
      'http://127.0.0.1:12345/backup/api/backup/v1/bz_list_computers?accountId=account-1',
    )
  })

  it('fails closed before transport use when endpoint suffixes are unavailable', async () => {
    const { transport, seenRequests } = recordingTransport()
    const raw = new BackupRawClient({ transport })

    await expect(
      raw.listComputers('https://backup.backblazeb2.com/backup', partnerToken('partner-token'), {
        accountId: accountId('account-1'),
      }),
    ).rejects.toThrow(B2PartnerAuthorizationError)
    expect(seenRequests).toHaveLength(0)
  })

  it('requires a locked URL guard before using a guarded transport without suffixes', async () => {
    const raw = new BackupRawClient({
      transport: new FetchTransport({ urlGuard: new UrlGuard() }),
    })

    await expect(
      raw.listComputers('https://backup.backblazeb2.com/backup', partnerToken('partner-token'), {
        accountId: accountId('account-1'),
      }),
    ).rejects.toThrow('locked URL guard')
  })

  it.each([
    ['malformed', 'not a URL'],
    ['plaintext HTTP', 'http://backup.backblazeb2.com/backup'],
    ['userinfo', 'https://user:secret@backup.backblazeb2.com/backup'],
    ['query string', 'https://backup.backblazeb2.com/backup?token=secret'],
    ['fragment', 'https://backup.backblazeb2.com/backup#token'],
    ['off-realm host', 'https://attacker.example/backup'],
  ])('rejects unsafe backupApiUrl values: %s', async (_name, backupApiUrl) => {
    const { transport, seenRequests } = recordingTransport()
    const raw = authorizedRawClient(transport)

    await expect(
      raw.listComputers(backupApiUrl, partnerToken('partner-token'), {
        accountId: accountId('account-1'),
      }),
    ).rejects.toThrow(B2PartnerAuthorizationError)
    expect(seenRequests).toHaveLength(0)
  })
})
