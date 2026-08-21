/**
 * The root entry's transient panel store: the two booleans this shell's
 * geometry depends on. Column widths are not stored — they are solved from the
 * measured frame (tracks.ts), so the store carries only what a user gesture
 * can change. Module level exports the factory only; a module-level handle
 * would pin the store's identity in the module cache and survive plugin
 * reloads as a de-facto singleton.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Panel state: the session column's fold and the details band's open flag. */
export type PanelState = {
  /** True while the session column renders its control rail. */
  sessionFolded: boolean
  /** True while the details band occupies its fixed width. */
  detailsOpen: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type PanelStoreActions = {
  toggleSidebar: (draft: PanelState) => void
  openDetails: (draft: PanelState) => void
  closeDetails: (draft: PanelState) => void
}

/**
 * Create the panel store handle. The three actions are the complete write set,
 * and they are deliberately the three `ILayout` transitions: this shell offers
 * no drag, so no other gesture can move a panel.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createPanelStore(): EngineStoreHandle<PanelState, PanelStoreActions> {
  return defineStore({
    init: (): PanelState => ({ sessionFolded: false, detailsOpen: false }),
    actions: {
      toggleSidebar: (d) => { d.sessionFolded = !d.sessionFolded },
      openDetails: (d) => { d.detailsOpen = true },
      closeDetails: (d) => { d.detailsOpen = false },
    },
  })
}
