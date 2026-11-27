/**
 * Browser side of the standalone-simulator harness. Every control request and
 * every B2 API request goes through the Vitest commands in
 * `remote-simulator-commands.ts`, which forward it to this test file's own
 * server. See that file for why the browser cannot reach the server directly.
 *
 * Only loaded under `pnpm test:browser` (dynamic import from
 * `remote-simulator.ts`).
 *
 * @packageDocumentation
 */

import { commands } from 'vitest/browser'
import type { HttpRequest, HttpResponse, HttpTransport } from '../http/transport.ts'
import type { ProxiedRequest, ProxiedResponse } from './remote-simulator-commands.ts'

declare module 'vitest/browser' {
  interface BrowserCommands {
    b2simInfo(): Promise<{ apiUrl: string; controlUrl: string }>
    b2simControl(
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<{ status: number; body: unknown }>
    b2simSend(request: ProxiedRequest): Promise<ProxiedResponse>
    b2simRelease(): Promise<void>
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

const proxyTransport: HttpTransport = {
  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted === true) throw abortError(request.signal)
    // Serialize string and byte bodies synchronously so requests reach the server
    // in the order the SDK sent them (the reauth-coalescing tests depend on it);
    // only streams and blobs need an await.
    const raw = request.body
    let body: string | null
    if (raw === undefined || raw === null) body = null
    else if (typeof raw === 'string') body = toBase64(new TextEncoder().encode(raw))
    else if (raw instanceof Uint8Array) body = toBase64(raw)
    else if (raw instanceof ArrayBuffer) body = toBase64(new Uint8Array(raw))
    else if (ArrayBuffer.isView(raw)) {
      body = toBase64(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    } else body = toBase64(new Uint8Array(await new Response(raw).arrayBuffer()))
    const sent = commands.b2simSend({
      url: request.url,
      method: request.method,
      headers: { ...(request.headers ?? {}) },
      body,
    })
    const signal = request.signal
    const proxied =
      signal === undefined
        ? await sent
        : await Promise.race([
            sent,
            new Promise<never>((_, reject) => {
              signal.addEventListener('abort', () => reject(abortError(signal)), { once: true })
            }),
          ])
    const bytes = fromBase64(proxied.body)
    const response = new Response(
      request.method === 'HEAD' || proxied.status === 204 || proxied.status === 304
        ? null
        : (bytes as BodyInit),
      { status: proxied.status, headers: proxied.headers },
    )
    return {
      status: response.status,
      headers: response.headers,
      body: response.body,
      json: <T>() => response.json() as Promise<T>,
      text: () => response.text(),
      arrayBuffer: () => response.arrayBuffer(),
    }
  },
}

/**
 * Connects to this test file's standalone simulator through the Vitest commands.
 *
 * @returns The connection used by `remote-simulator.ts`.
 */
export async function browserConnection(): Promise<{
  apiUrl: string
  controlUrl: string
  control(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>
  transport(): HttpTransport
}> {
  const { apiUrl, controlUrl } = await commands.b2simInfo()
  return {
    apiUrl,
    controlUrl,
    control: (method, path, body) => commands.b2simControl(method, path, body),
    transport: () => proxyTransport,
  }
}
