/**
 * URL allow-list guard. Defends against SSRF / URL-substitution attacks where
 * a compromised or hostile B2 endpoint returns an upload URL pointing at an
 * internal service (e.g. cloud metadata at `169.254.169.254`).
 *
 * The guard is built once per `B2Client` and updated by `B2Client.authorize()`.
 * Before authorization it is permissive (so the very first
 * `b2_authorize_account` request, whose URL the user configured, can succeed).
 * After authorization it is locked to host suffixes derived from the realm's
 * apiUrl/downloadUrl/s3ApiUrl, plus the well-known B2 upload-pod parent
 * domain `backblaze.com`.
 *
 * The guard runs in `FetchTransport` before any outgoing request. It rejects:
 *
 *   1. Literal IPv4/IPv6 addresses (defense in depth, covers attempts to
 *      bypass DNS-based checks with raw IPs).
 *   2. Well-known internal hostnames (`localhost`, `metadata`,
 *      `metadata.google.internal`, `.internal`, `.local`).
 *   3. Hosts not matching any allowed suffix once the SDK is locked.
 *
 * Users supplying a custom `transport` to `B2Client` bypass the guard. That
 * is their responsibility to document for their threat model.
 *
 * Threat-model note: the guard checks the URL's hostname before the
 * `fetch()` call. It does NOT pin the resolved IP. A DNS rebinding attack
 * could in principle resolve a permitted hostname to an internal IP between
 * the guard's check and `fetch()`'s own resolution. This is theoretical
 * against B2 because the allow-list is locked to a small set of stable
 * Backblaze hostnames (the realm's apiUrl/downloadUrl/s3ApiUrl plus the
 * `backblaze.com` parent), and DNS rebinding requires a hostname under
 * attacker control. Defense in depth — pinning the IP from the first
 * resolution and rejecting subsequent mismatches — would break legitimate
 * CDN failovers and is not justified at this surface area. If your
 * threat model requires it, supply a custom transport that does.
 */

import { B2SsrfError } from '../errors/index.ts'

/** A URL allow-list that can be reconfigured after construction. */
export class UrlGuard {
  private allowedSuffixes: readonly string[] = []

  /**
   * Lock the guard to the given host suffixes. A suffix matches a host
   * either exactly or as a `*.suffix` subdomain. For example,
   * `backblazeb2.com` allows `api.backblazeb2.com` and
   * `s3.us-west-004.backblazeb2.com`.
   *
   * Passing an empty array disables the guard (used by the simulator and
   * other test setups). Production code should always lock the guard after
   * a successful `b2_authorize_account`.
   *
   * @param suffixes - Allowed host suffixes.
   */
  setAllowedSuffixes(suffixes: readonly string[]): void {
    this.allowedSuffixes = suffixes
  }

  /**
   * Returns the current allowed-suffix list (for tests and diagnostics).
   *
   * @returns The currently-configured list of allowed host suffixes.
   */
  getAllowedSuffixes(): readonly string[] {
    return this.allowedSuffixes
  }

  /**
   * Validate `rawUrl` against the allow-list. Throws {@link B2SsrfError} if
   * the URL points at a literal IP, a known-internal hostname, or a host
   * outside the allowed suffixes. Permissive (no-op) when no suffixes have
   * been configured yet.
   *
   * @param rawUrl - The URL the caller is about to fetch.
   *
   * @throws A `B2SsrfError` when the URL is rejected.
   */
  check(rawUrl: string): void {
    if (this.allowedSuffixes.length === 0) return

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      throw new B2SsrfError(`malformed URL rejected by SSRF guard: ${rawUrl}`, rawUrl)
    }

    const host = parsed.hostname.toLowerCase()

    if (isLiteralIp(host)) {
      throw new B2SsrfError(
        `literal IP host not allowed by SSRF guard (use a hostname): ${host}`,
        rawUrl,
      )
    }

    if (isInternalHostname(host)) {
      throw new B2SsrfError(`internal hostname not allowed by SSRF guard: ${host}`, rawUrl)
    }

    for (const suffix of this.allowedSuffixes) {
      const lowered = suffix.toLowerCase()
      if (host === lowered || host.endsWith(`.${lowered}`)) return
    }

    throw new B2SsrfError(
      `host outside allowed B2 realm: ${host} (allowed suffixes: ${this.allowedSuffixes.join(', ')})`,
      rawUrl,
    )
  }
}

/**
 * Extract host suffixes to allow from a B2 authorize-account response.
 *
 * Known B2 realm hosts under `backblazeb2.com` are collapsed to that parent.
 * Unknown or custom realm hosts are used as scoped suffixes: the returned
 * hostname and its subdomains are allowed, but sibling hosts and parent
 * domains are not. This avoids accidentally trusting broad public suffixes
 * such as `co.uk`.
 *
 * Always includes `backblaze.com` because upload-pod URLs returned by
 * `b2_get_upload_url` use that parent domain (`pod-NNN-NNNN-NN.backblaze.com`)
 * rather than `backblazeb2.com`.
 *
 * @param storageApi - The `apiInfo.storageApi` portion of the authorize response.
 *
 * @returns Sorted list of unique host suffixes to allow.
 */
export function deriveAllowedSuffixes(storageApi: {
  apiUrl: string
  downloadUrl: string
  s3ApiUrl: string
}): readonly string[] {
  const suffixes = new Set<string>(['backblaze.com'])
  for (const url of [storageApi.apiUrl, storageApi.downloadUrl, storageApi.s3ApiUrl]) {
    try {
      const host = new URL(url).hostname
      suffixes.add(
        host === 'backblazeb2.com' || host.endsWith('.backblazeb2.com') ? 'backblazeb2.com' : host,
      )
    } catch {
      // Skip malformed URLs. The auth response is from B2 itself; malformed
      // entries would already have caused other failures upstream.
    }
  }
  return Array.from(suffixes).sort()
}

function isLiteralIp(host: string): boolean {
  // IPv4 dotted quad: e.g. 169.254.169.254
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  // IPv6: URL.hostname strips the brackets but keeps colons. Any colon in a
  // hostname is an IPv6 literal.
  if (host.includes(':')) return true
  return false
}

function isInternalHostname(host: string): boolean {
  if (host === 'localhost') return true
  if (host.endsWith('.localhost')) return true
  if (host === 'metadata') return true
  if (host === 'metadata.google.internal') return true
  if (host.endsWith('.internal')) return true
  if (host.endsWith('.local')) return true
  return false
}
