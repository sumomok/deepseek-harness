/**
 * The root entry's transient panel store: the selected main panel and the
 * booleans this shell's geometry depends on. Column widths are not stored —
 * they are solved from the measured frame (tracks.ts), so the store carries
 * only what a user gesture or an occupant report can change, plus the
 * breakpoint the frame mirrors in so `toggleSidebar` can pick its meaning.
 * Module level exports the factory only; a module-level handle would pin the
 * store's identity in the module cache and survive plugin reloads as a
 * de-facto singleton.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/**
 * Panel state: the selected main panel, the session column's fold, the right
 * column's reported presentation, the off-canvas drawer's open flag, and the
 * frame's narrow reading.
 */
export type PanelState = {
  /** Selected central panel, as `ILayout.panelInfo` publishes it; null displays the Conversation. */
  panelInfo: { activePanelId: MainPanelId | null }
  /** True while the session column renders its control rail (wide frames only). */
  sessionFolded: boolean
  /**
   * Whether the right column's occupant draws its panel at all. Reported by
   * that occupant through `ctx.layout`; nothing else writes it.
   */
  rightbarShown: boolean
  /** Whether the shown panel reserves the fixed details track; always false while hidden. */
  rightbarTrack: boolean
  /** Whether the shown panel covers the frame; the track reservation stays underneath. */
  rightbarFullscreen: boolean
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
  selectPanel: (draft: PanelState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: PanelState, panelIds: readonly string[]) => void
  toggleSidebar: (draft: PanelState) => void
  openRightbar: (draft: PanelState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: PanelState) => void
  openDrawer: (draft: PanelState) => void
  closeDrawer: (draft: PanelState) => void
  setNarrow: (draft: PanelState, narrow: boolean) => void
}

/**
 * Create the panel store handle. The write set is the `ILayout` transitions
 * (main-panel selection, the sidebar fold, the right column's presentation
 * report), the retention sweep that drops a selection whose `main` entry
 * unregistered, the drawer's own open/close, and the frame's narrow mirror:
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
    init: (): PanelState => ({
      panelInfo: { activePanelId: null },
      sessionFolded: false,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      drawerOpen: false,
      narrow: false,
    }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      toggleSidebar: (d) => {
        if (d.narrow) d.drawerOpen = !d.drawerOpen
        else d.sessionFolded = !d.sessionFolded
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        d.rightbarShown = true
        d.rightbarTrack = track
        d.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d) => {
        d.rightbarShown = false
        d.rightbarTrack = false
        d.rightbarFullscreen = false
      },
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
