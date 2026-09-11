// @vitest-environment jsdom
/**
 * createPanelStore unit account: the initial panel state, the complete write
 * set (the three ILayout transitions, the drawer's open/close, and the narrow
 * mirror), and per-instance independence. `toggleSidebar` is the one fold verb,
 * so it means the fold on a wide frame and the drawer on a narrow one. Uses the
 * test-sanctioned path — factory self-call plus `.create()` gives the real
 * engine instance over the same create path production uses.
 */
import { describe, expect, it } from 'vitest'
import { createPanelStore } from '../src/client/stores.ts'

describe('createPanelStore', () => {
  it('starts with the session column expanded, details closed, drawer closed, and wide', () => {
    const { store } = createPanelStore().create()
    expect(store.getSnapshot()).toEqual({ sessionFolded: false, detailsOpen: false, drawerOpen: false, narrow: false })
  })

  it('gives each create() an independent instance (the factory is not a singleton)', () => {
    const first = createPanelStore().create()
    const second = createPanelStore().create()
    first.actions.toggleSidebar()
    expect(second.store.getSnapshot().sessionFolded).toBe(false)
  })

  it('toggleSidebar folds and unfolds the session column on a wide frame', () => {
    const { store, actions } = createPanelStore().create()
    actions.toggleSidebar()
    expect(store.getSnapshot().sessionFolded).toBe(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().sessionFolded).toBe(false)
  })

  it('toggleSidebar toggles the drawer, not the fold, once narrow', () => {
    const { store, actions } = createPanelStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ drawerOpen: true, sessionFolded: false })
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ drawerOpen: false, sessionFolded: false })
  })

  it('openDrawer opens and closeDrawer closes the off-canvas drawer', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDrawer()
    expect(store.getSnapshot().drawerOpen).toBe(true)
    actions.closeDrawer()
    expect(store.getSnapshot().drawerOpen).toBe(false)
  })

  it('setNarrow mirrors the breakpoint and is a no-op when unchanged', () => {
    const { store, actions } = createPanelStore().create()
    actions.setNarrow(true)
    expect(store.getSnapshot().narrow).toBe(true)
    // Re-entering the same reading changes nothing (the equal-value guard).
    actions.openDrawer()
    actions.setNarrow(true)
    expect(store.getSnapshot()).toMatchObject({ narrow: true, drawerOpen: true })
  })

  it('setNarrow forces the drawer closed when the frame widens back past the breakpoint', () => {
    const { store, actions } = createPanelStore().create()
    actions.setNarrow(true)
    actions.openDrawer()
    expect(store.getSnapshot().drawerOpen).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, drawerOpen: false })
  })

  it('entering narrow leaves an open drawer untouched', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDrawer()
    actions.setNarrow(true)
    expect(store.getSnapshot()).toMatchObject({ narrow: true, drawerOpen: true })
  })

  it('openDetails is idempotent and closeDetails reverses it', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDetails()
    actions.openDetails()
    expect(store.getSnapshot().detailsOpen).toBe(true)
    actions.closeDetails()
    expect(store.getSnapshot().detailsOpen).toBe(false)
    actions.closeDetails()
    expect(store.getSnapshot().detailsOpen).toBe(false)
  })

  it('keeps the panels independent', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDetails()
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sessionFolded: true, detailsOpen: true })
  })

  it('writes nothing to browser storage', () => {
    const { actions } = createPanelStore().create()
    actions.toggleSidebar()
    actions.openDetails()
    actions.openDrawer()
    expect(localStorage.length).toBe(0)
  })
})
