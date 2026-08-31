// @vitest-environment jsdom
/**
 * server-sidebar browser half against the real SlotRegistry: the two reads
 * that have to precede registration (content-frame's page catalog, this
 * package's own server-menu document), the `sidebar` slot registration and
 * the four child seats it declares (`sidebar.workspaces` deliberately
 * absent — decision ①), the `conversation.session.header.actions`
 * registration for the "存为工作流" action, the workbench/workflow/page
 * business logic each injected callback wires, removal on fiber teardown
 * (HMR safety), the dictionaries, and the invariant companion's ownership
 * reservation.
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
import { SaveWorkflowAction, type SaveWorkflowInjected } from '../src/client/SaveWorkflowAction.tsx'
import type { createWorkflowStore } from '../src/client/workflow-store.ts'
import * as ServerSidebarInvariant from '../src/invariant.ts'
import { en, zh } from '../src/client/locales.ts'

/** The sidebar entry's inject factory, as `injectFace` below invokes it. */
type SidebarInjectFactory = (actions: BoundActions<ReturnType<typeof createWorkflowStore>>) => ServerSidebarInjected

/** The header action's inject factory: session-scope, no store — one positional `sessionId` argument. */
type HeaderInjectFactory = (sessionId: string) => SaveWorkflowInjected

/** Mocked `workspaces` service face this bench provides. */
interface BenchWorkspaces {
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
  workspaces: BenchWorkspaces
  sessions: BenchSessions
  remote: BenchRemote
}

const CONTENT_FRAME_SETTINGS_ROUTE = '/content-frame/settings'
const SERVER_MENU_ROUTE = '/server-menu/workflows'

const CONTENT_FRAME_PAGES = [{ id: 'home', title: 'Home', description: '', url: '/content-app/' }]
const PAGES = [{ id: 'home', title: 'Home' }]
const WORKFLOW = { id: 'w1', name: 'Alpha', order: 0, homeSessionId: 'session-a', navSnapshot: ['home'], savedAt: 1 }

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

/** Declare the layout-owned `sidebar`/`conversation` slots and ui-conversation's header-actions seat, as the real shells do. */
function declareSlots(ctx: Context): void {
  ctx.slots.register(
    {
      name: 'root',
      children: { sidebar: { kind: 'single', scope: 'root' }, conversation: { kind: 'single', scope: 'session-maybe' } },
    } as never,
    () => null,
  )
  ctx.slots.register(
    {
      name: 'conversation',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

/** Boot the browser half over a real slot tree, with every service it calls stubbed. */
async function bench(
  options: { currentSessionId?: string; recentWorkspaceId?: string; homePage?: string } = {},
): Promise<BenchResult> {
  stubFetch({
    [CONTENT_FRAME_SETTINGS_ROUTE]: {
      body: {
        cacheSize: 1,
        pages: CONTENT_FRAME_PAGES,
        ...options.homePage === undefined ? {} : { homePage: options.homePage },
      },
    },
    [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW] } },
  })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareSlots(ctx)
  const workspaces = {
    connectWorkspace: vi.fn(() => Promise.resolve('new-session')),
    list: { getSnapshot: () => ({ recentWorkspaceId: options.recentWorkspaceId }) },
  }
  const sessions = { open: vi.fn(), list: { getSnapshot: () => ({ current: options.currentSessionId }) } }
  const remote = { commands: { execute: vi.fn(() => Promise.resolve({ ok: true, value: undefined })) } }
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.commands', remote.commands as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, workspaces, sessions, remote }
}

/** Fresh mocked store actions, as the sidebar's inject factory receives them. */
interface MockActions {
  setServerMenu: ReturnType<typeof vi.fn>
  setError: ReturnType<typeof vi.fn>
}

/** Read the sidebar entry's inject factory with a fresh bound-actions stub. */
function injectSidebar(ctx: Context): { injected: ServerSidebarInjected; actions: MockActions } {
  const [entry] = ctx.slots.entries('sidebar')
  const actions: MockActions = { setServerMenu: vi.fn(), setError: vi.fn() }
  const injected = (entry?.inject as unknown as SidebarInjectFactory)(actions as never)
  return { injected, actions }
}

/** Read the header action's inject factory for the given session. */
function injectHeaderAction(ctx: Context, sessionId: string): SaveWorkflowInjected {
  const [entry] = ctx.slots.entries('conversation.session.header.actions')
  return (entry?.inject as unknown as HeaderInjectFactory)(sessionId)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('server-sidebar browser half: sidebar registration', () => {
  it('declares only the services it uses (no layout — decision ① drops the collapse toggle)', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale', 'remote', 'remote.commands'])
  })

  it('reads content-frame\'s pages and this package\'s own server-menu document before registering', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.entries('sidebar')).toHaveLength(1)
  })

  it('registers the shell and declares four child seats, without sidebar.workspaces', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.spec('sidebar.brand.mark')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.brand.name')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.settings')).toEqual({ kind: 'single', scope: 'root' })
    expect(ctx.slots.spec('sidebar.footer.action')).toEqual({ kind: 'list', scope: 'root' })
    expect(ctx.slots.spec('sidebar.workspaces')).toBeUndefined()
    const [entry] = ctx.slots.entries('sidebar')
    expect(entry?.component).toBe(ServerSidebarRoot)
    expect(entry?.locale).toBe('serverSidebar')
  })

  it('takes over conversation.hero.brand.mark at priority -1, shadowing a default-priority competitor', async () => {
    const { ctx } = await bench()
    const [ours] = ctx.slots.entries('conversation.hero.brand.mark')
    expect(ours?.options.priority).toBe(-1)
    expect((ours?.component as (() => null) | undefined)?.()).toBeNull()
    // ui-brand-official (an official build only) registers at the default
    // priority 0 — confirm it still shadows behind this row rather than
    // racing on registration order.
    const disposeCompetitor = ctx.slots.register({ name: 'conversation.hero.brand.mark' }, () => null)
    const [winner] = ctx.slots.entriesOfSlot('conversation.hero.brand.mark')
    expect(winner?.options.priority).toBe(-1)
    disposeCompetitor()
  })

  it('wires the fetched pages onto the injected face', async () => {
    const { ctx } = await bench()
    const { injected } = injectSidebar(ctx)
    expect(injected.pages).toEqual(PAGES)
  })

  it('opens a page against the current session without creating a new one', async () => {
    const { ctx, remote } = await bench({ currentSessionId: 'session-a' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenPage('home')
    expect(remote.commands.execute).toHaveBeenCalledWith('session-a', '/show-content-page home', [])
  })

  it('onOpenWorkbenchOnLoad reopens the recorded session directly when it is live, with no persist', async () => {
    const { ctx, sessions } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad('home-1', true)
    expect(sessions.open).toHaveBeenCalledWith('home-1')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbenchOnLoad creates a fresh workbench session and persists its id when there is none recorded', async () => {
    const { ctx, workspaces, sessions } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbenchOnLoad(undefined, false)
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbenchOnLoad leaves a workbench open with no session and no workspace to create one in', async () => {
    const { ctx, sessions } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad(undefined, false)
    expect(sessions.open).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) reopens the recorded session directly when it is live and still blank', async () => {
    const { ctx, sessions } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true)
    expect(sessions.open).toHaveBeenCalledWith('home-1')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) creates a fresh session when the recorded one is live but no longer blank', async () => {
    const { ctx, workspaces, sessions } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbench('home-1', true, false)
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbench (click) creates a fresh workbench session and persists its id when there is none recorded', async () => {
    const { ctx, workspaces, sessions } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbench(undefined, false, false)
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbench (click) leaves a workbench open with no session and no workspace to create one in', async () => {
    const { ctx, sessions } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbench(undefined, false, false)
    expect(sessions.open).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) shows the configured home page on a reused blank draft', async () => {
    const { ctx, remote } = await bench({ homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true)
    expect(remote.commands.execute).toHaveBeenCalledWith('home-1', '/show-content-page home', [])
  })

  it('onOpenWorkbench (click) shows the configured home page on a freshly created session', async () => {
    const { ctx, remote } = await bench({ recentWorkspaceId: 'workspace-1', homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbench(undefined, false, false)
    expect(remote.commands.execute).toHaveBeenCalledWith('new-session', '/show-content-page home', [])
  })

  it('onOpenWorkbench (click) shows nothing extra when no home page is configured', async () => {
    const { ctx, remote } = await bench()
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true)
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('onOpenWorkbenchOnLoad never shows the home page — load-time continuity leaves an already-open session untouched', async () => {
    const { ctx, remote } = await bench({ homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad('home-1', true)
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('opens a live workflow directly, with no replay and no persist', async () => {
    const { ctx, sessions, remote } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkflow(WORKFLOW, true)
    expect(sessions.open).toHaveBeenCalledWith('session-a')
    expect(remote.commands.execute).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('degrades a stale workflow: creates a fresh session, replays its snapshot, and repoints homeSessionId', async () => {
    const { ctx, workspaces, sessions, remote } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }] } } })
    await injected.onOpenWorkflow(WORKFLOW, false)
    expect(workspaces.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(remote.commands.execute).toHaveBeenCalledWith('new-session', '/show-content-page home', [])
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }] })
  })

  it('persists the given workflow list wholesale on save', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    const next = [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }]
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: next } } })
    await injected.onSaveWorkflows(next)
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: next })
  })

  it('surfaces a failed save through setError rather than throwing', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { ok: false, body: {} } })
    await injected.onSaveWorkflows([])
    expect(actions.setError).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error transport rejection rather than losing it', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('transport exploded')))
    await injected.onSaveWorkflows([])
    expect(actions.setError).toHaveBeenCalledWith('transport exploded')
  })

  it('leaves other workflows untouched while repointing only the degraded one', async () => {
    const other = { ...WORKFLOW, id: 'w2', name: 'Other', order: 1, homeSessionId: 'session-c' }
    const { ctx, sessions } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    let posted: unknown
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      expect(input).toBe(SERVER_MENU_ROUTE)
      if (init?.method === 'POST') posted = JSON.parse(init.body as string)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [WORKFLOW, other] }) })
    }))
    await injected.onOpenWorkflow(WORKFLOW, false)
    expect(sessions.open).toHaveBeenCalledWith('new-session')
    expect(posted).toEqual({ workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }, other] })
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW, other] })
  })

  it('removes the sidebar entry and child declarations on teardown (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar')).toHaveLength(0)
    expect(ctx.slots.spec('sidebar.brand.mark')).toBeUndefined()
    expect(ctx.slots.spec('sidebar.footer.action')).toBeUndefined()
    expect(ctx.slots.entries('conversation.hero.brand.mark')).toHaveLength(0)
  })
})

describe('server-sidebar browser half: save-workflow header action', () => {
  it('registers into conversation.session.header.actions with the given id and order', async () => {
    const { ctx } = await bench()
    const [entry] = ctx.slots.entries('conversation.session.header.actions')
    expect(entry?.component).toBe(SaveWorkflowAction)
    expect(entry?.options.id).toBe('save-workflow')
    expect(entry?.options.order).toBe(30)
    expect(entry?.locale).toBe('serverSidebar')
  })

  it('saves a new workflow and pushes the server\'s answer into the mounted sidebar\'s own store', async () => {
    const { ctx } = await bench()
    const { actions } = injectSidebar(ctx)
    const saved = { workflows: [WORKFLOW, { id: 'w2', name: 'New Flow', order: 1, homeSessionId: 'session-b', navSnapshot: ['home'], savedAt: 2 }] }
    stubFetch({ [SERVER_MENU_ROUTE]: { body: saved } })
    const headerInjected = injectHeaderAction(ctx, 'session-b')
    await headerInjected.onSave('session-b', 'New Flow', ['home'])
    expect(actions.setServerMenu).toHaveBeenCalledWith(saved)
  })

  it('still persists a new workflow when the sidebar has not been read yet (defensive path)', async () => {
    const { ctx } = await bench()
    // Read the header action's inject factory WITHOUT reading the sidebar's
    // own first, so `sidebarActions` inside client/index.ts's closure is
    // still unset for this call.
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW] } } })
    const headerInjected = injectHeaderAction(ctx, 'session-a')
    await expect(headerInjected.onSave('session-a', 'Alpha', ['home'])).resolves.toBeUndefined()
  })

  it('warns rather than throwing when the defensive path\'s own save also fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = await bench()
    let call = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      call += 1
      // The GET (readServerMenu) succeeds; the POST (saveServerMenu) fails.
      return call === 1
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [] }) })
        : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
    }))
    const headerInjected = injectHeaderAction(ctx, 'session-a')
    await headerInjected.onSave('session-a', 'Alpha', ['home'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to save workflow (sidebar not mounted)'), expect.any(Error),
    )
    warn.mockRestore()
  })
})

describe('server-sidebar browser half: dictionaries', () => {
  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    stubFetch({
      [CONTENT_FRAME_SETTINGS_ROUTE]: { body: { cacheSize: 1, pages: CONTENT_FRAME_PAGES } },
      [SERVER_MENU_ROUTE]: { body: { workflows: [] } },
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareSlots(ctx)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ recentWorkspaceId: undefined }) } } as never)
    ctx.provide('sessions', { open: vi.fn(), list: { getSnapshot: () => ({ current: undefined }) } } as never)
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
    expect(translate('workbench.label')).toBe(zh['workbench.label'])
    ctx.locale.setLocale('en')
    expect(translate('workbench.label')).toBe(en['workbench.label'])

    await fiber.dispose()
    expect(translate('workbench.label')).not.toBe(en['workbench.label'])
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
