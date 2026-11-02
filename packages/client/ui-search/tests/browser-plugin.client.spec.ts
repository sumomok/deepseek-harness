/**
 * ui-search plugin halves: the browser entry registers its dictionaries, its
 * page shortcut, and the overlay, and drives the Host read from the panel's
 * callbacks against a stubbed session data layer.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { SearchPanelInjected } from '../src/client/SearchPanel.tsx'
import { apply as applyNode } from '../src/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** Requests the stubbed session data layer received. */
const reads: { query: string; cursor?: string }[] = []
/** Identities the stubbed workspace was asked to open. */
const opened: string[] = []
/** Shortcut definitions the stubbed registry admitted. */
const registered: { id: string; defaults: Record<string, { code: string; modifiers: string[] }>; resolve: () => unknown }[] = []

/** What the next stub read answers with. */
let answer: 'page' | 'failure' = 'page'

/** Boot the browser half over a real slot tree that declares the overlay list. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  reads.length = 0
  opened.length = 0
  registered.length = 0
  answer = 'page'
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => ({ byId: { [SessionId('sess-a')]: { id: SessionId('sess-a'), title: '重构消息级全文搜索' } } }),
      subscribe: () => () => {},
    },
    searchMessages: async (request: { query: string; cursor?: string }) => {
      reads.push(request.cursor === undefined ? { query: request.query } : { query: request.query, cursor: request.cursor })
      if (answer === 'failure') return { ok: false, error: { code: 'transport/failed', message: 'gone' } }
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
  ctx.provide('uiWorkspace', { openSession: (id: string) => { opened.push(id) } } as never)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('configForms', { developerTools: { enabled: { getSnapshot: () => true, subscribe: () => () => {} } }, get: () => stubConfigForm().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
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
    expect(inject).toEqual(['sessions', 'slots', 'locale', 'shortcuts', 'uiWorkspace'])
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

  it('reads one page per settled query and appends the next page under its cursor', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    expect(reads).toEqual([{ query: '分页' }])
    const page = injected.hooks.search.getSnapshot()
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]?.title).toBe('重构消息级全文搜索')
    expect(page.phase).toBe('ready')
    injected.loadMore()
    await settle()
    expect(reads).toEqual([{ query: '分页' }, { query: '分页', cursor: 'page-2' }])
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

  it('opens the selected result and closes the panel', async () => {
    const { ctx } = await bench()
    const injected = face(ctx)
    injected.setQuery('分页')
    await settle()
    injected.moveActive(1)
    injected.openActive()
    expect(opened).toEqual(['sess-a'])
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

  it('leaves the node half inert', () => {
    expect(applyNode()).toBeUndefined()
  })
})
