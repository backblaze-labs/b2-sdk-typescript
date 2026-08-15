import { assertSecureRealmUrl } from '../auth/realms.ts'
import { B2PartnerAuthorizationError, B2RealmConfigurationError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import {
  getTransportUrlGuard,
  type HttpTransport,
  type UrlGuardedTransport,
} from '../http/transport.ts'
import { hostMatchesAllowedSuffix, UrlGuard } from '../http/url-guard.ts'
import { type B2EndpointUrlOptions, b2Url } from '../raw/url.ts'
import { accountId, partnerToken } from '../types/ids.ts'
import type {
  CreateGroupMemberRequest,
  CreateGroupMemberResponse,
  EjectGroupMemberRequest,
  EjectGroupMemberResponse,
  ListGroupMembersRequest,
  ListGroupMembersResponse,
  ListGroupsRequest,
  ListGroupsResponse,
  PartnerApiInfo,
  PartnerAuthorizeResponse,
  PartnerBackupApiInfo,
  PartnerGroupsApiInfo,
  ReserveTrialCreateAccountRequest,
  ReserveTrialCreateAccountRequestEntry,
  ReserveTrialCreateAccountResponse,
} from '../types/partner.ts'
import {
  redactCreateGroupMemberResponse,
  redactPartnerAuthorizeResponse,
  redactReserveTrialCreateAccountResponse,
} from './redaction.ts'

const PARTNER_API_V3: B2EndpointUrlOptions = { prefix: 'b2api', version: 'v3' }
const DEFAULT_PARTNER_REALM_URL = 'https://api.backblazeb2.com'
const PRODUCTION_HOST_SUFFIX = 'backblazeb2.com'
const PRODUCTION_ENDPOINT_HOST_SUFFIX = 'backblaze.com'
const STAGING_HOST_SUFFIX = 'backblaze.net'
const VERIFIED_PARTNER_AUTHORIZE_REALM_ORIGINS = new Set([
  'https://api.backblazeb2.com',
  'https://api.backblaze.net',
])

/** Configuration for constructing a {@link PartnerRawClient}. */
export interface PartnerRawClientOptions {
  /**
   * The HTTP transport used to send requests.
   *
   * Partner endpoint calls validate URLs against suffixes recorded by
   * `authorizePartner()`. A rehydrated client that skips authorization must use
   * a {@link UrlGuardedTransport} with a locked `urlGuard`.
   */
  readonly transport: HttpTransport
  /**
   * Partner endpoint host suffixes that have already been validated from a
   * cached Partner authorize response.
   *
   * @internal
   */
  readonly authorizedPartnerEndpointSuffixes?: readonly string[]
  /**
   * Allow direct custom authorize realms for tests or private proxies.
   * Leave disabled unless the configured host is trusted with the Master Application Key.
   */
  readonly allowCustomAuthorizeRealm?: boolean
}

/** Optional controls for raw Partner API requests. */
export interface PartnerRawRequestOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
  /** Per-request retry override. */
  readonly retry?: Partial<RetryOptions>
}

interface WirePartnerAuthorizeResponse {
  readonly accountId: string
  readonly authorizationToken: string
  readonly apiInfo: PartnerApiInfo
  readonly applicationKeyExpirationTimestamp: number | null
}

type QueryValue = string | number
type QueryParams = Readonly<Record<string, QueryValue>>

function assertVerifiedPartnerAuthorizeRealm(realmUrl: string, allowCustomAuthorizeRealm: boolean) {
  if (allowCustomAuthorizeRealm) return

  const realm = new URL(realmUrl)
  if (VERIFIED_PARTNER_AUTHORIZE_REALM_ORIGINS.has(realm.origin)) return

  throw new B2RealmConfigurationError(
    `refusing to send Master Application Key credentials to unverified Partner authorize realm: ${realm.origin}`,
  )
}

function endpointAllowedSuffixesForRealm(
  realmUrl: string,
  allowCustomAuthorizeRealm: boolean,
): readonly string[] {
  const realmHost = new URL(realmUrl).hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(realmHost, PRODUCTION_HOST_SUFFIX)) {
    return [PRODUCTION_ENDPOINT_HOST_SUFFIX, PRODUCTION_HOST_SUFFIX]
  }
  if (hostMatchesAllowedSuffix(realmHost, STAGING_HOST_SUFFIX)) return [STAGING_HOST_SUFFIX]
  return allowCustomAuthorizeRealm ? [] : [realmHost]
}

function authorizeRealmAllowedSuffix(realmUrl: string): string {
  const host = new URL(realmUrl).hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(host, PRODUCTION_HOST_SUFFIX)) return PRODUCTION_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, STAGING_HOST_SUFFIX)) return STAGING_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, PRODUCTION_ENDPOINT_HOST_SUFFIX)) {
    return PRODUCTION_ENDPOINT_HOST_SUFFIX
  }
  return host
}

function endpointAllowedSuffix(url: string): string {
  const host = new URL(url).hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(host, PRODUCTION_HOST_SUFFIX)) return PRODUCTION_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, STAGING_HOST_SUFFIX)) return STAGING_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, PRODUCTION_ENDPOINT_HOST_SUFFIX)) {
    return PRODUCTION_ENDPOINT_HOST_SUFFIX
  }
  return host
}

function validatePartnerEndpointUrl(
  rawUrl: string,
  fieldName: 'groupsApiUrl' | 'backupApiUrl',
  allowedSuffixes: readonly string[],
): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new B2PartnerAuthorizationError(
      `Partner authorize response included malformed ${fieldName}`,
    )
  }

  if (url.protocol !== 'https:') {
    throw new B2PartnerAuthorizationError(`Partner authorize response ${fieldName} must use HTTPS`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new B2PartnerAuthorizationError(
      `Partner authorize response ${fieldName} must not include userinfo`,
    )
  }
  if (url.search !== '' || url.hash !== '') {
    throw new B2PartnerAuthorizationError(
      `Partner authorize response ${fieldName} must not include query or fragment`,
    )
  }

  const guard = new UrlGuard()
  guard.setAllowedSuffixes(
    allowedSuffixes.length === 0 ? [url.hostname.toLowerCase()] : allowedSuffixes,
  )
  try {
    guard.check(rawUrl)
  } catch (err) {
    throw new B2PartnerAuthorizationError(
      err instanceof Error
        ? `Partner authorize response included unsafe ${fieldName}: ${err.message}`
        : `Partner authorize response included unsafe ${fieldName}`,
    )
  }

  return rawUrl
}

function normalizeGroupsApi(
  groupsApi: PartnerGroupsApiInfo,
  allowedSuffixes: readonly string[],
): PartnerGroupsApiInfo {
  return {
    ...groupsApi,
    groupsApiUrl: validatePartnerEndpointUrl(
      groupsApi.groupsApiUrl,
      'groupsApiUrl',
      allowedSuffixes,
    ),
    capabilities: [...(groupsApi.capabilities ?? [])],
    infoType: 'groupsApi',
  }
}

function normalizeBackupApi(
  backupApi: PartnerBackupApiInfo,
  allowedSuffixes: readonly string[],
): PartnerBackupApiInfo {
  return {
    ...backupApi,
    backupApiUrl: validatePartnerEndpointUrl(
      backupApi.backupApiUrl,
      'backupApiUrl',
      allowedSuffixes,
    ),
    capabilities: [...(backupApi.capabilities ?? [])],
    infoType: 'backupApi',
  }
}

function normalizePartnerAuthorizeResponse(
  response: WirePartnerAuthorizeResponse,
  realmUrl: string,
  allowCustomAuthorizeRealm: boolean,
): PartnerAuthorizeResponse {
  const { groupsApi, backupApi } = response.apiInfo
  if (groupsApi === undefined && backupApi === undefined) {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response did not include apiInfo.groupsApi or apiInfo.backupApi',
    )
  }

  const allowedSuffixes = endpointAllowedSuffixesForRealm(realmUrl, allowCustomAuthorizeRealm)
  const normalizedGroupsApi =
    groupsApi !== undefined ? normalizeGroupsApi(groupsApi, allowedSuffixes) : undefined
  const normalizedBackupApi =
    backupApi !== undefined ? normalizeBackupApi(backupApi, allowedSuffixes) : undefined
  const apiInfo: PartnerApiInfo = {
    ...(response.apiInfo.storageApi !== undefined
      ? { storageApi: response.apiInfo.storageApi }
      : {}),
    ...(normalizedGroupsApi !== undefined ? { groupsApi: normalizedGroupsApi } : {}),
    ...(normalizedBackupApi !== undefined ? { backupApi: normalizedBackupApi } : {}),
  }
  const normalized: PartnerAuthorizeResponse = {
    accountId: accountId(response.accountId),
    authorizationToken: partnerToken(response.authorizationToken),
    apiInfo,
    ...(normalizedGroupsApi !== undefined
      ? { groupsApiUrl: normalizedGroupsApi.groupsApiUrl }
      : {}),
    ...(normalizedBackupApi !== undefined
      ? { backupApiUrl: normalizedBackupApi.backupApiUrl }
      : {}),
    ...(normalizedGroupsApi !== undefined
      ? { groupsCapabilities: normalizedGroupsApi.capabilities }
      : {}),
    ...(normalizedBackupApi !== undefined
      ? { backupCapabilities: normalizedBackupApi.capabilities }
      : {}),
    applicationKeyExpirationTimestamp: response.applicationKeyExpirationTimestamp,
  }

  return redactPartnerAuthorizeResponse(normalized)
}

/**
 * Derives the Partner authorize and endpoint host suffixes that may receive
 * Partner tokens after a trusted authorize response has been validated.
 *
 * @param auth - Normalized Partner authorize response.
 * @param realmUrl - Realm URL used for Partner authorization.
 *
 * @returns Sorted list of unique host suffixes to allow.
 *
 * @internal
 */
export function derivePartnerAllowedSuffixes(
  auth: PartnerAuthorizeResponse,
  realmUrl: string,
): readonly string[] {
  const suffixes = new Set<string>([authorizeRealmAllowedSuffix(realmUrl)])
  if (auth.apiInfo.groupsApi !== undefined) {
    suffixes.add(endpointAllowedSuffix(auth.apiInfo.groupsApi.groupsApiUrl))
  }
  if (auth.apiInfo.backupApi !== undefined) {
    suffixes.add(endpointAllowedSuffix(auth.apiInfo.backupApi.backupApiUrl))
  }
  return Array.from(suffixes).sort()
}

/**
 * Validates cached Partner authorize endpoint URLs with the same realm policy
 * applied to fresh `authorizePartner()` responses and returns guard suffixes.
 *
 * @param auth - Cached Partner authorize response to validate.
 * @param realmUrl - Realm URL used for Partner authorization.
 * @param allowCustomAuthorizeRealm - Whether custom authorize realms are trusted.
 *
 * @returns Sorted list of host suffixes derived from the validated auth state.
 *
 * @throws B2PartnerAuthorizationError if the cached auth endpoints are unsafe.
 *
 * @internal
 */
export function validatePartnerAuthorizeResponseEndpoints(
  auth: PartnerAuthorizeResponse,
  realmUrl: string,
  allowCustomAuthorizeRealm: boolean,
): readonly string[] {
  const { groupsApi, backupApi } = auth.apiInfo
  if (groupsApi === undefined && backupApi === undefined) {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response did not include apiInfo.groupsApi or apiInfo.backupApi',
    )
  }

  const allowedSuffixes = endpointAllowedSuffixesForRealm(realmUrl, allowCustomAuthorizeRealm)
  if (groupsApi !== undefined) {
    validatePartnerEndpointUrl(groupsApi.groupsApiUrl, 'groupsApiUrl', allowedSuffixes)
  }
  if (backupApi !== undefined) {
    validatePartnerEndpointUrl(backupApi.backupApiUrl, 'backupApiUrl', allowedSuffixes)
  }

  return derivePartnerAllowedSuffixes(auth, realmUrl)
}

function lockTransportUrlGuard(transport: HttpTransport, allowedSuffixes: readonly string[]): void {
  const guard = getTransportUrlGuard(transport)
  if (guard === undefined) return

  const suffixes = new Set([...guard.getAllowedSuffixes(), ...allowedSuffixes])
  guard.setAllowedSuffixes(Array.from(suffixes).sort())
}

function partnerEndpointAllowedSuffixes(
  transport: HttpTransport,
  authorizedSuffixes: readonly string[],
): readonly string[] {
  if (authorizedSuffixes.length > 0) return authorizedSuffixes

  const guard = getTransportUrlGuard(transport)
  if (guard === undefined) {
    throw new B2PartnerAuthorizationError(
      'Partner endpoint requests require authorizePartner() or a UrlGuardedTransport with a locked URL guard before sending Partner tokens',
    )
  }

  const suffixes = guard.getAllowedSuffixes()
  if (suffixes.length === 0) {
    throw new B2PartnerAuthorizationError(
      'Partner endpoint requests require a locked URL guard before sending Partner tokens',
    )
  }

  return suffixes
}

function validatePartnerRequestGroupsApiUrl(
  transport: HttpTransport,
  authorizedSuffixes: readonly string[],
  groupsApiUrl: string,
): string {
  return validatePartnerEndpointUrl(
    groupsApiUrl,
    'groupsApiUrl',
    partnerEndpointAllowedSuffixes(transport, authorizedSuffixes),
  )
}

function mutationRequestOptions(
  options: PartnerRawRequestOptions | undefined,
): PartnerRawRequestOptions {
  return {
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    // These Partner POSTs create/eject accounts and are not idempotent. Keep
    // in-place retries disabled even if callers share retry options with GETs.
    retry: { ...(options?.retry ?? {}), maxRetries: 0 },
  }
}

function withQueryString(url: string, query: QueryParams): string {
  // Match the storage raw client's encodeURIComponent query semantics: spaces
  // are `%20`, not form-style `+`.
  const queryString = Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
  return queryString.length === 0 ? url : `${url}?${queryString}`
}

function reserveTrialCreateAccountRequestBody(
  request: ReserveTrialCreateAccountRequestEntry | ReserveTrialCreateAccountRequest,
): readonly ReserveTrialCreateAccountRequestEntry[] {
  const entries = Array.isArray(request) ? request : [request]
  return entries.map((entry) => ({
    email: entry.email,
    term: entry.term,
    storage: entry.storage,
    ...(entry.region != null ? { region: entry.region } : {}),
  }))
}

/**
 * Low-level client for Partner API authorization and endpoint bindings.
 */
export class PartnerRawClient {
  /** @internal */
  private readonly transport: HttpTransport
  private readonly allowCustomAuthorizeRealm: boolean
  private partnerEndpointSuffixes: readonly string[] = []

  /**
   * Creates a new PartnerRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: PartnerRawClientOptions) {
    this.transport = options.transport
    this.allowCustomAuthorizeRealm = options.allowCustomAuthorizeRealm ?? false
    this.partnerEndpointSuffixes = options.authorizedPartnerEndpointSuffixes ?? []
  }

  /**
   * Calls `b2_authorize_account` with Master Application Key credentials and
   * normalizes the Partner/Backup suites into a Partner-specific auth shape.
   *
   * The Partner API documentation currently shows the v3 authorize path, so
   * this method intentionally uses `/b2api/v3/b2_authorize_account` while the
   * storage raw client keeps using v4.
   *
   * @param masterKeyId - The Master Application Key ID for authentication.
   * @param masterKey - The Master Application Key secret.
   * @param realmUrl - The B2 realm URL to authenticate against.
   *
   * @returns The normalized Partner authorization response.
   *
   * @throws B2RealmConfigurationError if the realm URL is unsafe for Master Application Key credentials.
   * @throws B2PartnerAuthorizationError if the response omits or returns unsafe Partner endpoint data.
   */
  async authorizePartner(
    masterKeyId: string,
    masterKey: string,
    realmUrl = DEFAULT_PARTNER_REALM_URL,
  ): Promise<PartnerAuthorizeResponse> {
    assertSecureRealmUrl(realmUrl)
    assertVerifiedPartnerAuthorizeRealm(realmUrl, this.allowCustomAuthorizeRealm)
    const response = await this.transport.send({
      url: b2Url(realmUrl, { ...PARTNER_API_V3, endpoint: 'b2_authorize_account' }),
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${masterKeyId}:${masterKey}`)}`,
      },
    })
    const auth = normalizePartnerAuthorizeResponse(
      await response.json<WirePartnerAuthorizeResponse>(),
      realmUrl,
      this.allowCustomAuthorizeRealm,
    )
    this.partnerEndpointSuffixes = derivePartnerAllowedSuffixes(auth, realmUrl)
    lockTransportUrlGuard(this.transport, this.partnerEndpointSuffixes)
    return auth
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-create-group-member | b2_create_group_member}.
   *
   * The Partner API creates a new Backblaze account for an email address that
   * is not already a Backblaze account and adds that account to the managed
   * group. The wire response is a JSON array.
   *
   * @param groupsApiUrl - The Partner API base URL from `authorizePartner`.
   * @param authToken - The Partner API authorization token.
   * @param request - The group-member creation request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The created member result array, including the member application key.
   */
  async createGroupMember(
    groupsApiUrl: string,
    authToken: string,
    request: CreateGroupMemberRequest,
    options?: PartnerRawRequestOptions,
  ): Promise<CreateGroupMemberResponse> {
    const response = await this.postJson<CreateGroupMemberResponse>(
      groupsApiUrl,
      authToken,
      'b2_create_group_member',
      {
        adminAccountId: request.adminAccountId,
        groupId: request.groupId,
        memberEmail: request.memberEmail,
        ...(request.region != null ? { region: request.region } : {}),
      },
      mutationRequestOptions(options),
    )
    return redactCreateGroupMemberResponse(response)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-eject-group-member | b2_eject_group_member}.
   *
   * Ejection removes the member account from the group but does not delete the
   * Backblaze account. The wire response is a single JSON object.
   *
   * @param groupsApiUrl - The Partner API base URL from `authorizePartner`.
   * @param authToken - The Partner API authorization token.
   * @param request - The group-member ejection request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The ejected member object.
   */
  async ejectGroupMember(
    groupsApiUrl: string,
    authToken: string,
    request: EjectGroupMemberRequest,
    options?: PartnerRawRequestOptions,
  ): Promise<EjectGroupMemberResponse> {
    return this.postJson<EjectGroupMemberResponse>(
      groupsApiUrl,
      authToken,
      'b2_eject_group_member',
      {
        adminAccountId: request.adminAccountId,
        groupId: request.groupId,
        memberAccountId: request.memberAccountId,
        ...(request.email !== undefined ? { email: request.email } : {}),
      },
      mutationRequestOptions(options),
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-reserve-trial-create-account | b2_reserve_trial_create_account}.
   *
   * The Partner API creates one or more new Backblaze B2 accounts and starts
   * B2 Reserve trials for them. Backblaze documents both the wire request and
   * the success response as JSON arrays. The array form must include at least
   * one request entry. For convenience, this raw binding intentionally accepts
   * one request entry for the one-account case and always sends an array on the
   * wire.
   *
   * Each email address must not already be a Backblaze account. `term` is the
   * trial duration in days, documented as 7 through 30 inclusive. `storage` is
   * the requested storage in TB, documented as 1 through 50 inclusive.
   *
   * This operation is non-idempotent and creates billable accounts. Automatic
   * retries and expired-token reauthorization are disabled; long-lived batch
   * callers must catch auth expiry, reauthorize, and then decide whether to
   * issue a new request. A network or timeout failure after the server has
   * processed the request may still have created one or more accounts, and the
   * application keys from a lost response are not recoverable from B2. Bulk
   * callers should reconcile account state out of band, such as through Partner
   * account listing, before re-issuing the same batch.
   *
   * @param groupsApiUrl - The Partner API base URL from `authorizePartner`. The authorize response currently exposes the shared Partner endpoint base as `groupsApiUrl`.
   * @param authToken - The Partner API authorization token.
   * @param request - One reserve-trial account request, or one or more entries.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The created reserve-trial account result array.
   *
   * @experimental Partner API surface; shape may change as the Partner API docs evolve.
   */
  async reserveTrialCreateAccount(
    groupsApiUrl: string,
    authToken: string,
    request: ReserveTrialCreateAccountRequestEntry | ReserveTrialCreateAccountRequest,
    options?: PartnerRawRequestOptions,
  ): Promise<ReserveTrialCreateAccountResponse> {
    const response = await this.postJson<ReserveTrialCreateAccountResponse>(
      groupsApiUrl,
      authToken,
      'b2_reserve_trial_create_account',
      reserveTrialCreateAccountRequestBody(request),
      mutationRequestOptions(options),
    )
    return redactReserveTrialCreateAccountResponse(response)
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-groups | b2_list_groups}.
   *
   * Uses the documented canonical GET form. The wire response is a single JSON
   * object that surfaces `nextGroupId` for cursor-based pagination.
   *
   * @param groupsApiUrl - The Partner API base URL from `authorizePartner`.
   * @param authToken - The Partner API authorization token.
   * @param request - The group listing query parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The groups page object.
   */
  async listGroups(
    groupsApiUrl: string,
    authToken: string,
    request: ListGroupsRequest,
    options?: PartnerRawRequestOptions,
  ): Promise<ListGroupsResponse> {
    return this.getJson<ListGroupsResponse>(
      groupsApiUrl,
      authToken,
      'b2_list_groups',
      {
        adminAccountId: request.adminAccountId,
        ...(request.groupName !== undefined ? { groupName: request.groupName } : {}),
        ...(request.startGroupId !== undefined ? { startGroupId: request.startGroupId } : {}),
        ...(request.maxGroupCount !== undefined ? { maxGroupCount: request.maxGroupCount } : {}),
      },
      options,
    )
  }

  /**
   * Calls {@link https://www.backblaze.com/apidocs/b2-list-group-members | b2_list_group_members}.
   *
   * Uses the documented canonical GET form. The wire response is a JSON array
   * whose result objects surface `nextEmail` for cursor-based pagination.
   *
   * @param groupsApiUrl - The Partner API base URL from `authorizePartner`.
   * @param authToken - The Partner API authorization token.
   * @param request - The member listing query parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The group-member page result array.
   */
  async listGroupMembers(
    groupsApiUrl: string,
    authToken: string,
    request: ListGroupMembersRequest,
    options?: PartnerRawRequestOptions,
  ): Promise<ListGroupMembersResponse> {
    return this.getJson<ListGroupMembersResponse>(
      groupsApiUrl,
      authToken,
      'b2_list_group_members',
      {
        adminAccountId: request.adminAccountId,
        groupId: request.groupId,
        ...(request.startEmail !== undefined ? { startEmail: request.startEmail } : {}),
        ...(request.maxMemberCount !== undefined ? { maxMemberCount: request.maxMemberCount } : {}),
      },
      options,
    )
  }

  /**
   * Sends a JSON GET request to the specified Partner API endpoint.
   * @param groupsApiUrl - The Partner API base URL.
   * @param authToken - The Partner API authorization token.
   * @param endpoint - The Partner API endpoint name.
   * @param query - The query-string parameters.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async getJson<T>(
    groupsApiUrl: string,
    authToken: string,
    endpoint: string,
    query: QueryParams,
    options?: PartnerRawRequestOptions,
  ): Promise<T> {
    const safeGroupsApiUrl = validatePartnerRequestGroupsApiUrl(
      this.transport,
      this.partnerEndpointSuffixes,
      groupsApiUrl,
    )
    const response = await this.transport.send({
      url: withQueryString(b2Url(safeGroupsApiUrl, { ...PARTNER_API_V3, endpoint }), query),
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
   * Sends a JSON POST request to the specified Partner API endpoint.
   * @param groupsApiUrl - The Partner API base URL.
   * @param authToken - The Partner API authorization token.
   * @param endpoint - The Partner API endpoint name.
   * @param body - The JSON request body.
   * @param options - Optional abort and per-request retry settings.
   *
   * @returns The parsed JSON response.
   */
  private async postJson<T>(
    groupsApiUrl: string,
    authToken: string,
    endpoint: string,
    body: unknown,
    options?: PartnerRawRequestOptions,
  ): Promise<T> {
    const safeGroupsApiUrl = validatePartnerRequestGroupsApiUrl(
      this.transport,
      this.partnerEndpointSuffixes,
      groupsApiUrl,
    )
    const response = await this.transport.send({
      url: b2Url(safeGroupsApiUrl, { ...PARTNER_API_V3, endpoint }),
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
