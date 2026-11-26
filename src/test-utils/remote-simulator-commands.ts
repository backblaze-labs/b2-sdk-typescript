/**
 * Vitest browser-mode commands for the standalone-simulator harness. They run
 * in the Vitest (Node) process, registered in `vitest.browser.config.ts`.
 *
 * A browser page cannot start a process, and it cannot reach the simulator
 * directly: the server sends no CORS headers on its API ports and its control
 * plane refuses any request carrying an `Origin` header. So the browser side
 * (`remote-simulator-browser.ts`) sends each control request and each B2 API
 * request here, and these commands forward it to the server over loopback
 * HTTP. The SDK code under test still runs in the browser; only the bytes
 * travel through this process, much as the embedded simulator's in-process
 * transport bypassed `fetch` before.
 *
 * Isolation: one server per (browser session, test file), started on first
 * use and stopped by the `afterAll` in `remote-simulator-browser-setup.ts`.
 *
 * @packageDocumentation
 */

import { fileURLToPath } from 'node:url'
import type { BrowserCommandContext } from 'vitest/node'
import { resolveServeScript } from '../../scripts/b2-simulator/pin.mjs'
import { type SimulatorProcess, startSimulatorProcess } from './remote-simulator-process.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const servers = new Map<string, Promise<SimulatorProcess>>()

function keyOf(ctx: BrowserCommandContext): string {
  return `${ctx.sessionId}\u0000${ctx.testPath ?? ''}`
}

function serverFor(ctx: BrowserCommandContext): Promise<SimulatorProcess> {
  const key = keyOf(ctx)
  let pending = servers.get(key)
  if (pending === undefined) {
    pending = (async () =>
      startSimulatorProcess({
        serveScript: resolveServeScript({ repoRoot: REPO_ROOT, env: process.env }),
      }))()
    pending.catch(() => servers.delete(key))
    servers.set(key, pending)
  }
  return pending
}

/** A B2 API request serialized for the command channel. */
export interface ProxiedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  /** Request body, base64; null for none. */
  readonly body: string | null
}

/** A B2 API response serialized for the command channel. */
export interface ProxiedResponse {
  readonly status: number
  readonly headers: [string, string][]
  /** Response body, base64. */
  readonly body: string
}

/** The commands, for `browser.commands` in the browser config. */
export const b2SimulatorCommands = {
  /**
   * Reports this session's server, starting it on first use.
   *
   * @param ctx - Command context (identifies the browser session and test file).
   *
   * @returns The URLs of this session's server, starting it on first use.
   */
  async b2simInfo(ctx: BrowserCommandContext): Promise<{ apiUrl: string; controlUrl: string }> {
    const server = await serverFor(ctx)
    return { apiUrl: server.apiUrl, controlUrl: server.controlUrl }
  },

  /**
   * Forwards one control-plane request.
   *
   * @param ctx - Command context.
   * @param method - HTTP method.
   * @param path - Control route, e.g. `/reset`.
   * @param body - JSON body, or undefined for none.
   *
   * @returns Status and parsed JSON body.
   */
  async b2simControl(
    ctx: BrowserCommandContext,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const server = await serverFor(ctx)
    const response = await fetch(`${server.controlUrl}${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    })
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  },

  /**
   * Forwards one B2 API request to this session's server, and only there.
   *
   * @param ctx - Command context.
   * @param request - The serialized request.
   *
   * @returns The serialized response.
   *
   * @throws Error when the URL is not on the server's own origins.
   */
  async b2simSend(ctx: BrowserCommandContext, request: ProxiedRequest): Promise<ProxiedResponse> {
    const server = await serverFor(ctx)
    const origin = new URL(request.url).origin
    if (origin !== server.apiUrl && origin !== server.httpsUrl) {
      throw new Error(
        `standalone simulator proxy refused ${origin}: it only reaches ${server.apiUrl}. Pass realm: sim.realm to the B2Client.`,
      )
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body === null ? null : Buffer.from(request.body, 'base64'),
      redirect: 'manual',
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    return {
      status: response.status,
      headers: [...response.headers.entries()],
      body: bytes.toString('base64'),
    }
  },

  /**
   * Stops this session's server for the finished test file, if one was started.
   *
   * @param ctx - Command context.
   */
  async b2simRelease(ctx: BrowserCommandContext): Promise<void> {
    const key = keyOf(ctx)
    const pending = servers.get(key)
    if (pending === undefined) return
    servers.delete(key)
    await (await pending).stop()
  },
}
