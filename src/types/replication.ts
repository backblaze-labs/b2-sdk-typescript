import type { ApplicationKeyId, BucketId } from './ids.js'

/** A single replication rule defining how files are replicated to a destination bucket. */
export interface ReplicationRule {
  /** Destination bucket ID where replicated files are stored. */
  readonly destinationBucketId: BucketId
  /** Only files with this prefix are replicated. Empty string means all files. */
  readonly fileNamePrefix: string
  /** Whether to replicate files that existed before this rule was created. */
  readonly includeExistingFiles: boolean
  /** Whether this replication rule is currently active. */
  readonly isEnabled: boolean
  /** Priority of this rule relative to other rules. Lower numbers take precedence. */
  readonly priority: number
  /** Human-readable name for this replication rule. */
  readonly replicationRuleName: string
}

/** Configuration for a bucket acting as a replication destination. */
export interface ReplicationDestination {
  /** Mapping from source application key IDs to destination application key IDs. */
  readonly sourceToDestinationKeyMapping: Record<string, ApplicationKeyId>
}

/** Configuration for a bucket acting as a replication source. */
export interface ReplicationSource {
  /** Application key ID authorized to read from the source bucket. */
  readonly sourceApplicationKeyId: ApplicationKeyId
}

/** Complete replication configuration for a bucket, covering both source and destination roles. */
export interface ReplicationConfiguration {
  /** Source-side configuration with replication rules, or null if not a source. */
  readonly asReplicationSource: {
    /** Rules governing which files are replicated and where. */
    readonly replicationRules: readonly ReplicationRule[]
    /** Application key ID authorized to read from this source bucket. */
    readonly sourceApplicationKeyId: ApplicationKeyId
  } | null
  /** Destination-side configuration with key mappings, or null if not a destination. */
  readonly asReplicationDestination: {
    /** Mapping from source application key IDs to destination application key IDs. */
    readonly sourceToDestinationKeyMapping: Record<string, ApplicationKeyId>
  } | null
}
