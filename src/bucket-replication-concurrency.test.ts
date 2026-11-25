import { describe, expect, it } from 'vitest'
import { makeClient } from './test-utils/index.ts'
import { BucketType } from './types/bucket.ts'
import { applicationKeyId, bucketId } from './types/ids.ts'
import type { ReplicationRule } from './types/replication.ts'

describe('bucket replication rule concurrent updates', () => {
  it('retains both concurrent additions and removals', async () => {
    const { client } = makeClient()
    await client.authorize()
    const bucket = await client.createBucket({
      bucketName: 'replication-race',
      bucketType: BucketType.AllPrivate,
    })
    const rule = (name: string, priority: number): ReplicationRule => ({
      replicationRuleName: name,
      destinationBucketId: bucketId(`dest-${name}`),
      fileNamePrefix: `${name}/`,
      includeExistingFiles: false,
      isEnabled: true,
      priority,
    })
    const options = { sourceApplicationKeyId: applicationKeyId('source-key') }
    await Promise.all([
      bucket.addReplicationRule(rule('a', 1), options),
      bucket.addReplicationRule(rule('b', 2), options),
    ])
    const names = async () =>
      (await bucket.getReplication()).value?.asReplicationSource?.replicationRules
        .map((entry) => entry.replicationRuleName)
        .sort()
    expect(await names()).toEqual(['a', 'b'])
    await Promise.all([bucket.removeReplicationRule('a'), bucket.removeReplicationRule('b')])
    expect(await names()).toEqual([])
  })
})
