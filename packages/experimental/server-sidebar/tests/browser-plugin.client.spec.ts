// @vitest-environment jsdom
/**
 * server-sidebar browser half against the real SlotRegistry: the two reads
 * that have to precede registration (content-frame's page catalog, this
 * package's own server-menu document), the `sidebar` slot registration and
 * the four child seats it declares (`sidebar.workspaces` deliberately
 * absent — decision ①), the `conversation.session.header.actions`
 * registration for the "存为工作流" action and the untitled-conversation
 * title beside it, the withheld Settings entries, the
 * workbench/workflow/page
 * business logic each injected callback wires, the footer's identity source
 * and its sign-out action, removal on fiber teardown (HMR safety), and the
 * dictionaries.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, type ServerSidebarInjected } from '../src/client/index.ts'
import { ServerSidebarRoot } from '../src/client/ServerSidebarRoot.tsx'
import { SaveWorkflowAction, type SaveWorkflowInjected } from '../src/client/SaveWorkflowAction.tsx'
import { WithheldSettingsEntry } from '../src/client/settings-entries.ts'
import { CompactedRow, CompactionFailedRow } from '../src/client/CompactionRows.tsx'
import { UntitledTitle } from '../src/client/UntitledTitle.tsx'
import type { createWorkflowStore } from '../src/client/workflow-store.ts'
import type { NavSnapshotItem } from '../src/workflows.ts'
import { en, zh } from '../src/client/locales.ts'

/** The sidebar entry's inject factory, as `injectFace` below invokes it. */
type SidebarInjectFactory = (actions: BoundActions<ReturnType<typeof createWorkflowStore>>) => ServerSidebarInjected

/** The header action's inject factory: session-scope, no store — one positional `sessionId` argument. */
type HeaderInjectFactory = (sessionId: string) => SaveWorkflowInjected

/** Mocked `workspaces` service face this bench provides. */
interface BenchWorkspaces {
  archiveSession: ReturnType<typeof vi.fn>
  list: {
    getSnapshot: () => {
      phase: 'ready'
      archivedSessionIds: readonly string[]
      items: readonly { workspaceId: string; path: string; sessionIds: readonly string[]; createdAt: string }[]
    }
  }
}

/** Mocked `sessions` service face this bench provides. */
interface BenchSessions {
  list: { getSnapshot: () => { phase: 'ready'; ids: readonly string[]; byId: object } }
  scope: (id: string) => { get: (service: string) => { cancel: ReturnType<typeof vi.fn> } }
}

/** Mocked `uiWorkspace` service face this bench provides. */
interface BenchUiWorkspace {
  connectWorkspace: ReturnType<typeof vi.fn>
  openSession: ReturnType<typeof vi.fn>
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
  uiWorkspace: BenchUiWorkspace
  sessions: BenchSessions
  remote: BenchRemote
  /** The one cancel face every session scope in this bench resolves to. */
  cancel: ReturnType<typeof vi.fn>
}

const CONTENT_FRAME_SETTINGS_ROUTE = '/content-frame/settings'
const COMPONENT_SURFACE_VIEWS_ROUTE = '/component-surface/views'
const SERVER_MENU_ROUTE = '/server-menu/workflows'
const SERVER_IDENTITY_ROUTE = '/server-menu/identity'
const AUTH_GATE_SETTINGS_ROUTE = '/auth-gate/settings'
const AUTH_GATE_LOGOUT_ROUTE = '/auth-gate/logout'

/** A JWT-shaped token whose payload carries one display-name claim. */
function jwt(name: string): string {
  const body = btoa(JSON.stringify({ login_uname: name })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  return `header.${body}.signature`
}

const CONTENT_FRAME_PAGES = [{ id: 'home', title: 'Home', description: '', url: '/content-app/' }]
const COMPONENT_SURFACE_VIEWS = [{ id: 'sales', title: 'Sales' }]
const NAV_ITEMS = [
  { kind: 'page', entryId: 'home', title: 'Home' },
  { kind: 'view', entryId: 'sales', title: 'Sales' },
]
const NAV_SNAPSHOT: NavSnapshotItem[] = [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }]
const WORKFLOW = {
  id: 'w1', name: 'Alpha', order: 0, homeSessionId: 'session-a', navSnapshot: NAV_SNAPSHOT, savedAt: 1,
}

/**
 * Route the stubbed fetch by path; unhandled paths throw so a spec must ask for
 * exactly what it uses. The browser half asks for URLs resolved against the
 * deployment base, so the path is read off them.
 */
function stubFetch(routes: Partial<Record<string, { ok?: boolean; body: unknown }>>): void {
  vi.stubGlobal('fetch', vi.fn((input: URL) => {
    const route = routes[input.pathname]
    if (route === undefined) throw new Error(`unexpected fetch: ${input.href}`)
    return Promise.resolve({
      ok: route.ok ?? true,
      status: route.ok === false ? 503 : 200,
      json: () => Promise.resolve(route.body),
    })
  }))
}

/**
 * Declare the layout-owned `sidebar`/`conversation` slots, ui-conversation's
 * header-actions seat, ui-chat's node renderers, and the settings shell's
 * General item list and header action list, as the real shells do.
 */
function declareSlots(ctx: Context): void {
  ctx.slots.register(
    {
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        conversation: { kind: 'single', scope: 'session-maybe' },
        // Declared by ui-settings-general's General section and settings panel in the real page.
        'settings.general.item': { kind: 'list', scope: 'root' },
        'settings.action': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
  ctx.slots.register(
    {
      name: 'conversation',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
        // Declared by ui-chat's Chat view in the real page.
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    } as never,
    () => null,
  )
}

/** Boot the browser half over a real slot tree, with every service it calls stubbed. */
async function bench(
  options: {
    currentSessionId?: string
    recentWorkspaceId?: string
    homePage?: string
    homeView?: string
    /** Refuse component-surface's views route, as a composition without that plugin does. */
    withoutComponentSurface?: boolean
    /** Omit auth-gate's settings route, as a composition without that plugin does. */
    withoutAuthGate?: boolean
    /** Refuse this package's own identity route, as a composition with no webserver does. */
    withoutIdentity?: boolean
    /** Extra ids the session directory lists alongside the current one. */
    liveSessionIds?: readonly string[]
  } = {},
): Promise<BenchResult> {
  stubFetch({
    [CONTENT_FRAME_SETTINGS_ROUTE]: {
      body: {
        cacheSize: 1,
        pages: CONTENT_FRAME_PAGES,
        ...options.homePage === undefined ? {} : { homePage: options.homePage },
      },
    },
    [COMPONENT_SURFACE_VIEWS_ROUTE]: options.withoutComponentSurface === true
      ? { ok: false, body: {} }
      : { body: { views: COMPONENT_SURFACE_VIEWS, ...options.homeView === undefined ? {} : { homeView: options.homeView } } },
    [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW] } },
    [SERVER_IDENTITY_ROUTE]: options.withoutIdentity === true
      ? { ok: false, body: {} }
      : { body: { displayNameClaim: 'login_uname' } },
    [AUTH_GATE_LOGOUT_ROUTE]: { body: undefined },
    // A fragment-only login address, so the one test that lets the whole
    // sign-out run through leaves the jsdom page where it is (a path
    // navigation is the one thing jsdom refuses to perform).
    ...options.withoutAuthGate === true
      ? { [AUTH_GATE_SETTINGS_ROUTE]: { ok: false, body: {} } }
      : { [AUTH_GATE_SETTINGS_ROUTE]: { body: { loginUrl: '#/toy-login', cookieName: 'accessToken' } } },
  })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  declareSlots(ctx)
  const workspaces = {
    archiveSession: vi.fn(() => Promise.resolve()),
    list: {
      getSnapshot: () => ({
        phase: 'ready' as const,
        archivedSessionIds: [],
        items: options.recentWorkspaceId === undefined
          ? []
          : [{ workspaceId: options.recentWorkspaceId, path: '/workspace', sessionIds: [], createdAt: '2026-01-01T00:00:00.000Z' }],
      }),
    },
  }
  const cancel = vi.fn(() => Promise.resolve())
  const listed = [
    ...options.currentSessionId === undefined ? [] : [options.currentSessionId],
    ...options.liveSessionIds ?? [],
  ]
  const sessions = {
    list: {
      getSnapshot: () => ({
        phase: 'ready' as const,
        ids: listed,
        // The main view is the row the Conversation retains.
        byId: Object.fromEntries(listed.map(id => [id, {
          id, running: false, retainedBy: id === options.currentSessionId ? { mainView: 1 } : {},
        }])),
      }),
    },
    scope: () => ({ get: () => ({ cancel }) }),
  }
  const uiWorkspace = { connectWorkspace: vi.fn(() => Promise.resolve('new-session')), openSession: vi.fn() }
  const remote = { commands: { execute: vi.fn(() => Promise.resolve({ ok: true, value: undefined })) } }
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.commands', remote.commands as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, workspaces, uiWorkspace, sessions, remote, cancel }
}

/** Fresh mocked store actions, as the sidebar's inject factory receives them. */
interface MockActions {
  setServerMenu: ReturnType<typeof vi.fn>
  setError: ReturnType<typeof vi.fn>
  setTemporaryFailed: ReturnType<typeof vi.fn>
}

/** Read the sidebar entry's inject factory with a fresh bound-actions stub. */
function injectSidebar(ctx: Context): { injected: ServerSidebarInjected; actions: MockActions } {
  const [entry] = ctx.slots.entries('sidebar')
  const actions: MockActions = { setServerMenu: vi.fn(), setError: vi.fn(), setTemporaryFailed: vi.fn() }
  const injected = (entry?.inject as unknown as SidebarInjectFactory)(actions as never)
  return { injected, actions }
}

/**
 * One of this package's header-action entries, by its list id.
 * @param ctx - the bench context.
 * @param id - the entry's list id.
 * @returns the stored entry, or undefined.
 */
function headerAction(ctx: Context, id: string): ReturnType<Context['slots']['entries']>[number] | undefined {
  return ctx.slots.entries('conversation.session.header.actions').find(entry => entry.options.id === id)
}

/** Read the save-workflow header action's inject factory for the given session. */
function injectHeaderAction(ctx: Context, sessionId: string): SaveWorkflowInjected {
  const entry = headerAction(ctx, 'save-workflow')
  return (entry?.inject as unknown as HeaderInjectFactory)(sessionId)
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('server-sidebar browser half: sidebar registration', () => {
  it('declares only the services it uses (no layout — decision ① drops the collapse toggle)', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'remote', 'remote.commands'])
  })

  it('reads both navigation catalogs and this package\'s own server-menu document before registering', async () => {
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

  it('shadows each withheld settings entry at priority -1 with an entry that renders nothing', async () => {
    const { ctx } = await bench()
    const withheld = [
      { slot: 'settings.general.item', id: 'busy-compaction' },
      { slot: 'settings.general.item', id: 'auto-compact' },
      { slot: 'settings.action', id: 'open-document' },
    ] as const
    expect(WithheldSettingsEntry()).toBeNull()
    expect(ctx.slots.entries('settings.general.item').map(entry => entry.options.id)).toEqual(['busy-compaction', 'auto-compact'])
    expect(ctx.slots.entries('settings.action').map(entry => entry.options.id)).toEqual(['open-document'])
    for (const { slot, id } of withheld) {
      const ours = ctx.slots.entries(slot).find(entry => entry.options.id === id)
      expect(ours?.options.priority).toBe(-1)
      expect(ours?.component).toBe(WithheldSettingsEntry)
    }
    // The owning packages register their entries at the default priority 0
    // (`ui-chat`'s busy-compaction row, `@haoran/dsh-auto-compact`'s row,
    // `ui-settings-general`'s configuration-file action), in either order
    // relative to this one; the cell's winner stays the empty entry, and an
    // unrelated entry keeps its own cell.
    const disposeOwners = withheld.map(({ slot, id }) => ctx.slots.register(
      { name: slot, id, order: 0 },
      () => null,
    ))
    const disposeOther = ctx.slots.register({ name: 'settings.general.item', id: 'performance-usage', order: 30 }, () => null)
    for (const { slot, id } of withheld) {
      const winners = ctx.slots.entriesOfSlot(slot)
      expect(winners.filter(entry => entry.options.id === id).map(entry => entry.options.priority)).toEqual([-1])
    }
    expect(ctx.slots.entriesOfSlot('settings.general.item').map(entry => entry.options.id)).toContain('performance-usage')
    for (const dispose of [...disposeOwners, disposeOther]) dispose()
  })

  it('replaces ui-chat\'s landed and failed compaction rows by node key at priority -1, in this package\'s locale', async () => {
    const { ctx } = await bench()
    const replaced = [
      { key: 'compaction', component: CompactedRow },
      { key: 'compaction-failure', component: CompactionFailedRow },
    ] as const
    expect(ctx.slots.entries('conversation.chat.node').map(entry => entry.options.key)).toEqual(['compaction', 'compaction-failure'])
    for (const { key, component } of replaced) {
      const ours = ctx.slots.entries('conversation.chat.node').find(entry => entry.options.key === key)
      expect(ours?.options.priority).toBe(-1)
      expect(ours?.component).toBe(component)
      expect(ours?.locale).toBe('serverSidebar')
    }
    // ui-chat registers its rows at the default priority 0, in either order
    // relative to these; each key's winner stays this package's row, and the
    // running row's key keeps ui-chat's own.
    const disposeOwners = replaced.map(({ key }) => ctx.slots.register({ name: 'conversation.chat.node', key }, () => null))
    const disposeRunning = ctx.slots.register({ name: 'conversation.chat.node', key: 'compaction-running' }, () => null)
    const winners = ctx.slots.entriesOfSlot('conversation.chat.node')
    for (const { key, component } of replaced) {
      expect(winners.filter(entry => entry.options.key === key).map(entry => entry.component)).toEqual([component])
    }
    expect(winners.filter(entry => entry.options.key === 'compaction-running').map(entry => entry.options.priority)).toEqual([undefined])
    for (const dispose of [...disposeOwners, disposeRunning]) dispose()
  })

  it('wires both fetched catalogs onto the injected face, pages first', async () => {
    const { ctx } = await bench()
    const { injected } = injectSidebar(ctx)
    expect(injected.navItems).toEqual(NAV_ITEMS)
  })

  it('degrades to the page catalog alone when component-surface is not composed', async () => {
    const { ctx } = await bench({ withoutComponentSurface: true })
    const { injected } = injectSidebar(ctx)
    expect(injected.navItems).toEqual([NAV_ITEMS[0]])
  })

  it('opens a page against the current session without creating a new one', async () => {
    const { ctx, remote } = await bench({ currentSessionId: 'session-a' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenNavItem({ kind: 'page', entryId: 'home' })
    expect(remote.commands.execute).toHaveBeenCalledWith('session-a', '/show-content-page home', [])
  })

  it('opens a view through the view command against the same session', async () => {
    const { ctx, remote } = await bench({ currentSessionId: 'session-a' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenNavItem({ kind: 'view', entryId: 'sales' })
    expect(remote.commands.execute).toHaveBeenCalledWith('session-a', '/show-content-view sales', [])
  })

  it('onOpenWorkbenchOnLoad reopens the recorded session directly when it is live, with no persist', async () => {
    const { ctx, uiWorkspace } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad('home-1', true)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('home-1')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbenchOnLoad creates a fresh workbench session and persists its id when there is none recorded', async () => {
    const { ctx, uiWorkspace } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbenchOnLoad(undefined, false)
    expect(uiWorkspace.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], groups: [], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbenchOnLoad leaves a workbench open with no session and no workspace to create one in', async () => {
    const { ctx, uiWorkspace } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad(undefined, false)
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) reopens the recorded session directly when it is live and still clean', async () => {
    const { ctx, uiWorkspace } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true, false)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('home-1')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) creates a fresh session when the recorded one is live but no longer clean', async () => {
    const { ctx, uiWorkspace } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbench('home-1', true, false, false)
    expect(uiWorkspace.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], groups: [], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbench (click) creates a fresh workbench session and persists its id when there is none recorded', async () => {
    const { ctx, uiWorkspace } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onOpenWorkbench(undefined, false, false, false)
    expect(uiWorkspace.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], groups: [], workbenchSessionId: 'new-session' })
  })

  it('onOpenWorkbench (click) leaves a workbench open with no session and no workspace to create one in', async () => {
    const { ctx, uiWorkspace } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkbench(undefined, false, false, false)
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) shows the configured home page on a reused clean draft that has not shown it yet', async () => {
    const { ctx, remote } = await bench({ homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true, false)
    expect(remote.commands.execute).toHaveBeenCalledWith('home-1', '/show-content-page home', [])
  })

  it('onOpenWorkbench (click) skips the repeat call on a reused clean draft that already shows the home page', async () => {
    const { ctx, remote } = await bench({ homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true, true)
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('onOpenWorkbench (click) shows the configured home view when that is what the deployment configured', async () => {
    const { ctx, remote } = await bench({ homeView: 'sales' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true, false)
    expect(remote.commands.execute).toHaveBeenCalledWith('home-1', '/show-content-view sales', [])
  })

  it('onOpenWorkbench (click) shows the configured home page on a freshly created session, ignoring homeAlreadyShown', async () => {
    const { ctx, remote } = await bench({ recentWorkspaceId: 'workspace-1', homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    // `homeAlreadyShown` describes the DISPLACED session, not the fresh
    // one — a create outcome must show the home page regardless of its value.
    await injected.onOpenWorkbench(undefined, false, false, true)
    expect(remote.commands.execute).toHaveBeenCalledWith('new-session', '/show-content-page home', [])
  })

  it('onOpenWorkbench (click) shows nothing extra when no home page is configured', async () => {
    const { ctx, remote } = await bench()
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbench('home-1', true, true, false)
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('onOpenWorkbenchOnLoad never shows the home page — load-time continuity leaves an already-open session untouched', async () => {
    const { ctx, remote } = await bench({ homePage: 'home' })
    const { injected } = injectSidebar(ctx)
    await injected.onOpenWorkbenchOnLoad('home-1', true)
    expect(remote.commands.execute).not.toHaveBeenCalled()
  })

  it('opens a live workflow directly, with no replay and no persist', async () => {
    const { ctx, uiWorkspace, remote } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenWorkflow(WORKFLOW, true)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session-a')
    expect(remote.commands.execute).not.toHaveBeenCalled()
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('degrades a stale workflow: creates a fresh session, replays its snapshot, and repoints homeSessionId', async () => {
    const { ctx, uiWorkspace, remote } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }] } } })
    await injected.onOpenWorkflow(WORKFLOW, false)
    expect(uiWorkspace.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(remote.commands.execute).toHaveBeenNthCalledWith(1, 'new-session', '/show-content-page home', [])
    expect(remote.commands.execute).toHaveBeenNthCalledWith(2, 'new-session', '/show-content-view sales', [])
    expect(actions.setServerMenu).toHaveBeenCalledWith(
      { workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }], groups: [], workbenchSessionId: undefined },
    )
  })

  it('persists the given workflow list wholesale on save', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    const next = [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }]
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: next } } })
    await injected.onSaveMenu({ workflows: next })
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: next, groups: [], workbenchSessionId: undefined })
  })

  it('surfaces a failed save through setError rather than throwing', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { ok: false, body: {} } })
    await injected.onSaveMenu({ workflows: [] })
    expect(actions.setError).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('stringifies a non-Error transport rejection rather than losing it', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject('transport exploded')))
    await injected.onSaveMenu({ workflows: [] })
    expect(actions.setError).toHaveBeenCalledWith('transport exploded')
  })

  it('sends a groups-only patch without resending the workflow list', async () => {
    const { ctx } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    const groups = [{ id: 'g1', name: 'Reports', pinned: false, order: 0 }]
    let posted: unknown
    vi.stubGlobal('fetch', vi.fn((input: URL, init?: RequestInit) => {
      expect(input.pathname).toBe(SERVER_MENU_ROUTE)
      if (init?.method === 'POST') posted = JSON.parse(init.body as string)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [WORKFLOW], groups }) })
    }))
    await injected.onSaveMenu({ groups })
    expect(posted).toEqual({ groups })
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW], groups, workbenchSessionId: undefined })
  })

  it('opens one temporary conversation by selecting it, with no persist', async () => {
    const { ctx, uiWorkspace } = await bench()
    const { injected, actions } = injectSidebar(ctx)
    await injected.onOpenTemporary('session-loose')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session-loose')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('takes one temporary conversation off the list by archiving it, never deleting it', async () => {
    const { ctx, uiWorkspace, workspaces } = await bench({ currentSessionId: 'session-a' })
    const { injected, actions } = injectSidebar(ctx)
    await injected.onDismissTemporary('session-loose', 'home-1', true)
    expect(workspaces.archiveSession).toHaveBeenCalledWith('session-loose')
    expect(actions.setError).not.toHaveBeenCalled()
    expect(actions.setTemporaryFailed).toHaveBeenCalledWith(false)
    // A row that was not the one on screen leaves the selection alone.
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()
  })

  it('lands on the recorded workbench when the archived conversation was the one on screen', async () => {
    const { ctx, uiWorkspace } = await bench({ currentSessionId: 'session-loose', liveSessionIds: ['home-1'] })
    const { injected, actions } = injectSidebar(ctx)
    await injected.onDismissTemporary('session-loose', 'home-1', true)
    // Reopened, not re-created: the recorded workbench is still live, so
    // nothing is written back to the document.
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('home-1')
    expect(actions.setServerMenu).not.toHaveBeenCalled()
  })

  it('creates a workbench conversation and records it when the archived one on screen left none live', async () => {
    const { ctx, uiWorkspace } = await bench({
      currentSessionId: 'session-loose', recentWorkspaceId: 'workspace-1',
    })
    const { injected, actions } = injectSidebar(ctx)
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW], workbenchSessionId: 'new-session' } } })
    await injected.onDismissTemporary('session-loose', undefined, false)
    expect(uiWorkspace.connectWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(actions.setServerMenu).toHaveBeenCalledWith(
      { workflows: [WORKFLOW], groups: [], workbenchSessionId: 'new-session' },
    )
  })

  it('reports a failed archive as a flag and keeps its host wording out of the section', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, uiWorkspace, workspaces } = await bench({ currentSessionId: 'session-loose' })
    const { injected, actions } = injectSidebar(ctx)
    const refusal = new Error('session archive failed: session-not-found: no session session-loose')
    workspaces.archiveSession.mockRejectedValueOnce(refusal)
    await injected.onDismissTemporary('session-loose', 'home-1', true)
    expect(actions.setTemporaryFailed).toHaveBeenCalledWith(true)
    // Not through the workflow section's own line, which says "save failed".
    expect(actions.setError).not.toHaveBeenCalled()
    // The refusal's own wording is the host's, so it goes to the console and
    // nothing about it reaches the store the section renders from.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('server-sidebar:'), refusal)
    expect(actions.setTemporaryFailed.mock.calls.flat().join(' ')).not.toMatch(/\bsession\b/i)
    // A refused archive leaves the conversation open rather than landing away from it.
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('leaves other workflows untouched while repointing only the degraded one', async () => {
    const other = { ...WORKFLOW, id: 'w2', name: 'Other', order: 1, homeSessionId: 'session-c' }
    const { ctx, uiWorkspace } = await bench({ recentWorkspaceId: 'workspace-1' })
    const { injected, actions } = injectSidebar(ctx)
    let posted: unknown
    vi.stubGlobal('fetch', vi.fn((input: URL, init?: RequestInit) => {
      expect(input.pathname).toBe(SERVER_MENU_ROUTE)
      if (init?.method === 'POST') posted = JSON.parse(init.body as string)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [WORKFLOW, other] }) })
    }))
    await injected.onOpenWorkflow(WORKFLOW, false)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('new-session')
    expect(posted).toEqual({ workflows: [{ ...WORKFLOW, homeSessionId: 'new-session' }, other] })
    expect(actions.setServerMenu).toHaveBeenCalledWith({ workflows: [WORKFLOW, other], groups: [], workbenchSessionId: undefined })
  })

  it('seeds the footer\'s name from the claim the identity route named', async () => {
    localStorage.setItem('accessToken', `Bearer ${jwt('Signed-in Person')}`)
    const { ctx } = await bench()
    const { injected } = injectSidebar(ctx)
    expect(injected.hooks.displayName.getSnapshot()).toBe('Signed-in Person')
  })

  it('leaves the footer anonymous when the identity route answers nothing usable', async () => {
    localStorage.setItem('accessToken', `Bearer ${jwt('Signed-in Person')}`)
    const { ctx } = await bench({ withoutIdentity: true })
    const { injected } = injectSidebar(ctx)
    expect(injected.hooks.displayName.getSnapshot()).toBeUndefined()
  })

  it('signs the visitor out: stops the open conversation, drops the held token, and clears the stored keys', async () => {
    localStorage.setItem('accessToken', `Bearer ${jwt('Signed-in Person')}`)
    localStorage.setItem('userInfo', '{}')
    localStorage.setItem('someOtherApp.session', 'kept')
    const { ctx, cancel } = await bench({ currentSessionId: 'session-a' })
    const { injected } = injectSidebar(ctx)
    injected.onSignOut()
    await vi.waitFor(() => {
      expect(localStorage.getItem('accessToken')).toBeNull()
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      new URL(AUTH_GATE_LOGOUT_ROUTE, location.href), expect.objectContaining({ method: 'POST', keepalive: true }),
    )
    expect(localStorage.getItem('userInfo')).toBeNull()
    expect(localStorage.getItem('someOtherApp.session')).toBe('kept')
  })

  it('reports a sign-out it cannot perform rather than sending the visitor nowhere', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, cancel } = await bench({ withoutAuthGate: true })
    const { injected } = injectSidebar(ctx)
    injected.onSignOut()
    expect(cancel).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('server-sidebar: cannot sign out, the login page and mirror cookie are unknown')
    warn.mockRestore()
  })

  it('removes the sidebar entry and child declarations on teardown (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    await fiber.dispose()
    expect(ctx.slots.entries('sidebar')).toHaveLength(0)
    expect(ctx.slots.spec('sidebar.brand.mark')).toBeUndefined()
    expect(ctx.slots.spec('sidebar.footer.action')).toBeUndefined()
    expect(ctx.slots.entries('conversation.hero.brand.mark')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
    expect(ctx.slots.entries('settings.general.item')).toHaveLength(0)
    expect(ctx.slots.entries('settings.action')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(0)
  })
})

describe('server-sidebar browser half: untitled-conversation title', () => {
  it('registers ahead of every shipped header action, in this package\'s locale', async () => {
    const { ctx } = await bench()
    const entry = headerAction(ctx, 'untitled-title')
    expect(entry?.component).toBe(UntitledTitle)
    expect(entry?.options.order).toBe(-100)
    expect(entry?.locale).toBe('serverSidebar')
    // The lowest shipped order in this list is the subagent catalog's -30.
    const [first] = ctx.slots.entriesOfSlot('conversation.session.header.actions')
    expect(first?.options.id).toBe('untitled-title')
  })
})

describe('server-sidebar browser half: save-workflow header action', () => {
  it('registers into conversation.session.header.actions with the given id and order', async () => {
    const { ctx } = await bench()
    const entry = headerAction(ctx, 'save-workflow')
    expect(entry?.component).toBe(SaveWorkflowAction)
    expect(entry?.options.id).toBe('save-workflow')
    expect(entry?.options.order).toBe(30)
    expect(entry?.locale).toBe('serverSidebar')
  })

  it('saves a new workflow and pushes the server\'s answer into the mounted sidebar\'s own store', async () => {
    const { ctx } = await bench()
    const { actions } = injectSidebar(ctx)
    const saved = {
      workflows: [
        WORKFLOW,
        { id: 'w2', name: 'New Flow', order: 1, homeSessionId: 'session-b', navSnapshot: NAV_SNAPSHOT, savedAt: 2 },
      ],
    }
    stubFetch({ [SERVER_MENU_ROUTE]: { body: saved } })
    const headerInjected = injectHeaderAction(ctx, 'session-b')
    await headerInjected.onSave('session-b', 'New Flow', NAV_SNAPSHOT)
    expect(actions.setServerMenu).toHaveBeenCalledWith({ ...saved, groups: [], workbenchSessionId: undefined })
  })

  it('still persists a new workflow when the sidebar has not been read yet (defensive path)', async () => {
    const { ctx } = await bench()
    // Read the header action's inject factory WITHOUT reading the sidebar's
    // own first, so `sidebarActions` inside client/index.ts's closure is
    // still unset for this call.
    stubFetch({ [SERVER_MENU_ROUTE]: { body: { workflows: [WORKFLOW] } } })
    const headerInjected = injectHeaderAction(ctx, 'session-a')
    await expect(headerInjected.onSave('session-a', 'Alpha', NAV_SNAPSHOT)).resolves.toBeUndefined()
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
    await headerInjected.onSave('session-a', 'Alpha', NAV_SNAPSHOT)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to save workflow (sidebar not mounted)'), expect.any(Error),
    )
    warn.mockRestore()
  })
})

describe('server-sidebar browser half: the deployment\'s automatic home', () => {
  it('refuses at load when both packages configure one', async () => {
    stubFetch({
      [CONTENT_FRAME_SETTINGS_ROUTE]: { body: { pages: CONTENT_FRAME_PAGES, homePage: 'home' } },
      [COMPONENT_SURFACE_VIEWS_ROUTE]: { body: { views: COMPONENT_SURFACE_VIEWS, homeView: 'sales' } },
      [SERVER_MENU_ROUTE]: { body: { workflows: [] } },
      [SERVER_IDENTITY_ROUTE]: { body: { displayNameClaim: 'login_uname' } },
      [AUTH_GATE_SETTINGS_ROUTE]: { body: { loginUrl: '#/toy-login', cookieName: 'accessToken' } },
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareSlots(ctx)
    ctx.provide('locale', { register: () => () => {}, bind: () => () => '' } as never)
    // The plugin body itself, not a fiber: a rejecting apply is what fails the
    // row, and the fiber only reports it (the same shape auth-gate's own
    // load-time refusals are asserted in).
    await expect(apply(ctx)).rejects.toThrow(/one automatic home, not both/)
  })
})

describe('server-sidebar browser half: dictionaries', () => {
  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    stubFetch({
      [CONTENT_FRAME_SETTINGS_ROUTE]: { body: { cacheSize: 1, pages: CONTENT_FRAME_PAGES } },
      [COMPONENT_SURFACE_VIEWS_ROUTE]: { body: { views: COMPONENT_SURFACE_VIEWS } },
      [SERVER_MENU_ROUTE]: { body: { workflows: [] } },
      [SERVER_IDENTITY_ROUTE]: { body: { displayNameClaim: 'login_uname' } },
      [AUTH_GATE_SETTINGS_ROUTE]: { body: { loginUrl: '#/toy-login', cookieName: 'accessToken' } },
    })
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    declareSlots(ctx)
    ctx.provide('workspaces', { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [], items: [] }) } } as never)
    ctx.provide('uiWorkspace', { connectWorkspace: vi.fn() } as never)
    ctx.provide('sessions', { open: vi.fn(), list: { getSnapshot: () => ({ current: undefined }) } } as never)
    ctx.provide('remote', { commands: { execute: vi.fn() }, $on: () => () => {} } as never)
    ctx.provide('remote.commands', { execute: vi.fn() } as never)
    // The locale plugin binds a settings scope, which reads the connection
    // handle and the forwarded-event port.
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    ctx.provide('configForms', { developerTools: { enabled: createSnapshotStore(true) }, get: () => stubConfigForm().scope } as never)
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

  // The e2e scenario screens what the page renders; this screens the source
  // every one of those strings comes from, including the copy no ordinary
  // run puts on screen (a refused archive, an empty group).
  it('carries none of the banned vocabulary in any string either dictionary adds', () => {
    for (const [locale, dictionary] of Object.entries({ zh, en })) {
      for (const [key, copy] of Object.entries<string>(dictionary)) {
        for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /会话/, /工作区/]) {
          expect(copy, `${locale}.${key} matched ${String(banned)}`).not.toMatch(banned)
        }
      }
    }
  })
})
