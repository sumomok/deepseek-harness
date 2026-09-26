/**
 * This shell's implementation of the cross-plugin `ctx.layout` contract.
 *
 * The interface itself belongs to `dsh-client-ui-layout`, which declares the
 * `ctx.layout` Context merge that ui-conversation, ui-workspace, and
 * ui-sidebar-right inject; a shell replacing the shipped one therefore has to
 * satisfy that same face rather than mint a second service name. Every panel
 * transition is one action of the root entry's panel store, bound once when
 * the root registration creates its single store instance, so the face is live
 * before the first render.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createPanelStore } from './stores.ts'

/** The panel store's bound action set (framework-baked, draft params peeled). */
export type BoundPanelActions = BoundActions<ReturnType<typeof createPanelStore>>

/** The `ctx.layout` value plus the teardown the providing effect runs. */
export class PanelFace implements ILayout {
  private navigation = new AbortController()

  /**
   * @param panels - actions of the store instance shared with the root entry.
   * @param hasMainPanel - checks the live `main` slot registry for a panel id.
   * @param panelInfo - the root store's selected-panel source.
   */
  constructor(
    private readonly panels: BoundPanelActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
  ) {}

  /**
   * Select a registered main panel, or the Conversation.
   * @param panelId - registered `main` key, or null to show the Conversation.
   * @throws if the key is not registered; the current selection is kept.
   */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`server-layout: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns a signal the next navigation or this face's disposal aborts. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Fold the session column on a wide frame, or toggle the drawer on a narrow one. */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
  }

  /** Record the right column's occupant as shown, with its track and fullscreen presentation. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen)
  }

  /** Record the right column's occupant as hidden. */
  closeRightbar(): void {
    this.panels.closeRightbar()
  }

  /** Abort a pending navigation when the providing effect is torn down. */
  dispose(): void {
    this.navigation.abort()
  }
}
