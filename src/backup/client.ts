import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import type { UrlGuard } from '../http/url-guard.ts'
import type { PartnerAccountInfo } from '../partner/account-info.ts'
import { PartnerAuthCore } from '../partner/auth-core.ts'
import {
  derivePartnerAllowedSuffixes,
  validatePartnerAuthorizeResponseEndpoints,
} from '../partner/raw.ts'
import { PARTNER_TOKEN_REDACTED } from '../partner/redaction.ts'
import type {
  ComputerBackup,
  DeleteComputerResponse,
  ListComputersResponse,
} from '../types/backup.ts'
import type { AccountId, ComputerId, PartnerToken } from '../types/ids.ts'
import type { PartnerAuthorizeResponse } from '../types/partner.ts'
import { paginateItems } from '../util/paginator.ts'
import { BackupRawClient, setAuthorizedBackupEndpointSuffixes } from './raw.ts'

const MASTER_KEY_REDACTED = '[redacted Master Application Key]'

/**
 * Configuration options for creating a {@link BackupClient}.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface BackupClientOptions {
  /** The Master Application Key ID for the partner administrator account. */
  readonly masterKeyId: string
  /** The Master Application Key secret. */
  readonly masterKey: string
  /**
   * B2 realm to authenticate against. Accepts a known realm-map key
   * (`"production"` or `"staging"`) or a direct base URL. Custom HTTPS hosts
   * and loopback IP literal HTTP URLs for local testing are trusted with the
   * Master Application Key during Partner authorize, so never derive `realm`
   * from untrusted input. Defaults to `"production"`.
   */
  readonly realm?: string
  /**
   * Shared Partner authorization state. Defaults to
   * {@link InMemoryPartnerAccountInfo}. Pass the same store to
   * {@link BackupClient} and Partner clients when both surfaces should reuse
   * one Partner token. Cached authorization whose endpoints fail this client's
   * realm policy is ignored locally until `authorize()` replaces it; shared
   * stores are not cleared during construction.
   */
  readonly partnerAccountInfo?: PartnerAccountInfo
  /** Custom HTTP transport. Defaults to `FetchTransport`. Wrapped by `RetryTransport`. */
  readonly transport?: HttpTransport
  /** Override retry behavior (max retries, backoff, and per-attempt timeout). */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
  /**
   * Additional SSRF allow-list host suffixes for the default transport.
   *
   * Only consulted when {@link BackupClientOptions.transport} is unset; a
   * custom transport is the user's responsibility to harden.
   */
  readonly additionalAllowedHostSuffixes?: readonly string[]
  /**
   * Explicitly disable the default SSRF guard after authorize.
   *
   * Intended only for controlled simulator/private-proxy tests. Never enable
   * it for URLs derived from untrusted input or production credentials.
   */
  readonly disableSsrfGuard?: boolean
  /**
   * Follow same-origin GET/HEAD redirects in the default fetch transport after
   * checking each target with the SSRF guard. POST redirects remain blocked.
   * Defaults to true.
   */
  readonly followSameOriginRedirects?: boolean
  /**
   * Allow direct custom authorize realms for tests or private proxies.
   * Leave disabled unless the configured host is trusted with the Master
   * Application Key.
   */
  readonly allowCustomAuthorizeRealm?: boolean
}

/**
 * Options for Partner authorization performed by {@link BackupClient}.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface BackupAuthorizeOptions {
  /** Abort signal for cancelling the authorize request. */
  readonly signal?: AbortSignal
}

/**
 * Options for listing Computer Backup records.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface ListComputersOptions {
  /**
   * Account whose active computer backups should be listed. Defaults to the
   * partner administrator account ID from authorization.
   */
  readonly accountId?: AccountId
  /** Computer ID to start listing from for pagination. */
  readonly startComputerId?: ComputerId
  /** Maximum computers to return in this page. Forwarded to `maxComputerCount`. */
  readonly pageSize?: number
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/**
 * Options for paginating Computer Backup records.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface PaginateComputersOptions extends Omit<ListComputersOptions, 'startComputerId'> {
  /**
   * Aborts the iteration between page fetches. The signal is also forwarded to
   * each underlying list request.
   */
  readonly signal?: AbortSignal
}

/**
 * Options for deleting a Computer Backup record.
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export interface DeleteComputerOptions {
  /**
   * Account that owns the computer backup. Defaults to the partner
   * administrator account ID from authorization.
   */
  readonly accountId?: AccountId
  /** Computer ID of the backup to delete. */
  readonly computerId: ComputerId
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

interface BackupCoordinates {
  readonly backupApiUrl: string
  readonly authToken: PartnerToken
  readonly accountId: AccountId
}

/** Redacted JSON diagnostic shape emitted by {@link BackupClient.toJSON}. */
export interface BackupClientJson {
  /** Object kind for log consumers. */
  readonly type: 'BackupClient'
  /** Redacted Master Application Key credential placeholder. */
  readonly credentials: string
  /** Redacted Partner token placeholder, or unauthorized state. */
  readonly authorization: string
  /** Whether this client currently has Partner authorization state. */
  readonly authorized: boolean
  /** Current default URL guard suffixes, or null when a custom transport owns guarding. */
  readonly urlGuardAllowedSuffixes: readonly string[] | null
}

/**
 * High-level Computer Backup API client for listing and deleting backup records.
 *
 * The client uses Partner authorization and the `backupApiUrl` returned by
 * `authorizePartner`. The target account must belong to a group with
 * Enterprise Controls enabled, and the caller must be a group admin. Deleting
 * a backup also requires the Enterprise Controls setting that permits admins
 * to delete member backups.
 *
 * @example
 * ```ts
 * const backup = new BackupClient({
 *   masterKeyId: process.env.B2_MASTER_KEY_ID,
 *   masterKey: process.env.B2_MASTER_KEY,
 * })
 * await backup.authorize()
 * for await (const computer of backup.paginateComputers()) {
 *   console.log(computer.computerName)
 * }
 * ```
 *
 * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
 */
export class BackupClient {
  /** Low-level client for direct Computer Backup API calls. */
  readonly raw: BackupRawClient
  /** Partner authorization state storage (tokens, URLs, capabilities). */
  readonly partnerAccountInfo: PartnerAccountInfo
  /**
   * SSRF allow-list applied by the default transport. `null` when
   * a custom transport was supplied; in that case the SDK does not own the
   * guard.
   */
  readonly urlGuard: UrlGuard | null
  private readonly authCore: PartnerAuthCore

  /**
   * Creates a new BackupClient. Call {@link authorize} before making API requests
   * unless `partnerAccountInfo` already contains valid Partner authorization.
   *
   * @param options - Configuration including credentials, realm, and transport settings.
   */
  constructor(options: BackupClientOptions) {
    this.authCore = new PartnerAuthCore(options)
    this.partnerAccountInfo = this.authCore.partnerAccountInfo
    this.urlGuard = this.authCore.urlGuard
    this.raw = new BackupRawClient({
      transport: this.authCore.transport,
    })
    if (this.authCore.cachedEndpointSuffixes !== undefined) {
      setAuthorizedBackupEndpointSuffixes(this.raw, this.authCore.cachedEndpointSuffixes)
    }
  }

  /**
   * Authenticates with B2 Partner authorization and stores the authorization state.
   *
   * @param options - Optional abort signal.
   *
   * @returns The Partner authorization response containing tokens, URLs, and capabilities.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  async authorize(options?: BackupAuthorizeOptions): Promise<PartnerAuthorizeResponse> {
    const auth = await this.authCore.authorize(options)
    setAuthorizedBackupEndpointSuffixes(
      this.raw,
      derivePartnerAllowedSuffixes(auth, this.authCore.realmUrl),
    )
    return auth
  }

  /**
   * Lists active Computer Backup records for an account.
   *
   * @param options - Optional target account and pagination settings.
   *
   * @returns A page of computer backup records with an optional continuation cursor.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  async listComputers(options?: ListComputersOptions): Promise<ListComputersResponse> {
    const { backupApiUrl, authToken, accountId } = this.backupCoordinates(options?.accountId)
    return this.raw.listComputers(
      backupApiUrl,
      authToken,
      {
        accountId,
        ...(options?.startComputerId !== undefined
          ? { startComputerId: options.startComputerId }
          : {}),
        ...(options?.pageSize !== undefined ? { maxComputerCount: options.pageSize } : {}),
      },
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Async iterator that yields every active Computer Backup record for an account.
   *
   * @param options - Optional target account, page size, and abort signal.
   *
   * @returns An async iterable of {@link ComputerBackup} entries.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  paginateComputers(options?: PaginateComputersOptions): AsyncIterableIterator<ComputerBackup> {
    return paginateItems(
      async (cursor: ComputerId | undefined) => {
        const resp = await this.listComputers({
          ...(options?.accountId !== undefined ? { accountId: options.accountId } : {}),
          ...(options?.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
          ...(cursor !== undefined ? { startComputerId: cursor } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        })
        return { page: resp, nextCursor: resp.nextComputerId ?? undefined }
      },
      (page) => page.computers,
      options?.signal,
    )
  }

  /**
   * Deletes a Computer Backup record.
   *
   * This destructive mutation is not automatically retried or reauthorized in
   * place; callers should reconcile backup state before issuing a new delete
   * after an ambiguous failure.
   *
   * @param options - Target account, computer ID, and optional abort signal.
   *
   * @returns The deleted computer backup record array.
   *
   * @experimental Computer Backup API surface; shape may change as the Backup API docs evolve.
   */
  async deleteComputer(options: DeleteComputerOptions): Promise<DeleteComputerResponse> {
    const { backupApiUrl, authToken, accountId } = this.backupCoordinates(options.accountId)
    return this.raw.deleteComputer(
      backupApiUrl,
      authToken,
      {
        accountId,
        computerId: options.computerId,
      },
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  private backupCoordinates(accountIdOverride: AccountId | undefined): BackupCoordinates {
    const auth = this.partnerAccountInfo.getAuth()
    if (auth === null) {
      throw new B2PartnerAuthorizationError('Not authorized. Call BackupClient.authorize() first.')
    }
    // A BackupClient can share PartnerAccountInfo with a PartnerClient that
    // authorizes after this instance is constructed. Re-validate the shared auth
    // snapshot here before locking this client's guard and raw endpoint suffixes.
    const suffixes = validatePartnerAuthorizeResponseEndpoints(
      auth,
      this.authCore.realmUrl,
      this.authCore.allowCustomAuthorizeRealm,
    )
    this.authCore.lockUrlGuardFromSuffixes(suffixes)
    setAuthorizedBackupEndpointSuffixes(this.raw, suffixes)

    const backupApiUrl = this.partnerAccountInfo.getBackupApiUrl()
    if (backupApiUrl === null) {
      throw new B2PartnerAuthorizationError(
        'Computer Backup API is not available; Partner authorization did not return apiInfo.backupApi.',
      )
    }
    return {
      backupApiUrl,
      authToken: auth.authorizationToken,
      accountId: accountIdOverride ?? auth.accountId,
    }
  }

  /**
   * Hides credentials and Partner tokens from `JSON.stringify(client)`.
   *
   * @returns A redacted diagnostic object.
   */
  toJSON(): BackupClientJson {
    return {
      type: 'BackupClient',
      credentials: MASTER_KEY_REDACTED,
      authorization:
        this.partnerAccountInfo.getAuth() === null ? '[unauthorized]' : PARTNER_TOKEN_REDACTED,
      authorized: this.partnerAccountInfo.getAuth() !== null,
      urlGuardAllowedSuffixes: this.urlGuard?.getAllowedSuffixes() ?? null,
    }
  }

  /**
   * Hides credentials and Partner tokens from default stringification.
   *
   * @returns A short redacted label.
   */
  toString(): string {
    return `[BackupClient ${MASTER_KEY_REDACTED}]`
  }

  /**
   * Hides credentials and Partner tokens from Node's `util.inspect`.
   *
   * @returns A short redacted label.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }
}
