import { sha256Hex } from '../util/crypto.ts'
import { hasHttpHeaderControlCharacter } from '../util/http.ts'
import type { S3CompatibleAuthConfig, S3CompatibleFetch } from './client.ts'
import {
  type QueryParam,
  type S3PresignDate,
  type S3SignedRequestMethod,
  type SignedHeader,
  signS3Request,
} from './sigv4.ts'
import { s3ResponseError } from './xml.ts'

/** Default signed S3 helper request and consumed-body timeout in milliseconds. */
export const DEFAULT_S3_REQUEST_TIMEOUT_MS = 15 * 60_000

const HTTP_HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** Internal signed request input. */
export interface S3RequestInput {
  readonly config: S3CompatibleAuthConfig
  readonly fetchImpl: S3CompatibleFetch
  readonly method: S3SignedRequestMethod
  readonly bucket: string
  readonly key?: string
  readonly query?: readonly QueryParam[]
  readonly headers?: readonly SignedHeader[]
  readonly body?: string
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
  readonly signingDate?: S3PresignDate
  readonly expectedStatuses: readonly number[]
}

/** Response plus request deadline helpers owned by the caller until disposed. */
export interface S3RequestResult {
  readonly response: Response
  readonly signal: AbortSignal
  readonly timeoutMs: number
  race<T>(promise: Promise<T>): Promise<T>
  dispose(): void
}

/**
 * Sends one signed S3-compatible HTTP request.
 *
 * @param input - Request target, signing, fetch, timeout, and status controls.
 *
 * @returns The successful response plus helpers for consuming or releasing it.
 */
export async function sendSignedS3Request(input: S3RequestInput): Promise<S3RequestResult> {
  for (const [name, value] of input.headers ?? []) {
    assertSafeHeaderName(name)
    assertSafeHeaderValue(name, value)
  }
  for (const [name, value] of input.query ?? []) {
    assertSafeQueryValue(name, value)
  }

  const timeoutMs = normalizeRequestTimeoutMs(input.requestTimeoutMs)
  const scope = createRequestScope(input.signal, timeoutMs, input.method)
  try {
    const signed = await signS3Request(input.method, {
      endpoint: input.config.endpoint,
      region: input.config.region,
      accessKeyId: input.config.credentials.accessKeyId,
      secretAccessKey: input.config.credentials.secretAccessKey,
      bucketName: input.bucket,
      ...(input.key !== undefined ? { fileName: input.key } : {}),
      payloadHash: await s3PayloadHash(input.body),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.signingDate !== undefined ? { signingDate: input.signingDate } : {}),
    })
    const response = await scope.race(
      input.fetchImpl(signed.url, {
        method: input.method,
        headers: signed.headers,
        redirect: 'manual',
        ...(input.body !== undefined ? { body: input.body } : {}),
        signal: scope.signal,
      }),
    )

    if (!input.expectedStatuses.includes(response.status)) {
      throw await scope.race(s3ResponseError(response))
    }

    return {
      response,
      signal: scope.signal,
      timeoutMs,
      race: (promise) => scope.race(promise),
      dispose: () => scope.dispose(),
    }
  } catch (error) {
    scope.dispose()
    throw error
  }
}

/**
 * Cancels an unneeded response body so fetch connection pools can reuse the socket.
 *
 * @param response - Fetch response whose body is no longer needed.
 */
export async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Validates HTTP signed header names.
 *
 * @param name - Header name to validate.
 *
 * @throws TypeError when the header name is not a valid HTTP token.
 */
export function assertSafeHeaderName(name: string): void {
  if (!HTTP_HEADER_TOKEN.test(name)) {
    throw new TypeError(`S3 header name "${name}" must be a valid HTTP header token.`)
  }
}

/**
 * Validates HTTP signed header values.
 *
 * @param name - Human-readable field name used in the error message.
 * @param value - Header value to validate.
 *
 * @throws TypeError when the header value contains control characters.
 */
export function assertSafeHeaderValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(`${name} must not contain control characters.`)
  }
}

/**
 * Validates signed query parameter values.
 *
 * @param name - Human-readable field name used in the error message.
 * @param value - Query parameter value to validate.
 *
 * @throws TypeError when the query value contains control characters.
 */
export function assertSafeQueryValue(name: string, value: string): void {
  if (hasHttpHeaderControlCharacter(value)) {
    throw new TypeError(`${name} must not contain control characters.`)
  }
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_S3_REQUEST_TIMEOUT_MS
  if (value === 0) return value
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`requestTimeoutMs must be a positive integer or 0; received ${value}.`)
  }
  return value
}

async function s3PayloadHash(body: string | undefined): Promise<string> {
  return await sha256Hex(body ?? '')
}

function createRequestScope(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  method: S3SignedRequestMethod,
): {
  readonly signal: AbortSignal
  race<T>(promise: Promise<T>): Promise<T>
  dispose(): void
} {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectDeadline: (reason: Error) => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  void deadline.catch(() => undefined)
  const abort = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason)
    rejectDeadline(reason)
  }
  const callerAbortListener = () => {
    abort(abortReasonAsError(callerSignal?.reason))
  }
  const resetTimeout = () => {
    if (timeout !== undefined) clearTimeout(timeout)
    if (timeoutMs === 0) return
    timeout = setTimeout(() => {
      abort(new Error(`S3 ${method} request timed out after ${timeoutMs} ms.`))
    }, timeoutMs)
  }

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      abort(abortReasonAsError(callerSignal.reason))
    } else {
      callerSignal.addEventListener('abort', callerAbortListener, { once: true })
    }
  }
  resetTimeout()

  return {
    signal: controller.signal,
    async race<T>(promise: Promise<T>): Promise<T> {
      resetTimeout()
      return await Promise.race([promise, deadline])
    },
    dispose(): void {
      if (timeout !== undefined) clearTimeout(timeout)
      if (callerSignal !== undefined) {
        callerSignal.removeEventListener('abort', callerAbortListener)
      }
    },
  }
}

function abortReasonAsError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('S3 request was aborted.')
}
