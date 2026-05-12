export class Semaphore {
  private current = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.limit) {
      this.current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.current--
    }
  }

  get available(): number {
    return this.limit - this.current
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const sem = new Semaphore(concurrency)
  const results: R[] = new Array(items.length)
  const tasks = items.map(async (item, i) => {
    await sem.acquire()
    try {
      results[i] = await fn(item, i)
    } finally {
      sem.release()
    }
  })
  await Promise.all(tasks)
  return results
}
