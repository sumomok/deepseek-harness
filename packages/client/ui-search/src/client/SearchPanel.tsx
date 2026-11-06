import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {
  SearchIndexProgress, SearchMatch, SearchPanelState, SearchRow,
} from './state.ts'
import css from './SearchPanel.module.css'

/** Registration-side business face for the search panel. */
export interface SearchPanelInjected {
  hooks: {
    /** Client panel snapshot bound by the renderer as useSearch. */
    search: {
      getSnapshot(): SearchPanelState
      subscribe(listener: () => void): () => void
    }
    /** Index preparation the Host reports while a read is outstanding. */
    searchIndex: {
      getSnapshot(): SearchIndexProgress | undefined
      subscribe(listener: () => void): () => void
    }
  }
  /** Replace the query; the plugin body debounces the Host read. */
  setQuery: (value: string) => void
  /** Move the keyboard selection by one row. */
  moveActive: (delta: number) => void
  /** Open the selected result. */
  openActive: () => void
  /** Open the result at one row index. */
  openAt: (index: number) => void
  /** Read the next page, if any. */
  loadMore: () => void
  /** Repeat the last read after a failure. */
  retry: () => void
  /** Dismiss the overlay and release focus. */
  close: () => void
}

/** Full props of the overlay occupant. */
export type SearchPanelProps =
  PropsRuntime<'shell.overlay'>
  & InjectFace<SearchPanelInjected>
  & PropsLocale<typeof NS>

/**
 * Split one rendered string into the runs a renderer paints.
 * @param text - string whose spans `matches` index.
 * @param matches - matched spans inside `text`, in ascending order.
 * @returns alternating plain and matched text runs, in order.
 */
function runs(text: string, matches: readonly SearchMatch[]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start > cursor) parts.push({ text: text.slice(cursor, match.start), hit: false })
    const end = Math.min(match.start + match.length, text.length)
    parts.push({ text: text.slice(match.start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
  return parts
}

/**
 * Paint one string with every matched span wrapped in `mark`.
 * @param text - string to paint.
 * @param matches - matched spans inside `text`.
 * @returns the runs as React nodes.
 */
function highlighted(text: string, matches: readonly SearchMatch[]): ReactNode {
  return runs(text, matches).map((part, index) => part.hit
    ? <mark key={index} className={css.hit}>{part.text}</mark>
    : <Fragment key={index}>{part.text}</Fragment>)
}

/** Section heading for one row kind. */
function sectionOf(kind: SearchRow['kind'], t: SearchPanelProps['t']): string {
  if (kind === 'workspace') return t('section.workspaces')
  if (kind === 'session') return t('section.sessions')
  return t('section.messages')
}

/**
 * Workspace search overlay: one field over the three result sections and the
 * keyboard path through all of them.
 * @param props - injected panel state, the callbacks that drive it, and the locale seat.
 * @returns the overlay while open, otherwise nothing.
 */
export function SearchPanel({
  useSearch, useSearchIndex, setQuery, moveActive, openActive, openAt, loadMore, retry, close, t,
}: SearchPanelProps) {
  const state = useSearch(snapshot => snapshot)
  const index = useSearchIndex(snapshot => snapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state.open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [state.open])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    // jsdom has no layout engine and no scrollIntoView; the guard keeps the
    // component spec from failing on a browser API that has nothing to scroll.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- jsdom omits scrollIntoView.
    active?.scrollIntoView?.({ block: 'nearest' })
  }, [state.active, state.rows.length])

  if (!state.open) return null

  // Escape belongs to the dialog rather than the field, so it still dismisses
  // after Tab moves focus into the result list.
  const onEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    // A composition in progress owns its keys: Escape cancels the composition.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    close()
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Enter during an IME composition confirms the candidate, never a result.
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (state.phase !== 'loadingMore') openActive()
    }
  }

  const onScroll = (): void => {
    const list = listRef.current
    if (list === null || state.nextCursor === undefined || state.phase !== 'ready') return
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 24) loadMore()
  }

  const count = state.rows.length
  // The Host opens and reconciles the index on the first search; until it is
  // ready the wait is preparation, not ranking, and saying so is the only
  // feedback the person gets for the minutes it can take.
  const preparing = state.phase === 'loading' && index !== undefined && index.phase !== 'ready'
    ? t('panel.preparing', { examined: String(index.examined), total: String(index.total) })
    : undefined
  const status = preparing
    ?? (state.phase === 'loading'
      ? t('panel.loading')
      : state.phase === 'loadingMore'
        ? t('panel.loadingMore')
        : state.nextCursor === undefined
          ? t('result.count', { count: String(count) })
          : t('result.countMore', { count: String(count) }))

  const settled = state.phase !== 'loading' && state.phase !== 'loadingMore' && state.phase !== 'error'
  const notice = state.query.trim() === ''
    ? t('panel.idle')
    : settled && state.rows.length === 0 && state.nextCursor === undefined
      ? t('panel.empty')
      : undefined

  const rowKey = (row: SearchRow): string => row.kind === 'workspace'
    ? `workspace:${row.workspaceId}`
    : row.kind === 'session'
      ? `session:${row.sessionId}`
      : `message:${row.sessionId}:${String(row.seq)}`

  return (
    <div className={css.backdrop} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className={css.panel} role="dialog" aria-modal="true" aria-label={t('panel.aria')} onKeyDown={onEscape}>
        <div className={css.field}>
          <span className={css.icon} aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className={css.input}
            value={state.query}
            placeholder={t('panel.placeholder')}
            aria-label={t('panel.aria')}
            spellCheck={false}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
            onKeyDown={onFieldKeyDown}
          />
          <span className={css.escape} aria-hidden="true">{t('panel.escape')}</span>
        </div>
        <div ref={listRef} className={css.list} onScroll={onScroll}>
          {state.rows.map((row, rowIndex) => {
            const first = rowIndex === 0 || state.rows[rowIndex - 1]?.kind !== row.kind
            const selected = rowIndex === state.active
            const select = (): void => { openAt(rowIndex) }
            const enter = (): void => { moveActive(rowIndex - state.active) }
            return (
              <Fragment key={rowKey(row)}>
                {first && <div className={css.section}>{sectionOf(row.kind, t)}</div>}
                {row.kind === 'message'
                  ? (
                    <button
                      type="button"
                      className={css.row}
                      data-active={selected}
                      aria-label={t('result.openAria', { title: row.title ?? t('result.untitled') })}
                      onClick={select}
                      onPointerEnter={enter}
                    >
                      <span className={css.meta}>{row.title ?? t('result.untitled')}</span>
                      <span className={css.snippet}>{highlighted(row.snippet, row.matches)}</span>
                    </button>
                  )
                  : (
                    <button
                      type="button"
                      className={css.row}
                      data-active={selected}
                      aria-label={t(row.kind === 'workspace' ? 'result.openWorkspaceAria' : 'result.openSessionAria', { title: row.title })}
                      onClick={select}
                      onPointerEnter={enter}
                    >
                      <span className={css.primary}>{highlighted(row.title, row.matches)}</span>
                      {row.kind === 'session' && row.workspace !== '' && (
                        <span className={css.meta}>{row.workspace}</span>
                      )}
                    </button>
                  )}
              </Fragment>
            )
          })}
          {state.phase === 'error' && (
            <div className={css.failure}>
              <span className={css.failureText}>{t('panel.error')}</span>
              <button type="button" className={css.retry} onClick={retry}>
                {t('panel.retry')}
              </button>
            </div>
          )}
          {notice !== undefined && <p className={css.notice}>{notice}</p>}
          {settled && state.nextCursor !== undefined && (
            <button type="button" className={css.more} onClick={loadMore}>{t('panel.loadMore')}</button>
          )}
        </div>
        <footer className={css.footer}>
          <span>{status}</span>
          {state.coverage?.status === 'partial' && <span className={css.warn}>{t('panel.partial')}</span>}
          <span className={css.hint}>{t('panel.hint')}</span>
        </footer>
      </div>
    </div>
  )
}
