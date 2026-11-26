/**
 * Test harness for the standalone b2-simulator
 * (https://github.com/backblaze-labs/b2-simulator).
 *
 * The SDK's tests are moving off the embedded in-process `B2Simulator`
 * (`src/simulator/**`) onto the standalone server, which speaks the B2 native
 * API over real HTTP and is controlled through a separate loopback control
 * plane. This module is the shared setup for that: it starts (once per test
 * process) a server, resets it before each client, maps the embedded
 * simulator's options onto `POST /reset {config}`, and returns a small control
 * object whose methods mirror the embedded simulator's test hooks.
 *
 * How to run and how to migrate a test file: CONTRIBUTING.md, "Tests against
 * the standalone simulator".
 *
 * This module is excluded from coverage reports and production builds, like
 * the rest of `src/test-utils/`.
 *
 * @packageDocumentation
 */

import { B2Client, type B2ClientOptions } from '../client.ts'
import {
  FetchTransport,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '../http/transport.ts'
import type { B2SimulatorOptions, FaultSpec } from '../simulator/index.ts'

/**
 * Settings accepted by the standalone server's `POST /reset {config}`, as
 * documented in its docs/CONTRACT.md ("Reset").
 */
export interface StandaloneResetConfig {
  readonly profile: 'ts-sdk'
  readonly strictAuth: boolean
  readonly partnerAuthorize: boolean
  readonly minimumPartSize?: number
  readonly recommendedPartSize?: number
  readonly authTokenTtlMs?: number
  readonly customUploadTimestampsEnabled?: boolean
  readonly partnerApiEnabled?: boolean
  readonly partnerAccountHasValidPhone?: boolean
  readonly partnerAccountInGoodStanding?: boolean
}

/** Embedded options the standalone server takes under the same name and meaning. */
const PASS_THROUGH = [
  'minimumPartSize',
  'recommendedPartSize',
  'authTokenTtlMs',
  'customUploadTimestampsEnabled',
  'partnerApiEnabled',
  'partnerAccountHasValidPhone',
  'partnerAccountInGoodStanding',
] as const

/**
 * Embedded options with no standalone counterpart. In-process callbacks cannot
 * cross a process boundary; the standalone server has its own control routes
 * (`GET /webhooks`, `POST /drain`) for what the hooks were used to observe.
 */
const NO_EQUIVALENT = new Set([
  'onWebhookDeliver',
  'onReplicate',
  'onHookError',
  'partnerGroupsCapabilities',
  'partnerBackupCapabilities',
])

/**
 * Maps embedded {@link B2SimulatorOptions} to the standalone server's
 * `POST /reset` config.
 *
 * The standalone `ts-sdk` profile defaults to strict auth and the Partner
 * authorizer, while the embedded simulator defaults both off, so those two are
 * always sent explicitly. Options without an equivalent, and unknown options,
 * throw instead of being silently dropped.
 *
 * @param options - Embedded simulator options, as passed to `makeClient`.
 *
 * @returns The `config` object for `POST /reset`.
 *
 * @throws Error when an option has no standalone equivalent or is unknown.
 */
export function toResetConfig(options: B2SimulatorOptions = {}): StandaloneResetConfig {
  const config: Record<string, unknown> = {
    profile: 'ts-sdk',
    strictAuth: options.strictAuth ?? false,
    partnerAuthorize: options.partnerAuthorize ?? false,
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || key === 'strictAuth' || key === 'partnerAuthorize') continue
    if (NO_EQUIVALENT.has(key)) {
      throw new Error(
        `simulator option ${key} has no standalone simulator equivalent; keep this test on the embedded simulator or observe the effect through the control plane`,
      )
    }
    if (!(PASS_THROUGH as readonly string[]).includes(key)) {
      throw new Error(`unknown simulator option "${key}"`)
    }
    config[key] = value
  }
  return config as unknown as StandaloneResetConfig
}

/** How the harness reaches one standalone server (Node/Bun or browser backend). */
interface SimulatorConnection {
  /** HTTP origin of the B2 realm. */
  readonly apiUrl: string
  /** Origin of the control plane. */
  readonly controlUrl: string
  /** Sends one control-plane request and returns its status and parsed JSON body. */
  control(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>
  /** A transport that reaches the realm (and only the realm) over HTTP. */
  transport(): HttpTransport
}

function isBrowser(): boolean {
  const g = globalThis as { window?: unknown; process?: { versions?: { node?: string } } }
  return g.window !== undefined && g.process?.versions?.node === undefined
}

async function connect(): Promise<SimulatorConnection> {
  if (isBrowser()) {
    const { browserConnection } = await import('./remote-simulator-browser.ts')
    return await browserConnection()
  }
  const { processSimulator } = await import('./remote-simulator-process.ts')
  const server = await processSimulator()
  return {
    apiUrl: server.apiUrl,
    controlUrl: server.controlUrl,
    async control(method, path, body) {
      const response = await fetch(`${server.controlUrl}${path}`, {
        method,
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
          : {}),
      })
      const text = await response.text()
      return { status: response.status, body: text === '' ? null : JSON.parse(text) }
    },
    transport: () => realmOnlyTransport(new FetchTransport(), [server.apiUrl, server.httpsUrl]),
  }
}

/**
 * Wraps a transport so it refuses every URL outside the simulator's own
 * origins. The client's SSRF guard does not apply to a custom transport (the
 * same as with the embedded simulator's `sim.transport()`), so this is the
 * test-side allow-list: a test can reach the server it started and nothing
 * else, and a forgotten `realm: sim.realm` fails loudly instead of sending
 * test credentials to production.
 *
 * @param inner - The transport that does the I/O.
 * @param origins - The allowed origins.
 *
 * @returns The restricted transport.
 */
export function realmOnlyTransport(
  inner: HttpTransport,
  origins: readonly string[],
): HttpTransport {
  return {
    send(request: HttpRequest): Promise<HttpResponse> {
      const origin = new URL(request.url).origin
      if (!origins.includes(origin)) {
        return Promise.reject(
          new Error(
            `standalone simulator transport refused ${origin}: it only reaches ${origins.join(', ')}. Pass realm: sim.realm to the B2Client.`,
          ),
        )
      }
      return inner.send(request)
    },
  }
}

/** Handle for one fault registered with {@link RemoteSimulator.injectFailure}. */
export interface RemoteFaultHandle {
  /** Removes this fault. Idempotent, like the embedded simulator's handle. */
  clear(): Promise<void>
}

/** Bumped by every reset in this test process; a handle from an older one is stale. */
let currentGeneration = 0

/**
 * Control handle for the standalone simulator a test is using: the async
 * counterparts of the embedded `B2Simulator` test hooks, backed by the
 * server's control plane (b2-simulator docs/CONTRACT.md, "Control plane").
 */
export class RemoteSimulator {
  /** Realm URL to pass as `B2Client` `realm`. */
  readonly realm: string
  /** Origin of the control plane. */
  readonly controlUrl: string
  readonly #connection: SimulatorConnection
  readonly #generation: number

  /**
   * Use {@link resetRemoteSimulator} or {@link makeRemoteClient} instead.
   *
   * @param connection - How to reach the server.
   * @param generation - The reset this handle belongs to.
   */
  constructor(connection: SimulatorConnection, generation: number) {
    this.#connection = connection
    this.#generation = generation
    this.realm = connection.apiUrl
    this.controlUrl = connection.controlUrl
  }

  /**
   * Transport for a hand-built `B2Client` (pair it with `realm: sim.realm`), or
   * to wrap in a recording or failing test transport, like the embedded
   * simulator's `sim.transport()`.
   *
   * @returns A transport that reaches only this simulator.
   */
  transport(): HttpTransport {
    return this.#connection.transport()
  }

  async #control(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    if (this.#generation !== currentGeneration) {
      throw new Error(
        'this simulator handle was reset by a later makeRemoteClient/resetRemoteSimulator call in the same test process; use the newest handle (one test, one simulator)',
      )
    }
    return this.#connection.control(method, path, body)
  }

  async #expect200(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await this.#control(method, path, body)
    if (response.status !== 200) {
      throw new Error(
        `standalone simulator refused ${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`,
      )
    }
    return response.body
  }

  /**
   * Makes matching API calls fail (`POST /faults`). Defaults match the embedded
   * simulator: `503 service_unavailable`, message `simulated failure`, every
   * match until cleared. `on` must be a full endpoint name such as
   * `b2_upload_part`; URL fragments are refused by the server.
   *
   * @param spec - The fault, as for `B2Simulator.injectFailure`.
   *
   * @returns A handle whose `clear()` removes this fault.
   */
  async injectFailure(spec: FaultSpec): Promise<RemoteFaultHandle> {
    const body = (await this.#expect200('POST', '/faults', {
      on: spec.on,
      status: spec.status ?? 503,
      code: spec.code ?? 'service_unavailable',
      message: spec.message ?? 'simulated failure',
      ...(spec.skip !== undefined ? { skip: spec.skip } : {}),
      ...(spec.count !== undefined && Number.isFinite(spec.count) ? { count: spec.count } : {}),
      ...(spec.retryAfter !== undefined ? { retryAfter: spec.retryAfter } : {}),
    })) as { id: number }
    return {
      clear: async () => {
        const response = await this.#control('DELETE', `/faults/${body.id}`)
        // 404: already cleared, which the embedded handle treats as a no-op too.
        if (response.status !== 200 && response.status !== 404) {
          throw new Error(
            `standalone simulator refused DELETE /faults/${body.id}: ${response.status}`,
          )
        }
      },
    }
  }

  /** Removes every injected fault (`DELETE /faults`). */
  async clearFaults(): Promise<void> {
    await this.#expect200('DELETE', '/faults')
  }

  /**
   * Advances the virtual clock (`POST /clock`). Unlike the embedded simulator,
   * the standalone clock never rewinds: `ms` must be a positive integer.
   *
   * @param ms - Milliseconds to advance.
   */
  async advanceTime(ms: number): Promise<void> {
    if (!Number.isSafeInteger(ms) || ms <= 0) {
      throw new Error(
        `advanceTime(${ms}): the standalone clock takes a positive integer (it never rewinds)`,
      )
    }
    await this.#expect200('POST', '/clock', { advanceMs: ms })
  }

  async #uploadToken(
    action: 'expire' | 'invalidate',
    authorizationToken: string,
  ): Promise<boolean> {
    const path = `/upload-tokens/${action}`
    const response = await this.#control('POST', path, { authorizationToken })
    if (response.status === 404) return false
    if (response.status !== 200) {
      throw new Error(`standalone simulator refused POST ${path}: ${response.status}`)
    }
    return true
  }

  /**
   * Expires one upload token (`POST /upload-tokens/expire`).
   *
   * @param authorizationToken - Token from `b2_get_upload_url` / `b2_get_upload_part_url`.
   *
   * @returns `true` when the token existed, as the embedded method.
   */
  expireUploadToken(authorizationToken: string): Promise<boolean> {
    return this.#uploadToken('expire', authorizationToken)
  }

  /**
   * Invalidates one upload token (`POST /upload-tokens/invalidate`).
   *
   * @param authorizationToken - Token from `b2_get_upload_url` / `b2_get_upload_part_url`.
   *
   * @returns `true` when the token existed, as the embedded method.
   */
  invalidateUploadToken(authorizationToken: string): Promise<boolean> {
    return this.#uploadToken('invalidate', authorizationToken)
  }

  /** Waits until replication copies and webhook deliveries have settled (`POST /drain`). */
  async flushHooks(): Promise<void> {
    await this.#expect200('POST', '/drain')
  }
}

/**
 * Resets this test process's standalone simulator with the given embedded
 * simulator options (see {@link toResetConfig}) and returns its control handle.
 * Everything from before (buckets, files, keys, tokens, faults, clock offset) is
 * gone, and clients authorized before the reset must authorize again.
 *
 * Replaces `new B2Simulator(options)`.
 *
 * @param options - Embedded simulator options.
 *
 * @returns The control handle.
 */
export async function resetRemoteSimulator(options?: B2SimulatorOptions): Promise<RemoteSimulator> {
  const config = toResetConfig(options)
  const connection = await connect()
  // Any earlier handle is stale from here on, whether or not the reset succeeds.
  currentGeneration += 1
  const generation = currentGeneration
  const { status, body } = await connection.control('POST', '/reset', { config })
  if (status !== 200) {
    throw new Error(`standalone simulator refused POST /reset: ${status} ${JSON.stringify(body)}`)
  }
  return new RemoteSimulator(connection, generation)
}

/**
 * Remote counterpart of `makeClient` (same call shapes): resets the
 * standalone simulator and returns an un-authorized `B2Client` that talks to it
 * over HTTP, plus its control handle.
 *
 * @param options - A bare `B2SimulatorOptions` bag, or `{ sim, client }`.
 *
 * @returns The client and the simulator control handle.
 */
export async function makeRemoteClient(
  options?:
    | B2SimulatorOptions
    | {
        sim?: B2SimulatorOptions
        client?: Partial<Omit<B2ClientOptions, 'applicationKeyId' | 'applicationKey' | 'transport'>>
      },
): Promise<{ client: B2Client; sim: RemoteSimulator }> {
  const keys = options !== undefined ? Object.keys(options) : []
  const isStructured = options !== undefined && keys.every((k) => k === 'sim' || k === 'client')
  const simOptions = isStructured
    ? (options as { sim?: B2SimulatorOptions }).sim
    : (options as B2SimulatorOptions | undefined)
  const clientOverrides = isStructured
    ? (options as { client?: Partial<B2ClientOptions> }).client
    : undefined

  const sim = await resetRemoteSimulator(simOptions)
  const client = new B2Client({
    applicationKeyId: 'test-key-id',
    applicationKey: 'test-key',
    realm: sim.realm,
    transport: sim.transport(),
    ...(clientOverrides ?? {}),
  })
  return { client, sim }
}
