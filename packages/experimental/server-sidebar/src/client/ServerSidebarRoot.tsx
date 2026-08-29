/**
 * Sidebar shell: column geometry, ported from `dsh-client-ui-sidebar`'s own
 * `SidebarRoot` to honor the same behavioral contract this package's overlay
 * replaces (collapse is a slide plus crossfade, the 56px rail, the
 * pointer-driven scrollbar quieting — see that package's own module doc for
 * the full mechanics, unchanged here), plus this package's own addition: the
 * page-navigation and favorites menu, seated between the New Session button
 * and the `sidebar.workspaces` region.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls `dsh-client-ui-sidebar`'s five `sidebar.*` SlotMap
// declarations, reused here rather than redeclared so ui-workspace's and
// ui-settings's existing registrations keep working unchanged (this
// package's own module doc explains the replacement contract in full).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { MenuSection } from './MenuSection.tsx'
import type { MenuPage } from './pages.ts'
import type { ServerMenuFavorite } from './favorites-api.ts'
import type { createFavoritesStore } from './favorites-store.ts'
import css from './ServerSidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Registrant-private injected share: the shell's own controls plus this
 * package's menu data and actions.
 */
export interface ServerSidebarInjected {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
  /** The deployment's configured content-column pages, read once before this entry registered. */
  pages: readonly MenuPage[]
  /**
   * Open a configured page, creating a session first when none is current.
   * The menu does not await this — it returns a promise so tests can.
   */
  onOpenPage: (pageId: string) => Promise<void>
  /** Switch to a favorited session. */
  onOpenSession: (sessionId: string) => void
  /**
   * Persist the complete next favorites list. The menu does not await this —
   * it returns a promise so tests can.
   */
  onSaveFavorites: (next: ServerMenuFavorite[]) => Promise<void>
}

/** Full component props: layout owner state/actions, the declared holes, the favorites store, and this package's own share. */
export type ServerSidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.mark'
    | 'sidebar.brand.name'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & PropsStore<ReturnType<typeof createFavoritesStore>>
  & ServerSidebarInjected & PropsLocale<'serverSidebar'>

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + store share + injected callbacks).
 * @returns the sidebar element tree.
 */
export function ServerSidebarRoot({
  collapsed, width, startSession, toggleSidebar, t, renderSlot,
  pages, onOpenPage, onOpenSession, onSaveFavorites,
  useStore, useSessions,
}: ServerSidebarRootComponentProps) {
  /* jscpd:ignore-start -- geometry and JSX ported verbatim from
   * dsh-client-ui-sidebar's SidebarRoot to honor its behavioral contract
   * (this file's module doc explains why this is a copy, not an import).
   */
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const favorites = useStore(state => state.favorites)
  const favoritesError = useStore(state => state.error)

  // Session liveness for the favorites menu: read fresh on every relevant
  // change rather than captured once, so a favorite whose session is deleted
  // (or a new session created) is reflected without a save round trip.
  const currentId = useSessions(state => state.current)
  const byId = useSessions(state => state.byId)
  const current = currentId === undefined
    ? undefined
    : { id: currentId, title: byId[currentId]?.displayTitle ?? currentId }
  const liveSessionIds = useMemo(() => new Set(Object.keys(byId)), [byId])

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.logoRow}>
        {wide && (
          <button
            type="button"
            className={clsx(css.brand, css.wide)}
            aria-label={t('session.new.label')}
            onClick={() => { startSession() }}
          >
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
              </span>
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, {
                  fallback: (
                    <>
                      <span className={css.fallbackBrandName}>DSH Local Build</span>
                      {process.env.DSH_CLIENT_COMMIT_HASH
                        ? <span className={css.buildRevision}>{process.env.DSH_CLIENT_COMMIT_HASH}</span>
                        : null}
                    </>
                  ),
                })}
              </span>
            </span>
          </button>
        )}
        <Tooltip label={collapsed ? t('toggle.open') : t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.toggle)}
            aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            {!wide && (
              <span className={css.railMark} aria-hidden="true">
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
              </span>
            )}
            <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
          </button>
        </Tooltip>
      </div>

      <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.newSession}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutline16 size={wide ? 14 : 18} />
          {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
        </button>
      </Tooltip>

      <MenuSection
        wide={wide}
        pages={pages}
        favorites={favorites}
        favoritesError={favoritesError}
        current={current}
        liveSessionIds={liveSessionIds}
        onOpenPage={onOpenPage}
        onOpenSession={onOpenSession}
        onSaveFavorites={onSaveFavorites}
        t={t}
      />

      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {
          wide,
          expandSidebar: () => { if (collapsed) toggleSidebar() },
        })}
      </div>

      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', { wide })}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', { wide })}
        </div>
      </div>
    </div>
  )
  /* jscpd:ignore-end */
}
