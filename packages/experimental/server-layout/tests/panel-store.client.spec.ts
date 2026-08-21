// @vitest-environment jsdom
/**
 * createPanelStore unit account: the initial panel state, the complete write
 * set, and per-instance independence. Uses the test-sanctioned path — factory
 * self-call plus `.create()` gives the real engine instance over the same
 * create path production uses.
 */
import { describe, expect, it } from 'vitest'
import { createPanelStore } from '../src/client/stores.ts'

describe('createPanelStore', () => {
  it('starts with the session column expanded and details closed', () => {
    const { store } = createPanelStore().create()
    expect(store.getSnapshot()).toEqual({ sessionFolded: false, detailsOpen: false })
  })

  it('gives each create() an independent instance (the factory is not a singleton)', () => {
    const first = createPanelStore().create()
    const second = createPanelStore().create()
    first.actions.toggleSidebar()
    expect(second.store.getSnapshot().sessionFolded).toBe(false)
  })

  it('toggleSidebar folds and unfolds the session column', () => {
    const { store, actions } = createPanelStore().create()
    actions.toggleSidebar()
    expect(store.getSnapshot().sessionFolded).toBe(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().sessionFolded).toBe(false)
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

  it('keeps the two panels independent', () => {
    const { store, actions } = createPanelStore().create()
    actions.openDetails()
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({ sessionFolded: true, detailsOpen: true })
  })

  it('writes nothing to browser storage', () => {
    const { actions } = createPanelStore().create()
    actions.toggleSidebar()
    actions.openDetails()
    expect(localStorage.length).toBe(0)
  })
})
