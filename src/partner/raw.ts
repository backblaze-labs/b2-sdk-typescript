import { assertSecureRealmUrl } from '../auth/realms.ts'
import { B2PartnerAuthorizationError, B2RealmConfigurationError } from '../errors/index.ts'
import { FetchTransport, type HttpTransport } from '../http/transport.ts'
import { hostMatchesAllowedSuffix, UrlGuard } from '../http/url-guard.ts'
import { type B2EndpointUrlOptions, b2Url } from '../raw/url.ts'
import { accountId, partnerToken } from '../types/ids.ts'
import type {
  PartnerApiInfo,
  PartnerAuthorizeResponse,
  PartnerBackupApiInfo,
  PartnerGroupsApiInfo,
} from '../types/partner.ts'
import { redactPartnerAuthorizeResponse } from './redaction.ts'

const PARTNER_AUTHORIZE_API_V3: B2EndpointUrlOptions = { prefix: 'b2api', version: 'v3' }
const DEFAULT_PARTNER_REALM_URL = 'https://api.backblazeb2.com'
const PRODUCTION_HOST_SUFFIX = 'backblazeb2.com'
const STAGING_HOST_SUFFIX = 'backblaze.net'
const VERIFIED_PARTNER_AUTHORIZE_REALM_ORIGINS = new Set([
  'https://api.backblazeb2.com',
  'https://api.backblaze.net',
])

/** Configuration for constructing a {@link PartnerRawClient}. */
export interface PartnerRawClientOptions {
  /** The HTTP transport used to send requests. */
  readonly transport: HttpTransport
  /**
   * Allow direct custom authorize realms for tests or private proxies.
   * Leave disabled unless the configured host is trusted with the Master Application Key.
   */
  readonly allowCustomAuthorizeRealm?: boolean
}

interface WirePartnerAuthorizeResponse {
  readonly accountId: string
  readonly authorizationToken: string
  readonly apiInfo: PartnerApiInfo
  readonly applicationKeyExpirationTimestamp: number | null
}

function assertVerifiedPartnerAuthorizeRealm(realmUrl: string, allowCustomAuthorizeRealm: boolean) {
  if (allowCustomAuthorizeRealm) return

  const realm = new URL(realmUrl)
  if (VERIFIED_PARTNER_AUTHORIZE_REALM_ORIGINS.has(realm.origin)) return

  throw new B2RealmConfigurationError(
    `refusing to send Master Application Key credentials to unverified Partner authorize realm: ${realm.origin}`,
  )
}

function endpointAllowedSuffixesForRealm(realmUrl: string): readonly string[] {
  const realmHost = new URL(realmUrl).hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(realmHost, PRODUCTION_HOST_SUFFIX)) return [PRODUCTION_HOST_SUFFIX]
  if (hostMatchesAllowedSuffix(realmHost, STAGING_HOST_SUFFIX)) return [STAGING_HOST_SUFFIX]
  return [realmHost]
}

function endpointAllowedSuffix(url: string): string {
  const host = new URL(url).hostname.toLowerCase()
  if (hostMatchesAllowedSuffix(host, PRODUCTION_HOST_SUFFIX)) return PRODUCTION_HOST_SUFFIX
  if (hostMatchesAllowedSuffix(host, STAGING_HOST_SUFFIX)) return STAGING_HOST_SUFFIX
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
  guard.setAllowedSuffixes(allowedSuffixes)
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
): PartnerAuthorizeResponse {
  const { groupsApi, backupApi } = response.apiInfo
  if (groupsApi === undefined) {
    throw new B2PartnerAuthorizationError(
      'Partner authorize response did not include apiInfo.groupsApi',
    )
  }

  const allowedSuffixes = endpointAllowedSuffixesForRealm(realmUrl)
  const normalizedGroupsApi = normalizeGroupsApi(groupsApi, allowedSuffixes)
  const normalizedBackupApi =
    backupApi !== undefined ? normalizeBackupApi(backupApi, allowedSuffixes) : undefined
  const apiInfo: PartnerApiInfo = {
    ...(response.apiInfo.storageApi !== undefined
      ? { storageApi: response.apiInfo.storageApi }
      : {}),
    groupsApi: normalizedGroupsApi,
    ...(normalizedBackupApi !== undefined ? { backupApi: normalizedBackupApi } : {}),
  }
  const normalized: PartnerAuthorizeResponse = {
    accountId: accountId(response.accountId),
    authorizationToken: partnerToken(response.authorizationToken),
    apiInfo,
    groupsApiUrl: normalizedGroupsApi.groupsApiUrl,
    ...(normalizedBackupApi !== undefined
      ? { backupApiUrl: normalizedBackupApi.backupApiUrl }
      : {}),
    groupsCapabilities: normalizedGroupsApi.capabilities,
    ...(normalizedBackupApi !== undefined
      ? { backupCapabilities: normalizedBackupApi.capabilities }
      : {}),
    applicationKeyExpirationTimestamp: response.applicationKeyExpirationTimestamp,
  }

  return redactPartnerAuthorizeResponse(normalized)
}

function derivePartnerAllowedSuffixes(auth: PartnerAuthorizeResponse): readonly string[] {
  const suffixes = new Set<string>([endpointAllowedSuffix(auth.groupsApiUrl)])
  if (auth.backupApiUrl !== undefined) suffixes.add(endpointAllowedSuffix(auth.backupApiUrl))
  return Array.from(suffixes).sort()
}

function lockFetchTransportUrlGuard(
  transport: HttpTransport,
  auth: PartnerAuthorizeResponse,
): void {
  if (transport instanceof FetchTransport) {
    transport.urlGuard.setAllowedSuffixes(derivePartnerAllowedSuffixes(auth))
  }
}

/**
 * Low-level client for Partner API authorization and future Partner endpoints.
 */
export class PartnerRawClient {
  /** @internal */
  private readonly transport: HttpTransport
  private readonly allowCustomAuthorizeRealm: boolean

  /**
   * Creates a new PartnerRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: PartnerRawClientOptions) {
    this.transport = options.transport
    this.allowCustomAuthorizeRealm = options.allowCustomAuthorizeRealm ?? false
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
      url: b2Url(realmUrl, { ...PARTNER_AUTHORIZE_API_V3, endpoint: 'b2_authorize_account' }),
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${masterKeyId}:${masterKey}`)}`,
      },
    })
    const auth = normalizePartnerAuthorizeResponse(
      await response.json<WirePartnerAuthorizeResponse>(),
      realmUrl,
    )
    lockFetchTransportUrlGuard(this.transport, auth)
    return auth
  }
}
