import { PartnerClient, Region, type Region as RegionValue } from '@backblaze-labs/b2-sdk/partner'
import { fail, masterKeyOptions } from './env.ts'

const REGION_VALUES = new Set<string>(Object.values(Region))

export function partnerClientFromEnv(): PartnerClient {
  return new PartnerClient(masterKeyOptions())
}

export function parseRegion(raw: string | undefined): RegionValue | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '') return undefined
  if (REGION_VALUES.has(value)) return value as RegionValue

  fail(`Region must be one of: ${Object.values(Region).join(', ')}.`)
}
