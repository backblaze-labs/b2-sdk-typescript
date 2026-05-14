/**
 * Shared SDK-wide default values.
 *
 * Centralising defaults here makes the trade-offs visible and prevents the
 * drift that creeps in when each module hard-codes its own magic number.
 *
 * @packageDocumentation
 */

/**
 * Default parallel-task count for **data-transfer** operations: uploads
 * (multipart parts), downloads (byte ranges), server-side copies (parts),
 * and sync (file-by-file). Each in-flight task occupies one transport
 * slot and at least one part-worth of memory, so we keep this
 * conservative.
 *
 * Empirically `4` saturates a typical home / office uplink without
 * starving the event loop or risking B2's per-account upload-URL
 * rate-limit. Callers that have measured their environment can override
 * via the `concurrency` option on every transfer method.
 */
export const DEFAULT_TRANSFER_CONCURRENCY = 4

/**
 * Default parallel-task count for **bulk metadata** operations:
 * `Bucket.deleteMany` (per-version delete calls), and the action loop in
 * `synchronize` when it dispatches mixed actions in batches.
 *
 * Higher than the transfer default because each task is a tiny API
 * round-trip (no payload), so concurrency is bound by API latency rather
 * than bandwidth or local memory. `10` keeps a delete-of-thousands
 * snappy without overwhelming a single account's request budget.
 */
export const DEFAULT_BULK_CONCURRENCY = 10

/**
 * Default `maxFileCount` for list-style endpoints
 * (`b2_list_file_names`, `b2_list_file_versions`, `b2_list_parts`). B2
 * caps `maxFileCount` at `10000` for these endpoints; the SDK requests
 * `1000` per page so a single network blip doesn't lose 10× the work and
 * so callers see results sooner.
 *
 * `b2_list_unfinished_large_files` is capped at `100` server-side and is
 * not affected by this constant.
 */
export const DEFAULT_PAGE_SIZE = 1000

/**
 * Default MIME type for uploads when the caller omits `contentType`.
 * B2 documents `b2/x-auto` as the magic value that asks the service to
 * sniff the file's content and pick a sensible `Content-Type` itself.
 * Centralising the literal here keeps the upload, copy, and create-write
 * paths in sync.
 *
 * @see https://www.backblaze.com/apidocs/b2-upload-file
 */
export const DEFAULT_CONTENT_TYPE = 'b2/x-auto'
