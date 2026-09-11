/**
 * The service-line shell frame, registered into the built-in 'root' slot (the
 * web shell renders only 'root'). Four resident grid tracks — session |
 * content | chat | details — solved in px from the frame's own measured width
 * (tracks.ts). The frame owns three render decisions: the session slot renders
 * here with the fold state and the solved px width it must lay itself out
 * against, the content slot carries this shell's own empty-state body as its
 * renderSlot fallback, and the session-aware occupants render at fixed tree
 * positions so a session switch never moves them.
 *
 * Below the {@link isNarrow} breakpoint the session column leaves the grid
 * (its track solves to 0) and the session list is reached through an off-canvas
 * drawer the frame draws into its own overlay layer: a top-left hamburger opens
 * it, a scrim and the Escape key close it, and the same `sidebar` slot fills it
 * at {@link SIDEBAR_DRAWER} width. The occupant is unchanged — it renders full
 * content against whatever width it is handed, in the grid column or the
 * drawer. The drawer is forced closed as the frame widens back past the
 * breakpoint (stores.ts `setNarrow`) so no stale overlay survives onto a wide
 * layout.
 *
 * The content column additionally collapses to zero width while the current
 * session's content surface has shown nothing — read defensively off the
 * standard `useSessions` list feed's per-entry `projectionValues`
 * (`@deepseek-ai/dsh-experimental-content-surface`'s `contentSurface` key)
 * rather than importing that package: this shell has zero dependency on it,
 * and a deployment that never composes it simply always reads an empty
 * entry list, which is the same collapsed state (see the package README's
 * Known Limitations for the coupling this soft read carries).
 *
 * Pure component: everything arrives through the framework shares — zero
 * cordis imports, zero self-made hooks.
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { ContentPlaceholder } from './ContentPlaceholder.tsx'
import { isNarrow, SIDEBAR_DRAWER, solveTracks } from './tracks.ts'
import type { createPanelStore } from './stores.ts'
import css from './ShellFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share + locale seat. */
export type ShellFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'content' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createPanelStore>>
  & PropsLocale<'serverLayout'>

/**
 * Read whether the current session's content surface has anything to show,
 * off the standard session-list feed rather than a content-surface import
 * (see the module doc). Defensive `unknown` narrowing throughout: neither
 * `projectionValues` nor its `contentSurface` member is typed in this
 * package's own compilation.
 * @param state - the `useSessions` snapshot.
 * @returns `false` once the current session's content surface carries at
 * least one entry; `true` otherwise, including no current session at all.
 */
function currentContentEmpty(state: { byId: Record<string, { projectionValues?: unknown }>; current: string | undefined }): boolean {
  if (state.current === undefined) return true
  const projectionValues = state.byId[state.current]?.projectionValues as Record<string, unknown> | undefined
  const contentSurface = projectionValues?.contentSurface as { entries?: readonly unknown[] } | undefined
  return (contentSurface?.entries?.length ?? 0) === 0
}

/**
 * Render the four-track shell (see module doc).
 * @param props - the composed slot props.
 * @returns the frame element.
 */
export function ShellFrame({ useStore, useSessions, renderSlot, SessionProvider, t, actions }: ShellFrameProps) {
  const panels = useStore(s => s)
  const contentEmpty = useSessions(currentContentEmpty)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const hamburgerRef = useRef<HTMLButtonElement | null>(null)
  const drawerRef = useRef<HTMLDivElement | null>(null)
  const drawerWasOpen = useRef(false)
  // The window is the first-paint estimate; the observer below replaces it
  // with the frame's own box on the first delivered entry.
  const [frame, setFrame] = useState(() => window.innerWidth)

  useEffect(() => {
    const element = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width
      if (width !== undefined && width > 0) setFrame(width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const narrow = isNarrow(frame)
  // Mirror the breakpoint into the store so `toggleSidebar` picks the drawer
  // over the fold below it, and the drawer is dropped when the frame widens
  // back past it.
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])

  // The drawer's own keyboard dismissal: Escape while it is open. Pointer
  // dismissal is the scrim's click; a navigation tap does not auto-close (the
  // sidebar reuses the current session for a page or view, so no switch
  // reaches this frame — see the package README).
  useEffect(() => {
    if (!panels.drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') actions.closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions, panels.drawerOpen])

  // Move focus into the drawer when it opens and back to the hamburger when it
  // closes; the ref guard skips the first render so the page does not steal
  // focus onto the hamburger at load. On a widen-driven close the hamburger is
  // gone and the ref is null, which the optional call tolerates.
  useEffect(() => {
    if (panels.drawerOpen === drawerWasOpen.current) return
    drawerWasOpen.current = panels.drawerOpen
    const target = panels.drawerOpen ? drawerRef.current : hamburgerRef.current
    target?.focus()
  }, [panels.drawerOpen])

  const tracks = solveTracks(frame, panels.sessionFolded, panels.detailsOpen, contentEmpty, narrow)
  const showHamburger = narrow && !panels.drawerOpen
  const showDrawer = narrow && panels.drawerOpen
  const drawerWidth = Math.min(SIDEBAR_DRAWER, frame)

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${tracks.session}px ${tracks.content}px ${tracks.chat}px ${tracks.details}px` }}
      data-session-folded={panels.sessionFolded || undefined}
      data-details-open={panels.detailsOpen || undefined}
      data-content-empty={contentEmpty || undefined}
      data-narrow={narrow || undefined}
    >
      <div className={css.sessionCol} data-shell-column="session">
        {/* Below the breakpoint the column is a 0-width track and the session
            list moves to the drawer, so the slot renders there instead. Above
            it, the occupant lays itself out against the solved width, so it
            receives the rendered number rather than the ratio behind it. */}
        {narrow ? null : renderSlot('sidebar', { collapsed: panels.sessionFolded, width: tracks.session })}
      </div>
      <div className={css.contentCol} data-shell-column="content">
        {renderSlot('content', {}, {
          fallback: <ContentPlaceholder title={t('content.title')} hint={t('content.hint')} />,
        })}
      </div>
      <div className={css.chatCol} data-shell-column="chat">
        {renderSlot('conversation', {})}
      </div>
      {/* Zero width keeps the details subtree mounted across close/open.
          `details` is strict session scope, so the renderer requires the
          standard-kit SessionProvider seat around it: the provider withholds
          the entry while no session is current, rather than rendering it
          without a scope binding. */}
      <div className={css.detailsCol} data-shell-column="details">
        <SessionProvider>{renderSlot('details', {})}</SessionProvider>
      </div>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
        {showHamburger && (
          <button
            ref={hamburgerRef}
            type="button"
            className={css.hamburger}
            aria-label={t('sidebar.open')}
            aria-haspopup="dialog"
            data-shell-drawer-toggle
            onClick={() => { actions.openDrawer() }}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {showDrawer && (
          <>
            <div
              className={css.scrim}
              data-shell-drawer-scrim
              aria-hidden
              onClick={() => { actions.closeDrawer() }}
            />
            <div
              ref={drawerRef}
              className={css.drawer}
              style={{ width: drawerWidth }}
              role="dialog"
              aria-label={t('sidebar.navigation')}
              tabIndex={-1}
              data-shell-drawer
            >
              {renderSlot('sidebar', { collapsed: false, width: drawerWidth })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
