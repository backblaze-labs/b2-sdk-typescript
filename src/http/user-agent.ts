import { VERSION } from '../version.ts'

/**
 * Stable identifier Backblaze can grep server logs for to find every request
 * issued by this SDK regardless of how the User-Agent comment evolves.
 * Treat as part of the public contract: do NOT rename without coordinating.
 */
export const SDK_PRODUCT = 'b2-sdk-ts'

/**
 * The npm package name. Embedded in the User-Agent comment alongside
 * {@link SDK_PRODUCT} so log queries that grep on either token work.
 */
export const SDK_PACKAGE = '@backblaze/b2-sdk'

/** Detected runtime + OS information for the User-Agent comment. */
interface Platform {
  /** Runtime identifier: `node/<x.y.z>`, `bun/<x.y.z>`, `deno/<x.y.z>`, `browser`, or `unknown`. */
  readonly runtime: string
  /** OS identifier (`linux`, `darwin`, `win32`, etc.) when available, or `undefined`. */
  readonly os: string | undefined
  /** CPU architecture (`x64`, `arm64`, etc.) when available, or `undefined`. */
  readonly arch: string | undefined
}

/**
 * Best-effort detection of the JS runtime and host OS. Used to populate the
 * User-Agent comment so server-side logs can spot Bun/Deno adoption and
 * triage OS-specific issues without asking for a repro environment.
 *
 * @returns The detected runtime, OS, and architecture tokens.
 */
function detectPlatform(): Platform {
  const g = globalThis as Record<string, unknown>

  // Deno: Deno.version.deno, Deno.build.{os,arch}.
  if (typeof g['Deno'] !== 'undefined') {
    const deno = g['Deno'] as {
      version?: { deno?: string }
      build?: { os?: string; arch?: string }
    }
    return {
      runtime: deno.version?.deno ? `deno/${deno.version.deno}` : 'deno',
      os: deno.build?.os,
      arch: deno.build?.arch,
    }
  }

  // Bun: globalThis.Bun.version, process.platform/arch (Bun is Node-compat).
  if (typeof g['Bun'] !== 'undefined') {
    const bun = g['Bun'] as { version?: string }
    const proc = g['process'] as { platform?: string; arch?: string } | undefined
    return {
      runtime: bun.version ? `bun/${bun.version}` : 'bun',
      os: proc?.platform,
      arch: proc?.arch,
    }
  }

  // Node: process.versions.node, process.platform, process.arch.
  if (typeof g['process'] !== 'undefined') {
    const proc = g['process'] as {
      versions?: { node?: string }
      platform?: string
      arch?: string
    }
    if (proc.versions?.node) {
      return {
        runtime: `node/${proc.versions.node}`,
        os: proc.platform,
        arch: proc.arch,
      }
    }
  }

  // Browsers (and other navigator-only runtimes like Cloudflare Workers,
  // Vercel Edge, etc.). We deliberately do NOT parse the existing navigator
  // UA — that's noisy, often spoofed, and the request layer already adds the
  // browser's own UA on top.
  if (typeof g['navigator'] !== 'undefined') {
    return { runtime: 'browser', os: undefined, arch: undefined }
  }

  return { runtime: 'unknown', os: undefined, arch: undefined }
}

/**
 * Build the User-Agent header value the SDK sends on every B2 request.
 *
 * Default format:
 * ```
 * b2-sdk-ts/<version> (typescript; @backblaze/b2-sdk; <runtime>; <os>; <arch>)
 * ```
 *
 * `<os>` and `<arch>` are omitted when not detectable (e.g. inside a browser).
 * A custom prefix from {@link import('../client.ts').B2ClientOptions.userAgent}
 * is prepended verbatim so app-level identifiers come first:
 * ```
 * my-app/1.0 b2-sdk-ts/0.1.0 (typescript; @backblaze/b2-sdk; node/24.14.1; linux; x64)
 * ```
 *
 * @param custom - Optional prefix prepended to the default User-Agent.
 *
 * @returns The formatted User-Agent header string.
 */
export function getUserAgent(custom?: string): string {
  const { runtime, os, arch } = detectPlatform()
  const parts = ['typescript', SDK_PACKAGE, runtime]
  if (os !== undefined) parts.push(os)
  if (arch !== undefined) parts.push(arch)
  const base = `${SDK_PRODUCT}/${VERSION} (${parts.join('; ')})`
  return custom ? `${custom} ${base}` : base
}
