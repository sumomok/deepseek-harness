/**
 * The root entry's transient panel store: the booleans this shell's geometry
 * depends on. Column widths are not stored — they are solved from the measured
 * frame (tracks.ts), so the store carries only what a user gesture can change
 * plus the breakpoint the frame mirrors in so `toggleSidebar` can pick its
 * meaning. Module level exports the factory only; a module-level handle would
 * pin the store's identity in the module cache and survive plugin reloads as a
 * de-facto singleton.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/**
 * Panel state: the session column's fold, the details band's open flag, the
 * off-canvas drawer's open flag, and the frame's narrow reading.
 */
export type PanelState = {
  /** True while the session column renders its control rail (wide frames only). */
  sessionFolded: boolean
  /** True while the details band occupies its fixed width. */
  detailsOpen: boolean
  /** True while the off-canvas session drawer is open over the content (narrow frames only). */
  drawerOpen: boolean
  /**
   * True while the frame is below the fold breakpoint (ShellFrame feeds it
   * through `setNarrow`). It picks `toggleSidebar`'s meaning and forces the
   * drawer closed on the way back to a wide frame; the drawer only exists
   * while this is true.
   */
  narrow: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type PanelStoreActions = {
  toggleSidebar: (draft: PanelState) => void
  openDetails: (draft: PanelState) => void
  closeDetails: (draft: PanelState) => void
  openDrawer: (draft: PanelState) => void
  closeDrawer: (draft: PanelState) => void
  setNarrow: (draft: PanelState, narrow: boolean) => void
}

/**
 * Create the panel store handle. The write set is the three `ILayout`
 * transitions plus the drawer's own open/close and the frame's narrow mirror:
 * this shell offers no drag, so no other gesture can move a panel.
 *
 * `toggleSidebar` is the one fold verb external callers reach through
 * `ctx.layout`, so it means the fold on a wide frame and the drawer on a narrow
 * one, where the session column is out of the grid and the rail has no place to
 * show. `openDrawer`/`closeDrawer` are the frame's own hamburger, scrim, and
 * Escape gestures. `setNarrow` mirrors the breakpoint and forces the drawer
 * closed when the frame widens back past it, so a stale overlay never survives
 * onto a wide layout.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createPanelStore(): EngineStoreHandle<PanelState, PanelStoreActions> {
  return defineStore({
    init: (): PanelState => ({ sessionFolded: false, detailsOpen: false, drawerOpen: false, narrow: false }),
    actions: {
      toggleSidebar: (d) => {
        if (d.narrow) d.drawerOpen = !d.drawerOpen
        else d.sessionFolded = !d.sessionFolded
      },
      openDetails: (d) => { d.detailsOpen = true },
      closeDetails: (d) => { d.detailsOpen = false },
      openDrawer: (d) => { d.drawerOpen = true },
      closeDrawer: (d) => { d.drawerOpen = false },
      // Crossing back to a wide frame drops the drawer: it has no place in the
      // grid layout, and a re-widen must not leave it hanging over the columns.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        if (!narrow) d.drawerOpen = false
      },
    },
  })
}
