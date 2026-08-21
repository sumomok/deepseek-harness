/**
 * This shell's implementation of the cross-plugin `ctx.layout` contract.
 *
 * The interface itself belongs to `dsh-client-ui-layout`, which declares the
 * `ctx.layout` Context merge that ui-sidebar and ui-conversation inject; a
 * shell replacing the shipped one therefore has to satisfy that same face
 * rather than mint a second service name. The panel transitions are exactly
 * the panel store's action set, so this module is only the seam between them:
 * the root registration's inject hook hands over the entry's bound actions,
 * and the face forwards to whichever set is current.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createPanelStore } from './stores.ts'

/** The panel store's bound action set (framework-baked, draft params peeled). */
export type BoundPanelActions = BoundActions<ReturnType<typeof createPanelStore>>

/** The `ctx.layout` face plus the assembly-side hook that arms it. */
export interface PanelFace {
  /** The value provided as `ctx.layout`. */
  readonly layout: ILayout
  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook, so the face is live from the entry's first
   * render; on entry re-register the fresh actions replace the stale set.
   * @param actions - bound actions of the entry's panel store instance.
   */
  attach: (actions: BoundPanelActions) => void
}

/**
 * Build the panel face and its assembly hook as one closure pair.
 * @returns the `ctx.layout` value and the hook the root registration arms it with.
 */
export function createPanelFace(): PanelFace {
  let panels: BoundPanelActions | undefined
  // Callers are UI gestures, which cannot fire before the root entry rendered
  // (the inject hook runs in its first render) — reaching this unwired is a
  // boot-order bug, not a race to tolerate.
  const armed = (): BoundPanelActions => {
    if (panels === undefined) throw new Error('server-layout: panel actions not wired (root entry not mounted)')
    return panels
  }
  return {
    layout: {
      toggleSidebar: () => { armed().toggleSidebar() },
      openDetails: () => { armed().openDetails() },
      closeDetails: () => { armed().closeDetails() },
    },
    attach: (actions) => { panels = actions },
  }
}
