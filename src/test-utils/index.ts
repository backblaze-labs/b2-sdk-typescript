/**
 * Shared test helpers.
 *
 * These were originally inlined in every `*.test.ts` file (11+ copies of
 * `makeClient()`, 9 of `readStream()`, etc.). Pulling them here trims ~330
 * LOC of duplication and gives new tests a single, discoverable place to
 * find the canonical building blocks.
 *
 * This module is excluded from coverage reports (`vitest.coverage.config.ts`)
 * and from production builds (`vite.config.ts`) — it ships nowhere except
 * the local test process.
 *
 * @packageDocumentation
 */

import { B2Client } from '../client.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import { B2Simulator, type B2SimulatorOptions } from '../simulator/index.ts'
import { utf8Encoder } from '../util/text-codec.ts'

/**
 * Builds an un-authorized {@link B2Client} backed by a fresh in-memory
 * {@link B2Simulator}. Returns the client + simulator so tests can
 * inspect simulator state.
 *
 * Sync (no `authorize()` call) to match the pattern existing tests rely
 * on: most call `await client.authorize()` separately in `beforeEach` and
 * occasionally want to exercise pre-authorize behaviour without paying
 * for the network round-trip on every helper invocation.
 *
 * @param options - Optional simulator overrides (e.g. `minimumPartSize`).
 *   See {@link B2SimulatorOptions}.
 *
 * @returns A `{ client, sim }` pair. Call `await client.authorize()` before
 *   making any authenticated request.
 */
export function makeClient(options?: B2SimulatorOptions): {
  client: B2Client
  sim: B2Simulator
} {
  const sim = new B2Simulator(options)
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    transport: sim.transport(),
  })
  return { client, sim }
}

/**
 * Drains a `ReadableStream<Uint8Array>` into a single contiguous
 * `Uint8Array`. Equivalent to what most tests need when they download a
 * file body for assertion.
 *
 * @param stream - The byte stream to drain.
 *
 * @returns A `Uint8Array` containing every byte that was emitted.
 */
export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.byteLength
  const result = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    result.set(c, offset)
    offset += c.byteLength
  }
  return result
}

/**
 * Generates a deterministic byte pattern of the requested size. Each byte
 * is `i % 251`, where 251 is prime so adjacent test buffers don't
 * accidentally produce the same SHA-1 prefix.
 *
 * @param size - Number of bytes to produce.
 *
 * @returns A `Uint8Array` of length `size` with the deterministic fill.
 */
export function deterministicBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size)
  for (let i = 0; i < size; i++) buf[i] = i % 251
  return buf
}

/**
 * Returns a Unix-millisecond timestamp `n` days from now. Negative `n`
 * yields a timestamp in the past, useful for testing already-expired
 * object-lock retention windows.
 *
 * Replaces the `Date.now() + N * 24 * 60 * 60 * 1000` arithmetic that
 * recurs throughout object-lock and lifecycle tests.
 *
 * @param n - Number of days from now. May be fractional or negative.
 *
 * @returns A millisecond timestamp suitable for `retainUntilTimestamp`.
 */
export function daysFromNow(n: number): number {
  return Date.now() + n * 24 * 60 * 60 * 1000
}

/**
 * Builds an `HttpResponse` representing a B2-style JSON error body. Use
 * inside a custom transport to make a specific endpoint reject with a
 * given status + code + message.
 *
 * @param status - HTTP status code (e.g. 400, 503).
 * @param code - B2 error code (e.g. `'bad_request'`, `'service_unavailable'`).
 * @param message - Human-readable message.
 *
 * @returns An `HttpResponse` ready to return from `transport.send`.
 */
export function jsonErrorResponse(status: number, code: string, message: string): HttpResponse {
  const body = JSON.stringify({ status, code, message })
  return {
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(utf8Encoder.encode(body))
        controller.close()
      },
    }),
    json: <T>() => Promise.resolve(JSON.parse(body) as T),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(utf8Encoder.encode(body).buffer as ArrayBuffer),
  }
}

/**
 * Options for {@link failingTransport}.
 */
export interface FailingTransportOptions {
  /**
   * Substring matched against `request.url`. When the request's URL
   * contains this string, the transport returns the configured failure.
   * Typically a B2 endpoint name like `'b2_upload_part'`.
   */
  on: string
  /** HTTP status to return on a matched request. Defaults to `400`. */
  status?: number
  /** B2 error code to return on a matched request. Defaults to `'bad_request'`. */
  code?: string
  /** Human-readable message. Defaults to `'simulated failure'`. */
  message?: string
  /**
   * Number of failures before falling through to the inner transport. The
   * default `Infinity` keeps failing every matched request. Set this to
   * exercise "transient" failure flows where N attempts fail and then the
   * (N+1)-th succeeds.
   */
  maxFailures?: number
  /**
   * Number of matched requests to let pass through to the inner transport
   * BEFORE starting to fail. The default `0` fails from the first match.
   */
  failAfter?: number
}

/**
 * Wraps an inner `HttpTransport` and returns a `400 bad_request` (or
 * configured failure) for requests whose URL contains `options.on`. All
 * other requests pass through unchanged.
 *
 * Replaces dozens of inline hand-rolled "fail this endpoint" transports
 * across the test suite, which all followed the same shape: check
 * `request.url` for a B2 endpoint substring, return a JSON error response,
 * fall through to the inner transport otherwise.
 *
 * @param inner - The transport to wrap (typically `sim.transport()`).
 * @param options - Match + failure configuration.
 *
 * @returns A new {@link HttpTransport} that fails matching requests and
 *   forwards everything else.
 */
export function failingTransport(
  inner: HttpTransport,
  options: FailingTransportOptions,
): HttpTransport {
  const status = options.status ?? 400
  const code = options.code ?? 'bad_request'
  const message = options.message ?? 'simulated failure'
  const maxFailures = options.maxFailures ?? Number.POSITIVE_INFINITY
  const failAfter = options.failAfter ?? 0
  let matched = 0
  let failed = 0

  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      if (request.url.includes(options.on)) {
        matched += 1
        if (matched > failAfter && failed < maxFailures) {
          failed += 1
          return jsonErrorResponse(status, code, message)
        }
      }
      return inner.send(request)
    },
  }
}
