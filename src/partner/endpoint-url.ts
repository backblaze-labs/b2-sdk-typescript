import { B2PartnerAuthorizationError } from '../errors/index.ts'
import type { RetryOptions } from '../http/retry.ts'
import { getTransportUrlGuard, type HttpTransport } from '../http/transport.ts'
import { hostMatchesAllowedSuffix, UrlGuard } from '../http/url-guard.ts'

/** Partner authorize endpoint URL field names that are validated before token use. */
export type PartnerEndpointUrlField = 'groupsApiUrl' | 'backupApiUrl'

/** Message copy for resolving endpoint suffixes from an authorized or guarded transport. */
export interface EndpointAllowedSuffixMessages {
  /** Error message when no validated suffixes and no URL guard are available. */
  readonly missingGuard: string
  /** Error message when a URL guard exists but has not been locked to suffixes. */
  readonly unlockedGuard: string
}

/** Query-string scalar value supported by Partner and Backup endpoint helpers. */
export type QueryValue = string | number
/** Query-string parameter map supported by Partner and Backup endpoint helpers. */
export type QueryParams = Readonly<Record<string, QueryValue>>

/** Shared request options shape for non-idempotent Partner and Backup mutations. */
export interface MutationRequestOptions {
  /** Abort signal for cancelling the request. */
  readonly signal?: AbortSignal
  /** Per-request retry override. */
  readonly retry?: Partial<RetryOptions>
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === '[::1]' || host === '::1') return true

  const parts = host.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255)
  )
}

function hostAllowedBySuffixes(hostname: string, allowedSuffixes: readonly string[]): boolean {
  return allowedSuffixes.some((suffix) => hostMatchesAllowedSuffix(hostname, suffix))
}

/**
 * Resolves endpoint host suffixes from fresh/cached Partner authorization or a locked transport guard.
 *
 * @param transport - Transport whose URL guard may already be locked.
 * @param authorizedSuffixes - Suffixes derived from validated Partner authorization.
 * @param messages - Surface-specific failure messages.
 *
 * @returns The suffixes safe for credential-bearing endpoint requests.
 *
 * @throws B2PartnerAuthorizationError if no locked guard or authorized suffixes exist.
 *
 * @internal
 */
export function endpointAllowedSuffixes(
  transport: HttpTransport,
  authorizedSuffixes: readonly string[],
  messages: EndpointAllowedSuffixMessages,
): readonly string[] {
  if (authorizedSuffixes.length > 0) return authorizedSuffixes

  const guard = getTransportUrlGuard(transport)
  if (guard === undefined) {
    throw new B2PartnerAuthorizationError(messages.missingGuard)
  }

  const suffixes = guard.getAllowedSuffixes()
  if (suffixes.length === 0) {
    throw new B2PartnerAuthorizationError(messages.unlockedGuard)
  }

  return suffixes
}

/**
 * Validates a Partner-derived endpoint URL before a Partner token is sent to it.
 *
 * @param rawUrl - Endpoint URL from Partner authorization or cache.
 * @param fieldName - Authorize-response field being validated.
 * @param allowedSuffixes - Host suffix allow-list derived from the trusted realm.
 *
 * @returns The original URL when it is safe to use.
 *
 * @throws B2PartnerAuthorizationError if the URL is malformed or unsafe.
 *
 * @internal
 */
export function validatePartnerEndpointUrl(
  rawUrl: string,
  fieldName: PartnerEndpointUrlField,
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

  const host = url.hostname.toLowerCase()
  const isAllowedLoopbackHttp =
    url.protocol === 'http:' && isLoopbackHost(host) && hostAllowedBySuffixes(host, allowedSuffixes)

  if (url.protocol !== 'https:' && !isAllowedLoopbackHttp) {
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

  if (isAllowedLoopbackHttp) return rawUrl

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

/**
 * Appends query parameters using the SDK's B2 URL encoding semantics.
 *
 * @param url - Base URL without query string.
 * @param query - Query keys and string/number values to append.
 *
 * @returns URL with encoded query parameters, or the original URL for an empty query.
 *
 * @internal
 */
export function withQueryString(url: string, query: QueryParams): string {
  // Match the storage raw client's encodeURIComponent query semantics: spaces
  // are `%20`, not form-style `+`.
  const queryString = Object.entries(query)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&')
  return queryString.length === 0 ? url : `${url}?${queryString}`
}

/**
 * Forces non-idempotent mutation calls to opt out of automatic request replay.
 *
 * @param options - Caller-provided request options.
 *
 * @returns Request options with `retry.maxRetries` set to zero.
 *
 * @internal
 */
export function nonRetryingMutationRequestOptions(
  options: MutationRequestOptions | undefined,
): MutationRequestOptions {
  return {
    ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    retry: { ...(options?.retry ?? {}), maxRetries: 0 },
  }
}
