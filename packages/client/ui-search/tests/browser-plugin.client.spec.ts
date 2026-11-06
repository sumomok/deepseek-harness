/**
 * ui-search plugin halves: the browser entry registers its dictionaries, its
 * page shortcut, and the overlay, derives name matches from the client
 * catalogs, and drives the Host read from the panel's callbacks against a
 * stubbed session data layer.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { SearchPanelInjected } from '../src/client/SearchPanel.tsx'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Requests the stubbed session data layer received. */
const reads: { query: string; cursor?: string }[] = []
/** Identities the stubbed workspace was asked to open as Sessions. */
const opened: string[] = []
/** Message positions each open asked the Session's transcript to land on. */
const revealed: (number | undefined)[] = []
/** Workspace identities the stubbed Workspace service was asked to open. */
const openedWorkspaces: string[] = []
/** Shortcut definitions the stubbed registry admitted. */
const registered: { id: string; defaults: Record<string, { code: string; modifiers: string[] }>; resolve: () => unknown }[] = []

/** One Session row the stubbed catalog serves. */
interface CatalogRow {
  id: SessionId
  title?: string
  blank?: boolean
  origin?: 'subagent'
  updatedAt: number
}

/** One Workspace row the stubbed projection serves. */
interface WorkspaceRow {
  workspaceId: string
  title: string
  sessionIds: string[]
}

/** Session catalog the next query derives name matches from. */
let catalog: CatalogRow[] = []
/** Workspace projection the next query derives name matches from. */
let workspaceRows: WorkspaceRow[] = []
/** Session ids the stubbed Workspace projection reports as archived. */
let archived: string[] = []
/** Announces a Workspace projection change to the subscribers the plugin registered. */
let archiveEmit: () => void = () => {}
/** Whether the next Workspace open refuses, like a failed Session creation. */
let refuseWorkspaceOpen = false

/** What the next stub read answers with. */
let answer: 'page' | 'failure' | 'deferred' | 'bare' = 'page'
/** Settles the read parked by `answer = 'deferred'`. */
let release: (() => void) | undefined
/** Fiber of the suite's current bench, disposed before the next one boots. */
let lastFiber: ReturnType<Context['plugin']> | undefined

// Disposal cancels a pending debounce and waits for in-flight reads, so a
// finished test cannot append to the shared request log of the next one.
afterEach(async () => {
  await lastFiber?.dispose()
  lastFiber = undefined
})

/** Boot the browser half over a real slot tree that declares the overlay list. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  reads.length = 0
  opened.length = 0
  revealed.length = 0
  openedWorkspaces.length = 0
  registered.length = 0
  answer = 'page'
  release = undefined
  archived = []
  refuseWorkspaceOpen = false
  catalog = [
    { id: SessionId('sess-a'), title: '重构消息级全文搜索', updatedAt: 5 },
    { id: SessionId('sess-publish'), title: '发布检查清单', updatedAt: 4 },
    { id: SessionId('sess-archived'), title: '归档实验记录', updatedAt: 3 },
    { id: SessionId('sess-blank'), title: '临时会话', blank: true, updatedAt: 2 },
    { id: SessionId('sess-sub'), title: '子代理巡检', origin: 'subagent', updatedAt: 1 },
  ]
  workspaceRows = [
    { workspaceId: 'ws-main', title: 'deepseek-harness', sessionIds: ['sess-a', 'sess-blank'] },
    { workspaceId: 'ws-default', title: 'default-workspace', sessionIds: ['sess-publish'] },
  ]
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({
        ids: catalog.map(row => row.id),
        byId: Object.fromEntries(catalog.map(row => [row.id, {
          id: row.id,
          title: row.title,
          displayTitle: row.title ?? '',
          blank: row.blank ?? false,
          origin: row.origin,
          running: false,
          retainedBy: {},
          updatedAt: row.updatedAt,
        }])),
      }),
      subscribe: () => () => {},
    },
    searchMessages: async (request: { query: string; cursor?: string }) => {
      reads.push(request.cursor === undefined ? { query: request.query } : { query: request.query, cursor: request.cursor })
      if (answer === 'failure') return { ok: false, error: { code: 'transport/failed', message: 'gone' } }
      if (answer === 'deferred') await new Promise<void>((resolve) => { release = resolve })
      if (answer === 'bare') {
        return {
          ok: true,
          value: {
            items: [{ sessionId: SessionId('sess-a'), seq: 8, snippet: '下一页用分页游标续读。' }],
            nextCursor: undefined,
            coverage: { status: 'complete', skippedSessions: 0 },
          },
        }
      }
      return {
        ok: true,
        value: {
          items: [{ sessionId: SessionId('sess-a'), seq: 7, snippet: '下一页用分页游标续读。', matches: [{ start: 4, length: 2 }] }],
          nextCursor: 'page-2',
          coverage: { status: 'complete', skippedSessions: 0 },
        },
      }
    },
  } as never)
  ctx.provide('shortcuts', {
    register: (definition: { id: string; defaults: Record<string, { code: string; modifiers: string[] }>; resolve: () => unknown }) => {
      registered.push(definition)
      return () => {}
    },
  } as never)
  ctx.provide('uiWorkspace', {
    openSession: (id: string, options?: { revealSeq?: number }) => {
      opened.push(id)
      revealed.push(options?.revealSeq)
    },
    openWorkspace: (id: string) => {
      openedWorkspaces.push(id)
      return refuseWorkspaceOpen ? Promise.reject(new Error('session creation refused')) : Promise.resolve()
    },
  } as never)
  const archiveListeners = new Set<() => void>()
  archiveEmit = () => { for (const listener of archiveListeners) listener() }
  ctx.provide('workspaces', {
    list: {
      getSnapshot: () => ({ items: workspaceRows, archivedSessionIds: archived }),
      subscribe: (listener: () => void) => {
        archiveListeners.add(listener)
        return () => { archiveListeners.delete(listener) }
      },
    },
  } as never)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: { getSnapshot: () => true, subscribe: () => () => {} } }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  lastFiber = fiber
  return { ctx, fiber }
}

/** The overlay entry's inject face. */
function face(ctx: Context): SearchPanelInjected {
  const entry = ctx.slots.entries('shell.overlay').find(candidate => candidate.options.id === 'search.panel')
  const build = entry?.inject as (() => SearchPanelInjected) | undefined
  if (build === undefined) throw new Error('search.panel entry registered no inject face')
  return build()
}

/** Wait for one debounced read to reach the stub. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 400))
}

describe('ui-search browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['sessions', 'workspaces', 'slots', 'locale', 'shortcuts', 'uiWorkspace'])
  })

  it('registers the overlay and removes it with the fiber (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).toContain('search.panel')
    await fiber.dispose()
    expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).not.toContain('search.panel')
  })

  it('binds the page shortcut per platform and opens the panel', async () => {
    const { ctx } = await bench()
    const definition = registered.find(candidate => candidate.id === 'search.messages')
    if (definition === undefined) throw new Error('ui-search registered no search shortcut')
    expect(definition.defaults['desktop:macos']).toEqual({ code: 'KeyF', modifiers: ['primary'] })
    expect(definition.defaults['web:macos']).toEqual({ code: 'KeyF', modifiers: ['primary', 'alt'] })
    const injected = face(ctx)
    expect(injected.hooks.search.getSnapshot().open).toBe(false)
    const verdict = definition.resolve() as { status: string; run: () => void }
    expect(verdict.status).toBe('handled')
    verdict.run()
    expect(injected.hooks.search.getSnapshot().open).toBe(true)
    expect((definition as unknown as { label: () => string }).label()).toBe(zh['panel.aria'])
  })

  it('reruns the current phrase when the shortcut fires again', async () => {
    const { ctx } = await bench()
    const definition = registered.find(candidate => candidate.id === 'search.messages')
    if (definition === undefined) throw new Error('ui-search registered no search shortcut')
    const injected = face(ctx)
    injected.setQuery('发布')
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['session'])
    ;(definition.resolve() as { run: () => void }).run()
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['session'])
    await settle()
    expect(reads).toEqual([{ query: '发布' }])
  })

  it('registers the dictionaries under its own namespace and withdraws them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('panel.aria')).toBe(zh['panel.aria'])
    ctx.locale.setLocale('en')
    expect(translate('panel.aria')).toBe(en['panel.aria'])
    await fiber.dispose()
    expect(translate('panel.aria')).not.toBe(zh['panel.aria'])
  })

  it('lists matching Workspaces and Sessions before waiting for a Host read', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    catalog = [{ id: SessionId('sess-local'), title: '检索会话', updatedAt: 1 }]
    workspaceRows = [{ workspaceId: 'ws-local', title: '检索工作区', sessionIds: ['sess-local'] }]
    injected.setQuery('检索')
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['workspace', 'session'])
    await settle()
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['workspace', 'session', 'message'])
    expect(reads).toEqual([{ query: '检索' }])
  })

  it('opens a matched Workspace through the Workspace service and closes the panel', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('默认')
    const row = injected.hooks.search.getSnapshot().rows[0]
    if (row?.kind !== 'workspace') throw new Error('the automatic Workspace did not match its localized name')
    expect(row.title).toBe('默认工作区')
    injected.openAt(0)
    expect(openedWorkspaces).toEqual(['ws-default'])
    expect(injected.hooks.search.getSnapshot().open).toBe(false)
  })

  it('contains a refused Workspace open instead of failing the overlay', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    refuseWorkspaceOpen = true
    injected.setQuery('deepseek')
    injected.openAt(0)
    await settle()
    expect(openedWorkspaces).toEqual(['ws-main'])
    expect(injected.hooks.search.getSnapshot().open).toBe(false)
  })

  it('opens a matched Session without a message to land on', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('发布')
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['session'])
    injected.openAt(0)
    expect(opened).toEqual(['sess-publish'])
    expect(revealed).toEqual([undefined])
  })

  it('hides archived, blank, and subagent Sessions from name matches', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    archived = ['sess-archived']
    injected.setQuery('归档')
    expect(injected.hooks.search.getSnapshot().rows).toEqual([])
    injected.setQuery('临时')
    expect(injected.hooks.search.getSnapshot().rows).toEqual([])
    injected.setQuery('巡检')
    expect(injected.hooks.search.getSnapshot().rows).toEqual([])
  })

  it('orders matching Sessions by recency', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    catalog = [
      { id: SessionId('sess-old'), title: '迭代记录', updatedAt: 1 },
      { id: SessionId('sess-new'), title: '迭代总结', updatedAt: 9 },
    ]
    injected.setQuery('迭代')
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind === 'session' ? row.sessionId : '')).toEqual(['sess-new', 'sess-old'])
  })

  it('refreshes name matches when the Workspace projection changes', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('发布')
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['session'])
    workspaceRows = [...workspaceRows, { workspaceId: 'ws-publish', title: '发布归档', sessionIds: [] }]
    archiveEmit()
    expect(injected.hooks.search.getSnapshot().rows.map(row => row.kind)).toEqual(['workspace', 'session'])
  })

  it('reads one page per settled query and appends the next page under its cursor', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    expect(reads).toEqual([{ query: '分页' }])
    const page = injected.hooks.search.getSnapshot()
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.kind).toBe('message')
    expect(page.rows[0]?.kind === 'message' ? page.rows[0].title : undefined).toBe('重构消息级全文搜索')
    expect(page.phase).toBe('ready')
    injected.loadMore()
    await settle()
    expect(reads).toEqual([{ query: '分页' }, { query: '分页', cursor: 'page-2' }])
  })

  it('never doubles a page read or resumes one the Host did not promise', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    injected.loadMore()
    expect(reads).toEqual([])
    await settle()
    injected.loadMore()
    injected.loadMore()
    await settle()
    expect(reads).toEqual([{ query: '分页' }, { query: '分页', cursor: 'page-2' }])
  })

  it('drops the previous cursor as soon as the phrase changes', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    expect(injected.hooks.search.getSnapshot().nextCursor).toBe('page-2')
    injected.setQuery('游标')
    expect(injected.hooks.search.getSnapshot().nextCursor).toBeUndefined()
    injected.loadMore()
    await settle()
    // The pending first page for the new phrase still runs; no read resumes
    // from the dropped cursor.
    expect(reads.map(read => read.cursor)).toEqual([undefined, undefined])
  })

  it('clears the sequence when the field goes blank', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    injected.setQuery('')
    await settle()
    const page = injected.hooks.search.getSnapshot()
    expect(page.rows).toEqual([])
    expect(page.phase).toBe('idle')
    expect(reads).toHaveLength(1)
    archiveEmit()
    expect(injected.hooks.search.getSnapshot().rows).toEqual([])
  })

  it('keeps a failed read visible and retries the same query', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    answer = 'failure'
    injected.setQuery('分页')
    await settle()
    expect(injected.hooks.search.getSnapshot().phase).toBe('error')
    answer = 'page'
    injected.retry()
    await settle()
    expect(injected.hooks.search.getSnapshot().phase).toBe('ready')
    expect(reads.at(-1)).toEqual({ query: '分页' })
  })

  it('renders a hit the Host returned without match spans', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    answer = 'bare'
    injected.setQuery('分页')
    await settle()
    const rows = injected.hooks.search.getSnapshot().rows
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind === 'message' ? rows[0].matches : undefined).toEqual([])
  })

  it('clamps the selection at both ends of the list', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    catalog = [{ id: SessionId('sess-local'), title: '检索会话', updatedAt: 1 }]
    workspaceRows = [{ workspaceId: 'ws-local', title: '检索工作区', sessionIds: ['sess-local'] }]
    injected.setQuery('检索')
    await settle()
    expect(injected.hooks.search.getSnapshot().rows).toHaveLength(3)
    injected.moveActive(-1)
    expect(injected.hooks.search.getSnapshot().active).toBe(0)
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(1)
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(2)
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(2)
  })

  it('opens the selected message result and closes the panel', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    injected.moveActive(1)
    injected.openAt(0)
    expect(opened).toEqual(['sess-a'])
    // The hit's own message position travels with the open, so the Chat view
    // lands on the message instead of only opening its Session.
    expect(revealed).toEqual([7])
    expect(injected.hooks.search.getSnapshot().open).toBe(false)
  })

  it('moves the selection inside the available rows only', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(-1)
    injected.setQuery('分页')
    await settle()
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(0)
    injected.moveActive(1)
    expect(injected.hooks.search.getSnapshot().active).toBe(0)
  })

  it('drops a page that arrives after the panel closed', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    answer = 'deferred'
    injected.setQuery('分页')
    await settle()
    expect(release).toBeDefined()
    injected.close()
    release?.()
    await settle()
    const page = injected.hooks.search.getSnapshot()
    expect(page.open).toBe(false)
    expect(page.rows).toEqual([])
  })

  it('keeps only the newest page when a slower earlier read lands last', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    answer = 'deferred'
    injected.setQuery('分页')
    await settle()
    const first = release
    answer = 'page'
    injected.setQuery('游标')
    await settle()
    first?.()
    await settle()
    const page = injected.hooks.search.getSnapshot()
    expect(page.rows).toHaveLength(1)
    expect(page.phase).toBe('ready')
  })

  it('hides a hit whose Session the person archived', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    archived = ['sess-a']
    injected.setQuery('分页')
    await settle()
    const page = injected.hooks.search.getSnapshot()
    expect(page.rows).toEqual([])
    expect(page.phase).toBe('ready')
  })

  it('opens the highlighted row through the keyboard path', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.openActive()
    expect(opened).toEqual([])
    injected.setQuery('发布')
    injected.openActive()
    expect(opened).toEqual(['sess-publish'])
    expect(injected.hooks.search.getSnapshot().open).toBe(false)
  })

  it('re-reads visibility when the archive set changes, without another Host read', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    expect(injected.hooks.search.getSnapshot().rows).toHaveLength(1)
    archived = ['sess-a']
    archiveEmit()
    expect(injected.hooks.search.getSnapshot().rows).toEqual([])
    expect(injected.hooks.search.getSnapshot().phase).toBe('ready')
    expect(reads).toHaveLength(1)
  })

  it('waits for a read it started before finishing disposal, and publishes nothing after', async () => {
    const { ctx, fiber } = await bench()
    const injected = face(ctx)
    answer = 'deferred'
    injected.setQuery('分页')
    await settle()
    expect(release).toBeDefined()
    const before = injected.hooks.search.getSnapshot()
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(disposed).toBe(false)
    release?.()
    await disposal
    expect(disposed).toBe(true)
    expect(injected.hooks.search.getSnapshot()).toEqual(before)
    expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).not.toContain('search.panel')
  })

  it('leaves the node half inert', () => {
    // oxlint-disable-next-line typescript/no-confusing-void-expression -- the node half's contract is to return nothing.
    expect(applyNode()).toBeUndefined()
  })
})
