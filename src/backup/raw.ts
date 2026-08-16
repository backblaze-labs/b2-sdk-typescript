import type { RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import {
  endpointAllowedSuffixes,
  validatePartnerEndpointUrl,
  withQueryString,
} from '../partner/endpoint-url.ts'
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

function mutationRequestOptions(
  options: BackupRawRequestOptions | undefined,
): BackupRawRequestOptions {
  return {
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    // Backup deletes are destructive and not proven idempotent. Keep automatic
    // replay disabled even when callers pass retry options intended for GETs.
    retry: { ...(options?.retry ?? {}), maxRetries: 0 },
  }
}

const backupEndpointSuffixesByClient = new WeakMap<BackupRawClient, readonly string[]>()

function authorizedBackupEndpointSuffixes(client: BackupRawClient): readonly string[] {
  return backupEndpointSuffixesByClient.get(client) ?? []
}

/**
 * Replaces the validated Computer Backup endpoint host suffixes.
 *
 * @param client - Raw client whose endpoint suffixes should be updated.
 * @param suffixes - Host suffixes derived from Partner authorization.
 *
 * @internal
 */
export function setAuthorizedBackupEndpointSuffixes(
  client: BackupRawClient,
  suffixes: readonly string[],
): void {
  backupEndpointSuffixesByClient.set(client, suffixes)
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

  /**
   * Creates a new BackupRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: BackupRawClientOptions) {
    this.transport = options.transport
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
    return this.postJson<DeleteComputerResponse>(
      backupApiUrl,
      authToken,
      'bz_delete_computer',
      {
        accountId: request.accountId,
        computerId: request.computerId,
      },
      mutationRequestOptions(options),
    )
  }

  private safeBackupApiUrl(backupApiUrl: string): string {
    return validatePartnerEndpointUrl(
      backupApiUrl,
      'backupApiUrl',
      backupEndpointAllowedSuffixes(this.transport, authorizedBackupEndpointSuffixes(this)),
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
