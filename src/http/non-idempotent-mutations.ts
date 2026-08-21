/** Partner API endpoints that must not be automatically replayed. */
export const PARTNER_NON_IDEMPOTENT_MUTATION_ENDPOINTS = [
  'b2_create_group_member',
  'b2_eject_group_member',
  'b2_reserve_trial_create_account',
] as const

/** Computer Backup API endpoints that must not be automatically replayed. */
export const BACKUP_NON_IDEMPOTENT_MUTATION_ENDPOINTS = ['bz_delete_computer'] as const

/** Partner endpoint name that requires replay opt-out handling. */
export type PartnerNonIdempotentMutationEndpoint =
  (typeof PARTNER_NON_IDEMPOTENT_MUTATION_ENDPOINTS)[number]

/** Computer Backup endpoint name that requires replay opt-out handling. */
export type BackupNonIdempotentMutationEndpoint =
  (typeof BACKUP_NON_IDEMPOTENT_MUTATION_ENDPOINTS)[number]

const PARTNER_NON_IDEMPOTENT_MUTATION_ENDPOINT_SET: ReadonlySet<string> = new Set(
  PARTNER_NON_IDEMPOTENT_MUTATION_ENDPOINTS,
)
const BACKUP_NON_IDEMPOTENT_MUTATION_ENDPOINT_SET: ReadonlySet<string> = new Set(
  BACKUP_NON_IDEMPOTENT_MUTATION_ENDPOINTS,
)

export function isPartnerNonIdempotentMutationEndpoint(
  endpoint: string | undefined,
): endpoint is PartnerNonIdempotentMutationEndpoint {
  return endpoint !== undefined && PARTNER_NON_IDEMPOTENT_MUTATION_ENDPOINT_SET.has(endpoint)
}

export function isBackupNonIdempotentMutationEndpoint(
  endpoint: string | undefined,
): endpoint is BackupNonIdempotentMutationEndpoint {
  return endpoint !== undefined && BACKUP_NON_IDEMPOTENT_MUTATION_ENDPOINT_SET.has(endpoint)
}
