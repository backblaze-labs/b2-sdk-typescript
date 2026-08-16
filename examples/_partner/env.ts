import { BackupClient } from '@backblaze-labs/b2-sdk/backup'
import { PartnerClient, Region, type Region as RegionValue } from '@backblaze-labs/b2-sdk/partner'

const REGION_VALUES = new Set<string>(Object.values(Region))

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (value !== undefined && value !== '') return value
  fail(`Set ${name} before running this example.`)
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function masterKeyOptions(): {
  readonly masterKeyId: string
  readonly masterKey: string
  readonly realm?: string
} {
  const realm = optionalEnv('B2_REALM')
  return {
    masterKeyId: requireEnv('B2_MASTER_KEY_ID'),
    masterKey: requireEnv('B2_MASTER_KEY'),
    ...(realm !== undefined ? { realm } : {}),
  }
}

export function partnerClientFromEnv(): PartnerClient {
  return new PartnerClient(masterKeyOptions())
}

export function backupClientFromEnv(): BackupClient {
  return new BackupClient(masterKeyOptions())
}

export function positiveInteger(raw: string | undefined, name: string): number {
  if (raw === undefined || raw.trim() === '') {
    fail(`Provide ${name}.`)
  }

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${name} must be a positive integer.`)
  }
  return value
}

export function optionalPositiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  return positiveInteger(raw, name)
}

export function parseRegion(raw: string | undefined): RegionValue | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  if (REGION_VALUES.has(raw)) return raw as RegionValue

  fail(`Region must be one of: ${Object.values(Region).join(', ')}.`)
}

export function requireConfirmation(envName: string, action: string): void {
  if (process.env[envName] === '1') return
  fail(`${action} Set ${envName}=1 to confirm.`)
}

export function formatTimestamp(timestampMillis: number): string {
  if (!Number.isFinite(timestampMillis)) return String(timestampMillis)
  return new Date(timestampMillis).toISOString()
}
