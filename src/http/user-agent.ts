import { VERSION } from '../version.js'

function detectRuntime(): string {
  const g = globalThis as Record<string, unknown>
  if (typeof g.Deno !== 'undefined') return 'deno'
  if (typeof g.Bun !== 'undefined') return 'bun'
  if (typeof g.process !== 'undefined') {
    const proc = g.process as { versions?: { node?: string } }
    if (proc.versions?.node) return `node/${proc.versions.node}`
  }
  if (typeof g.navigator !== 'undefined') return 'browser'
  return 'unknown'
}

export function getUserAgent(custom?: string): string {
  const base = `b2-sdk-ts/${VERSION} (${detectRuntime()})`
  return custom ? `${custom} ${base}` : base
}
