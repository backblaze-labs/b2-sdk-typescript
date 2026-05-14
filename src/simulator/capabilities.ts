/**
 * Capability requirement table mapping each B2 native API endpoint to
 * the capability (or capabilities — usually one) the caller's
 * application key must hold to invoke it. Used by `B2Simulator` when
 * `strictAuth: true` is set, so test code that exercises a restricted
 * key sees the same `403 unauthorized` response real B2 would return.
 *
 * Source: https://www.backblaze.com/apidocs (each endpoint page lists
 * the required capability in its description).
 *
 * @packageDocumentation
 */

import { Capability } from '../types/auth.ts'

/** Endpoint → required capability(s). An empty array means "no capability check". */
export const ENDPOINT_CAPABILITIES: Record<string, readonly Capability[]> = {
  // Auth endpoint takes credentials, not an auth token — no cap check.
  b2_authorize_account: [],
  // Bucket management.
  b2_create_bucket: [Capability.WriteBuckets],
  b2_delete_bucket: [Capability.DeleteBuckets],
  b2_update_bucket: [Capability.WriteBuckets],
  b2_list_buckets: [Capability.ListBuckets],
  // File upload + URL acquisition.
  b2_get_upload_url: [Capability.WriteFiles],
  b2_get_upload_part_url: [Capability.WriteFiles],
  b2_upload_file: [Capability.WriteFiles],
  b2_upload_part: [Capability.WriteFiles],
  b2_start_large_file: [Capability.WriteFiles],
  b2_finish_large_file: [Capability.WriteFiles],
  b2_cancel_large_file: [Capability.WriteFiles],
  b2_copy_file: [Capability.WriteFiles],
  b2_copy_part: [Capability.WriteFiles],
  // File listing + reading.
  b2_list_file_names: [Capability.ListFiles],
  b2_list_file_versions: [Capability.ListFiles],
  b2_list_unfinished_large_files: [Capability.ListFiles],
  b2_list_parts: [Capability.ListFiles],
  b2_get_file_info: [Capability.ReadFiles],
  b2_download_file_by_id: [Capability.ReadFiles],
  b2_download_file_by_name: [Capability.ReadFiles],
  // File mutations.
  b2_hide_file: [Capability.WriteFiles],
  b2_delete_file_version: [Capability.DeleteFiles],
  // Object lock + legal hold.
  b2_update_file_retention: [Capability.WriteFileRetentions],
  b2_update_file_legal_hold: [Capability.WriteFileLegalHolds],
  // Application keys.
  b2_create_key: [Capability.WriteKeys],
  b2_list_keys: [Capability.ListKeys],
  b2_delete_key: [Capability.DeleteKeys],
  // Download authorisation.
  b2_get_download_authorization: [Capability.ShareFiles],
  // Notification rules.
  b2_get_bucket_notification_rules: [Capability.ReadBucketNotifications],
  b2_set_bucket_notification_rules: [Capability.WriteBucketNotifications],
}

/**
 * Find which capabilities are missing from the caller's grant set
 * relative to the endpoint requirement.
 *
 * @param endpoint - B2 endpoint name (e.g. `'b2_upload_file'`).
 * @param granted - Capabilities the caller's key has.
 *
 * @returns The subset of required capabilities that the caller is
 *   missing. Empty array means "request authorized".
 */
export function missingCapabilitiesFor(
  endpoint: string,
  granted: readonly Capability[],
): readonly Capability[] {
  const required = ENDPOINT_CAPABILITIES[endpoint] ?? []
  const grantedSet = new Set(granted)
  return required.filter((cap) => !grantedSet.has(cap))
}
