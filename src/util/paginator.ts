/**
 * Generic pagination helpers for B2 list endpoints.
 *
 * B2 returns paginated results as `{ items, nextCursor }` shapes that differ
 * per endpoint (`nextFileName`, `nextFileId`, `nextPartNumber`,
 * `nextApplicationKeyId`, etc.). These helpers let callers iterate without
 * threading the cursor by hand.
 *
 * Two flavours:
 *   - {@link paginatePages} yields each page as the server returned it.
 *     Useful when the caller wants the per-page response object (e.g. for
 *     access to per-page metadata or to control item-iteration order).
 *   - {@link paginateItems} flattens pages and yields individual items.
 *     Useful for the common "iterate everything" case.
 *
 * Both helpers honour an optional {@link AbortSignal} that aborts the
 * iteration **between fetches**. They do NOT abort an in-flight network
 * request: the underlying list call has its own `signal` parameter and
 * each consumer must wire that through if mid-flight cancellation is
 * required.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * for await (const file of bucket.paginateFileNames({ prefix: 'photos/' })) {
 *   console.log(file.fileName, file.contentLength)
 * }
 * ```
 *
 */

/**
 * Options accepted by every `paginateX` method on `Bucket` and `B2Client`.
 */
export interface PaginatorOptions {
  /**
   * Maximum items per page. Forwarded to the underlying list call's
   * `maxFileCount` / `maxKeyCount` / `maxPartCount` parameter. B2 caps this
   * at endpoint-specific limits (typically 10000 for files, 100 for parts).
   */
  pageSize?: number
  /**
   * Aborts the iteration between fetches. When already aborted at call time,
   * the iterator throws immediately on its first `next()` call.
   *
   * Note: this does NOT abort an in-flight HTTP request mid-page. The
   * iterator checks `signal.throwIfAborted()` only between fetches.
   */
  signal?: AbortSignal
}

/**
 * Function that fetches a single page given a cursor.
 *
 * The cursor is `undefined` for the first page, then takes the value of the
 * previous page's `nextCursor` on subsequent calls. Iteration stops when
 * `nextCursor` is `undefined` (or any other falsy value the caller maps to
 * `undefined`).
 *
 * @typeParam Page - The per-page response shape returned by the B2 endpoint.
 * @typeParam Cursor - The cursor type (typically `string` or a `{name, id}` pair).
 */
export type PageFetcher<Page, Cursor> = (cursor: Cursor | undefined) => Promise<{
  /** The page just fetched. */
  page: Page
  /** Cursor for the next page, or `undefined` if there are no more pages. */
  nextCursor: Cursor | undefined
}>

/**
 * Async-iterates one page at a time. Stops when `fetcher` returns
 * `nextCursor: undefined`.
 *
 * @typeParam Page - The per-page response shape.
 * @typeParam Cursor - The cursor type used to request the next page.
 *
 * @param fetcher - Function that fetches one page given the current cursor.
 * @param signal - Optional abort signal. Checked before each fetch.
 *
 * @returns An async iterable of pages.
 *
 * @throws DOMException When `signal` is aborted between fetches.
 *
 * @example
 * ```ts
 * for await (const page of paginatePages(
 *   async (cursor) => {
 *     const resp = await bucket.listFileNames({ startFileName: cursor })
 *     return { page: resp, nextCursor: resp.nextFileName ?? undefined }
 *   },
 *   abortSignal,
 * )) {
 *   for (const file of page.files) { ... }
 * }
 * ```
 */
export async function* paginatePages<Page, Cursor>(
  fetcher: PageFetcher<Page, Cursor>,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<Page> {
  let cursor: Cursor | undefined
  for (;;) {
    signal?.throwIfAborted()
    const { page, nextCursor } = await fetcher(cursor)
    yield page
    if (nextCursor === undefined) return
    cursor = nextCursor
  }
}

/**
 * Async-iterates items by flattening pages. The `extractItems` function
 * pulls the relevant array out of each page (e.g. `page.files`,
 * `page.keys`, `page.parts`). Each item is yielded individually so the
 * caller can `for await (const item of paginator)` rather than nest loops.
 *
 * Aborts between **pages**, not between items: if `signal` is aborted while
 * the caller is processing the items of page N, the iterator will still
 * yield all of page N's remaining items before checking the signal before
 * fetching page N+1.
 *
 * @typeParam Page - The per-page response shape.
 * @typeParam Cursor - The cursor type used to request the next page.
 * @typeParam Item - The item type the caller wants to iterate.
 *
 * @param fetcher - Function that fetches one page given the current cursor.
 * @param extractItems - Pulls the iterable items out of a page.
 * @param signal - Optional abort signal. Checked before each fetch.
 *
 * @returns An async iterable of individual items.
 *
 * @throws DOMException When `signal` is aborted between fetches.
 */
export async function* paginateItems<Page, Cursor, Item>(
  fetcher: PageFetcher<Page, Cursor>,
  extractItems: (page: Page) => Iterable<Item>,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<Item> {
  for await (const page of paginatePages(fetcher, signal)) {
    yield* extractItems(page)
  }
}
