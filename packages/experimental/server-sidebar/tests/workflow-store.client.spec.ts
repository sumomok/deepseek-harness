/**
 * `createWorkflowStore`'s own actions, invoked through a real instance
 * rather than a mocked `BoundActions` stand-in (which is how
 * `browser-plugin.client.spec.ts` exercises the injected face, bypassing
 * this module's own draft mutators entirely), plus the hand-rolled
 * `localStorage` half: what a fresh browser starts from, what a stored
 * document restores, what an unusable one falls back to, and what a click
 * writes back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowStore, SIDEBAR_VIEW_STORAGE_KEY } from '../src/client/workflow-store.ts'
import { TEMPORARY_GROUP_ID } from '../src/menu-constants.ts'
import type { ServerMenuState } from '../src/client/workflow-api.ts'

const WORKFLOW = { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }
const GROUP = { id: 'g1', name: '每日', pinned: false, order: 0 }

/** The document a read answers before anything is saved. */
function emptyMenu(): ServerMenuState {
  return { workflows: [], groups: [], workbenchSessionId: undefined }
}

/** Install a `localStorage` stand-in over a plain map, and hand back its calls. */
function stubStorage(seed?: string): { written: string[]; setItem: ReturnType<typeof vi.fn> } {
  const written: string[] = []
  const setItem = vi.fn((_key: string, value: string) => { written.push(value) })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === SIDEBAR_VIEW_STORAGE_KEY && seed !== undefined ? seed : null),
    setItem,
  })
  return { written, setItem }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createWorkflowStore', () => {
  it('seeds state from the initial document, defensively copied', () => {
    const initial: ServerMenuState = {
      workflows: [WORKFLOW], groups: [GROUP], workbenchSessionId: 'home-1',
    }
    const instance = createWorkflowStore(initial).create()
    expect(instance.getSnapshot()).toEqual({
      workflows: initial.workflows,
      groups: initial.groups,
      workbenchSessionId: 'home-1',
      error: undefined,
      temporaryFailed: false,
      view: { collapsed: {}, temporaryExpanded: false },
    })
    initial.workflows.push({ ...WORKFLOW, id: 'w2' })
    initial.groups.push({ ...GROUP, id: 'g2' })
    expect(instance.getSnapshot().workflows).toHaveLength(1)
    expect(instance.getSnapshot().groups).toHaveLength(1)
  })

  it('seeds an absent workbenchSessionId as undefined', () => {
    const instance = createWorkflowStore(emptyMenu()).create()
    expect(instance.getSnapshot().workbenchSessionId).toBeUndefined()
  })

  it('setServerMenu replaces the whole document and clears a pending error', () => {
    const instance = createWorkflowStore(emptyMenu()).create()
    instance.actions.setError('save failed')
    expect(instance.getSnapshot().error).toBe('save failed')
    const next: ServerMenuState = { workflows: [WORKFLOW], groups: [GROUP], workbenchSessionId: 'home-1' }
    instance.actions.setServerMenu(next)
    expect(instance.getSnapshot()).toEqual({
      ...next, error: undefined, temporaryFailed: false, view: { collapsed: {}, temporaryExpanded: false },
    })
  })

  it('setError records the message without touching the document', () => {
    const seeded: ServerMenuState = { workflows: [WORKFLOW], groups: [], workbenchSessionId: 'home-1' }
    const instance = createWorkflowStore(seeded).create()
    instance.actions.setError('network down')
    expect(instance.getSnapshot()).toEqual({
      ...seeded, error: 'network down', temporaryFailed: false, view: { collapsed: {}, temporaryExpanded: false },
    })
  })

  it('setTemporaryFailed records a failed archive apart from a failed save, and takes it back', () => {
    const instance = createWorkflowStore(emptyMenu()).create()
    instance.actions.setTemporaryFailed(true)
    expect(instance.getSnapshot().temporaryFailed).toBe(true)
    expect(instance.getSnapshot().error).toBeUndefined()
    instance.actions.setTemporaryFailed(false)
    expect(instance.getSnapshot().temporaryFailed).toBe(false)
  })

  it('drops the fold entries of groups the authoritative document no longer has', () => {
    const { written } = stubStorage(JSON.stringify({
      collapsed: { g1: true, gone: true, [TEMPORARY_GROUP_ID]: true }, temporaryExpanded: false,
    }))
    const loaded = { workflows: [], groups: [GROUP, { ...GROUP, id: 'gone' }], workbenchSessionId: undefined }
    const instance = createWorkflowStore(loaded).create()
    instance.actions.setServerMenu({ workflows: [], groups: [GROUP], workbenchSessionId: undefined })
    const kept = { g1: true, [TEMPORARY_GROUP_ID]: true }
    expect(instance.getSnapshot().view.collapsed).toEqual(kept)
    expect(written.map(text => JSON.parse(text) as unknown))
      .toEqual([{ collapsed: kept, temporaryExpanded: false }])
  })

  it('drops them on the document it loads with too, not only on one a save answers', () => {
    const { written } = stubStorage(JSON.stringify({
      collapsed: { g1: true, gone: true }, temporaryExpanded: true,
    }))
    const instance = createWorkflowStore({ workflows: [], groups: [GROUP], workbenchSessionId: undefined }).create()
    expect(instance.getSnapshot().view).toEqual({ collapsed: { g1: true }, temporaryExpanded: true })
    expect(written.map(text => JSON.parse(text) as unknown))
      .toEqual([{ collapsed: { g1: true }, temporaryExpanded: true }])
  })

  it('writes nothing back when every fold entry still names a live group', () => {
    const { written } = stubStorage(JSON.stringify({ collapsed: { g1: true }, temporaryExpanded: false }))
    const loaded = { workflows: [], groups: [GROUP], workbenchSessionId: undefined }
    const instance = createWorkflowStore(loaded).create()
    instance.actions.setServerMenu({ workflows: [], groups: [GROUP], workbenchSessionId: undefined })
    expect(instance.getSnapshot().view.collapsed).toEqual({ g1: true })
    expect(written).toEqual([])
  })
})

describe('the remembered view', () => {
  it('starts collapsed-free with no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined)
    const instance = createWorkflowStore(emptyMenu()).create()
    expect(instance.getSnapshot().view).toEqual({ collapsed: {}, temporaryExpanded: false })
    // Nothing to write to, and nothing thrown for the click that tried.
    instance.actions.setTemporaryExpanded(true)
    expect(instance.getSnapshot().view.temporaryExpanded).toBe(true)
  })

  it('starts from the stored document', () => {
    stubStorage(JSON.stringify({ collapsed: { g1: true, g2: false }, temporaryExpanded: true }))
    const loaded = { workflows: [], groups: [GROUP, { ...GROUP, id: 'g2' }], workbenchSessionId: undefined }
    expect(createWorkflowStore(loaded).create().getSnapshot().view)
      .toEqual({ collapsed: { g1: true, g2: false }, temporaryExpanded: true })
  })

  it('drops the parts of a stored document it cannot use', () => {
    stubStorage(JSON.stringify({ collapsed: { g1: true, g2: 'yes' }, temporaryExpanded: 'yes' }))
    const loaded = { workflows: [], groups: [GROUP], workbenchSessionId: undefined }
    expect(createWorkflowStore(loaded).create().getSnapshot().view)
      .toEqual({ collapsed: { g1: true }, temporaryExpanded: false })
  })

  it('falls back to the default view for a stored value of the wrong kind', () => {
    for (const stored of ['"a string"', '[]', 'null', '{"collapsed":"nonsense"}']) {
      stubStorage(stored)
      expect(createWorkflowStore(emptyMenu()).create().getSnapshot().view)
        .toEqual({ collapsed: {}, temporaryExpanded: false })
    }
  })

  it('falls back to the default view, saying so, when the stored text is not JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubStorage('not json')
    expect(createWorkflowStore(emptyMenu()).create().getSnapshot().view)
      .toEqual({ collapsed: {}, temporaryExpanded: false })
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not read the remembered sidebar view:', expect.anything())
    warn.mockRestore()
  })

  it('remembers each collapsed group as plain JSON, keeping the rest of the view', () => {
    const { written } = stubStorage()
    const instance = createWorkflowStore(emptyMenu()).create()
    instance.actions.setTemporaryExpanded(true)
    instance.actions.setGroupCollapsed('g1', true)
    instance.actions.setGroupCollapsed('g2', false)
    expect(instance.getSnapshot().view).toEqual({ collapsed: { g1: true, g2: false }, temporaryExpanded: true })
    expect(written.map(text => JSON.parse(text) as unknown)).toEqual([
      { collapsed: {}, temporaryExpanded: true },
      { collapsed: { g1: true }, temporaryExpanded: true },
      { collapsed: { g1: true, g2: false }, temporaryExpanded: true },
    ])
  })

  it('falls back to everything expanded when reading the store itself is refused', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A browser configured to block site data throws on the global's own
    // getter, before any method on it is called — `typeof localStorage` is
    // itself the statement that fails.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: Access is denied for this document.') },
    })
    try {
      const instance = createWorkflowStore(emptyMenu()).create()
      expect(instance.getSnapshot().view).toEqual({ collapsed: {}, temporaryExpanded: false })
      // And the click that would have been remembered still lands.
      instance.actions.setGroupCollapsed('g1', true)
      expect(instance.getSnapshot().view.collapsed).toEqual({ g1: true })
    } finally {
      if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage
      else Object.defineProperty(globalThis, 'localStorage', original)
    }
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not read the remembered sidebar view:', expect.anything())
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not remember the sidebar view:', expect.anything())
    warn.mockRestore()
  })

  it('keeps the click when the store refuses the write', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded') },
    })
    const instance = createWorkflowStore(emptyMenu()).create()
    instance.actions.setGroupCollapsed('g1', true)
    expect(instance.getSnapshot().view.collapsed).toEqual({ g1: true })
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not remember the sidebar view:', expect.anything())
    warn.mockRestore()
  })
})
