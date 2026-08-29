/**
 * `createFavoritesStore`'s own actions, invoked through a real instance
 * rather than a mocked `BoundActions` stand-in (which is how
 * `browser-plugin.client.spec.ts` exercises the injected face, bypassing
 * this module's own draft mutators entirely).
 */
import { describe, expect, it } from 'vitest'
import { createFavoritesStore } from '../src/client/favorites-store.ts'

describe('createFavoritesStore', () => {
  it('seeds state from the initial list, defensively copied', () => {
    const initial = [{ sessionId: 's1', label: 'A', order: 0 }]
    const instance = createFavoritesStore(initial).create()
    expect(instance.getSnapshot()).toEqual({ favorites: initial, error: undefined })
    initial.push({ sessionId: 's2', label: 'B', order: 1 })
    expect(instance.getSnapshot().favorites).toHaveLength(1)
  })

  it('setFavorites replaces the list and clears a pending error', () => {
    const instance = createFavoritesStore([]).create()
    instance.actions.setError('save failed')
    expect(instance.getSnapshot().error).toBe('save failed')
    instance.actions.setFavorites([{ sessionId: 's1', label: 'A', order: 0 }])
    expect(instance.getSnapshot()).toEqual({ favorites: [{ sessionId: 's1', label: 'A', order: 0 }], error: undefined })
  })

  it('setError records the message without touching the list', () => {
    const seeded = [{ sessionId: 's1', label: 'A', order: 0 }]
    const instance = createFavoritesStore(seeded).create()
    instance.actions.setError('network down')
    expect(instance.getSnapshot()).toEqual({ favorites: seeded, error: 'network down' })
  })
})
