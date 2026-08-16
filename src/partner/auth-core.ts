import { getRealmUrl } from '../auth/realms.ts'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions } from '../http/retry.ts'
import type { HttpTransport } from '../http/transport.ts'
import { FetchTransport, RetryTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import type { PartnerAuthorizeResponse } from '../types/partner.ts'
import { abortReason, raceWithAbort, throwIfSignalAborted } from '../util/abort.ts'
import type { PartnerAccountInfo } from './account-info.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import {
  derivePartnerAllowedSuffixes,
  PartnerRawClient,
  validatePartnerAuthorizeResponseEndpoints,
} from './raw.ts'

/** Shared Partner authorization options used by Partner and Backup facades. */
export interface PartnerAuthCoreOptions {
  /** The Master Application Key ID for the partner administrator account. */
  readonly masterKeyId: string
  /** The Master Application Key secret. */
  readonly masterKey: string
  /** B2 realm alias or direct trusted realm URL. Defaults to `"production"`. */
  readonly realm?: string
  /** Storage backend for Partner authorization state. */
  readonly partnerAccountInfo?: PartnerAccountInfo
  /** Custom HTTP transport. Defaults to {@link FetchTransport}. */
  readonly transport?: HttpTransport
  /** Override retry behavior for retryable requests. */
  readonly retry?: Partial<RetryOptions>
  /** Custom user-agent string prepended to the SDK default. */
  readonly userAgent?: string
  /** Extra trusted host suffixes to merge into the default SSRF guard. */
  readonly additionalAllowedHostSuffixes?: readonly string[]
  /** Explicitly disable default SSRF guard suffix locking. */
  readonly disableSsrfGuard?: boolean
  /** Whether the default fetch transport may follow same-origin GET/HEAD redirects. */
  readonly followSameOriginRedirects?: boolean
  /** Allow direct custom authorize realms for tests or private proxies. */
  readonly allowCustomAuthorizeRealm?: boolean
}

/** Options for Partner authorization through {@link PartnerAuthCore}. */
export interface PartnerAuthCoreAuthorizeOptions {
  /** Abort signal for cancelling the authorize request. */
  readonly signal?: AbortSignal
}

interface InflightPartnerReauth {
  readonly controller: AbortController
  readonly promise: Promise<string>
  waiters: number
  settled: boolean
}

/**
 * Internal Partner authorization state machine shared by public facades.
 *
 * @internal
 */
export class PartnerAuthCore {
  /** Low-level Partner raw client used for authorization and Partner endpoints. */
  readonly raw: PartnerRawClient
  /** Partner authorization state storage. */
  readonly partnerAccountInfo: PartnerAccountInfo
  /** Default transport URL guard, or null when a custom transport owns guarding. */
  readonly urlGuard: UrlGuard | null
  /** Retry-wrapped transport shared by facade-specific raw clients. */
  readonly transport: HttpTransport
  /** Resolved Partner authorize realm URL. */
  readonly realmUrl: string
  /** Whether custom authorize realms are trusted. */
  readonly allowCustomAuthorizeRealm: boolean
  /** Endpoint suffixes validated from cached authorization during construction. */
  readonly cachedEndpointSuffixes: readonly string[] | undefined
  readonly #masterKeyId: string
  readonly #masterKey: string
  private readonly additionalAllowedSuffixes: readonly string[] | undefined
  private readonly disableSsrfGuard: boolean
  #inflightReauth: InflightPartnerReauth | null = null

  /**
   * Creates a shared Partner authorization core.
   *
   * @param options - Credentials, state storage, transport, retry, and guard settings.
   */
  constructor(options: PartnerAuthCoreOptions) {
    this.#masterKeyId = options.masterKeyId
    this.#masterKey = options.masterKey
    this.realmUrl = getRealmUrl(options.realm ?? 'production')
    this.partnerAccountInfo = options.partnerAccountInfo ?? new InMemoryPartnerAccountInfo()
    this.additionalAllowedSuffixes = options.additionalAllowedHostSuffixes
    this.disableSsrfGuard = options.disableSsrfGuard ?? false
    this.allowCustomAuthorizeRealm = options.allowCustomAuthorizeRealm ?? false

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

    this.transport = new RetryTransport({
      transport: baseTransport,
      retry: { ...DEFAULT_RETRY_OPTIONS, ...options.retry },
      onReauth: (signal) => this.reauthorize(signal),
    })

    this.cachedEndpointSuffixes = this.validateCachedAuth()
    if (this.cachedEndpointSuffixes !== undefined) {
      this.lockUrlGuardFromSuffixes(this.cachedEndpointSuffixes)
    }

    this.raw = new PartnerRawClient({
      transport: this.transport,
      ...(this.cachedEndpointSuffixes !== undefined
        ? { authorizedPartnerEndpointSuffixes: this.cachedEndpointSuffixes }
        : {}),
      ...(options.allowCustomAuthorizeRealm !== undefined
        ? { allowCustomAuthorizeRealm: options.allowCustomAuthorizeRealm }
        : {}),
    })
  }

  /**
   * Authenticates with B2 Partner authorization and stores the authorization state.
   *
   * @param options - Optional abort signal.
   *
   * @returns The normalized Partner authorization response.
   */
  async authorize(options?: PartnerAuthCoreAuthorizeOptions): Promise<PartnerAuthorizeResponse> {
    throwIfSignalAborted(options?.signal)
    const auth = await this.raw.authorizePartner(
      this.#masterKeyId,
      this.#masterKey,
      this.realmUrl,
      options?.signal !== undefined ? { signal: options.signal } : undefined,
    )
    throwIfSignalAborted(options?.signal)
    this.partnerAccountInfo.setAuth(auth)
    this.lockUrlGuard(auth)
    return auth
  }

  /**
   * Locks the default transport URL guard to suffixes from a validated auth response.
   *
   * @param auth - Partner authorization response to derive suffixes from.
   */
  lockUrlGuard(auth: PartnerAuthorizeResponse): void {
    this.lockUrlGuardFromSuffixes(derivePartnerAllowedSuffixes(auth, this.realmUrl))
  }

  /**
   * Locks the default transport URL guard to previously validated endpoint suffixes.
   *
   * @param derived - Validated endpoint suffixes.
   */
  lockUrlGuardFromSuffixes(derived: readonly string[]): void {
    if (this.urlGuard === null) return
    const merged =
      this.disableSsrfGuard === true
        ? []
        : this.additionalAllowedSuffixes !== undefined
          ? Array.from(new Set([...derived, ...this.additionalAllowedSuffixes]))
          : derived
    this.urlGuard.setAllowedSuffixes(merged)
  }

  private validateCachedAuth(): readonly string[] | undefined {
    const cachedAuth = this.partnerAccountInfo.getAuth()
    if (cachedAuth === null) return undefined
    try {
      return validatePartnerAuthorizeResponseEndpoints(
        cachedAuth,
        this.realmUrl,
        this.allowCustomAuthorizeRealm,
      )
    } catch {
      this.partnerAccountInfo.clear()
      return undefined
    }
  }

  private reauthorize(signal: AbortSignal | undefined): Promise<string> {
    throwIfSignalAborted(signal)
    const inflight = this.#inflightReauth ?? this.startReauthorize()
    inflight.waiters += 1
    return raceWithAbort(inflight.promise, signal).finally(() => {
      inflight.waiters -= 1
      if (inflight.waiters === 0 && !inflight.settled && !inflight.controller.signal.aborted) {
        inflight.controller.abort(signal?.aborted === true ? abortReason(signal) : undefined)
      }
    })
  }

  private startReauthorize(): InflightPartnerReauth {
    const controller = new AbortController()
    const promise = raceWithAbort(this.doReauthorize(controller.signal), controller.signal).finally(
      () => {
        if (this.#inflightReauth?.controller !== controller) return
        this.#inflightReauth.settled = true
        this.#inflightReauth = null
      },
    )
    const inflight: InflightPartnerReauth = {
      controller,
      promise,
      waiters: 0,
      settled: false,
    }
    this.#inflightReauth = inflight
    return inflight
  }

  private async doReauthorize(signal: AbortSignal): Promise<string> {
    const auth = await this.authorize({ signal })
    return auth.authorizationToken
  }
}
