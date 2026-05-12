import { B2Error, ExpiredAuthTokenError, NetworkError, classifyError } from '../errors/index.js'
import type { B2ErrorResponse } from '../types/errors.js'
import { DEFAULT_RETRY_OPTIONS, type RetryOptions, computeBackoff, sleep } from './retry.js'
import { getUserAgent } from './user-agent.js'

export interface HttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers?: Record<string, string>
  readonly body?: BodyInit | null
  readonly signal?: AbortSignal
}

export interface HttpResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | null
  json<T>(): Promise<T>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>
}

export class FetchTransport implements HttpTransport {
  private readonly userAgent: string

  constructor(options?: { userAgent?: string }) {
    this.userAgent = getUserAgent(options?.userAgent)
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
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

export interface RetryTransportOptions {
  readonly transport: HttpTransport
  readonly retry?: Partial<RetryOptions>
  readonly onReauth?: () => Promise<void>
}

export class RetryTransport implements HttpTransport {
  private readonly inner: HttpTransport
  private readonly options: RetryOptions
  private readonly onReauth?: () => Promise<void>

  constructor(opts: RetryTransportOptions) {
    this.inner = opts.transport
    this.options = { ...DEFAULT_RETRY_OPTIONS, ...opts.retry }
    if (opts.onReauth !== undefined) this.onReauth = opts.onReauth
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    let lastError: B2Error | NetworkError | undefined

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0 && lastError) {
        const retryAfter = lastError instanceof NetworkError ? undefined : lastError.retryAfter
        const delay = computeBackoff(attempt - 1, this.options, retryAfter)
        await sleep(delay, request.signal)
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
          await this.onReauth()
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
