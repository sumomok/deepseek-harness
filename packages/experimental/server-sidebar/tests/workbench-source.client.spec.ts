/**
 * `createWorkbenchSource`: the header's copy of the workbench id holds the
 * value it starts from until a publish changes it, and tells subscribers only
 * about a change.
 */
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchSource } from '../src/client/workbench-source.ts'

describe('createWorkbenchSource', () => {
  it('holds the id it starts from', () => {
    expect(createWorkbenchSource('wb-1').getSnapshot()).toBe('wb-1')
    expect(createWorkbenchSource(undefined).getSnapshot()).toBeUndefined()
  })

  it('notifies each subscriber once per changed id, and not for the same id again', () => {
    const source = createWorkbenchSource(undefined)
    const first = vi.fn()
    const second = vi.fn()
    source.subscribe(first)
    source.subscribe(second)
    source.publish('wb-1')
    expect(source.getSnapshot()).toBe('wb-1')
    source.publish('wb-1')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('stops notifying a subscriber that unsubscribed', () => {
    const source = createWorkbenchSource('wb-1')
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    unsubscribe()
    source.publish('wb-2')
    expect(listener).not.toHaveBeenCalled()
    expect(source.getSnapshot()).toBe('wb-2')
  })
})
