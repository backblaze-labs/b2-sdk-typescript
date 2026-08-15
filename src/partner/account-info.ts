import type { AccountId, PartnerToken } from '../types/ids.ts'
import type { PartnerAuthorizeResponse, PartnerCapability } from '../types/partner.ts'

/**
 * Stores Partner API and Computer Backup authorization state between requests.
 *
 * Reauthorization follows the storage client's `RetryTransport.onReauth`
 * contract: re-run `PartnerRawClient.authorizePartner` with the same Master
 * Application Key credentials, store the fresh response with `setAuth`, then
 * return `authorizationToken` to the retry transport.
 */
export interface PartnerAccountInfo {
  /** Store a fresh Partner authorization response, replacing any previous state. */
  setAuth(auth: PartnerAuthorizeResponse): void
  /** Return the current Partner authorization response, or null if not authorized. */
  getAuth(): PartnerAuthorizeResponse | null
  /** Discard all cached Partner authorization state. */
  clear(): void

  /** Current Partner/Backup authorization token. */
  getPartnerToken(): PartnerToken
  /** Base URL for Partner API calls, or null when the suite is unavailable. */
  getGroupsApiUrl(): string | null
  /** Base URL for Computer Backup API calls, or null when the suite is unavailable. */
  getBackupApiUrl(): string | null
  /** The authorized partner administrator account ID. */
  getAccountId(): AccountId
  /** Capabilities granted for Partner API calls, or null when the suite is unavailable. */
  getGroupsCapabilities(): readonly PartnerCapability[] | null
  /** Capabilities granted for Computer Backup API calls, or null when the suite is unavailable. */
  getBackupCapabilities(): readonly PartnerCapability[] | null
}
