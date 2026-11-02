import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type { SearchPanelState, SearchResultRow } from './state.ts'
import css from './SearchPanel.module.css'

/** Registration-side business face for the search panel. */
export interface SearchPanelInjected {
  hooks: {
    /** Client panel snapshot bound by the renderer as useSearch. */
    search: {
      getSnapshot(): SearchPanelState
      subscribe(listener: () => void): () => void
    }
  }
  /** Replace the query; the plugin body debounces the Host read. */
  setQuery: (value: string) => void
  /** Move the keyboard selection by one row. */
  moveActive: (delta: number) => void
  /** Open the selected result. */
  openActive: () => void
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
 * Split one excerpt into the runs a renderer paints.
 * @param row - result whose `matches` index its own `snippet`.
 * @returns alternating plain and matched text runs, in order.
 */
function runs(row: SearchResultRow): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const match of row.matches) {
    if (match.start > cursor) parts.push({ text: row.snippet.slice(cursor, match.start), hit: false })
    const end = Math.min(match.start + match.length, row.snippet.length)
    parts.push({ text: row.snippet.slice(match.start, end), hit: true })
    cursor = end
  }
  if (cursor < row.snippet.length) parts.push({ text: row.snippet.slice(cursor), hit: false })
  return parts
}

/**
 * Workspace-wide message search overlay: one field, one result list, and the
 * keyboard path through it.
 * @param props - injected panel state, the callbacks that drive it, and the locale seat.
 * @returns the overlay while open, otherwise nothing.
 */
export function SearchPanel({
  useSearch, setQuery, moveActive, openActive, loadMore, retry, close, t,
}: SearchPanelProps) {
  const state = useSearch(snapshot => snapshot)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state.open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [state.open])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.active, state.rows.length])

  if (!state.open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
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
  const status = state.phase === 'loading'
    ? t('panel.loading')
    : state.phase === 'loadingMore'
      ? t('panel.loadingMore')
      : state.nextCursor === undefined
        ? t('result.count', { count: String(count) })
        : t('result.countMore', { count: String(count) })

  const notice = state.query.trim() === ''
    ? t('panel.idle')
    : state.phase === 'error'
      ? undefined
      : state.phase === 'loading' || state.phase === 'loadingMore'
        ? undefined
        : t('panel.empty')

  return (
    <div className={css.backdrop} onPointerDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className={css.panel} role="dialog" aria-modal="true" aria-label={t('panel.aria')}>
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
            onKeyDown={onKeyDown}
          />
          <span className={css.escape} aria-hidden="true">{t('panel.escape')}</span>
        </div>
        <div ref={listRef} className={css.list} onScroll={onScroll}>
          {state.rows.map((row, index) => (
            <button
              key={`${row.sessionId}:${String(row.seq)}`}
              type="button"
              className={css.row}
              data-active={index === state.active}
              aria-label={t('result.openAria', { title: row.title ?? t('result.untitled') })}
              onPointerDown={(event) => { event.preventDefault(); openActive() }}
              onPointerEnter={() => { moveActive(index - state.active) }}
            >
              <span className={css.title}>{row.title ?? t('result.untitled')}</span>
              <span className={css.snippet}>
                {runs(row).map((part, partIndex) => part.hit
                  ? <mark key={partIndex} className={css.hit}>{part.text}</mark>
                  : <span key={partIndex}>{part.text}</span>)}
              </span>
            </button>
          ))}
          {state.phase === 'error' && (
            <div className={css.failure}>
              <span className={css.failureText}>{t('panel.error')}</span>
              <button type="button" className={css.retry} onPointerDown={(event) => { event.preventDefault(); retry() }}>
                {t('panel.retry')}
              </button>
            </div>
          )}
          {notice !== undefined && <p className={css.notice}>{notice}</p>}
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
