import { describe, expect, it } from 'vitest'
import { type PageFetcher, paginateItems, paginatePages } from './paginator.ts'

/**
 * Unit tests for the generic pagination helpers. These exercise the cursor
 * threading, termination conditions, AbortSignal handling, and error
 * propagation independently of any actual B2 endpoint, so the per-endpoint
 * paginator methods in `Bucket` / `B2Client` can be thinner glue layers
 * with their own integration tests.
 */

/**
 * Test helper that builds a `PageFetcher` from an in-memory array of pages.
 * Each page advertises a numeric cursor pointing at the next page's index;
 * the final page returns `nextCursor: undefined` to terminate.
 *
 * Also tracks the cursor sequence the fetcher receives, so tests can assert
 * that the cursor threads forward correctly.
 */
function arrayFetcher<T>(pages: T[][]): {
  fetcher: PageFetcher<{ items: T[]; index: number }, number>
  cursorsSeen: (number | undefined)[]
  callCount: () => number
} {
  const cursorsSeen: (number | undefined)[] = []
  let calls = 0
  return {
    cursorsSeen,
    callCount: () => calls,
    fetcher: async (cursor) => {
      calls += 1
      cursorsSeen.push(cursor)
      const index = cursor ?? 0
      const items = pages[index] ?? []
      const nextCursor = index + 1 < pages.length ? index + 1 : undefined
      return { page: { items, index }, nextCursor }
    },
  }
}

describe('paginatePages', () => {
  it('iterates a single empty page when there is one to return', async () => {
    const { fetcher } = arrayFetcher<number>([[]])
    const pages: { items: number[]; index: number }[] = []
    for await (const page of paginatePages(fetcher, undefined)) pages.push(page)
    expect(pages).toEqual([{ items: [], index: 0 }])
  })

  it('iterates multiple pages, threading the cursor between fetches', async () => {
    const { fetcher, cursorsSeen, callCount } = arrayFetcher([
      [1, 2, 3],
      [4, 5],
      [6, 7, 8, 9],
    ])
    const pages: number[][] = []
    for await (const page of paginatePages(fetcher, undefined)) {
      pages.push([...page.items])
    }
    expect(pages).toEqual([
      [1, 2, 3],
      [4, 5],
      [6, 7, 8, 9],
    ])
    expect(cursorsSeen).toEqual([undefined, 1, 2])
    expect(callCount()).toBe(3)
  })

  it('stops at the page where nextCursor is undefined', async () => {
    let callCount = 0
    const fetcher: PageFetcher<string, number> = async (cursor) => {
      callCount += 1
      if (cursor === undefined) return { page: 'first', nextCursor: 1 }
      return { page: 'second', nextCursor: undefined }
    }
    const pages: string[] = []
    for await (const page of paginatePages(fetcher, undefined)) pages.push(page)
    expect(pages).toEqual(['first', 'second'])
    expect(callCount).toBe(2)
  })

  it('aborts before the first fetch when the signal is already aborted', async () => {
    const { fetcher, callCount } = arrayFetcher([[1, 2, 3]])
    const controller = new AbortController()
    controller.abort()
    await expect(async () => {
      for await (const _page of paginatePages(fetcher, controller.signal)) {
        // unreachable
      }
    }).rejects.toThrow()
    // Fetcher must NOT have been called at all.
    expect(callCount()).toBe(0)
  })

  it('aborts between fetches when the signal flips mid-iteration', async () => {
    const { fetcher, callCount } = arrayFetcher([
      [1, 2],
      [3, 4],
      [5, 6],
    ])
    const controller = new AbortController()
    const pages: number[][] = []
    await expect(async () => {
      for await (const page of paginatePages(fetcher, controller.signal)) {
        pages.push([...page.items])
        // Flip the abort signal after the first page is delivered. The next
        // pre-fetch `throwIfAborted` check must trip and terminate the loop
        // before the second fetch runs.
        if (pages.length === 1) controller.abort()
      }
    }).rejects.toThrow()
    expect(pages).toEqual([[1, 2]])
    expect(callCount()).toBe(1)
  })

  it('propagates a fetcher rejection through `for await`', async () => {
    let calls = 0
    const fetcher: PageFetcher<number, number> = async () => {
      calls += 1
      if (calls === 2) throw new Error('boom on page 2')
      return { page: calls, nextCursor: calls }
    }
    const pages: number[] = []
    await expect(async () => {
      for await (const page of paginatePages(fetcher, undefined)) pages.push(page)
    }).rejects.toThrow(/boom on page 2/)
    expect(pages).toEqual([1])
  })

  it('handles a cursor type other than primitives (object cursor)', async () => {
    type Cursor = { fileName: string; fileId: string }
    const pagesData = [
      { items: ['a'], next: { fileName: 'b', fileId: 'fid_b' } as Cursor | undefined },
      { items: ['b'], next: { fileName: 'c', fileId: 'fid_c' } as Cursor | undefined },
      { items: ['c'], next: undefined as Cursor | undefined },
    ]
    let i = 0
    const fetcher: PageFetcher<string[], Cursor> = async (cursor) => {
      // Assert cursor propagation between fetches.
      if (i > 0) {
        expect(cursor).toEqual(pagesData[i - 1]?.next)
      } else {
        expect(cursor).toBeUndefined()
      }
      const current = pagesData[i]
      i += 1
      if (current === undefined) throw new Error('overran')
      return { page: current.items, nextCursor: current.next }
    }
    const collected: string[] = []
    for await (const page of paginatePages(fetcher, undefined)) collected.push(...page)
    expect(collected).toEqual(['a', 'b', 'c'])
  })
})

describe('paginateItems', () => {
  it('flattens items from multiple pages', async () => {
    const { fetcher } = arrayFetcher([[1, 2, 3], [4], [5, 6]])
    const items: number[] = []
    for await (const item of paginateItems(fetcher, (p) => p.items, undefined)) {
      items.push(item)
    }
    expect(items).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('skips empty pages cleanly (no items yielded but iteration continues)', async () => {
    const { fetcher } = arrayFetcher([[1, 2], [], [3]])
    const items: number[] = []
    for await (const item of paginateItems(fetcher, (p) => p.items, undefined)) {
      items.push(item)
    }
    expect(items).toEqual([1, 2, 3])
  })

  it('yields nothing when every page is empty', async () => {
    const { fetcher } = arrayFetcher<number>([[], [], []])
    const items: number[] = []
    for await (const item of paginateItems(fetcher, (p) => p.items, undefined)) {
      items.push(item)
    }
    expect(items).toEqual([])
  })

  it('aborts between pages mid-iteration', async () => {
    // Page 1: items [1, 2]. After consuming both, controller fires. The
    // next pre-fetch abort check must trip; page 2 must not be fetched.
    const { fetcher, callCount } = arrayFetcher([
      [1, 2],
      [3, 4],
    ])
    const controller = new AbortController()
    const items: number[] = []
    await expect(async () => {
      for await (const item of paginateItems(fetcher, (p) => p.items, controller.signal)) {
        items.push(item)
        if (item === 2) controller.abort()
      }
    }).rejects.toThrow()
    expect(items).toEqual([1, 2])
    expect(callCount()).toBe(1)
  })

  it('propagates a fetcher rejection', async () => {
    let calls = 0
    const fetcher: PageFetcher<{ items: number[] }, number> = async () => {
      calls += 1
      if (calls === 1) return { page: { items: [1, 2] }, nextCursor: 1 }
      throw new Error('boom')
    }
    const items: number[] = []
    await expect(async () => {
      for await (const item of paginateItems(fetcher, (p) => p.items, undefined)) {
        items.push(item)
      }
    }).rejects.toThrow(/boom/)
    expect(items).toEqual([1, 2])
  })

  it('supports a custom item extractor (different key per page shape)', async () => {
    type Page = { keys: { id: string }[]; nextKey: string | undefined }
    const pagesData: Page[] = [
      { keys: [{ id: 'k1' }, { id: 'k2' }], nextKey: 'k2' },
      { keys: [{ id: 'k3' }], nextKey: undefined },
    ]
    let i = 0
    const fetcher: PageFetcher<Page, string> = async () => {
      const p = pagesData[i++]
      if (p === undefined) throw new Error('overran')
      return { page: p, nextCursor: p.nextKey }
    }
    const ids: string[] = []
    for await (const k of paginateItems(fetcher, (p) => p.keys, undefined)) {
      ids.push(k.id)
    }
    expect(ids).toEqual(['k1', 'k2', 'k3'])
  })
})
