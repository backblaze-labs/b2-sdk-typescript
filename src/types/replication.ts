import type { ApplicationKeyId, BucketId } from './ids.js'

export interface ReplicationRule {
  readonly destinationBucketId: BucketId
  readonly fileNamePrefix: string
  readonly includeExistingFiles: boolean
  readonly isEnabled: boolean
  readonly priority: number
  readonly replicationRuleName: string
}

export interface ReplicationDestination {
  readonly sourceToDestinationKeyMapping: Record<string, ApplicationKeyId>
}

export interface ReplicationSource {
  readonly sourceApplicationKeyId: ApplicationKeyId
}

export interface ReplicationConfiguration {
  readonly asReplicationSource: {
    readonly replicationRules: readonly ReplicationRule[]
    readonly sourceApplicationKeyId: ApplicationKeyId
  } | null
  readonly asReplicationDestination: {
    readonly sourceToDestinationKeyMapping: Record<string, ApplicationKeyId>
  } | null
}
