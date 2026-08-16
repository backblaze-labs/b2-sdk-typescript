import type { HttpTransport } from '@backblaze-labs/b2-sdk'
import { PartnerClient, Region, type Region as RegionValue } from '@backblaze-labs/b2-sdk/partner'
import { fail, masterKeyOptions } from './env.ts'

const REGION_VALUES = new Set<string>(Object.values(Region))

async function smokePartnerTransport(): Promise<HttpTransport | undefined> {
  if (process.env.B2_USE_SIMULATOR !== '1') return undefined

  const { B2Simulator } = await import('@backblaze-labs/b2-sdk/simulator')
  return new B2Simulator({ partnerAuthorize: true }).transport()
}

export async function partnerClientFromEnv(): Promise<PartnerClient> {
  const transport = await smokePartnerTransport()
  return new PartnerClient({
    ...masterKeyOptions(),
    ...(transport !== undefined ? { transport } : {}),
  })
}

export function parseRegion(raw: string | undefined): RegionValue | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '') return undefined
  if (REGION_VALUES.has(value)) return value as RegionValue

  fail(`Region must be one of: ${Object.values(Region).join(', ')}.`)
}
