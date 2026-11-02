import { afterEach, describe, expect, it, vi } from 'vitest'

// the live-suite credential gate is the only thing that turns "no credentials"
// from a silent skip into a failure in CI. These offline tests pin that behaviour.
// The helper reads its environment at import time, so each case re-imports it.
async function loadHelper(env: Record<string, string>) {
  vi.resetModules()
  for (const name of [
    'B2_APPLICATION_KEY_ID',
    'B2_APPLICATION_KEY',
    'B2_MASTER_KEY_ID',
    'B2_MASTER_KEY',
    'B2_INTEGRATION_REQUIRE_CREDENTIALS',
    'B2_INTEGRATION_REQUIRE_MASTER_CREDENTIALS',
    'B2_INTEGRATION_REQUIRE_PARTNER_CREDENTIALS',
  ]) {
    vi.stubEnv(name, env[name] ?? '')
  }
  return await import('./live-b2.ts')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('requireB2IntegrationCredentials', () => {
  it('does not throw without the require flag, even with no credentials (live tests skip)', async () => {
    const helper = await loadHelper({})
    expect(helper.skipB2Integration).toBe(true)
    expect(() => helper.requireB2IntegrationCredentials()).not.toThrow()
  })

  it('throws instead of skipping when the require flag is set and credentials are missing', async () => {
    const helper = await loadHelper({ B2_INTEGRATION_REQUIRE_CREDENTIALS: '1' })
    expect(() => helper.requireB2IntegrationCredentials()).toThrow(
      /credentials are required when B2_INTEGRATION_REQUIRE_CREDENTIALS=1/,
    )
  })

  it('throws on partially supplied credentials when the flag is set', async () => {
    const helper = await loadHelper({
      B2_INTEGRATION_REQUIRE_CREDENTIALS: '1',
      B2_APPLICATION_KEY_ID: 'id-only',
    })
    expect(() => helper.requireB2IntegrationCredentials()).toThrow(/must be provided together/)
  })

  it('accepts a complete key pair when the flag is set', async () => {
    const helper = await loadHelper({
      B2_INTEGRATION_REQUIRE_CREDENTIALS: '1',
      B2_APPLICATION_KEY_ID: 'id',
      B2_APPLICATION_KEY: 'key',
    })
    expect(helper.skipB2Integration).toBe(false)
    expect(() => helper.requireB2IntegrationCredentials()).not.toThrow()
  })
})

describe('requireMasterCredentials', () => {
  it('does not throw without a flag', async () => {
    const helper = await loadHelper({})
    expect(() => helper.requireMasterCredentials()).not.toThrow()
  })

  it.each([
    'B2_INTEGRATION_REQUIRE_MASTER_CREDENTIALS',
    'B2_INTEGRATION_REQUIRE_PARTNER_CREDENTIALS',
  ])('throws when %s is set and the master key is missing', async (flag) => {
    const helper = await loadHelper({ [flag]: '1' })
    expect(() => helper.requireMasterCredentials()).toThrow(
      /master-key integration credentials are required/,
    )
  })
})
