import { expect, it } from 'vitest'
import { collectStream } from './collect.ts'

it('collects each response chunk before the producer reuses its buffer', async () => {
  const shared = new Uint8Array(2)
  let count = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (count === 2) {
          controller.close()
          return
        }
        shared.set(count++ === 0 ? [1, 2] : [3, 4])
        controller.enqueue(shared)
      },
    },
    { highWaterMark: 0 },
  )
  expect(Array.from(await collectStream(stream))).toEqual([1, 2, 3, 4])
})
