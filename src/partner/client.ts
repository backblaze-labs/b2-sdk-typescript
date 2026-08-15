import { getRealmUrl } from '../auth/realms.ts'
import { B2PartnerAuthorizationError } from '../errors/index.ts'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import { FetchTransport, RetryTransport } from '../http/transport.ts'
import { hostMatchesAllowedSuffix, UrlGuard } from '../http/url-guard.ts'
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
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient } from './raw.ts'

const PRODUCTION_HOST_SUFFIX = 'backblazeb2.com'
const PRODUCTION_ENDPOINT_HOST_SUFFIX = 'backblaze.com'
const STAGING_HOST_SUFFIX = 'backblaze.net'

/** Configuration options for creating a {@link PartnerClient}. */
export interface PartnerClientOptions {
  /** The Master Application Key ID for the partner administrator account. */
  readonly masterKeyId: string
  /** The Master Application Key secret. */
  readonly masterKey: string
  /**
   * B2 realm to authenticate against. Accepts a known realm-map key
   * (`"production"` or `"staging"`) or a direct base URL. Custom HTTPS hosts
   * are trusted with Master Application Key credentials only when
   * {@link allowCustomAuthorizeRealm} is also enabled.
   */
  readonly realm?: string
  /** Storage backend for Partner authorization state. Defaults to {@link InMemoryPartnerAccountInfo}. */
  readonly partnerAccountInfo?: PartnerAccountInfo
  /** Custom HTTP transport. Defaults to {@link FetchTransport}. Wrapped by {@link RetryTransport}. */
  readonly transport?: HttpTransport
  /** Override retry behavior (max retries, backoff, and per-attempt timeout). */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
  /**
   * Override the SSRF allow-list. By default the SDK locks the
   * {@link FetchTransport} to host suffixes derived from the Partner authorize
   * response. Pass an explicit list to add hosts (for example, a trusted test
   * proxy) or set to an empty array to disable the guard entirely.
   *
   * Only consulted when {@link PartnerClientOptions.transport} is unset; a
   * custom transport is the user's responsibility to harden.
   */
  readonly allowedHostSuffixes?: readonly string[]
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

/** Options for listing Partner groups. */
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

/** Options for paginating Partner groups. */
export interface PaginateGroupsOptions extends Omit<ListGroupsOptions, 'startGroupId'> {
  /**
   * Aborts the iteration between page fetches. The signal is also forwarded to
   * each underlying list request.
   */
  readonly signal?: AbortSignal
}

/** Options for listing Partner group members. */
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

/** Options for paginating Partner group members. */
export interface PaginateGroupMembersOptions extends Omit<ListGroupMembersOptions, 'startEmail'> {
  /**
   * Aborts the iteration between page fetches. The signal is also forwarded to
   * each underlying list request.
   */
  readonly signal?: AbortSignal
}

/** Options for creating a Partner group member. */
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

/** Options for ejecting a Partner group member. */
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

/** Coordinates needed for Partner groups API requests. */
interface PartnerGroupsCoordinates {
  readonly groupsApiUrl: string
  readonly authToken: PartnerToken
  readonly adminAccountId: AccountId
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
 */
export class PartnerClient {
  /** Low-level client for direct Partner API calls. */
  readonly raw: PartnerRawClient
  /** Partner authorization state storage (tokens, URLs, capabilities). */
  readonly partnerAccountInfo: PartnerAccountInfo
  /**
   * SSRF allow-list applied by the default {@link FetchTransport}. `null` when
   * a custom transport was supplied; in that case the SDK does not own the
   * guard.
   */
  readonly urlGuard: UrlGuard | null
  private readonly masterKeyId: string
  private readonly masterKey: string
  private readonly realmUrl: string
  private readonly userAllowedSuffixes: readonly string[] | undefined

  /**
   * Creates a new PartnerClient. Call {@link authorize} before making API requests.
   *
   * @param options - Configuration including credentials, realm, and transport settings.
   */
  constructor(options: PartnerClientOptions) {
    this.masterKeyId = options.masterKeyId
    this.masterKey = options.masterKey
    this.realmUrl = getRealmUrl(options.realm ?? 'production')
    this.partnerAccountInfo = options.partnerAccountInfo ?? new InMemoryPartnerAccountInfo()
    this.userAllowedSuffixes = options.allowedHostSuffixes

    let baseTransport: HttpTransport
    if (options.transport !== undefined) {
      baseTransport = options.transport
      this.urlGuard = null
    } else {
      const urlGuard = new UrlGuard()
      baseTransport = new FetchTransport({
        urlGuard,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
        ...(options.followSameOriginRedirects !== undefined
          ? { followSameOriginRedirects: options.followSameOriginRedirects }
          : {}),
      })
      this.urlGuard = urlGuard
    }

    const retryTransport = new RetryTransport({
      transport: baseTransport,
      retry: { ...DEFAULT_RETRY_OPTIONS, ...options.retry },
      onReauth: () => this.reauthorize(),
    })

    const cachedAuth = this.partnerAccountInfo.getAuth()
    if (cachedAuth !== null) this.lockUrlGuard(cachedAuth)

    this.raw = new PartnerRawClient({
      transport: retryTransport,
      ...(options.allowCustomAuthorizeRealm !== undefined
        ? { allowCustomAuthorizeRealm: options.allowCustomAuthorizeRealm }
        : {}),
    })
  }

  /**
   * Authenticates with B2 Partner authorization and stores the authorization state.
   *
   * @returns The Partner authorization response containing tokens, URLs, and capabilities.
   */
  async authorize(): Promise<PartnerAuthorizeResponse> {
    const auth = await this.raw.authorizePartner(this.masterKeyId, this.masterKey, this.realmUrl)
    this.partnerAccountInfo.setAuth(auth)
    this.lockUrlGuard(auth)
    return auth
  }

  /**
   * Lists Partner groups for the authorized partner administrator account.
   *
   * @param options - Optional group filter and pagination settings.
   *
   * @returns A page of Partner groups with an optional continuation cursor.
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
        return {
          page: resp,
          nextCursor: resp.find((result) => result.nextEmail !== null)?.nextEmail ?? undefined,
        }
      },
      (page) => page.flatMap((result) => result.groupMembers),
      options.signal,
    )
  }

  /**
   * Creates a new Backblaze account and adds it to a Partner group.
   *
   * @param options - Group ID, member email, and optional region.
   *
   * @returns The created member result array, including the member application key.
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
   * @param options - Group ID, member account ID, and optional replacement email.
   *
   * @returns The ejected member object.
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
   * @param request - A single trial account request or a non-empty request array.
   *
   * @returns The created reserve-trial account result array.
   */
  async reserveTrialAccounts(
    request: ReserveTrialCreateAccountRequestEntry | ReserveTrialCreateAccountRequest,
  ): Promise<ReserveTrialCreateAccountResponse> {
    const { groupsApiUrl, authToken } = this.groupsCoordinates()
    return this.raw.reserveTrialCreateAccount(groupsApiUrl, authToken, request)
  }

  private lockUrlGuard(auth: PartnerAuthorizeResponse): void {
    if (this.urlGuard === null) return
    const derived = derivePartnerAllowedSuffixes(auth, this.realmUrl)
    const merged =
      this.userAllowedSuffixes !== undefined
        ? this.userAllowedSuffixes.length === 0
          ? []
          : Array.from(new Set([...derived, ...this.userAllowedSuffixes]))
        : derived
    this.urlGuard.setAllowedSuffixes(merged)
  }

  private async reauthorize(): Promise<string> {
    this.partnerAccountInfo.clear()
    const auth = await this.authorize()
    return auth.authorizationToken
  }

  private groupsCoordinates(): PartnerGroupsCoordinates {
    const groupsApiUrl = this.partnerAccountInfo.getGroupsApiUrl()
    if (groupsApiUrl === null) {
      throw new B2PartnerAuthorizationError(
        'Partner API is not available; authorizePartner() did not return apiInfo.groupsApi.',
      )
    }
    return {
      groupsApiUrl,
      authToken: this.partnerAccountInfo.getPartnerToken(),
      adminAccountId: this.partnerAccountInfo.getAccountId(),
    }
  }
}

function derivePartnerAllowedSuffixes(
  auth: PartnerAuthorizeResponse,
  realmUrl: string,
): readonly string[] {
  const suffixes = new Set<string>()
  addPartnerUrlSuffix(suffixes, realmUrl)
  if (auth.apiInfo.groupsApi !== undefined) {
    addPartnerUrlSuffix(suffixes, auth.apiInfo.groupsApi.groupsApiUrl)
  }
  if (auth.apiInfo.backupApi !== undefined) {
    addPartnerUrlSuffix(suffixes, auth.apiInfo.backupApi.backupApiUrl)
  }
  return Array.from(suffixes).sort()
}

function addPartnerUrlSuffix(suffixes: Set<string>, rawUrl: string): void {
  try {
    suffixes.add(partnerAllowedSuffix(new URL(rawUrl).hostname))
  } catch {
    // Malformed cached auth will be rejected by PartnerRawClient before use.
  }
}

function partnerAllowedSuffix(hostname: string): string {
  const host = hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(host, PRODUCTION_HOST_SUFFIX)) return PRODUCTION_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, STAGING_HOST_SUFFIX)) return STAGING_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, PRODUCTION_ENDPOINT_HOST_SUFFIX)) {
    return PRODUCTION_ENDPOINT_HOST_SUFFIX
  }
  return host
}
