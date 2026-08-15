import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { AccountId, PartnerToken } from '../types/ids.ts'
import type { PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'
import type { PartnerAccountInfo } from './account-info.ts'
import { validatePartnerAuthorizeResponseShape } from './auth-shape.ts'
import {
  PARTNER_TOKEN_REDACTED,
  partnerAuthorizeResponseToRedactedJson,
  type RedactedPartnerAuthorizeResponseJson,
  redactPartnerAuthorizeResponse,
} from './redaction.ts'

function clonePartnerAuth(auth: PartnerAuthorizeResponse): PartnerAuthorizeResponse {
  validatePartnerAuthorizeResponseShape(auth)

  const groupsApi =
    auth.apiInfo.groupsApi === undefined
      ? undefined
      : {
          ...auth.apiInfo.groupsApi,
          capabilities: [...auth.apiInfo.groupsApi.capabilities],
          infoType: 'groupsApi' as const,
        }
  const backupApi =
    auth.apiInfo.backupApi === undefined
      ? undefined
      : {
          ...auth.apiInfo.backupApi,
          capabilities: [...auth.apiInfo.backupApi.capabilities],
          infoType: 'backupApi' as const,
        }
  const cloned: PartnerAuthorizeResponse = {
    accountId: auth.accountId,
    authorizationToken: auth.authorizationToken,
    apiInfo: {
      ...(auth.apiInfo.storageApi !== undefined ? { storageApi: auth.apiInfo.storageApi } : {}),
      ...(groupsApi !== undefined ? { groupsApi } : {}),
      ...(backupApi !== undefined ? { backupApi } : {}),
    },
    ...(groupsApi !== undefined ? { groupsApiUrl: groupsApi.groupsApiUrl } : {}),
    ...(backupApi !== undefined ? { backupApiUrl: backupApi.backupApiUrl } : {}),
    ...(groupsApi !== undefined ? { groupsCapabilities: groupsApi.capabilities } : {}),
    ...(backupApi !== undefined ? { backupCapabilities: backupApi.capabilities } : {}),
    applicationKeyExpirationTimestamp: auth.applicationKeyExpirationTimestamp,
  }

  return redactPartnerAuthorizeResponse(cloned)
}

/**
 * In-memory implementation of {@link PartnerAccountInfo}.
 * Suitable for short-lived processes or tests; state is lost when the process exits.
 */
export class InMemoryPartnerAccountInfo implements PartnerAccountInfo {
  /** Cached Partner authorization response, or null before authorizePartner() is called. */
  #auth: PartnerAuthorizeResponse | null = null

  /**
   * Store a fresh Partner authorization response, replacing any previous state.
   *
   * @param auth - The Partner authorize response to store.
   */
  setAuth(auth: PartnerAuthorizeResponse): void {
    this.#auth = clonePartnerAuth(auth)
  }

  /**
   * Return the current Partner authorization response, or null if not authorized.
   *
   * @returns The cached Partner authorization response, or null if not yet authorized.
   */
  getAuth(): PartnerAuthorizeResponse | null {
    return this.#auth
  }

  /** Discard all cached Partner authorization state. */
  clear(): void {
    this.#auth = null
  }

  /**
   * Current Partner/Backup authorization token.
   *
   * @returns The current Partner token.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getPartnerToken(): PartnerToken {
    return this.requireAuth().authorizationToken
  }

  /**
   * Base URL for Partner API calls.
   *
   * @returns The base URL for Partner API calls.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getGroupsApiUrl(): string | null {
    return this.requireAuth().apiInfo.groupsApi?.groupsApiUrl ?? null
  }

  /**
   * Base URL for Computer Backup API calls, or null when the suite is unavailable.
   *
   * @returns The Computer Backup API URL, or null.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getBackupApiUrl(): string | null {
    return this.requireAuth().backupApiUrl ?? null
  }

  /**
   * The authorized partner administrator account ID.
   *
   * @returns The authorized account identifier.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getAccountId(): AccountId {
    return this.requireAuth().accountId
  }

  /**
   * Capabilities granted for Partner API calls.
   *
   * @returns The Partner API capabilities.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getGroupsCapabilities(): readonly PartnerCapability[] | null {
    return this.requireAuth().apiInfo.groupsApi?.capabilities ?? null
  }

  /**
   * Capabilities granted for Computer Backup API calls, or null when the suite is unavailable.
   *
   * @returns The Computer Backup API capabilities, or null.
   *
   * @throws B2PartnerAuthorizationError if not yet authorized.
   */
  getBackupCapabilities(): readonly PartnerCapability[] | null {
    return this.requireAuth().backupCapabilities ?? null
  }

  /**
   * Hides the Partner token from `JSON.stringify(accountInfo)`.
   *
   * @returns Redacted Partner auth state, or null when not authorized.
   */
  toJSON(): { readonly auth: RedactedPartnerAuthorizeResponseJson | null } {
    return {
      auth: this.#auth === null ? null : partnerAuthorizeResponseToRedactedJson(this.#auth),
    }
  }

  /**
   * Hides the Partner token from default stringification.
   *
   * @returns A short opaque label for this account info store.
   */
  toString(): string {
    return this.#auth === null
      ? '[InMemoryPartnerAccountInfo unauthorized]'
      : `[InMemoryPartnerAccountInfo ${PARTNER_TOKEN_REDACTED}]`
  }

  /**
   * Hides the Partner token from Node's `util.inspect`.
   *
   * @returns A short opaque label for this account info store.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString()
  }

  /**
   * Retrieve the cached auth response or throw if not yet authorized.
   *
   * @returns The cached authorization response.
   *
   * @throws B2PartnerAuthorizationError if authorizePartner() has not been called.
   */
  private requireAuth(): PartnerAuthorizeResponse {
    if (!this.#auth) {
      throw new B2PartnerAuthorizationError('Not authorized. Call authorizePartner() first.')
    }
    return this.#auth
  }
}
