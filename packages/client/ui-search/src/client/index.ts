/**
 * Workspace-wide search, browser half: one overlay that lists matching
 * Workspaces and Sessions from the client catalogs, then reads the Host's
 * indexed message search page by page and opens whatever row the person picks.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SearchPanel } from './SearchPanel.tsx'
import type { SearchPanelInjected } from './SearchPanel.tsx'
import { localMatches } from './local.ts'
import { NS, de, en, es, fr, ja, pt, ru, zh, type SearchKey } from './locales.ts'
import { IDLE_STATE, type SearchCursor, type SearchMessageRow, type SearchPanelState, type SearchRow } from './state.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace search panel copy. */
    'search': SearchKey
  }
}

export type { SearchPanelInjected, SearchPanelProps } from './SearchPanel.tsx'
export type { SearchPanelState, SearchRow } from './state.ts'

/** Required services: the session data layer, the slot registry, dictionaries, and shortcuts. */
export const inject = ['sessions', 'workspaces', 'slots', 'locale', 'shortcuts', 'uiWorkspace']

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
  /** Workspace and Session rows for the current query, derived from client catalogs. */
  let local: SearchRow[] = []
  /** Every message row this sequence has read, archived ones included; visibility is derived. */
  let retained: SearchMessageRow[] = []
  /** Reads that have not settled; disposal waits for them. */
  const inflight = new Set<Promise<void>>()

  const cancelPending = (): void => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    pending?.abort()
    pending = undefined
  }

  const setState = (patch: Partial<SearchPanelState>): void => {
    store.set({ ...store.getSnapshot(), ...patch })
  }

  /** Sessions the person archived; the client catalogs expose them, the search index does not. */
  const archived = (): ReadonlySet<SessionId> => new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)

  /** Name matches for one query, from the current Workspace and Session projections. */
  const names = (query: string): SearchRow[] => localMatches(
    ctx.sessions.list.getSnapshot(),
    ctx.workspaces.list.getSnapshot(),
    query,
    archived(),
    t('workspace.defaultName'),
  )

  /**
   * Publish the rows that survive the archive set and keep the selection inside
   * them. Rows are retained unfiltered so a later archive or restore changes
   * what the person sees without another Host read.
   * @param patch - further state fields to publish with the visible rows.
   */
  const publish = (patch: Partial<SearchPanelState> = {}): void => {
    const hidden = archived()
    const visible = [...local, ...retained]
      .filter(row => row.kind === 'workspace' || !hidden.has(row.sessionId))
    const next = { ...store.getSnapshot(), ...patch }
    setState({
      ...patch,
      rows: visible,
      active: visible.length === 0 ? -1 : Math.min(Math.max(next.active, 0), visible.length - 1),
    })
  }

  const titleOf = (sessionId: SearchMessageRow['sessionId']): string | undefined => {
    const row = ctx.sessions.list.getSnapshot().byId[sessionId]
    const title = row?.title?.trim()
    return title === undefined || title === '' ? undefined : title
  }

  /**
   * Start one page read and keep it in the set disposal waits on.
   * @param query - the phrase this sequence searches for.
   * @param cursor - continuation cursor, absent for the first page.
   * @param token - sequence identity the reply must still match to be published.
   */
  const startRead = (query: string, cursor: SearchCursor | undefined, token: number): void => {
    timer = undefined
    const read = readPage(query, cursor, token)
    inflight.add(read)
    void read.finally(() => { inflight.delete(read) })
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
    const rows: SearchMessageRow[] = result.value.items.map(item => ({
      kind: 'message',
      sessionId: item.sessionId,
      seq: Number(item.seq),
      title: titleOf(item.sessionId),
      snippet: item.snippet,
      matches: item.matches ?? [],
    }))
    const seen = new Set(retained.map(row => `${row.sessionId}:${String(row.seq)}`))
    retained = [...retained, ...rows.filter(row => !seen.has(`${row.sessionId}:${String(row.seq)}`))]
    publish({ phase: 'ready', nextCursor: result.value.nextCursor, coverage: result.value.coverage })
  }

  const search = (query: string): void => {
    const trimmed = query.trim()
    sequence += 1
    const token = sequence
    cancelPending()
    local = trimmed === '' ? [] : names(trimmed)
    retained = []
    if (trimmed === '') {
      setState({ rows: [], phase: 'idle', nextCursor: undefined, coverage: undefined, active: -1 })
      return
    }
    publish({ nextCursor: undefined, coverage: undefined, active: -1, phase: 'loading' })
    timer = setTimeout(() => { startRead(trimmed, undefined, token) }, QUERY_DEBOUNCE_MS)
  }

  const open = (): void => {
    setState({ open: true })
    const current = store.getSnapshot()
    if (current.query.trim() !== '') search(current.query)
  }

  const close = (): void => {
    sequence += 1
    cancelPending()
    local = []
    retained = []
    store.set({ ...IDLE_STATE })
  }

  /**
   * Open the Workspace or Session a name row names, or reveal the message a hit
   * names, then dismiss the panel. A message's landing belongs to that
   * Session's Chat view: the target travels with the selection, so it outlives
   * the Session opening and still works while that Session is already showing.
   */
  const openRow = (index: number): void => {
    const row = store.getSnapshot().rows[index]
    if (row === undefined) return
    if (row.kind === 'workspace') {
      // The Workspace service reports a refused Session creation through its own
      // notice, so the overlay only keeps the rejection from going unhandled.
      void ctx.uiWorkspace.openWorkspace(row.workspaceId).catch(() => {})
      close()
      return
    }
    if (row.kind === 'session') ctx.uiWorkspace.openSession(row.sessionId)
    else ctx.uiWorkspace.openSession(row.sessionId, { revealSeq: SessionSeq(row.seq) })
    close()
  }

  const injected: SearchPanelInjected = {
    hooks: { search: store, searchIndex: ctx.sessions.searchIndex },
    setQuery: (value) => {
      // The old rows and cursor belong to the old phrase: clear them before the
      // debounce fires so Enter cannot open a result the field no longer names.
      setState({ query: value })
      search(value)
    },
    moveActive: (delta) => {
      const { rows, active } = store.getSnapshot()
      if (rows.length === 0) return
      setState({ active: Math.min(Math.max(active + delta, 0), rows.length - 1) })
    },
    openActive: () => {
      openRow(store.getSnapshot().active < 0 ? 0 : store.getSnapshot().active)
    },
    openAt: (index) => { openRow(index) },
    loadMore: () => {
      const { query, nextCursor, phase } = store.getSnapshot()
      if (nextCursor === undefined || phase !== 'ready') return
      startRead(query.trim(), nextCursor, sequence)
    },
    retry: () => {
      const { query } = store.getSnapshot()
      sequence += 1
      retained = []
      startRead(query.trim(), undefined, sequence)
    },
    close,
  }

  // Archiving, restoring, and Workspace renames change what the retained rows
  // and name matches may show without a new Host read, so follow both catalogs.
  ctx.effect(() => ctx.workspaces.list.subscribe(() => {
    const trimmed = store.getSnapshot().query.trim()
    if (trimmed !== '') local = names(trimmed)
    publish()
  }), 'ui-search: catalog follow')

  // Disposal invalidates the sequence, aborts the read in flight, and waits for
  // every read this plugin started, so nothing publishes after teardown.
  ctx.effect(() => () => {
    sequence += 1
    cancelPending()
    return Promise.allSettled([...inflight]).then(() => undefined)
  }, 'ui-search: pending reads')

  ctx.effect(() => ctx.shortcuts.register({
    id: brandString<ShortcutCommandId>('search.messages'),
    label: () => t('panel.aria'),
    aliases: ['search messages', 'full text search'],
    defaults: {
      'desktop:macos': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:windows': { code: 'KeyF', modifiers: ['primary'] },
      'desktop:linux': { code: 'KeyF', modifiers: ['primary'] },
      'web:macos': { code: 'KeyF', modifiers: ['primary', 'alt'] },
      'web:windows': { code: 'KeyF', modifiers: ['primary', 'alt'] },
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
