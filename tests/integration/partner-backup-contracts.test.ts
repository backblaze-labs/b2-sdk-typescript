/**
 * Live version-pin smoke for the Partner and Computer Backup APIs.
 *
 * Requires a Master Application Key with sales-approved Partner API access
 * (and, for the group/backup probes, Business Groups / Enterprise Controls
 * provisioned on the key):
 *   B2_MASTER_KEY_ID
 *   B2_MASTER_KEY
 *   B2_REALM (optional)
 *
 * These are the MASTER-key endpoints called out in #228 as having zero live
 * coverage. This smoke confirms that live B2 accepts each read-only method at
 * its pinned wire version: Partner authorize on v3, Partner group reads on v4,
 * and Computer Backup on v1. It records the exact route the SDK sends and only
 * asserts the version once the live call has succeeded, so a green run is
 * evidence B2 accepted that version.
 *
 * The mutating methods (`b2_create_group_member`, `b2_eject_group_member`,
 * `b2_reserve_trial_create_account`, `bz_delete_computer`) are intentionally
 * NOT exercised here: they create or delete real accounts, group members, and
 * backup records, so they cannot be safely probed against a live account. Their
 * version pins are covered by the request-construction guardrails in
 * src/partner/raw.test.ts and src/backup/raw.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { BackupClient } from '../../src/backup/index.ts'
import type { HttpRequest, HttpResponse, HttpTransport } from '../../src/http/transport.ts'
import { FetchTransport } from '../../src/http/transport.ts'
import { PartnerClient } from '../../src/partner/index.ts'

const masterKeyId = process.env['B2_MASTER_KEY_ID'] ?? ''
const masterKey = process.env['B2_MASTER_KEY'] ?? ''
const realm = process.env['B2_REALM']?.trim()
const skip = !masterKeyId || !masterKey

/**
 * Wraps a real {@link FetchTransport} and records the wire version segment seen
 * for each B2 endpoint name, so live-accepted routes can be asserted after the
 * request succeeds. The endpoint name is the terminal path segment and the
 * version is the segment before it (query strings are dropped by `URL`).
 */
function recordingFetchTransport(): {
  transport: HttpTransport
  versionOf: (endpoint: string) => string | undefined
} {
  const inner = new FetchTransport()
  const versions = new Map<string, string>()
  return {
    transport: {
      async send(request: HttpRequest): Promise<HttpResponse> {
        const segments = new URL(request.url).pathname.split('/').filter((s) => s.length > 0)
        const endpoint = segments.at(-1)
        const version = segments.at(-2)
        if (endpoint !== undefined && version !== undefined) versions.set(endpoint, version)
        return inner.send(request)
      },
    },
    versionOf: (endpoint) => versions.get(endpoint),
  }
}

const realmOption = realm !== undefined && realm !== '' ? { realm } : {}

describe.skipIf(skip)('Partner/Backup live API version pins', () => {
  it('authorizes Partner on v3 and reads groups on v4', async () => {
    const recorder = recordingFetchTransport()
    const partner = new PartnerClient({
      masterKeyId,
      masterKey,
      ...realmOption,
      transport: recorder.transport,
    })

    const auth = await partner.authorize()
    expect(recorder.versionOf('b2_authorize_account')).toBe('v3')

    if (auth.groupsApiUrl === undefined) {
      // The key authorized but the Partner groups suite is not provisioned;
      // the v3 authorize confirmation above still holds.
      return
    }

    const groups = await partner.listGroups()
    expect(recorder.versionOf('b2_list_groups')).toBe('v4')

    const firstGroup = groups.groups[0]
    if (firstGroup !== undefined) {
      await partner.listGroupMembers({ groupId: firstGroup.groupId })
      expect(recorder.versionOf('b2_list_group_members')).toBe('v4')
    }
  })

  it('authorizes Backup and lists computers on v1', async () => {
    const recorder = recordingFetchTransport()
    const backup = new BackupClient({
      masterKeyId,
      masterKey,
      ...realmOption,
      transport: recorder.transport,
    })

    const auth = await backup.authorize()
    if (auth.backupApiUrl === undefined) {
      // The key authorized but the Computer Backup suite is not provisioned.
      return
    }

    await backup.listComputers()
    expect(recorder.versionOf('bz_list_computers')).toBe('v1')
  })
})
