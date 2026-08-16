import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import { getTransportUrlGuard, type HttpTransport } from '../http/transport.ts'
import { hostMatchesAllowedSuffix, UrlGuard } from '../http/url-guard.ts'
import { type B2EndpointUrlOptions, b2Url } from '../raw/url.ts'
import type {
  DeleteComputerRequest,
  DeleteComputerResponse,
  ListComputersRequest,
  ListComputersResponse,
} from '../types/backup.ts'

const BACKUP_API_V1: B2EndpointUrlOptions = { prefix: 'api/backup', version: 'v1' }

/** Configuration for constructing a {@link BackupRawClient}. */
export interface BackupRawClientOptions {
  /**
   * The HTTP transport used to send requests.
   *
   * Computer Backup endpoint calls validate URLs against suffixes recorded by
   * Partner authorization. A rehydrated client that skips authorization must
   * use a transport with a locked `urlGuard`.
   */
  readonly transport: HttpTransport
  /**
   * Computer Backup endpoint host suffixes that have already been validated
   * from a cached Partner authorize response.
   *
   * @internal
   */
  readonly authorizedBackupEndpointSuffixes?: readonly string[]
}

/** Optional controls for raw Computer Backup API requests. */
export interface BackupRawRequestOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
  /** Per-request retry override. */
  readonly retry?: Partial<RetryOptions>
}

type QueryValue = string | number
type QueryParams = Readonly<Record<string, QueryValue>>

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === '[::1]' || host === '::1') return true

  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  )
}

function hostAllowedBySuffixes(hostname: string, allowedSuffixes: readonly string[]): boolean {
  return allowedSuffixes.some((suffix) => hostMatchesAllowedSuffix(hostname, suffix))
}

function backupEndpointAllowedSuffixes(
  transport: HttpTransport,
  authorizedSuffixes: readonly string[],
): readonly string[] {
  if (authorizedSuffixes.length > 0) return authorizedSuffixes

  const guard = getTransportUrlGuard(transport)
  if (guard === undefined) {
    throw new B2PartnerAuthorizationError(
      'Computer Backup endpoint requests require BackupClient.authorize() or a locked URL guard before sending Partner tokens',
    )
  }

  const suffixes = guard.getAllowedSuffixes()
  if (suffixes.length === 0) {
    throw new B2PartnerAuthorizationError(
      'Computer Backup endpoint requests require a locked URL guard before sending Partner tokens',
    )
  }

  return suffixes
}

function validateBackupEndpointUrl(rawUrl: string, allowedSuffixes: readonly string[]): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response included malformed backupApiUrl',
    )
  }

  const host = url.hostname.toLowerCase()
  const isAllowedLoopbackHttp =
    url.protocol === 'http:' && isLoopbackHost(host) && hostAllowedBySuffixes(host, allowedSuffixes)

  if (url.protocol !== 'https:' && !isAllowedLoopbackHttp) {
    throw new B2PartnerAuthorizationError('Partner authorize response backupApiUrl must use HTTPS')
  }
  if (url.username !== '' || url.password !== '') {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response backupApiUrl must not include userinfo',
    )
  }
  if (url.search !== '' || url.hash !== '') {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response backupApiUrl must not include query or fragment',
    )
  }

  if (isAllowedLoopbackHttp) return rawUrl

  const guard = new UrlGuard()
  guard.setAllowedSuffixes(allowedSuffixes)
  try {
    guard.check(rawUrl)
  } catch (err) {
    throw new B2PartnerAuthorizationError(
      err instanceof Error
        ? `Partner authorize response included unsafe backupApiUrl: ${err.message}`
        : 'Partner authorize response included unsafe backupApiUrl',
    )
  }

  return rawUrl
}

function withQueryString(url: string, query: QueryParams): string {
  const queryString = Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
  return queryString.length === 0 ? url : `${url}?${queryString}`
}

/**
 * Low-level client for Computer Backup API endpoint bindings.
 *
 * Each method maps directly to one `bz_*` HTTP call under the
 * `/api/backup/v1/` route using the `backupApiUrl` returned by Partner
 * authorization.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export class BackupRawClient {
  /** @internal */
  private readonly transport: HttpTransport
  private backupEndpointSuffixes: readonly string[] = []

  /**
   * Creates a new BackupRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: BackupRawClientOptions) {
    this.transport = options.transport
    this.backupEndpointSuffixes = options.authorizedBackupEndpointSuffixes ?? []
  }

  /**
   * Replaces the validated Computer Backup endpoint host suffixes.
   *
   * @param suffixes - Host suffixes derived from Partner authorization.
   *
   * @internal
   */
  setAuthorizedBackupEndpointSuffixes(suffixes: readonly string[]): void {
    this.backupEndpointSuffixes = suffixes
  }

  /**
   * Calls `bz_list_computers`.
   *
   * Uses the documented GET form. The response is a single JSON object with a
   * `nextComputerId` cursor and active computer backup records.
   *
   * @param backupApiUrl - The Computer Backup API base URL from `authorizePartner`.
   * @param authToken - The Partner authorization token.
   * @param request - The computer listing query parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The computer backup page object.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  async listComputers(
    backupApiUrl: string,
    authToken: string,
    request: ListComputersRequest,
    options?: BackupRawRequestOptions,
  ): Promise<ListComputersResponse> {
    return this.getJson<ListComputersResponse>(
      backupApiUrl,
      authToken,
      'bz_list_computers',
      {
        accountId: request.accountId,
        ...(request.startComputerId !== undefined
          ? { startComputerId: request.startComputerId }
          : {}),
        ...(request.maxComputerCount !== undefined
          ? { maxComputerCount: request.maxComputerCount }
          : {}),
      },
      options,
    )
  }

  /**
   * Calls `bz_delete_computer`.
   *
   * The documented wire response is a JSON array of deletion records.
   *
   * @param backupApiUrl - The Computer Backup API base URL from `authorizePartner`.
   * @param authToken - The Partner authorization token.
   * @param request - The computer deletion request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The deleted computer backup record array.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  async deleteComputer(
    backupApiUrl: string,
    authToken: string,
    request: DeleteComputerRequest,
    options?: BackupRawRequestOptions,
  ): Promise<DeleteComputerResponse> {
    return this.postJson<DeleteComputerResponse>(
      backupApiUrl,
      authToken,
      'bz_delete_computer',
      {
        accountId: request.accountId,
        computerId: request.computerId,
      },
      options,
    )
  }

  private safeBackupApiUrl(backupApiUrl: string): string {
    return validateBackupEndpointUrl(
      backupApiUrl,
      backupEndpointAllowedSuffixes(this.transport, this.backupEndpointSuffixes),
    )
  }

  /**
   * Sends a JSON GET request to the specified Computer Backup API endpoint.
   *
   * @param backupApiUrl - The Computer Backup API base URL.
   * @param authToken - The Partner authorization token.
   * @param endpoint - The Computer Backup API endpoint name.
   * @param query - The query-string parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async getJson<T>(
    backupApiUrl: string,
    authToken: string,
    endpoint: string,
    query: QueryParams,
    options?: BackupRawRequestOptions,
  ): Promise<T> {
    const response = await this.transport.send({
      url: withQueryString(
        b2Url(this.safeBackupApiUrl(backupApiUrl), { ...BACKUP_API_V1, endpoint }),
        query,
      ),
      method: 'GET',
      headers: {
        Authorization: authToken,
      },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    })
    return response.json<T>()
  }

  /**
   * Sends a JSON POST request to the specified Computer Backup API endpoint.
   *
   * @param backupApiUrl - The Computer Backup API base URL.
   * @param authToken - The Partner authorization token.
   * @param endpoint - The Computer Backup API endpoint name.
   * @param body - The JSON request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async postJson<T>(
    backupApiUrl: string,
    authToken: string,
    endpoint: string,
    body: unknown,
    options?: BackupRawRequestOptions,
  ): Promise<T> {
    const response = await this.transport.send({
      url: b2Url(this.safeBackupApiUrl(backupApiUrl), { ...BACKUP_API_V1, endpoint }),
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.retry !== undefined ? { retry: options.retry } : {}),
    })
    return response.json<T>()
  }
}
