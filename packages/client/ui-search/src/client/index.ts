/**
 * Workspace-wide message search, browser half: one overlay that reads the
 * Host's indexed message search page by page and opens the message a result
 * came from.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SearchPanel } from './SearchPanel.tsx'
import type { SearchPanelInjected } from './SearchPanel.tsx'
import { NS, de, en, es, fr, ja, pt, ru, zh, type SearchKey } from './locales.ts'
import { IDLE_STATE, type SearchCursor, type SearchPanelState, type SearchResultRow } from './state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Message search panel copy. */
    'search': SearchKey
  }
}

export type { SearchPanelInjected, SearchPanelProps } from './SearchPanel.tsx'
export type { SearchPanelState, SearchResultRow } from './state.ts'

/** Required services: the session data layer, the slot registry, dictionaries, and shortcuts. */
export const inject = ['sessions', 'slots', 'locale', 'shortcuts', 'uiWorkspace']

/** Debounce between the last keystroke and the Host read. */
const QUERY_DEBOUNCE_MS = 250

/**
 * Client plugin body: register the dictionaries, the shortcut, and the overlay.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-search: dictionaries')
  const store = createSnapshotStore<SearchPanelState>(IDLE_STATE)
  const t = ctx.locale.bind(NS)
  let sequence = 0
  let pending: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancelPending = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    pending?.abort()
    pending = undefined
  }

  const setState = (patch: Partial<SearchPanelState>): void => {
    store.set({ ...store.getSnapshot(), ...patch })
  }

  const titleOf = (sessionId: SearchResultRow['sessionId']): string | undefined => {
    const row = ctx.sessions.list.getSnapshot().byId[sessionId]
    const title = row?.title?.trim()
    return title === undefined || title === '' ? undefined : title
  }

  /** Read one page, appending when `cursor` continues an existing sequence. */
  const readPage = async (query: string, cursor: SearchCursor | undefined, token: number): Promise<void> => {
    cancelPending()
    const controller = new AbortController()
    pending = controller
    setState(cursor === undefined ? { phase: 'loading' } : { phase: 'loadingMore' })
    const result = await ctx.sessions.searchMessages(
      cursor === undefined ? { query } : { query, cursor },
      controller.signal,
    )
    if (token !== sequence) return
    pending = undefined
    if (!result.ok) {
      setState({ phase: 'error', nextCursor: undefined })
      return
    }
    const rows: SearchResultRow[] = result.value.items.map(item => ({
      sessionId: item.sessionId,
      seq: Number(item.seq),
      title: titleOf(item.sessionId),
      snippet: item.snippet,
      matches: item.matches ?? [],
    }))
    const previous = cursor === undefined ? [] : store.getSnapshot().rows
    const seen = new Set(previous.map(row => `${row.sessionId}:${String(row.seq)}`))
    const appended = [...previous, ...rows.filter(row => !seen.has(`${row.sessionId}:${String(row.seq)}`))]
    setState({
      rows: appended,
      phase: 'ready',
      nextCursor: result.value.nextCursor,
      coverage: result.value.coverage,
      active: appended.length === 0 ? -1 : Math.min(Math.max(store.getSnapshot().active, 0), appended.length - 1),
    })
  }

  const search = (query: string): void => {
    const trimmed = query.trim()
    sequence += 1
    const token = sequence
    cancelPending()
    if (trimmed === '') {
      setState({ rows: [], phase: 'idle', nextCursor: undefined, coverage: undefined, active: -1 })
      return
    }
    timer = setTimeout(() => { void readPage(trimmed, undefined, token) }, QUERY_DEBOUNCE_MS)
  }

  const open = (): void => {
    setState({ open: true })
    const current = store.getSnapshot()
    if (current.query.trim() !== '') search(current.query)
  }

  const close = (): void => {
    sequence += 1
    cancelPending()
    store.set({ ...IDLE_STATE })
  }

  const injected: SearchPanelInjected = {
    hooks: { search: store },
    setQuery: (value) => { setState({ query: value, active: -1 }); search(value) },
    moveActive: (delta) => {
      const { rows, active } = store.getSnapshot()
      if (rows.length === 0) return
      const next = active < 0 ? 0 : Math.min(Math.max(active + delta, 0), rows.length - 1)
      setState({ active: next })
    },
    openActive: () => {
      const { rows, active } = store.getSnapshot()
      const row = rows[active < 0 ? 0 : active]
      if (row === undefined) return
      ctx.uiWorkspace.openSession(row.sessionId)
      close()
    },
    loadMore: () => {
      const { query, nextCursor, phase } = store.getSnapshot()
      if (nextCursor === undefined || phase !== 'ready') return
      void readPage(query.trim(), nextCursor, sequence)
    },
    retry: () => {
      const { query } = store.getSnapshot()
      sequence += 1
      void readPage(query.trim(), undefined, sequence)
    },
    close,
  }

  ctx.effect(() => () => { cancelPending() }, 'ui-search: pending reads')

  ctx.effect(() => ctx.shortcuts.register({
    id: brandString<ShortcutCommandId>('search.messages'),
    label: () => t('panel.aria'),
    aliases: ['search messages', 'full text search'],
    defaults: {
      'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
      'web:macos': { code: 'KeyK', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyK', modifiers: ['primary', 'alt'] },
    },
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => ({ status: 'handled', run: open }),
  }), 'ui-search: shortcut')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'search.panel',
    locale: NS,
    inject: () => injected,
  }, SearchPanel))
}
