import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { accountId, partnerToken } from '../types/ids.ts'
import { PartnerCapability } from '../types/partner.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'

describe('InMemoryPartnerAccountInfo Node inspection', () => {
  it('redacts the Partner token from util.inspect output', () => {
    const accountInfo = new InMemoryPartnerAccountInfo()
    accountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: partnerToken('partner-token'),
      apiInfo: {
        groupsApi: {
          groupsApiUrl: 'https://groups.backblazeb2.com/partner',
          capabilities: [PartnerCapability.All],
          infoType: 'groupsApi',
        },
      },
      groupsApiUrl: 'https://groups.backblazeb2.com/partner',
      groupsCapabilities: [PartnerCapability.All],
      applicationKeyExpirationTimestamp: null,
    })

    expect(inspect(accountInfo)).not.toContain('partner-token')
    expect(inspect(accountInfo.getAuth())).not.toContain('partner-token')
    // "does not contain the token" also passes for an empty or broken dump,
    // so require the redaction marker and the surviving non-secret fields.
    expect(inspect(accountInfo)).toContain('[redacted Partner token]')
    expect(inspect(accountInfo.getAuth())).toContain(
      "authorizationToken: '[redacted Partner token]'",
    )
    expect(inspect(accountInfo.getAuth())).toContain("accountId: 'partner-account'")
  })
})
