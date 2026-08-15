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
  })
})
