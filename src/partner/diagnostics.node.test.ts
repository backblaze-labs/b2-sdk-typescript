import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { HttpRequest, UrlGuardedTransport } from '../http/transport.ts'
import { UrlGuard } from '../http/url-guard.ts'
import { B2Simulator } from '../simulator/index.ts'
import { jsonResponse } from '../test-utils/index.ts'
import { accountId, applicationKeyId, groupId, partnerToken } from '../types/ids.ts'
import { PartnerCapability, Region } from '../types/partner.ts'
import { PartnerClient } from './client.ts'
import { InMemoryPartnerAccountInfo } from './in-memory.ts'
import { PartnerRawClient } from './raw.ts'
import { APPLICATION_KEY_REDACTED } from './redaction.ts'

function makeGuardedRawClient(responses: Readonly<Record<string, unknown>>): PartnerRawClient {
  const urlGuard = new UrlGuard()
  urlGuard.setAllowedSuffixes(['backblazeb2.com'])
  const transport: UrlGuardedTransport = {
    urlGuard,
    async send(request: HttpRequest) {
      const endpoint = new URL(request.url).pathname.split('/').at(-1) ?? ''
      return jsonResponse(responses[endpoint] ?? {})
    },
  }
  return new PartnerRawClient({ transport })
}

describe('Partner Node diagnostics', () => {
  it('redacts group-member application keys through util.inspect', async () => {
    const secret = 'application-key-secret'
    const raw = makeGuardedRawClient({
      b2_create_group_member: {
        applicationKey: secret,
        applicationKeyId: applicationKeyId('application-key-id'),
        groupMember: {
          accountId: accountId('member-account'),
          email: 'member@example.com',
          groupId: groupId('254'),
          groupName: 'Example Group',
          region: Region.UsWest,
          s3Endpoint: 's3.us-west-004.backblazeb2.com',
        },
      },
    })

    const result = await raw.createGroupMember(
      'https://groups.backblazeb2.com/partner',
      partnerToken('partner-token'),
      {
        adminAccountId: accountId('admin-account'),
        groupId: groupId('254'),
        memberEmail: 'member@example.com',
      },
    )
    const created = result

    expect(inspect(result)).not.toContain(secret)
    expect(inspect(created)).not.toContain(secret)
    expect(inspect(result)).toContain(APPLICATION_KEY_REDACTED)
    expect(inspect(created)).toContain(APPLICATION_KEY_REDACTED)
  })

  it('redacts reserve trial application keys through util.inspect', async () => {
    const sim = new B2Simulator({ partnerAuthorize: true })
    const raw = new PartnerRawClient({ transport: sim.transport() })
    const auth = await raw.authorizePartner('master-key-id', 'master-key')
    if (auth.groupsApiUrl === undefined) throw new Error('expected simulator Partner API URL')

    const result = await raw.reserveTrialCreateAccount(auth.groupsApiUrl, auth.authorizationToken, {
      email: 'trial-node-inspect-redaction@example.com',
      term: 7,
      storage: 1,
    })
    const account = result

    expect(inspect(result)).not.toContain(account.applicationKey)
    expect(inspect(account)).not.toContain(account.applicationKey)
    expect(inspect(result)).toContain(APPLICATION_KEY_REDACTED)
    expect(inspect(account)).toContain(APPLICATION_KEY_REDACTED)
  })

  it('redacts PartnerClient credentials and tokens through util.inspect', () => {
    const partnerAccountInfo = new InMemoryPartnerAccountInfo()
    partnerAccountInfo.setAuth({
      accountId: accountId('partner-account'),
      authorizationToken: partnerToken('partner-token-secret'),
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
    const client = new PartnerClient({
      masterKeyId: 'master-key-id-secret',
      masterKey: 'master-key-secret',
      partnerAccountInfo,
      transport: {
        async send() {
          throw new Error('unexpected request')
        },
      },
    })

    const rendered = [inspect(client), inspect({ client: { ...client } })].join('\n')

    expect(rendered).not.toContain('master-key-id-secret')
    expect(rendered).not.toContain('master-key-secret')
    expect(rendered).not.toContain('masterKey')
    expect(rendered).not.toContain('masterKeyId')
    expect(rendered).not.toContain('partner-token-secret')
    expect(rendered).not.toContain('application-key-secret')
    expect(rendered).toContain('[redacted')
  })
})
