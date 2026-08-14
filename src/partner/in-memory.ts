import type { AccountId, PartnerToken } from '../types/ids.ts'
import type { PartnerAuthorizeResponse } from '../types/partner.ts'
import type { PartnerAccountInfo } from './account-info.ts'

/**
 * In-memory implementation of {@link PartnerAccountInfo}.
 * Suitable for short-lived processes or tests; state is lost when the process exits.
 */
export class InMemoryPartnerAccountInfo implements PartnerAccountInfo {
  /** Cached Partner authorization response, or null before authorizePartner() is called. */
  private auth: PartnerAuthorizeResponse | null = null

  /**
   * Store a fresh Partner authorization response, replacing any previous state.
   *
   * @param auth - The Partner authorize response to store.
   */
  setAuth(auth: PartnerAuthorizeResponse): void {
    this.auth = auth
  }

  /**
   * Return the current Partner authorization response, or null if not authorized.
   *
   * @returns The cached Partner authorization response, or null if not yet authorized.
   */
  getAuth(): PartnerAuthorizeResponse | null {
    return this.auth
  }

  /** Discard all cached Partner authorization state. */
  clear(): void {
    this.auth = null
  }

  /**
   * Current Partner/Backup authorization token.
   *
   * @returns The current Partner token.
   *
   * @throws Error if not yet authorized.
   */
  getPartnerToken(): PartnerToken {
    return this.requireAuth().authorizationToken
  }

  /**
   * Base URL for Partner API calls.
   *
   * @returns The base URL for Partner API calls.
   *
   * @throws Error if not yet authorized.
   */
  getGroupsApiUrl(): string {
    return this.requireAuth().groupsApiUrl
  }

  /**
   * Base URL for Computer Backup API calls, or null when the suite is unavailable.
   *
   * @returns The Computer Backup API URL, or null.
   *
   * @throws Error if not yet authorized.
   */
  getBackupApiUrl(): string | null {
    return this.requireAuth().backupApiUrl ?? null
  }

  /**
   * The authorized partner administrator account ID.
   *
   * @returns The authorized account identifier.
   *
   * @throws Error if not yet authorized.
   */
  getAccountId(): AccountId {
    return this.requireAuth().accountId
  }

  /**
   * Capabilities granted for Partner API calls.
   *
   * @returns The Partner API capabilities.
   *
   * @throws Error if not yet authorized.
   */
  getGroupsCapabilities(): ReturnType<PartnerAccountInfo['getGroupsCapabilities']> {
    return this.requireAuth().groupsCapabilities
  }

  /**
   * Capabilities granted for Computer Backup API calls, or null when the suite is unavailable.
   *
   * @returns The Computer Backup API capabilities, or null.
   *
   * @throws Error if not yet authorized.
   */
  getBackupCapabilities(): ReturnType<PartnerAccountInfo['getBackupCapabilities']> {
    return this.requireAuth().backupCapabilities ?? null
  }

  /**
   * Retrieve the cached auth response or throw if not yet authorized.
   *
   * @returns The cached authorization response.
   *
   * @throws Error if authorizePartner() has not been called.
   */
  private requireAuth(): PartnerAuthorizeResponse {
    if (!this.auth) throw new Error('Not authorized. Call authorizePartner() first.')
    return this.auth
  }
}
