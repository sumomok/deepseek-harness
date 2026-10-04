/**
 * One task at a time: a start while one runs is refused, the slot frees
 * once the task settles either way, and a wait for the free slot ends then.
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { singleFlight } from '../src/single-flight.ts'

describe('singleFlight', () => {
  it('refuses a second task while the first runs, and takes one again after it resolves', async () => {
    const slot = singleFlight(() => undefined)
    let finish: () => void = () => undefined
    const first = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const second = vi.fn(async () => undefined)
    expect(slot.run(first)).toBe(true)
    expect(slot.running()).toBe(true)
    expect(slot.run(second)).toBe(false)
    await vi.waitFor(() => { expect(first).toHaveBeenCalledTimes(1) })
    finish()
    await vi.waitFor(() => { expect(slot.running()).toBe(false) })
    expect(second).not.toHaveBeenCalled()
    expect(slot.run(second)).toBe(true)
    await vi.waitFor(() => { expect(second).toHaveBeenCalledTimes(1) })
  })

  it('reports a rejected task and frees the slot', async () => {
    const onError = vi.fn()
    const slot = singleFlight(onError)
    expect(slot.run(() => Promise.reject(new Error('EBUSY')))).toBe(true)
    await vi.waitFor(() => { expect(slot.running()).toBe(false) })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'EBUSY' }))
  })

  it('ends a wait for the free slot at once when nothing runs, and otherwise once the task settled', async () => {
    const slot = singleFlight(() => undefined)
    await expect(slot.idle()).resolves.toBeUndefined()
    let fail: (error: Error) => void = () => undefined
    expect(slot.run(() => new Promise<void>((_resolve, reject) => { fail = reject }))).toBe(true)
    let idle = false
    const waited = slot.idle().then(() => { idle = true })
    await vi.waitFor(() => { expect(slot.running()).toBe(true) })
    await Promise.resolve()
    expect(idle).toBe(false)
    fail(new Error('EBUSY'))
    await waited
    expect(idle).toBe(true)
    expect(slot.running()).toBe(false)
  })
})
