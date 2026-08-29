/**
 * The two menu groups this shell adds over the shipped sidebar's contract:
 * page navigation (`dsh-experimental-content-frame`'s configured pages) and
 * favorite sessions. Wide, it renders inline between the New Session button
 * and the workspace browser; collapsed, both groups move into one rail icon
 * plus a floating panel — the same rail form
 * `@deepseek-ai/dsh-cordis-client-runner`'s `CordisPanel` uses for the
 * sidebar footer.
 *
 * Pure presentation: every list comes from props, and the one local state
 * this component owns is which row (if any) is mid-edit — never persisted,
 * never read back from a store.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconBrowseOutline16, IconEditOutline16, IconPlusOutline16, IconTrashOutline16, Tooltip, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuPage } from './pages.ts'
import type { ServerMenuFavorite } from './favorites-api.ts'
import type { ServerSidebarKey } from './locales.ts'
import css from './MenuSection.module.css'

/** One session row the menu can check favorites against for staleness. */
export interface CurrentSession {
  readonly id: string
  readonly title: string
}

/** Full props of the menu region. */
export interface MenuSectionProps {
  /** Shell fold-state output: wide renders the full menu, rail one icon plus a floating panel. */
  wide: boolean
  /** The deployment's configured content-column pages, in declaration order. */
  pages: readonly MenuPage[]
  /** The current favorites list, authoritative from the last successful read or write. */
  favorites: readonly ServerMenuFavorite[]
  /** The last save's failure message, when one is pending. */
  favoritesError: string | undefined
  /** The current session, when one is selected — the add-favorite action's target and default label. */
  current: CurrentSession | undefined
  /** Every session id the workspace domain currently lists, for stale-favorite detection. */
  liveSessionIds: ReadonlySet<string>
  /** Open a configured page, creating a session first when none is current. Not awaited by this component. */
  onOpenPage: (pageId: string) => Promise<void>
  /** Switch to a favorited session. */
  onOpenSession: (sessionId: string) => void
  /** Persist the complete next favorites list. Not awaited by this component. */
  onSaveFavorites: (next: ServerMenuFavorite[]) => Promise<void>
  /** Locale seat. */
  t: (key: ServerSidebarKey, vars?: Record<string, string>) => string
}

/** Which row (if any) is mid-edit; never persisted. */
type EditState =
  | { readonly mode: 'idle' }
  | { readonly mode: 'adding'; readonly draft: string }
  | { readonly mode: 'renaming'; readonly sessionId: string; readonly draft: string }

/** Next display order for an appended favorite: one past the current highest. */
function nextOrder(favorites: readonly ServerMenuFavorite[]): number {
  return favorites.reduce((max, favorite) => Math.max(max, favorite.order), -1) + 1
}

/** Favorites sorted for display: declared order, ties broken on session id for a stable render. */
function sortedFavorites(favorites: readonly ServerMenuFavorite[]): ServerMenuFavorite[] {
  return [...favorites].sort((left, right) => left.order - right.order || (left.sessionId < right.sessionId ? -1 : 1))
}

/** The menu content shared by the wide and rail (panel) forms. */
function MenuBody({
  pages, favorites, favoritesError, current, liveSessionIds, edit, setEdit, onOpenPage, onOpenSession, onSaveFavorites, t,
}: MenuSectionProps & { edit: EditState; setEdit: (next: EditState) => void }) {
  const alreadyFavorited = current !== undefined && favorites.some(favorite => favorite.sessionId === current.id)

  const commitAdd = (draft: string): void => {
    setEdit({ mode: 'idle' })
    const label = draft.trim()
    if (label.length === 0 || current === undefined) return
    void onSaveFavorites([...favorites, { sessionId: current.id, label, order: nextOrder(favorites) }])
  }
  const commitRename = (sessionId: string, draft: string): void => {
    setEdit({ mode: 'idle' })
    const label = draft.trim()
    if (label.length === 0) return
    void onSaveFavorites(favorites.map(favorite => (favorite.sessionId === sessionId ? { ...favorite, label } : favorite)))
  }
  const remove = (sessionId: string): void => {
    void onSaveFavorites(favorites.filter(favorite => favorite.sessionId !== sessionId))
  }

  return (
    <div className={css.body}>
      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('menu.pages.title')}</h3>
        {pages.length === 0
          ? <p className={css.empty}>{t('menu.pages.empty')}</p>
          : (
            <ul className={css.list}>
              {pages.map(page => (
                <li key={page.id}>
                  <button type="button" className={css.itemButton} onClick={() => { void onOpenPage(page.id) }}>
                    {page.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
      </section>
      <section className={css.group}>
        <div className={css.groupHead}>
          <h3 className={css.groupTitle}>{t('menu.favorites.title')}</h3>
          <Tooltip label={t('menu.favorites.add')} side="bottom" delayMs={500}>
            <button
              type="button"
              className={css.addButton}
              aria-label={t('menu.favorites.add')}
              disabled={current === undefined || alreadyFavorited || edit.mode === 'adding'}
              // The `disabled` expression above already covers `current === undefined`, so a real
              // click never reaches this handler without one — a browser (and jsdom) never
              // dispatches click on a disabled button.
              /* v8 ignore next -- defensive: disabled already excludes the no-current-session case. */
              onClick={() => { if (current !== undefined) setEdit({ mode: 'adding', draft: current.title }) }}
            >
              <IconPlusOutline16 size={14} />
            </button>
          </Tooltip>
        </div>
        {favoritesError !== undefined && (
          <p className={css.error} role="alert">{t('menu.favorites.error', { message: favoritesError })}</p>
        )}
        {edit.mode === 'adding' && (
          <input
            className={css.renameInput}
            autoFocus
            aria-label={t('menu.favorites.namePlaceholder')}
            placeholder={t('menu.favorites.namePlaceholder')}
            defaultValue={edit.draft}
            onBlur={(event) => { commitAdd(event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              else if (event.key === 'Escape') setEdit({ mode: 'idle' })
            }}
          />
        )}
        {favorites.length === 0 && edit.mode !== 'adding'
          ? <p className={css.empty}>{t('menu.favorites.empty')}</p>
          : (
            <ul className={css.list}>
              {sortedFavorites(favorites).map((favorite) => {
                const stale = !liveSessionIds.has(favorite.sessionId)
                const renaming = edit.mode === 'renaming' && edit.sessionId === favorite.sessionId
                return (
                  <li key={favorite.sessionId} className={clsx(css.favoriteRow, stale && css.stale)}>
                    {renaming ? (
                      <input
                        className={css.renameInput}
                        autoFocus
                        aria-label={t('menu.favorites.namePlaceholder')}
                        placeholder={t('menu.favorites.namePlaceholder')}
                        defaultValue={favorite.label}
                        onBlur={(event) => { commitRename(favorite.sessionId, event.currentTarget.value) }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          else if (event.key === 'Escape') setEdit({ mode: 'idle' })
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className={css.itemButton}
                        disabled={stale}
                        onClick={() => { onOpenSession(favorite.sessionId) }}
                      >
                        {favorite.label}
                        {stale && <span className={css.staleLabel}>{t('menu.favorites.stale')}</span>}
                      </button>
                    )}
                    <div className={css.favoriteActions}>
                      {!stale && (
                        <Tooltip label={t('menu.favorites.rename')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className={css.iconButton}
                            aria-label={t('menu.favorites.rename')}
                            onClick={() => { setEdit({ mode: 'renaming', sessionId: favorite.sessionId, draft: favorite.label }) }}
                          >
                            <IconEditOutline16 size={12} />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip label={t('menu.favorites.remove')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={css.iconButton}
                          aria-label={t('menu.favorites.remove')}
                          onClick={() => { remove(favorite.sessionId) }}
                        >
                          <IconTrashOutline16 size={12} />
                        </button>
                      </Tooltip>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
      </section>
    </div>
  )
}

/**
 * Render the menu region: inline while the sidebar is wide, or one rail
 * trigger plus a dismissible floating panel while it is collapsed.
 * @param props - see {@link MenuSectionProps}.
 * @returns the menu element tree.
 */
export function MenuSection(props: MenuSectionProps) {
  const [edit, setEdit] = useState<EditState>({ mode: 'idle' })
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number }>()

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      /* v8 ignore next -- defensive: the rail root renders unconditionally, so the effect always finds it. */
      if (rect !== undefined) setAnchor({ left: rect.right + 8, top: rect.top })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  if (props.wide) {
    return (
      <div className={css.wideRoot} data-server-sidebar-menu>
        <MenuBody {...props} edit={edit} setEdit={setEdit} />
      </div>
    )
  }

  return (
    <div ref={rootRef} className={css.railRoot} data-server-sidebar-menu>
      <Tooltip label={props.t('menu.trigger')} side="right" delayMs={500}>
        <button
          type="button"
          className={css.railTrigger}
          aria-label={props.t('menu.trigger')}
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          <IconBrowseOutline16 size={18} />
        </button>
      </Tooltip>
      {open && anchor !== undefined && (
        <section className={css.panel} style={anchor} data-server-sidebar-menu-panel aria-label={props.t('menu.trigger')}>
          <MenuBody {...props} edit={edit} setEdit={setEdit} />
        </section>
      )}
    </div>
  )
}
