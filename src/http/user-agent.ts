import { VERSION } from '../version.ts'

/**
 * Detects the current JavaScript runtime (Node, Deno, Bun, or browser).
 *
 * @returns A string identifier for the active runtime environment.
 */
function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>
  if (typeof g['Deno'] !== 'undefined') return 'deno'
  if (typeof g['Bun'] !== 'undefined') return 'bun'
  if (typeof g['process'] !== 'undefined') {
    const proc = g['process'] as { versions?: { node?: string } }
    if (proc.versions?.node) return `node/${proc.versions.node}`
  }
  if (typeof g['navigator'] !== 'undefined') return 'browser'
  return 'unknown'
}

/**
 * Builds the User-Agent string for B2 API requests.
 * Format: `b2-sdk-ts/{version} ({runtime})`, optionally prefixed with a custom string.
 *
 * @param custom - Optional prefix prepended to the default User-Agent.
 *
 * @returns The formatted User-Agent header string.
 */
export function getUserAgent(custom?: string): string {
  const base = `b2-sdk-ts/${VERSION} (${detectRuntime()})`
  return custom ? `${custom} ${base}` : base
}
