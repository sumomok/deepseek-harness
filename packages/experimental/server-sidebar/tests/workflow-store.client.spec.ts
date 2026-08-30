/**
 * `createWorkflowStore`'s own actions, invoked through a real instance
 * rather than a mocked `BoundActions` stand-in (which is how
 * `browser-plugin.client.spec.ts` exercises the injected face, bypassing
 * this module's own draft mutators entirely).
 */
import { describe, expect, it } from 'vitest'
import { createWorkflowStore } from '../src/client/workflow-store.ts'

describe('createWorkflowStore', () => {
  it('seeds state from the initial document, defensively copied', () => {
    const initial = { workflows: [{ id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }], workbenchSessionId: 'home-1' }
    const instance = createWorkflowStore(initial).create()
    expect(instance.getSnapshot()).toEqual({ workflows: initial.workflows, workbenchSessionId: 'home-1', error: undefined })
    initial.workflows.push({ id: 'w2', name: 'B', order: 1, homeSessionId: 's2', navSnapshot: [], savedAt: 2 })
    expect(instance.getSnapshot().workflows).toHaveLength(1)
  })

  it('seeds an absent workbenchSessionId as undefined', () => {
    const instance = createWorkflowStore({ workflows: [], workbenchSessionId: undefined }).create()
    expect(instance.getSnapshot().workbenchSessionId).toBeUndefined()
  })

  it('setServerMenu replaces the whole document and clears a pending error', () => {
    const instance = createWorkflowStore({ workflows: [], workbenchSessionId: undefined }).create()
    instance.actions.setError('save failed')
    expect(instance.getSnapshot().error).toBe('save failed')
    const next = { workflows: [{ id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }], workbenchSessionId: 'home-1' }
    instance.actions.setServerMenu(next)
    expect(instance.getSnapshot()).toEqual({ ...next, error: undefined })
  })

  it('setError records the message without touching the document', () => {
    const seeded = { workflows: [{ id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }], workbenchSessionId: 'home-1' }
    const instance = createWorkflowStore(seeded).create()
    instance.actions.setError('network down')
    expect(instance.getSnapshot()).toEqual({ ...seeded, error: 'network down' })
  })
})
