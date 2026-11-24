import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

const SESSION = 'blocked-session' as SessionId

describe('ComposerBlockRegistry', () => {
  it('republishes only when the copy changes', () => {
    const registry = new ComposerBlockRegistry()
    const listener = vi.fn()
    const store = registry.storeFor(SESSION)
    store.subscribe(listener)

    registry.set(SESSION, { reason: 'select a model first' })
    expect(store.getSnapshot()).toEqual({ reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    // Identical copy: no publication at all.
    registry.set(SESSION, { reason: 'select a model first' })
    expect(listener).toHaveBeenCalledTimes(1)

    registry.set(SESSION, undefined)
    expect(store.getSnapshot()).toBeUndefined()

    registry.forget(SESSION)
    expect(registry.storeFor(SESSION).getSnapshot()).toBeUndefined()
  })

  it('skips creating a store when clearing an absent session and clears all stores on clear()', () => {
    const registry = new ComposerBlockRegistry()
    const absent = 'absent-session' as SessionId
    registry.set(absent, undefined)
    const stores = Reflect.get(registry, 'stores') as Map<SessionId, unknown>
    expect(stores.has(absent)).toBe(false)

    const store = registry.storeFor(SESSION)
    registry.set(SESSION, { reason: 'blocked' })
    expect(stores.size).toBe(1)
    registry.clear()
    expect(stores.size).toBe(0)
    expect(registry.storeFor(SESSION)).not.toBe(store)
  })
})
