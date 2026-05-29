import { B2Error, classifyError, ExpiredAuthTokenError, NetworkError } from '../errors/index.ts'
import type { B2ErrorResponse } from '../types/errors.ts'
import { computeBackoff, DEFAULT_RETRY_OPTIONS, type RetryOptions, sleep } from './retry.ts'
import { UrlGuard } from './url-guard.ts'
import { getUserAgent } from './user-agent.ts'

/** Describes an outgoing HTTP request to the B2 API. */
export interface HttpRequest {
  /** Fully qualified URL to send the request to. */
  readonly url: string
  /** HTTP method. B2 uses GET for downloads (HEAD to fetch only headers) and POST for all other operations. */
  readonly method: 'GET' | 'HEAD' | 'POST'
  /** Request headers. Authorization and content-type are typically included. */
  readonly headers?: Record<string, string>
  /** Request body. Used for POST requests (JSON payloads or file uploads). */
  readonly body?: BodyInit | null
  /** Optional abort signal for request cancellation. */
  readonly signal?: AbortSignal
}

/** Represents a parsed HTTP response from the B2 API. */
export interface HttpResponse {
  /** HTTP status code. */
  readonly status: number
  /** Response headers. */
  readonly headers: Headers
  /** Response body as a readable stream, or null for empty responses. */
  readonly body: ReadableStream<Uint8Array> | null
  /** Parses the response body as JSON. */
  json<T>(): Promise<T>
  /** Reads the response body as a UTF-8 string. */
  text(): Promise<string>
  /** Reads the response body as an ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>
}

/**
 * Transport layer abstraction for sending HTTP requests.
 * Implementations handle the actual network I/O and can be composed
 * (e.g. wrapping a {@link FetchTransport} with a {@link RetryTransport}).
 */
export interface HttpTransport {
  /** Sends an HTTP request and returns the response. */
  send(request: HttpRequest): Promise<HttpResponse>
}

/**
 * Default transport implementation using the global `fetch` API.
 * Automatically sets the User-Agent header on each request and applies the
 * SSRF {@link UrlGuard} (if configured) before opening the connection.
 */
export class FetchTransport implements HttpTransport {
  /** User-Agent string sent with every request. */
  private readonly userAgent: string
  /** SSRF allow-list applied to every outgoing URL. Mutable so `B2Client.authorize()` can lock it down post-auth. */
  readonly urlGuard: UrlGuard

  /**
   * Creates a new FetchTransport.
   * @param options - Optional configuration: custom User-Agent prefix and SSRF guard.
   */
  constructor(options?: { userAgent?: string; urlGuard?: UrlGuard }) {
    this.userAgent = getUserAgent(options?.userAgent)
    this.urlGuard = options?.urlGuard ?? new UrlGuard()
  }

  /**
   * Sends the request using the global `fetch` function.
   * @param request - The HTTP request to execute.
   *
   * @returns The HTTP response.
   *
   * @throws B2SsrfError when the URL fails the configured SSRF guard.
   */
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.urlGuard.check(request.url)

    const headers = new Headers(request.headers)
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', this.userAgent)
    }

    const response = await fetch(request.url, {
      method: request.method,
      headers,
      body: request.body ?? null,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    })

    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      json: <T>() => response.json() as Promise<T>,
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer(),
    }
  }
}

/** Configuration for {@link RetryTransport}. */
export interface RetryTransportOptions {
  /** The underlying transport to delegate requests to. */
  readonly transport: HttpTransport
  /** Override default retry settings (max retries, delays). */
  readonly retry?: Partial<RetryOptions>
  /**
   * Callback invoked on expired auth token errors. Must refresh
   * credentials AND return the fresh auth token. The transport
   * substitutes the new token into `request.headers.Authorization`
   * before retrying — without this, the retried request would still
   * carry the expired token captured by the original caller and the
   * loop would never make progress.
   */
  readonly onReauth?: () => Promise<string>
  /**
   * Sleep implementation used between retry attempts. Defaults to the real
   * `sleep` from `./retry.js`. Test code can inject a no-op to avoid real
   * delays without relying on module mocking (which differs across runners).
   *
   * @internal
   */
  readonly sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Transport wrapper that adds automatic retry with exponential backoff.
 * Handles transient B2 errors (408, 429, 503), expired auth tokens,
 * and network failures. Delegates to an inner {@link HttpTransport}.
 */
export class RetryTransport implements HttpTransport {
  /** The wrapped transport that performs actual HTTP requests. */
  private readonly inner: HttpTransport
  /** Resolved retry options (defaults merged with user overrides). */
  private readonly options: RetryOptions
  /** Optional callback to refresh auth credentials on 401 — returns the fresh token. */
  private readonly onReauth?: () => Promise<string>
  /** Sleep implementation used between retries; injectable for tests. */
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>

  /**
   * Creates a new RetryTransport.
   * @param opts - Retry transport configuration.
   */
  constructor(opts: RetryTransportOptions) {
    this.inner = opts.transport
    this.options = { ...DEFAULT_RETRY_OPTIONS, ...opts.retry }
    if (opts.onReauth !== undefined) this.onReauth = opts.onReauth
    this.sleepImpl = opts.sleepImpl ?? sleep
  }

  /**
   * Sends the request with automatic retry on transient failures.
   * On expired auth tokens, calls {@link RetryTransportOptions.onReauth} and retries.
   * @param originalRequest - The HTTP request to execute. The caller's
   *   reference is not mutated; on reauth, a copy with a refreshed
   *   Authorization header is sent.
   *
   * @returns The HTTP response.
   */
  async send(originalRequest: HttpRequest): Promise<HttpResponse> {
    // `request` is reassigned (not mutated) when reauth produces a
    // fresh Authorization header, so the caller's `originalRequest`
    // stays untouched.
    let request: HttpRequest = originalRequest
    let lastError: B2Error | NetworkError | undefined

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0 && lastError) {
        const retryAfter = lastError instanceof NetworkError ? undefined : lastError.retryAfter
        const delay = computeBackoff(attempt - 1, this.options, retryAfter)
        await this.sleepImpl(delay, request.signal)
      }

      try {
        const response = await this.inner.send(request)

        if (response.status >= 200 && response.status < 300) {
          return response
        }

        let errorBody: B2ErrorResponse
        try {
          errorBody = await response.json<B2ErrorResponse>()
        } catch {
          errorBody = {
            status: response.status,
            code: 'internal_error',
            message: `HTTP ${response.status}`,
          }
        }

        const retryAfterHeader = response.headers.get('Retry-After')
        const retryAfterSec = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined
        const requestId = response.headers.get('X-Bz-Request-Id') ?? undefined

        const error = classifyError(errorBody, {
          ...(retryAfterSec !== undefined ? { retryAfter: retryAfterSec } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        })

        if (error instanceof ExpiredAuthTokenError && this.onReauth) {
          // Reauth returns the FRESH token; build a new request with a
          // shallow-copied headers object so the Authorization swap
          // doesn't mutate the caller's original request (which they
          // may hold for retry / introspection). Without this swap the
          // retry would carry the expired token captured at
          // request-build time and bounce off the server again,
          // exhausting the retry budget.
          const freshToken = await this.onReauth()
          request = {
            ...request,
            headers: { ...(request.headers ?? {}), Authorization: freshToken },
          }
          continue
        }

        if (!error.retryable || attempt === this.options.maxRetries) {
          throw error
        }

        lastError = error
      } catch (err) {
        if (err instanceof B2Error || err instanceof NetworkError) {
          throw err
        }

        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err
        }

        const networkErr = new NetworkError(
          err instanceof Error ? err.message : 'Network error',
          err,
        )

        if (attempt === this.options.maxRetries) {
          throw networkErr
        }

        lastError = networkErr
      }
    }

    throw lastError ?? new NetworkError('Max retries exceeded')
  }
}
