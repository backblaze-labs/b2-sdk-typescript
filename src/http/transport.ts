import {
  B2Error,
  B2RedirectError,
  B2SsrfError,
  classifyError,
  ExpiredAuthTokenError,
  NetworkError,
} from '../errors/index.ts'
import type { B2ErrorResponse } from '../types/errors.ts'
import { computeBackoff, DEFAULT_RETRY_OPTIONS, type RetryOptions, sleep } from './retry.ts'
import { UrlGuard } from './url-guard.ts'
import { getUserAgent } from './user-agent.ts'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_SAME_ORIGIN_REDIRECTS = 5

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
  /** Optional per-request retry override. */
  readonly retry?: Partial<RetryOptions>
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
 * Redirect following is disabled so redirected URLs cannot bypass the guard or
 * receive credential-bearing headers without an explicit checked request.
 */
export class FetchTransport implements HttpTransport {
  /** User-Agent string sent with every request. */
  private readonly userAgent: string
  /** Whether same-origin GET/HEAD redirects should be followed after guard checks. */
  private readonly followSameOriginRedirects: boolean
  /** SSRF allow-list applied to every outgoing URL. Mutable so `B2Client.authorize()` can lock it down post-auth. */
  readonly urlGuard: UrlGuard

  /**
   * Creates a new FetchTransport.
   * @param options - Optional configuration: custom User-Agent prefix and SSRF guard.
   */
  constructor(options?: {
    userAgent?: string
    urlGuard?: UrlGuard
    /**
     * Follow same-origin GET/HEAD redirects after checking the target with the
     * URL guard. POST redirects are still blocked to avoid replaying
     * credential-bearing payloads to an unexpected endpoint. Defaults to true.
     */
    followSameOriginRedirects?: boolean
  }) {
    this.userAgent = getUserAgent(options?.userAgent)
    this.followSameOriginRedirects = options?.followSameOriginRedirects ?? true
    this.urlGuard = options?.urlGuard ?? new UrlGuard()
  }

  /**
   * Sends the request using the global `fetch` function.
   * @param request - The HTTP request to execute.
   *
   * @returns The HTTP response.
   *
   * @throws B2SsrfError when the URL fails the configured SSRF guard.
   * @throws B2RedirectError when a response attempts to redirect.
   */
  async send(request: HttpRequest): Promise<HttpResponse> {
    let currentRequest = request
    let redirectCount = 0

    while (true) {
      this.urlGuard.check(currentRequest.url)

      const headers = new Headers(currentRequest.headers)
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', this.userAgent)
      }

      const timeoutScope = createRequestTimeoutScope(currentRequest)
      let response: Response
      try {
        response = await fetch(currentRequest.url, {
          method: currentRequest.method,
          headers,
          body: currentRequest.body ?? null,
          redirect: 'manual',
          ...(timeoutScope.signal !== undefined ? { signal: timeoutScope.signal } : {}),
        })
      } catch (err) {
        timeoutScope.dispose()
        if (timeoutScope.timedOut) {
          throw createRequestTimeoutError(timeoutScope)
        }
        throw err
      }

      if (isBlockedRedirect(response)) {
        const location = response.headers.get('Location')
        if (
          this.followSameOriginRedirects &&
          location !== null &&
          redirectCount < MAX_SAME_ORIGIN_REDIRECTS &&
          canFollowSameOriginRedirect(currentRequest, location)
        ) {
          const nextUrl = new URL(location, currentRequest.url).toString()
          await cancelResponseBody(response)
          timeoutScope.dispose()
          this.urlGuard.check(nextUrl)
          currentRequest = { ...currentRequest, url: nextUrl }
          redirectCount += 1
          continue
        }

        await cancelResponseBody(response)
        timeoutScope.dispose()
        throw new B2RedirectError(currentRequest.url, response.status, location)
      }

      return createTimedHttpResponse(response, timeoutScope)
    }
  }
}

interface RequestTimeoutScope {
  readonly signal?: AbortSignal
  readonly timeoutMs: number
  readonly timedOut: boolean
  reset(): void
  dispose(): void
}

function createRequestTimeoutScope(request: HttpRequest): RequestTimeoutScope {
  const timeoutMs = request.retry?.requestTimeoutMs ?? DEFAULT_RETRY_OPTIONS.requestTimeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const scope: RequestTimeoutScope = {
      timeoutMs: 0,
      timedOut: false,
      reset() {},
      dispose() {},
    }
    if (request.signal !== undefined) return { ...scope, signal: request.signal }
    return scope
  }

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout>
  const abortFromUpstream = (): void => {
    clearTimeout(timer)
    controller.abort(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'))
  }
  const armTimer = (): ReturnType<typeof setTimeout> => {
    const nextTimer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('HTTP request timed out', 'TimeoutError'))
    }, timeoutMs)
    unrefTimer(nextTimer)
    return nextTimer
  }
  timer = armTimer()

  const reset = (): void => {
    if (timedOut || controller.signal.aborted) return
    clearTimeout(timer)
    timer = armTimer()
  }

  if (request.signal?.aborted === true) {
    clearTimeout(timer)
    abortFromUpstream()
  } else {
    request.signal?.addEventListener('abort', abortFromUpstream, { once: true })
  }

  return {
    signal: controller.signal,
    timeoutMs,
    get timedOut() {
      return timedOut
    },
    reset,
    dispose() {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abortFromUpstream)
    },
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === 'function') maybeUnref.call(timer)
}

function createRequestTimeoutError(scope: RequestTimeoutScope): DOMException {
  return new DOMException(`HTTP request timed out after ${scope.timeoutMs} ms`, 'TimeoutError')
}

function createTimedHttpResponse(
  response: Response,
  timeoutScope: RequestTimeoutScope,
): HttpResponse {
  const body = response.body
  if (body === null) timeoutScope.dispose()
  let timedBody: ReadableStream<Uint8Array> | undefined

  return {
    status: response.status,
    headers: response.headers,
    get body() {
      if (body === null) return null
      timedBody ??= createTimedResponseBody(body, timeoutScope)
      return timedBody
    },
    json: <T>() =>
      readTimedResponseBody(timeoutScope, response, () => response.json() as Promise<T>),
    text: () => readTimedResponseBody(timeoutScope, response, () => response.text()),
    arrayBuffer: () => readTimedResponseBody(timeoutScope, response, () => response.arrayBuffer()),
  }
}

async function readTimedResponseBody<T>(
  timeoutScope: RequestTimeoutScope,
  response: Response,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await raceBodyReadWithAbort(timeoutScope, read(), (reason) =>
      cancelResponseBody(response, reason),
    )
  } catch (err) {
    if (timeoutScope.timedOut) {
      throw createRequestTimeoutError(timeoutScope)
    }
    throw err
  } finally {
    timeoutScope.dispose()
  }
}

function createTimedResponseBody(
  body: ReadableStream<Uint8Array>,
  timeoutScope: RequestTimeoutScope,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    timeoutScope.dispose()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= body.getReader()
      try {
        const result = await raceBodyReadWithAbort(timeoutScope, reader.read(), (reason) =>
          reader?.cancel(reason),
        )
        if (result.done) {
          dispose()
          controller.close()
          return
        }
        timeoutScope.reset()
        controller.enqueue(result.value)
      } catch (err) {
        dispose()
        if (timeoutScope.timedOut) {
          controller.error(createRequestTimeoutError(timeoutScope))
          return
        }
        controller.error(err)
      }
    },
    async cancel(reason) {
      dispose()
      try {
        if (reader !== undefined) {
          await reader.cancel(reason)
          return
        }
        await body.cancel(reason)
      } catch {
        // Best-effort cleanup when the caller cancels the wrapper body.
      }
    },
  })
}

async function raceBodyReadWithAbort<T>(
  timeoutScope: RequestTimeoutScope,
  read: Promise<T>,
  abortCleanup?: ((reason: unknown) => Promise<void> | void) | undefined,
): Promise<T> {
  const signal = timeoutScope.signal
  if (signal === undefined) return read
  const abortReason = (): unknown => signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (signal.aborted) {
    const reason = abortReason()
    await runAbortCleanup(abortCleanup, reason)
    throw reason
  }

  let removeAbortListener: (() => void) | undefined
  const abort = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      const reason = abortReason()
      reject(reason)
      void runAbortCleanup(abortCleanup, reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })

  try {
    return await Promise.race([read, abort])
  } finally {
    removeAbortListener?.()
  }
}

async function runAbortCleanup(
  abortCleanup: ((reason: unknown) => Promise<void> | void) | undefined,
  reason: unknown,
): Promise<void> {
  try {
    await abortCleanup?.(reason)
  } catch {
    // Abort cleanup is best-effort and must not mask the abort reason.
  }
}

function isBlockedRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || REDIRECT_STATUSES.has(response.status)
}

function canFollowSameOriginRedirect(request: HttpRequest, location: string): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  try {
    return new URL(request.url).origin === new URL(location, request.url).origin
  } catch {
    return false
  }
}

async function cancelResponseBody(response: Response, reason?: unknown): Promise<void> {
  try {
    await response.body?.cancel(reason)
  } catch {
    // Best-effort cleanup before throwing the primary error.
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
 * Decide whether `url` points at a URL-pinned upload POST endpoint.
 *
 * @param url - Request URL to inspect.
 *
 * @returns Whether the request is a direct upload endpoint.
 */
function isUploadEndpoint(url: string): boolean {
  // Match the upload POST endpoints, while avoiding two false positives:
  //   - the `b2_get_upload_url` / `b2_get_upload_part_url` URL-fetch calls
  //     (ordinary API endpoints — their paths don't contain `/b2_upload_*`); and
  //   - download-by-name URLs `/file/<bucket>/<fileName>`, where the file name
  //     is user-controlled and could literally be `b2_upload_file`.
  // Real upload URLs live under `/b2api/.../b2_upload_file[/...]` and never
  // start with `/file/`, so the prefix check cleanly excludes downloads while
  // `includes` still matches upload URLs that carry path segments after the
  // endpoint name (e.g. `/b2api/v2/b2_upload_file/<bucketId>/<token>`).
  const path = new URL(url).pathname
  return (
    !path.startsWith('/file/') &&
    (path.includes('/b2_upload_file') || path.includes('/b2_upload_part'))
  )
}

function isFinishLargeFileEndpoint(url: string): boolean {
  return new URL(url).pathname.includes('/b2_finish_large_file')
}

function isReplayUnsafePostEndpoint(url: string): boolean {
  return isUploadEndpoint(url) || isFinishLargeFileEndpoint(url)
}

/**
 * Decide whether a classified error should be retried in place for `url`.
 * Transient errors normally retry; upload endpoints bubble to the upload layer
 * for fresh-URL retry except account-level 429 throttling, where fetching a new
 * upload URL only amplifies the rate limit.
 *
 * @param error - The classified, retryability-tagged error.
 * @param url - The request URL (used to detect upload endpoints).
 *
 * @returns Whether to retry the request in place.
 */
function shouldRetryInPlace(error: B2Error, url: string): boolean {
  if (!error.retryable) return false
  if (isFinishLargeFileEndpoint(url)) return false
  if (isUploadEndpoint(url) && error.status === 429) return true
  if (isUploadEndpoint(url)) return false
  return true
}

function isTerminalTransportError(err: unknown): boolean {
  return (
    err instanceof B2Error ||
    err instanceof B2RedirectError ||
    err instanceof NetworkError ||
    err instanceof B2SsrfError ||
    (err instanceof DOMException && err.name === 'AbortError')
  )
}

/**
 * Transport wrapper that adds automatic retry with exponential backoff.
 * Handles transient errors (408, 429, and the transient 5xx set 500/502/503/504),
 * expired auth tokens, and network failures. Delegates to an inner
 * {@link HttpTransport}.
 *
 * Upload endpoints (`b2_upload_file` / `b2_upload_part`) are URL-pinned. Their
 * retryable pod failures bubble to the upload layer, which evicts the failed
 * URL, fetches a fresh one, and retries there. HTTP 429 remains an in-place
 * retry so account-level throttling does not trigger extra upload URL fetches.
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
    const retryOptions = { ...this.options, ...originalRequest.retry }
    let lastError: B2Error | NetworkError | undefined
    let didReauth = false
    let attempt = 0

    while (attempt <= retryOptions.maxRetries) {
      throwIfSignalAborted(request.signal)

      if (attempt > 0 && lastError) {
        const retryAfter = lastError instanceof NetworkError ? undefined : lastError.retryAfter
        const delay = computeBackoff(attempt - 1, retryOptions, retryAfter)
        await this.sleepImpl(delay, request.signal)
      }

      try {
        const response = await this.inner.send({ ...request, retry: retryOptions })
        await throwIfSignalAbortedAfterResponse(request.signal, response)

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

        if (
          error instanceof ExpiredAuthTokenError &&
          this.onReauth &&
          !isUploadEndpoint(request.url) &&
          !didReauth
        ) {
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
          didReauth = true
          lastError = undefined
          continue
        }

        if (!shouldRetryInPlace(error, request.url) || attempt === retryOptions.maxRetries) {
          throw error
        }

        lastError = error
        attempt += 1
      } catch (err) {
        throwIfSignalAborted(request.signal)
        if (isTerminalTransportError(err)) {
          throw err
        }

        const networkErr = new NetworkError(
          err instanceof Error ? err.message : 'Network error',
          err,
        )

        if (isReplayUnsafePostEndpoint(request.url) || attempt === retryOptions.maxRetries) {
          throw networkErr
        }

        lastError = networkErr
        attempt += 1
      }
    }

    throw lastError ?? new NetworkError('Max retries exceeded')
  }
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

async function throwIfSignalAbortedAfterResponse(
  signal: AbortSignal | undefined,
  response: HttpResponse,
): Promise<void> {
  if (signal?.aborted !== true) return
  const reason = signal.reason ?? new DOMException('Aborted', 'AbortError')
  try {
    await response.body?.cancel(reason)
  } catch {
    // Best-effort cleanup before preserving the caller's abort reason.
  }
  throw reason
}
