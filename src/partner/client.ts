import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import type { UrlGuard } from '../http/url-guard.ts'
import type { AccountId, GroupId, PartnerToken } from '../types/ids.ts'
import type {
  CreateGroupMemberResponse,
  EjectGroupMemberResponse,
  ListedGroupMember,
  ListGroupMembersResponse,
  ListGroupsResponse,
  PartnerAuthorizeResponse,
  PartnerGroup,
  Region,
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResponse,
} from '../types/partner.ts'
import { paginateItems } from '../util/paginator.ts'
import type { PartnerAccountInfo } from './account-info.ts'
import { PartnerAuthCore } from './auth-core.ts'
import type { PartnerRawClient } from './raw.ts'
import { PARTNER_TOKEN_REDACTED } from './redaction.ts'

const MASTER_KEY_REDACTED = '[redacted Master Application Key]'

/**
 * Configuration options for creating a {@link PartnerClient}.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerClientOptions {
  /** The Master Application Key ID for the partner administrator account. */
  readonly masterKeyId: string
  /** The Master Application Key secret. */
  readonly masterKey: string
  /**
   * B2 realm to authenticate against. Accepts a known realm-map key
   * (`"production"` or `"staging"`) or a direct base URL. Custom HTTPS hosts
   * are trusted with the Master Application Key during authorize, so never
   * derive `realm` from untrusted input. URL values must use HTTPS, or
   * loopback IP literal HTTP for local testing only; Master Application Key
   * credentials are sent unencrypted over loopback HTTP. Unsupported schemes,
   * malformed URLs, non-URL strings, plaintext HTTP hostnames such as
   * `localhost`, and non-loopback plaintext HTTP are rejected before
   * credentials are sent. URL values must not include userinfo, query strings,
   * or fragments. Defaults to `"production"`.
   */
  readonly realm?: string
  /**
   * Storage backend for Partner authorization state. Defaults to
   * {@link InMemoryPartnerAccountInfo}. Cached authorization whose endpoint
   * URLs fail the configured realm policy is cleared during construction so
   * callers can reauthorize before making Partner API requests.
   */
  readonly partnerAccountInfo?: PartnerAccountInfo
  /** Custom HTTP transport. Defaults to `FetchTransport`. Wrapped by `RetryTransport`. */
  readonly transport?: HttpTransport
  /** Override retry behavior (max retries, backoff, and per-attempt timeout). */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
  /**
   * Additional SSRF allow-list host suffixes. By default the SDK locks the
   * default transport to host suffixes derived from the Partner authorize
   * response. Pass an explicit list to add trusted hosts, for example a test
   * proxy. An empty array adds no hosts and leaves the default guard enabled.
   *
   * Only consulted when {@link PartnerClientOptions.transport} is unset; a
   * custom transport is the user's responsibility to harden.
   */
  readonly additionalAllowedHostSuffixes?: readonly string[]
  /**
   * Explicitly disable the default SSRF guard after authorize.
   *
   * This is intended only for controlled simulator/private-proxy tests. Never
   * enable it for URLs derived from untrusted input or production credentials.
   * Only consulted when {@link PartnerClientOptions.transport} is unset.
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
 * Options for Partner authorization.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PartnerAuthorizeOptions {
  /** Abort signal for cancelling the authorize request. */
  readonly signal?: AbortSignal
}

/**
 * Options for listing Partner groups.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupsOptions {
  /** Optional group name filter. Multiple groups may share the same name. */
  readonly groupName?: string
  /** Group ID to start listing from for pagination. */
  readonly startGroupId?: GroupId
  /** Maximum groups to return in this page. Forwarded to `maxGroupCount`. */
  readonly pageSize?: number
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/**
 * Options for paginating Partner groups.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PaginateGroupsOptions extends Omit<ListGroupsOptions, 'startGroupId'> {
  /**
   * Aborts the iteration between page fetches. The signal is also forwarded to
   * each underlying list request.
   */
  readonly signal?: AbortSignal
}

/**
 * Options for listing Partner group members.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ListGroupMembersOptions {
  /** Group ID whose active members should be listed. */
  readonly groupId: GroupId
  /** First member email address to return for pagination. */
  readonly startEmail?: string
  /** Maximum members to return in this page. Forwarded to `maxMemberCount`. */
  readonly pageSize?: number
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/**
 * Options for paginating Partner group members.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface PaginateGroupMembersOptions extends Omit<ListGroupMembersOptions, 'startEmail'> {
  /**
   * Aborts the iteration between page fetches. The signal is also forwarded to
   * each underlying list request.
   */
  readonly signal?: AbortSignal
}

/**
 * Options for creating a Partner group member.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface CreateGroupMemberOptions {
  /** Group ID that the new Backblaze account will join. */
  readonly groupId: GroupId
  /** Email address for the new group member account. */
  readonly memberEmail: string
  /** Region for the new account's data, or null to use the current default region. */
  readonly region?: Region | null
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/**
 * Options for ejecting a Partner group member.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface EjectGroupMemberOptions {
  /** Group ID that currently contains the member. */
  readonly groupId: GroupId
  /** Account ID of the group member being ejected. */
  readonly memberAccountId: AccountId
  /** Replacement email for the ejected account, or null to keep the current email address. */
  readonly email?: string | null
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/**
 * Options for reserving B2 Reserve trial accounts.
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export interface ReserveTrialAccountsOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
}

/** Coordinates needed for Partner groups API requests. */
interface PartnerGroupsCoordinates {
  readonly groupsApiUrl: string
  readonly authToken: PartnerToken
  readonly adminAccountId: AccountId
}

/** Redacted JSON diagnostic shape emitted by {@link PartnerClient.toJSON}. */
export interface PartnerClientJson {
  /** Object kind for log consumers. */
  readonly type: 'PartnerClient'
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
 * High-level Partner API client for groups, members, and B2 Reserve trials.
 *
 * @example
 * ```ts
 * const partner = new PartnerClient({
 *   masterKeyId: process.env.B2_MASTER_KEY_ID,
 *   masterKey: process.env.B2_MASTER_KEY,
 * })
 * await partner.authorize()
 * for await (const group of partner.paginateGroups()) {
 *   console.log(group.groupName)
 * }
 * ```
 *
 * @experimental Partner API surface; shape may change as the Partner API docs evolve.
 */
export class PartnerClient {
  /** Low-level client for direct Partner API calls. */
  readonly raw: PartnerRawClient
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
   * Creates a new PartnerClient. Call {@link authorize} before making API requests.
   *
   * @param options - Configuration including credentials, realm, and transport settings.
   */
  constructor(options: PartnerClientOptions) {
    this.authCore = new PartnerAuthCore(options)
    this.raw = this.authCore.raw
    this.partnerAccountInfo = this.authCore.partnerAccountInfo
    this.urlGuard = this.authCore.urlGuard
  }

  /**
   * Authenticates with B2 Partner authorization and stores the authorization state.
   *
   * @param options - Optional abort signal.
   *
   * @returns The Partner authorization response containing tokens, URLs, and capabilities.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async authorize(options?: PartnerAuthorizeOptions): Promise<PartnerAuthorizeResponse> {
    return this.authCore.authorize(options)
  }

  /**
   * Lists Partner groups for the authorized partner administrator account.
   *
   * @param options - Optional group filter and pagination settings.
   *
   * @returns A page of Partner groups with an optional continuation cursor.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async listGroups(options?: ListGroupsOptions): Promise<ListGroupsResponse> {
    const { groupsApiUrl, authToken, adminAccountId } = this.groupsCoordinates()
    return this.raw.listGroups(
      groupsApiUrl,
      authToken,
      {
        adminAccountId,
        ...(options?.groupName !== undefined ? { groupName: options.groupName } : {}),
        ...(options?.startGroupId !== undefined ? { startGroupId: options.startGroupId } : {}),
        ...(options?.pageSize !== undefined ? { maxGroupCount: options.pageSize } : {}),
      },
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Async iterator that yields every Partner group for the authorized account.
   *
   * @param options - Optional group filter, page size, and abort signal.
   *
   * @returns An async iterable of {@link PartnerGroup} entries.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  paginateGroups(options?: PaginateGroupsOptions): AsyncIterableIterator<PartnerGroup> {
    return paginateItems(
      async (cursor: GroupId | undefined) => {
        const resp = await this.listGroups({
          ...(options?.groupName !== undefined ? { groupName: options.groupName } : {}),
          ...(options?.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
          ...(cursor !== undefined ? { startGroupId: cursor } : {}),
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        })
        return { page: resp, nextCursor: resp.nextGroupId ?? undefined }
      },
      (page) => page.groups,
      options?.signal,
    )
  }

  /**
   * Lists active members for a Partner group.
   *
   * @param options - Group ID plus optional pagination settings.
   *
   * @returns A page of group-member results with an optional continuation cursor.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async listGroupMembers(options: ListGroupMembersOptions): Promise<ListGroupMembersResponse> {
    const { groupsApiUrl, authToken, adminAccountId } = this.groupsCoordinates()
    return this.raw.listGroupMembers(
      groupsApiUrl,
      authToken,
      {
        adminAccountId,
        groupId: options.groupId,
        ...(options.startEmail !== undefined ? { startEmail: options.startEmail } : {}),
        ...(options.pageSize !== undefined ? { maxMemberCount: options.pageSize } : {}),
      },
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Async iterator that yields every active member for a Partner group.
   *
   * @param options - Group ID plus optional page size and abort signal.
   *
   * @returns An async iterable of {@link ListedGroupMember} entries.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  paginateGroupMembers(
    options: PaginateGroupMembersOptions,
  ): AsyncIterableIterator<ListedGroupMember> {
    return paginateItems(
      async (cursor: string | undefined) => {
        const resp = await this.listGroupMembers({
          groupId: options.groupId,
          ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
          ...(cursor !== undefined ? { startEmail: cursor } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        // The API returns an array for consistency with batch-capable Partner
        // surfaces, but this request is scoped to one group ID.
        const result = resp[0]
        return {
          page: resp,
          nextCursor: result?.nextEmail ?? undefined,
        }
      },
      (page) => page.flatMap((result) => result.groupMembers),
      options.signal,
    )
  }

  /**
   * Creates a new Backblaze account and adds it to a Partner group.
   *
   * This mutation is non-idempotent. Automatic retries and expired-token
   * reauthorization are disabled; long-running batch callers must catch token
   * expiry, call {@link authorize}, and decide whether to issue a new request.
   *
   * @param options - Group ID, member email, and optional region.
   *
   * @returns The created member result array, including the member application key.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async createGroupMember(options: CreateGroupMemberOptions): Promise<CreateGroupMemberResponse> {
    const { groupsApiUrl, authToken, adminAccountId } = this.groupsCoordinates()
    return this.raw.createGroupMember(
      groupsApiUrl,
      authToken,
      {
        adminAccountId,
        groupId: options.groupId,
        memberEmail: options.memberEmail,
        ...(options.region !== undefined ? { region: options.region } : {}),
      },
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Ejects an active member from a Partner group without deleting the account.
   *
   * This mutation is non-idempotent. Automatic retries and expired-token
   * reauthorization are disabled; long-running batch callers must catch token
   * expiry, call {@link authorize}, and decide whether to issue a new request.
   *
   * @param options - Group ID, member account ID, and optional replacement email.
   *
   * @returns The ejected member object.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async ejectGroupMember(options: EjectGroupMemberOptions): Promise<EjectGroupMemberResponse> {
    const { groupsApiUrl, authToken, adminAccountId } = this.groupsCoordinates()
    return this.raw.ejectGroupMember(
      groupsApiUrl,
      authToken,
      {
        adminAccountId,
        groupId: options.groupId,
        memberAccountId: options.memberAccountId,
        ...(options.email !== undefined ? { email: options.email } : {}),
      },
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Reserves one or more new B2 Reserve trial accounts.
   *
   * This operation is non-idempotent and automatic retries/expired-token
   * reauthorization are disabled at the raw layer. If the request fails after
   * the server processes it, the returned application keys may be
   * unrecoverable; reconcile account state before reissuing a batch.
   *
   * @param request - A single trial account request or a non-empty request array.
   * @param options - Optional abort signal.
   *
   * @returns The created reserve-trial account result array.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async reserveTrialAccounts(
    request: ReserveTrialCreateAccountRequestEntry | ReserveTrialCreateAccountRequest,
    options?: ReserveTrialAccountsOptions,
  ): Promise<ReserveTrialCreateAccountResponse> {
    if (Array.isArray(request) && request.length === 0) {
      throw new TypeError(
        'reserveTrialAccounts request array must include at least one account request.',
      )
    }
    const { groupsApiUrl, authToken } = this.groupsCoordinates()
    return this.raw.reserveTrialCreateAccount(
      groupsApiUrl,
      authToken,
      request,
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    )
  }

  /**
   * Hides credentials and Partner tokens from `JSON.stringify(client)`.
   *
   * @returns A redacted diagnostic object.
   */
  toJSON(): PartnerClientJson {
    return {
      type: 'PartnerClient',
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
    return `[PartnerClient ${MASTER_KEY_REDACTED}]`
  }

  /**
   * Hides credentials and Partner tokens from Node's `util.inspect`.
   *
   * @returns A short redacted label.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }

  private groupsCoordinates(): PartnerGroupsCoordinates {
    const groupsApiUrl = this.partnerAccountInfo.getGroupsApiUrl()
    if (groupsApiUrl === null) {
      throw new B2PartnerAuthorizationError(
        'Partner API is not available; PartnerClient.authorize() did not return apiInfo.groupsApi.',
      )
    }
    return {
      groupsApiUrl,
      authToken: this.partnerAccountInfo.getPartnerToken(),
      adminAccountId: this.partnerAccountInfo.getAccountId(),
    }
  }
}
