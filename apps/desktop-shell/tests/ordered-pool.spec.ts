/**
 * How the bounded pool orders results and failures when calls finish out of
 * list order, and when it stops starting items.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { mapInOrder } from '../scripts/ordered-pool.ts'

/** A promise and the functions that settle it, so a test decides when each call finishes. */
interface Gate {
  promise: Promise<void>
  open: () => void
  fail: (error: Error) => void
}

function gate(): Gate {
  let open = (): void => {}
  let fail = (_error: Error): void => {}
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve
    fail = reject
  })
  return { promise, open, fail }
}

/** Lets every settled call's continuation run before the test settles the next one. */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('mapInOrder', () => {
  it('returns each result at its item\'s index when the calls finish in reverse', async () => {
    const items = [0, 1, 2, 3, 4, 5]
    const gates = items.map(() => gate())
    const finished: number[] = []
    const pending = mapInOrder(items, 3, async (item) => {
      await gates[item]?.promise
      finished.push(item)
      return `r${String(item)}`
    })
    for (const item of [...items].reverse()) {
      gates[item]?.open()
      await drain()
    }
    expect(await pending).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
    expect(finished).not.toEqual(items)
  })

  it('rejects with the lowest-index failure even when a later item failed first', async () => {
    const items = [0, 1, 2, 3]
    const gates = items.map(() => gate())
    const failed: number[] = []
    const pending = mapInOrder(items, 4, async (item) => {
      try {
        await gates[item]?.promise
      } catch (error) {
        failed.push(item)
        throw error
      }
      return item
    })
    const outcome = pending.then(() => 'resolved', (error: unknown) => error)
    gates[2]?.fail(new Error('item 2'))
    await drain()
    gates[1]?.open()
    gates[3]?.open()
    await drain()
    gates[0]?.fail(new Error('item 0'))
    expect(await outcome).toEqual(new Error('item 0'))
    expect(failed).toEqual([2, 0])
  })

  it('starts no item after a failure and settles only once the started calls have', async () => {
    const items = [0, 1, 2, 3, 4]
    const gates = items.map(() => gate())
    const started: number[] = []
    let settled = false
    const pending = mapInOrder(items, 2, async (item) => {
      started.push(item)
      if (item === 0) throw new Error('item 0')
      await gates[item]?.promise
      return item
    })
    const outcome = pending.then(() => 'resolved', (error: unknown) => error).finally(() => { settled = true })
    await drain()
    expect(started).toEqual([0, 1])
    expect(settled).toBe(false)
    gates[1]?.open()
    expect(await outcome).toEqual(new Error('item 0'))
    expect(started).toEqual([0, 1])
  })
})
