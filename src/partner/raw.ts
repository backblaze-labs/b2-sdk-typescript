import { assertSecureRealmUrl } from '../auth/realms.ts'
import type { HttpTransport } from '../http/transport.ts'
import { type B2UrlOptions, b2Url } from '../raw/url.ts'
import type { PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'

type B2EndpointUrlOptions = Omit<B2UrlOptions, 'endpoint'>

const PARTNER_AUTHORIZE_API_V3: B2EndpointUrlOptions = { prefix: 'b2api', version: 'v3' }

/** Configuration for constructing a {@link PartnerRawClient}. */
export interface PartnerRawClientOptions {
  /** The HTTP transport used to send requests. */
  readonly transport: HttpTransport
}

interface WirePartnerSuiteInfo {
  readonly capabilities?: readonly PartnerCapability[]
}

interface WirePartnerGroupsApiInfo extends WirePartnerSuiteInfo {
  readonly groupsApiUrl: string
  readonly infoType?: 'groupsApi'
}

interface WirePartnerBackupApiInfo extends WirePartnerSuiteInfo {
  readonly backupApiUrl: string
  readonly infoType?: 'backupApi'
}

interface WirePartnerAuthorizeResponse {
  readonly accountId: string
  readonly authorizationToken: string
  readonly apiInfo: {
    readonly groupsApi?: WirePartnerGroupsApiInfo
    readonly backupApi?: WirePartnerBackupApiInfo
  }
  readonly applicationKeyExpirationTimestamp: number | null
}

function normalizePartnerAuthorizeResponse(
  response: WirePartnerAuthorizeResponse,
): PartnerAuthorizeResponse {
  const { groupsApi, backupApi } = response.apiInfo
  if (groupsApi === undefined) {
    throw new Error('Partner authorize response did not include apiInfo.groupsApi')
  }

  return {
    accountId: response.accountId as PartnerAuthorizeResponse['accountId'],
    authorizationToken:
      response.authorizationToken as PartnerAuthorizeResponse['authorizationToken'],
    groupsApiUrl: groupsApi.groupsApiUrl,
    ...(backupApi !== undefined ? { backupApiUrl: backupApi.backupApiUrl } : {}),
    groupsCapabilities: [...(groupsApi.capabilities ?? [])],
    ...(backupApi !== undefined ? { backupCapabilities: [...(backupApi.capabilities ?? [])] } : {}),
    applicationKeyExpirationTimestamp: response.applicationKeyExpirationTimestamp,
  }
}

/**
 * Low-level client for Partner API authorization and future Partner endpoints.
 */
export class PartnerRawClient {
  /** @internal */
  private readonly transport: HttpTransport

  /**
   * Creates a new PartnerRawClient with the given transport.
   *
   * @param options - The constructor configuration.
   */
  constructor(options: PartnerRawClientOptions) {
    this.transport = options.transport
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
   * @throws Error if the response does not include the Partner `groupsApi` suite.
   */
  async authorizePartner(
    masterKeyId: string,
    masterKey: string,
    realmUrl = 'https://api.backblazeb2.com',
  ): Promise<PartnerAuthorizeResponse> {
    assertSecureRealmUrl(realmUrl)
    const response = await this.transport.send({
      url: b2Url(realmUrl, { ...PARTNER_AUTHORIZE_API_V3, endpoint: 'b2_authorize_account' }),
      method: 'GET',
      headers: {
        Authorization: `Basic ${btoa(`${masterKeyId}:${masterKey}`)}`,
      },
    })
    return normalizePartnerAuthorizeResponse(await response.json<WirePartnerAuthorizeResponse>())
  }
}
