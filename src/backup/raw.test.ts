import { describe, expect, it } from 'vitest'
import { B2PartnerAuthorizationError } from '../errors/index.ts'
import { FetchTransport, type HttpRequest, type HttpTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { jsonResponse, recordingTransport } from '../test-utils/index.ts'
import { accountId, computerId, partnerToken } from '../types/ids.ts'
import { BackupRawClient } from './raw.ts'

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
    const raw = new BackupRawClient({
      transport,
      authorizedBackupEndpointSuffixes: ['backblazeb2.com', 'backblaze.com'],
    })

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

  it('builds bz_delete_computer POST requests under the backup API path', async () => {
    const deleted = [
      {
        computerId: computerId('computer-1'),
        computerName: 'laptop',
        lastFileUploadedTimestamp: 123,
      },
    ]
    const { transport, seenRequests } = okTransport(deleted)
    const raw = new BackupRawClient({
      transport,
      authorizedBackupEndpointSuffixes: ['backblazeb2.com', 'backblaze.com'],
    })

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
    expect(request === undefined ? null : requestJsonBody(request)).toEqual({
      accountId: 'account-1',
      computerId: 'computer-1',
    })
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
    const raw = new BackupRawClient({
      transport,
      authorizedBackupEndpointSuffixes: ['127.0.0.1'],
    })

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
    const raw = new BackupRawClient({
      transport,
      authorizedBackupEndpointSuffixes: ['backblazeb2.com', 'backblaze.com'],
    })

    await expect(
      raw.listComputers(backupApiUrl, partnerToken('partner-token'), {
        accountId: accountId('account-1'),
      }),
    ).rejects.toThrow(B2PartnerAuthorizationError)
    expect(seenRequests).toHaveLength(0)
  })
})
