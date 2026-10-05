/**
 * The service-line shell frame, registered into the built-in 'root' slot (the
 * web shell renders only 'root'). Four resident grid tracks — session |
 * content | chat | details — solved in px from the frame's own measured width
 * (tracks.ts). The frame owns four render decisions: the session slot renders
 * here with the fold state and the solved px width it must lay itself out
 * against, the content slot carries this shell's own empty-state body as its
 * renderSlot fallback, the chat column renders the `main` entry the selected
 * panel names (the Conversation by default), and the right column's occupant
 * receives the fixed details width it draws its panel at. Every occupant
 * renders at a fixed tree position so a session switch never moves it.
 *
 * Below the {@link isNarrow} breakpoint the session column leaves the grid
 * (its track solves to 0) and the session list is reached through an off-canvas
 * drawer the frame draws into its own overlay layer: a top-left hamburger opens
 * it, a scrim and an Escape that no layer inside it handled close it, and the
 * same `sidebar` slot fills it at {@link SIDEBAR_DRAWER} width. The occupant is unchanged — it renders full
 * content against whatever width it is handed, in the grid column or the
 * drawer. The drawer is forced closed as the frame widens back past the
 * breakpoint (stores.ts `setNarrow`) so no stale overlay survives onto a wide
 * layout.
 *
 * The content column additionally collapses to zero width while the current
 * session's content surface has shown nothing — read defensively off the
 * standard `useSessions` list feed's `projectionValues` on the main view's row
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
import { DETAILS_WIDTH, isNarrow, SIDEBAR_DRAWER, solveTracks } from './tracks.ts'
import type { createPanelStore } from './stores.ts'
import css from './ShellFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share + locale seat. */
export type ShellFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'content' | 'main' | 'rightbar' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createPanelStore>>
  & PropsLocale<'serverLayout'>

/** The session-list fields the content-empty read looks at. */
interface ContentEmptyInput {
  byId: Record<string, { projectionValues?: object; retainedBy: Readonly<Record<string, number | undefined>> }>
}

/**
 * Read whether the main view's content surface has anything to show, off the
 * standard session-list feed rather than a content-surface import (see the
 * module doc). The main view is the row the Conversation retains
 * (`retainedBy.mainView`). Defensive narrowing throughout: the
 * `contentSurface` projection key is not typed in this package's own
 * compilation.
 * @param state - the `useSessions` snapshot.
 * @returns `false` once the main view's content surface carries at least one
 * entry; `true` otherwise, including no main-view session at all.
 */
function currentContentEmpty(state: ContentEmptyInput): boolean {
  const current = Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)
  if (current?.projectionValues === undefined) return true
  const contentSurface: unknown = Reflect.get(current.projectionValues, 'contentSurface')
  if (typeof contentSurface !== 'object' || contentSurface === null || !('entries' in contentSurface)) return true
  return !Array.isArray(contentSurface.entries) || contentSurface.entries.length === 0
}

/**
 * The chat column: the `main` entry the selected panel names, subscribed on
 * its own so a selection change re-renders only this subtree.
 */
function MainPanel({ usePanelInfo, renderSlot }: Pick<ShellFrameProps, 'usePanelInfo' | 'renderSlot'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Render the four-track shell (see module doc).
 * @param props - the composed slot props.
 * @returns the frame element.
 */
export function ShellFrame({ useStore, useSessions, usePanelInfo, renderSlot, t, actions }: ShellFrameProps) {
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

  // The drawer's own keyboard dismissal: Escape while it is open, unless a
  // layer inside it already took that Escape (a menu or a dialog calls
  // preventDefault before this window listener runs). Pointer dismissal is
  // the scrim's click; a navigation tap does not auto-close (the sidebar
  // reuses the current session for a page or view, so no switch reaches this
  // frame — see the package README).
  useEffect(() => {
    if (!panels.drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) actions.closeDrawer()
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

  const tracks = solveTracks(frame, panels.sessionFolded, panels.rightbarTrack, contentEmpty, narrow)
  const rightbarWidth = Math.min(DETAILS_WIDTH, frame)
  const showHamburger = narrow && !panels.drawerOpen
  const showDrawer = narrow && panels.drawerOpen
  const drawerWidth = Math.min(SIDEBAR_DRAWER, frame)

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${tracks.session}px ${tracks.content}px ${tracks.chat}px ${tracks.details}px` }}
      data-session-folded={panels.sessionFolded || undefined}
      data-details-open={panels.rightbarTrack || undefined}
      data-rightbar-fullscreen={panels.rightbarFullscreen || undefined}
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
        <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
      </div>
      {/* The right column's occupant draws its panel against this column's
          right edge at the fixed details width; the track only decides whether
          chat makes room for it. The occupant owns its Session binding and
          reports shown/track/fullscreen through ctx.layout. */}
      <div className={css.detailsCol} data-shell-column="details">
        {renderSlot('rightbar', { width: rightbarWidth, viewportWidth: frame, canShow: rightbarWidth > 0 })}
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
