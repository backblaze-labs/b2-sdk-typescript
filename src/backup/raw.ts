import type { BackupNonIdempotentMutationEndpoint } from '../http/non-idempotent-mutations.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import {
  endpointAllowedSuffixes,
  nonRetryingMutationRequestOptions,
  type QueryParams,
  validatePartnerEndpointUrl,
  withQueryString,
} from '../partner/endpoint-url.ts'
import { type B2EndpointUrlOptions, b2Url } from '../raw/url.ts'
import type {
  DeleteComputerRequest,
  DeleteComputerResponse,
  DeleteComputerResult,
  ListComputersRequest,
  ListComputersResponse,
} from '../types/backup.ts'

const BACKUP_API: B2EndpointUrlOptions = { prefix: 'api/backup', version: 'v1' }

/**
 * Normalizes the `bz_delete_computer` wire response to the array-shaped schema.
 *
 * The Backblaze apidocs response *schema* declares a JSON array, but the
 * accompanying *example* shows a single bare object. This tolerates both: an
 * array passes through unchanged, and a lone object is wrapped in a
 * single-element array, so callers always receive a {@link DeleteComputerResponse}
 * regardless of which shape live B2 returns.
 *
 * @param raw - The parsed `bz_delete_computer` JSON body.
 *
 * @returns The response as the canonical array shape.
 *
 * @throws TypeError When the body is neither an array nor an object.
 */
function normalizeDeleteComputerResponse(raw: unknown): DeleteComputerResponse {
  if (Array.isArray(raw)) return raw as DeleteComputerResponse
  if (raw !== null && typeof raw === 'object') return [raw as DeleteComputerResult]
  throw new TypeError('bz_delete_computer returned an unexpected response body shape')
}

/** Configuration for constructing a {@link BackupRawClient}. */
export interface BackupRawClientOptions {
  /**
   * The HTTP transport used to send requests.
   *
   * Computer Backup endpoint calls validate URLs against suffixes recorded by
   * Partner authorization. A rehydrated client that skips authorization must
   * use `authorizedBackupEndpointSuffixes` or a transport with a locked
   * `urlGuard`. Because Partner authorize responses redact
   * `authorizationToken` under `JSON.stringify`, durable caches should persist
   * `partnerAuthorizeResponseForPersistence(auth)` only to encrypted or
   * otherwise credential-grade storage, or use another secure token-preserving
   * representation.
   */
  readonly transport: HttpTransport
  /**
   * Validated Computer Backup endpoint host suffixes restored from cached
   * Partner authorization. Facades normally manage this after authorization;
   * direct raw clients can pass trusted suffixes derived from
   * `derivePartnerAllowedSuffixes()`. Do not derive this cache with
   * `JSON.stringify(authorizePartner())`, which intentionally stores a redacted
   * token placeholder instead of a usable Partner token. Rehydrating that
   * placeholder fails fast.
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

function backupEndpointAllowedSuffixes(
  transport: HttpTransport,
  authorizedSuffixes: readonly string[],
): readonly string[] {
  return endpointAllowedSuffixes(transport, authorizedSuffixes, {
    missingGuard:
      'Computer Backup endpoint requests require BackupClient.authorize() or a locked URL guard before sending Partner tokens',
    unlockedGuard:
      'Computer Backup endpoint requests require a locked URL guard before sending Partner tokens',
  })
}

function backupEndpointUrl(backupApiUrl: string, endpoint: string): string {
  return b2Url(backupApiUrl, { ...BACKUP_API, endpoint })
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
  private authorizedEndpointSuffixes: readonly string[]

  /**
   * Creates a new BackupRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: BackupRawClientOptions) {
    this.transport = options.transport
    this.authorizedEndpointSuffixes = Array.from(options.authorizedBackupEndpointSuffixes ?? [])
  }

  /**
   * Replaces the validated Computer Backup endpoint host suffixes.
   *
   * @param suffixes - Host suffixes derived from Partner authorization.
   *
   * @internal
   */
  setAuthorizedEndpointSuffixes(suffixes: readonly string[]): void {
    this.authorizedEndpointSuffixes = Array.from(suffixes)
  }

  /**
   * Calls `bz_list_computers`.
   *
   * Uses the documented GET form. The wire response is a single JSON object
   * with a `nextComputerId` cursor and active computer backup records.
   *
   * @param backupApiUrl - The Computer Backup API base URL from `authorizePartner`.
   * @param authToken - The Partner authorization token.
   * @param request - The computer listing query parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The single-object computer backup wire response.
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
   * The documented wire response is a JSON array of deletion records. This
   * destructive mutation is not automatically retried or reauthorized in place.
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
    const response = await this.postNonRetryingMutationJson<unknown>(
      backupApiUrl,
      authToken,
      'bz_delete_computer',
      {
        accountId: request.accountId,
        computerId: request.computerId,
      },
      options,
    )
    return normalizeDeleteComputerResponse(response)
  }

  private safeBackupApiUrl(backupApiUrl: string): string {
    return validatePartnerEndpointUrl(
      backupApiUrl,
      'backupApiUrl',
      backupEndpointAllowedSuffixes(this.transport, this.authorizedEndpointSuffixes),
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
      url: withQueryString(backupEndpointUrl(this.safeBackupApiUrl(backupApiUrl), endpoint), query),
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
   * Sends a non-retrying JSON mutation POST request to the specified Computer Backup API endpoint.
   *
   * @param backupApiUrl - The Computer Backup API base URL.
   * @param authToken - The Partner authorization token.
   * @param endpoint - The Computer Backup API endpoint name.
   * @param body - The JSON request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async postNonRetryingMutationJson<T>(
    backupApiUrl: string,
    authToken: string,
    endpoint: BackupNonIdempotentMutationEndpoint,
    body: unknown,
    options?: BackupRawRequestOptions,
  ): Promise<T> {
    const requestOptions = nonRetryingMutationRequestOptions(options)
    const response = await this.transport.send({
      url: backupEndpointUrl(this.safeBackupApiUrl(backupApiUrl), endpoint),
      method: 'POST',
      headers: {
        Authorization: authToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(requestOptions.signal !== undefined ? { signal: requestOptions.signal } : {}),
      ...(requestOptions.idempotent !== undefined ? { idempotent: requestOptions.idempotent } : {}),
      ...(requestOptions.retry !== undefined ? { retry: requestOptions.retry } : {}),
    })
    return response.json<T>()
  }
}
