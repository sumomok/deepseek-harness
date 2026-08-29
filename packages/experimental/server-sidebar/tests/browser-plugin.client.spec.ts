/**
 * server-sidebar browser half against the real SlotRegistry: the two reads
 * that have to precede the registration (content-frame's page catalog, this
 * package's own favorites list), the `sidebar` slot registration and the five
 * child seats it declares, the plain runtime/layout callbacks the injected
 * face wires, removal on fiber teardown (HMR safety), the dictionaries, and
 * the invariant companion's ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, type ServerSidebarInjected } from '../src/client/index.ts'
import { ServerSidebarRoot } from '../src/client/ServerSidebarRoot.tsx'
import type { createFavoritesStore } from '../src/client/favorites-store.ts'
import * as ServerSidebarInvariant from '../src/invariant.ts'
import { en, zh } from '../src/client/locales.ts'

/** The entry's inject factory, as `injectFace` below invokes it. */
type InjectFactory = (actions: BoundActions<ReturnType<typeof createFavoritesStore>>) => ServerSidebarInjected

/** Mocked `workspaces` service face this bench provides. */
interface BenchWorkspaces {
  startSession: ReturnType<typeof vi.fn>
  connectWorkspace: ReturnType<typeof vi.fn>
  list: { getSnapshot: () => { recentWorkspaceId: string | undefined } }
}

/** Mocked `sessions` service face this bench provides. */
interface BenchSessions {
  open: ReturnType<typeof vi.fn>
  list: { getSnapshot: () => { current: string | undefined } }
}

/** Mocked `remote` service face this bench provides. */
interface BenchRemote {
  commands: { execute: ReturnType<typeof vi.fn> }
}

/** What one `bench()` call hands back to its test. */
interface BenchResult {
  ctx: Context
  fiber: ReturnType<Context['plugin']>
  layout: { toggleSidebar: ReturnType<typeof vi.fn> }
  workspaces: BenchWorkspaces
  sessions: BenchSessions
  remote: BenchRemote
}

const CONTENT_FRAME_SETTINGS_ROUTE = '/content-frame/settings'
const FAVORITES_ROUTE = '/server-menu/favorites'

const CONTENT_FRAME_PAGES = [{ id: 'home', title: 'Home', description: '', url: '/content-app/' }]
const PAGES = [{ id: 'home', title: 'Home' }]
const FAVORITES = [{ sessionId: 'session-a', label: 'A', order: 0 }]

/** Route the stubbed fetch by path; unhandled paths throw so a spec must ask for exactly what it uses. */
function stubFetch(routes: Partial<Record<string, { ok?: boolean; body: unknown }>>): void {
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const route = routes[input]
    if (route === undefined) throw new Error(`unexpected fetch: ${input}`)
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.ok === false ? 503 : 200,
      json: () => Promise.resolve(route.body),
    })
  }))
}

/** Declare the layout-owned `sidebar` slot the way the real root shell does. */
function declareSidebarSlot(ctx: Context): void {
  ctx.slots.register(
    { name: 'root', children: { sidebar: { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

/** Boot the browser half over a real slot tree, with every service it calls stubbed. */
async function bench(options: { currentSessionId?: string; recentWorkspaceId?: string } = {}): Promise<BenchResult> {
  stubFetch({
    [CONTENT_FRAME_SETTINGS_ROUTE]: { body: { cacheSize: 1, pages: CONTENT_FRAME_PAGES } },
    [FAVORITES_ROUTE]: { body: { favorites: FAVORITES } },
  })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareSidebarSlot(ctx)
  const layout = { toggleSidebar: vi.fn() }
  const workspaces = {
    startSession: vi.fn(),
    connectWorkspace: vi.fn(() => Promise.resolve('new-session')),
    list: { getSnapshot: () => ({ recentWorkspaceId: options.recentWorkspaceId }) },
  }
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current: options.currentSessionId }) } }
  const remote = { commands: { execute: vi.fn(() => Promise.resolve({ ok: true, value: undefined })) } }
  ctx.provide('layout', layout as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.commands', remote.commands as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, layout, workspaces, sessions, remote }
}

/** Fresh mocked store actions, as the entry's inject factory receives them. */
interface MockActions {
  setFavorites: ReturnType<typeof vi.fn>
  setError: ReturnType<typeof vi.fn>
}

/** Read the entry's inject factory with a fresh bound-actions stub. */
function injectFace(ctx: Context): { injected: ServerSidebarInjected; actions: MockActions } {
  const [entry] = ctx.slots.entries('sidebar')
  const actions: MockActions = { setFavorites: vi.fn(), setError: vi.fn() }
  const injected = (entry?.inject as unknown as InjectFactory)(actions as never)
  return { injected, actions }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server-sidebar browser half', () => {
  it('declares only the services it uses', () => {
    expect(inject).toEqual(['slots', 'layout', 'sessions', 'workspaces', 'locale', 'remote', 'remote.commands'])
  })

  it('reads content-frame\'s pages and this package\'s own favorites before registering', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.entries('sidebar')).toHaveLength(1)
  })

  it('registers the shell and declares the same five child seats the shipped sidebar does', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.spec('sidebar.brand.mark')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.brand.name')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.workspaces')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.settings')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.footer.action')).toEqual({ kind: 'list', scope: 'root' })
    const [entry] = ctx.slots.entries('sidebar')
    expect(entry?.component).toBe(ServerSidebarRoot)
    expect(entry?.locale).toBe('serverSidebar')
  })

  it('wires the injected callbacks to the runtime services and the fetched pages', async () => {
    const { ctx, layout, workspaces, sessions } = await bench({ currentSessionId: 'session-a' })
    const { injected, actions } = injectFace(ctx)
    expect(injected.pages).toEqual(PAGES)

    injected.startSession('workspace' as never)
    expect(workspaces.startSession).toHaveBeenCalledWith('workspace')
    injected.toggleSidebar()
    expect(layout.toggleSidebar).toHaveBeenCalledOnce()

    injected.onOpenSession('session-a')
    expect(sessions.open).toHaveBeenCalledWith('session-a')

    stubFetch({ [FAVORITES_ROUTE]: { body: { favorites: [...FAVORITES, { sessionId: 'session-b', label: 'B', order: 1 }] } } })
    await injected.onSaveFavorites([...FAVORITES, { sessionId: 'session-b', label: 'B', order: 1 }])
    expect(actions.setFavorites).toHaveBeenCalledWith([...FAVORITES, { sessionId: 'session-b', label: 'B', order: 1 }])
  })

  it('opens a page against the current session without creating a new one', async () => {
    const { ctx, remote } = await bench({ currentSessionId: 'session-a' })
    const { injected } = injectFace(ctx)
    await injected.onOpenPage('home')
    expect(remote.commands.execute).toHaveBeenCalledWith('session-a', '/show-content-page home', [])
  })

  it('creates a session from the recent workspace before opening a page when none is current', async () => {
    const { ctx, workspaces, sessions, remote } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected } = injectFace(ctx)
    await injected.onOpenPage('home')
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(remote.commands.execute).toHaveBeenCalledWith('new-session', '/show-content-page home', [])
  })

  it('leaves a page click a contained no-op with no session and no workspace to create one in', async () => {
    const { ctx, remote } = await bench()
    const { injected } = injectFace(ctx)
    await injected.onOpenPage('home')
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('surfaces a failed favorites save through setError rather than throwing', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectFace(ctx)

    stubFetch({ [FAVORITES_ROUTE]: { ok: false, body: {} } })
    await injected.onSaveFavorites([])
    expect(actions.setError).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    expect(actions.setFavorites).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error transport rejection rather than losing it', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectFace(ctx)

    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('transport exploded')))
    await injected.onSaveFavorites([])
    expect(actions.setError).toHaveBeenCalledWith('transport exploded')
  })

  it('removes the entry and child declarations on teardown (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar')).toHaveLength(0)
    expect(ctx.slots.spec('sidebar.brand.mark')).toBeUndefined()
    expect(ctx.slots.spec('sidebar.workspaces')).toBeUndefined()
    expect(ctx.slots.spec('sidebar.footer.action')).toBeUndefined()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    stubFetch({
      [CONTENT_FRAME_SETTINGS_ROUTE]: { body: { cacheSize: 1, pages: CONTENT_FRAME_PAGES } },
      [FAVORITES_ROUTE]: { body: { favorites: FAVORITES } },
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareSidebarSlot(ctx)
    ctx.provide('layout', { toggleSidebar: vi.fn() } as never)
    ctx.provide('workspaces', { startSession: vi.fn() } as never)
    ctx.provide('sessions', { open: vi.fn() } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() }, $on: () => () => {} } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    // The locale plugin binds a settings scope, which reads the connection
    // handle and the forwarded-event port.
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
    // There is no jsdom `window` in this lane, so browser-language detection
    // never runs and the locale comes from FALLBACK_LOCALE (en): state the
    // asserted locale explicitly.
    ctx.locale.setLocale('zh')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const translate = ctx.locale.bind('serverSidebar')
    expect(translate('session.new')).toBe(zh['session.new'])
    ctx.locale.setLocale('en')
    expect(translate('session.new')).toBe(en['session.new'])

    await fiber.dispose()
    expect(translate('session.new')).not.toBe(en['session.new'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('server-sidebar invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(ServerSidebarInvariant)
    await fiber.await()
    expect(ServerSidebarInvariant.name).toBe('experimental-server-sidebar-invariant')
    expect(ServerSidebarInvariant.inject).toEqual(['invariants'])
    await fiber.dispose()
  })
})
