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

import { request as httpRequest } from 'node:http'
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

/**
 * Sends one request over plain HTTP and returns the response bytes exactly as
 * the server sent them. Unlike `fetch`, this does not decode a
 * `Content-Encoding` body: the realm echoes `b2ContentEncoding` overrides as
 * `Content-Encoding` on bytes that are not encoded, and a browser only decodes
 * a body when the page reads it, which a headers-only test never does.
 *
 * @param url - The request URL (an `http:` URL on the server's own origin).
 * @param method - The HTTP method.
 * @param headers - The request headers.
 * @param body - The request body, or null for none.
 *
 * @returns The status, headers and raw body bytes.
 */
function sendRaw(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer | null,
): Promise<{ status: number; headers: [string, string][]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // Send a body with a Content-Length, as fetch does, not chunked.
    const hasLength = Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')
    const sent =
      body === null || hasLength ? headers : { ...headers, 'content-length': String(body.length) }
    const req = httpRequest(url, { method, headers: sent }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const entries: [string, string][] = []
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          entries.push([name, Array.isArray(value) ? value.join(', ') : value])
        }
        resolve({ status: res.statusCode ?? 0, headers: entries, body: Buffer.concat(chunks) })
      })
    })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
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
    const body = request.body === null ? null : Buffer.from(request.body, 'base64')
    if (origin === server.apiUrl) {
      const response = await sendRaw(request.url, request.method, request.headers, body)
      return { ...response, body: response.body.toString('base64') }
    }
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
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
