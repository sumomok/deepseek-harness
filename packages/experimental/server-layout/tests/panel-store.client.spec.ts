// @vitest-environment jsdom
/**
 * createPanelStore unit account: the initial panel state, the complete write
 * set (the ILayout transitions, the main-panel retention sweep, the drawer's
 * open/close, and the narrow mirror), and per-instance independence. `toggleSidebar` is the one fold verb,
 * so it means the fold on a wide frame and the drawer on a narrow one. Uses the
 * test-sanctioned path — factory self-call plus `.create()` gives the real
 * engine instance over the same create path production uses.
 */
import { describe, expect, it } from 'vitest'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createPanelStore } from '../src/client/stores.ts'

const SCHEDULE = 'schedule' as MainPanelId

describe('createPanelStore', () => {
  it('starts on the Conversation with the session column expanded, the right column hidden, drawer closed, and wide', () => {
    const { store } = createPanelStore().create()
    expect(store.getSnapshot()).toEqual({
      panelInfo: { activePanelId: null },
      sessionFolded: false,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      drawerOpen: false,
      narrow: false,
    })
  })

  it('selectPanel records the selection and retainMainPanels drops one whose entry left', () => {
    const { store, actions } = createPanelStore().create()
    actions.selectPanel(SCHEDULE)
    actions.retainMainPanels(['conversation', 'schedule'])
    expect(store.getSnapshot().panelInfo.activePanelId).toBe(SCHEDULE)
    actions.retainMainPanels(['conversation'])
    expect(store.getSnapshot().panelInfo.activePanelId).toBeNull()
    actions.retainMainPanels([])
    expect(store.getSnapshot().panelInfo.activePanelId).toBeNull()
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

  it('openRightbar records the reported presentation and closeRightbar clears all of it', () => {
    const { store, actions } = createPanelStore().create()
    actions.openRightbar(true, false)
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false })
    actions.openRightbar(false, true)
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: true, rightbarTrack: false, rightbarFullscreen: true })
    actions.closeRightbar()
    expect(store.getSnapshot()).toMatchObject({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false })
  })

  it('keeps the panels independent', () => {
    const { store, actions } = createPanelStore().create()
    actions.openRightbar(true, false)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sessionFolded: true, rightbarTrack: true })
  })

  it('writes nothing to browser storage', () => {
    const { actions } = createPanelStore().create()
    actions.toggleSidebar()
    actions.openRightbar(true, false)
    actions.openDrawer()
    expect(localStorage.length).toBe(0)
  })
})
