// @vitest-environment jsdom
/**
 * `ServerSidebarRoot`'s three-section console: the brand row, the workbench
 * entry (decision ①'s auto-open-on-load, the clean-draft click path — both
 * the blank bit and the content-surface check — and the active highlight),
 * the navigation and workflow groups it seats, and the footer avatar row.
 * Pointer-driven scrollbar behavior is `pointer-scrollbars.client.spec.tsx`'s
 * own concern, ported unchanged from the original shell and not re-asserted
 * here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ServerSidebarRoot, type ServerSidebarRootComponentProps } from '../src/client/ServerSidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import type { NavSnapshotItem, ServerMenuGroup, ServerMenuPatch, ServerMenuWorkflow } from '../src/client/workflow-api.ts'
import { TEMPORARY_GROUP_ID } from '../src/menu-constants.ts'

const t: ServerSidebarRootComponentProps['t'] = (key, vars?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = vars[name]
      return typeof value === 'string' ? value : ''
    })
}

const NAV_ITEMS = [
  { kind: 'page', entryId: 'home', title: 'Home' },
  { kind: 'view', entryId: 'sales', title: 'Sales' },
] as const

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

/** No Session has a pending interaction in these fixtures. */
const noPendingInteraction: ServerSidebarRootComponentProps['useSessionPendingInteraction'] =
  selector => selector(new Map())

/** One session row as this bench authors it; `mount` fills the fields every row really carries. */
interface BenchSession {
  displayTitle: string
  /** The durable title, which is the only one the temporary section draws. */
  title?: string
  completed?: boolean
  blank?: boolean
  origin?: 'subagent'
  updatedAt?: number
  projectionValues?: unknown
}

interface Bench {
  workflows: ServerMenuWorkflow[]
  groups: ServerMenuGroup[]
  workbenchSessionId: string | undefined
  workflowsError: string | undefined
  /** Whether the last 移出列表 was refused, which the temporary section reports itself. */
  temporaryFailed: boolean
  view: { collapsed: Record<string, boolean>; temporaryExpanded: boolean }
  current: string | undefined
  byId: Record<string, BenchSession>
  /** The session directory's order; defaults to whatever `byId` holds. */
  ids?: string[]
  archivedSessionIds: string[]
  phase: 'pending' | 'ready'
  /**
   * Defaults to an available Workspace, so pre-existing scenarios keep
   * auto-opening immediately (see workbenchIsLive/hasWorkspace gating).
   */
  hasWorkspace: boolean
  /** What the identity source currently answers; absent is the anonymous footer. */
  displayName: string | undefined
  /** The deployment's configured automatic home, or `undefined` when none is configured. */
  home: NavSnapshotItem | undefined
}

function mount(overrides: Partial<Bench> = {}) {
  const onOpenNavItem = vi.fn(() => Promise.resolve())
  const onOpenWorkbenchOnLoad = vi.fn(() => Promise.resolve())
  const onOpenWorkbench = vi.fn(() => Promise.resolve())
  const onOpenWorkflow = vi.fn(() => Promise.resolve())
  const onSaveMenu = vi.fn((_patch: ServerMenuPatch) => Promise.resolve())
  const onOpenTemporary = vi.fn(() => Promise.resolve())
  const onDismissTemporary = vi.fn(() => Promise.resolve())
  const setGroupCollapsed = vi.fn()
  const setTemporaryExpanded = vi.fn()
  const onSignOut = vi.fn()
  const renderSlot = vi.fn((
    key: string,
    _owner: unknown,
    options?: { fallback?: ReactNode },
  ) => options?.fallback ?? <div data-testid={key} />)
  let current: Bench = {
    workflows: [],
    groups: [],
    workbenchSessionId: undefined,
    workflowsError: undefined,
    temporaryFailed: false,
    view: { collapsed: {}, temporaryExpanded: false },
    current: undefined,
    byId: {},
    archivedSessionIds: [],
    phase: 'ready',
    hasWorkspace: true,
    displayName: undefined,
    home: undefined,
    ...overrides,
  }
  const root = () => (
    <ServerSidebarRoot
      collapsed={false} width={240}
      t={t}
      navItems={NAV_ITEMS} onOpenNavItem={onOpenNavItem}
      {...current.home === undefined ? {} : { home: current.home }}
      onOpenWorkbenchOnLoad={onOpenWorkbenchOnLoad}
      onOpenWorkbench={onOpenWorkbench}
      onOpenWorkflow={onOpenWorkflow} onSaveMenu={onSaveMenu}
      onOpenTemporary={onOpenTemporary} onDismissTemporary={onDismissTemporary} onSignOut={onSignOut}
      useDisplayName={<S,>(sel: (name: string | undefined) => S): S => sel(current.displayName)}
      useStore={(<S,>(sel: (s: {
        workflows: ServerMenuWorkflow[]
        groups: ServerMenuGroup[]
        workbenchSessionId: string | undefined
        error: string | undefined
        temporaryFailed: boolean
        view: Bench['view']
      }) => S): S => sel({
        workflows: current.workflows,
        groups: current.groups,
        workbenchSessionId: current.workbenchSessionId,
        error: current.workflowsError,
        temporaryFailed: current.temporaryFailed,
        view: current.view,
      }))}
      actions={{
        setServerMenu: vi.fn(), setError: vi.fn(), setTemporaryFailed: vi.fn(),
        setGroupCollapsed, setTemporaryExpanded,
      }}
      useSessions={((<S,>(sel: (s: {
        ids: string[]
        byId: Record<string, BenchSession & { blank: boolean; updatedAt: number }>
        current: string | undefined
        phase: 'pending' | 'ready'
      }) => S): S => sel({
        ids: current.ids ?? Object.keys(current.byId),
        byId: Object.fromEntries(Object.entries(current.byId)
          .map(([id, session]) => [id, { blank: false, updatedAt: 0, ...session }])),
        current: current.current,
        phase: current.phase,
      })) as unknown) as ServerSidebarRootComponentProps['useSessions']}
      useWorkspaces={((<S,>(sel: (s: {
        phase: 'pending' | 'ready'
        items: readonly object[]
        archivedSessionIds: readonly string[]
      }) => S): S => (
        sel({
          phase: 'ready',
          items: current.hasWorkspace ? [{}] : [],
          archivedSessionIds: current.archivedSessionIds,
        })
      )) as unknown) as ServerSidebarRootComponentProps['useWorkspaces']}
      useSessionPendingInteraction={noPendingInteraction}
      renderSlot={renderSlot}
    />
  )
  const view = render(root())
  return {
    onOpenNavItem,
    onOpenWorkbenchOnLoad,
    onOpenWorkbench,
    onOpenWorkflow,
    onSaveMenu,
    onOpenTemporary,
    onDismissTemporary,
    setGroupCollapsed,
    setTemporaryExpanded,
    onSignOut,
    renderSlot,
    rerender(next: Partial<Bench>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('ServerSidebarRoot', () => {
  it('shows the workbench-assistant brand fallback, with no commit hash regardless of the environment', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    mount()
    expect(screen.getByText(en['brand.name.fallback'])).toBeTruthy()
    expect(screen.queryByText('0123456')).toBeNull()
    expect(screen.queryByText('DSH Local Build')).toBeNull()
  })

  it('renders no brand-mark fallback (the slot takeover leaves it empty)', () => {
    mount()
    expect(screen.getByTestId('sidebar.brand.mark').firstChild).toBeNull()
  })

  describe('footer identity', () => {
    it('names the signed-in person when the token carries a name', () => {
      mount({ displayName: 'Signed-in Person' })
      expect(screen.getByText('Signed-in Person')).toBeTruthy()
      expect(screen.queryByText(en['avatar.namePlaceholder'])).toBeNull()
    })

    it('keeps the anonymous placeholder when there is no name to show', () => {
      mount()
      expect(screen.getByText(en['avatar.namePlaceholder'])).toBeTruthy()
    })

    it('follows the identity source when the name moves under a mounted shell', () => {
      const b = mount({ displayName: 'Signed-in Person' })
      b.rerender({ displayName: 'The Other Person' })
      expect(screen.getByText('The Other Person')).toBeTruthy()
    })

    it('hands a sign-out click to the injected action', () => {
      const b = mount()
      fireEvent.click(screen.getByRole('button', { name: en['signOut.action'] }))
      expect(b.onSignOut).toHaveBeenCalledTimes(1)
    })
  })

  describe('workbench click: clean-draft semantics', () => {
    it('reopens the recorded session directly when it is live, blank, and carries no content-surface entries', () => {
      const b = mount({
        workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home', blank: true } }, current: 'home-1',
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, true, false)
    })

    it('creates a fresh session when the recorded session is live but no longer blank', () => {
      const b = mount({
        workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home', blank: false } }, current: 'home-1',
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, false, false)
    })

    it('reports the recorded workbench id as not live (and not clean) once its session leaves the list', () => {
      const b = mount({ workbenchSessionId: 'home-1', byId: {}, current: 'other' })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', false, false, false)
    })

    it('reopens the recorded session when its only content-surface entry is the configured home page', () => {
      const b = mount({
        workbenchSessionId: 'home-1',
        byId: {
          'home-1': {
            displayTitle: 'Home',
            blank: true,
            projectionValues: { contentSurface: { entries: [{ kind: 'page', entryId: 'home' }] } },
          },
        },
        current: 'home-1',
        home: { kind: 'page', entryId: 'home' },
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      // Both the reuse decision (isClean) and the auto-open dedup hint
      // (homeAlreadyShown) read true: the draft is clean, and it already
      // shows the one entry it is allowed to carry.
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, true, true)
    })

    it('reports a blank draft carrying a content-surface entry beyond the configured home page as not clean', () => {
      const b = mount({
        workbenchSessionId: 'home-1',
        byId: {
          'home-1': {
            displayTitle: 'Home',
            blank: true,
            projectionValues: { contentSurface: { entries: [{ kind: 'page', entryId: 'reports' }] } },
          },
        },
        current: 'home-1',
        home: { kind: 'page', entryId: 'home' },
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, false, false)
    })

    it('treats a session with no projectionValues at all as carrying no content-surface entries, falling back to the blank bit alone', () => {
      const b = mount({
        workbenchSessionId: 'home-1',
        byId: { 'home-1': { displayTitle: 'Home', blank: true } },
        current: 'home-1',
        home: { kind: 'page', entryId: 'home' },
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, true, false)
    })
  })

  describe('workbench auto-open on load: continuity semantics', () => {
    it('auto-opens the workbench once the session list settles with no current session', () => {
      const b = mount({ phase: 'pending', current: undefined })
      expect(b.onOpenWorkbenchOnLoad).not.toHaveBeenCalled()
      b.rerender({ phase: 'ready' })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledTimes(1)
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith(undefined, false)
    })

    it('auto-opens with the recorded id and its liveness when one is already recorded, regardless of content', () => {
      const b = mount({
        phase: 'pending',
        current: undefined,
        workbenchSessionId: 'home-1',
        byId: { 'home-1': { displayTitle: 'Home', blank: false } },
      })
      b.rerender({ phase: 'ready' })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith('home-1', true)
    })

    it('does not auto-open the workbench when a session is already current', () => {
      const b = mount({ phase: 'ready', current: 'session-a' })
      expect(b.onOpenWorkbenchOnLoad).not.toHaveBeenCalled()
    })

    it('does not repeat the auto-open attempt on a later, unrelated re-render', () => {
      const b = mount({ phase: 'ready', current: undefined })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledTimes(1)
      b.rerender({ workflows: [] })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledTimes(1)
    })

    it('opens a live recorded session with no Workspace available at all', () => {
      const b = mount({
        phase: 'ready',
        current: undefined,
        workbenchSessionId: 'home-1',
        byId: { 'home-1': { displayTitle: 'Home' } },
        hasWorkspace: false,
      })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith('home-1', true)
    })

    it('withholds the attempt while no live session and no Workspace are available, firing once one appears', () => {
      const b = mount({ phase: 'ready', current: undefined, hasWorkspace: false })
      expect(b.onOpenWorkbenchOnLoad).not.toHaveBeenCalled()
      b.rerender({ hasWorkspace: true })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledTimes(1)
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith(undefined, false)
    })

    it('never fires once current gets a value, even if a Workspace later appears', () => {
      const b = mount({ phase: 'ready', current: undefined, hasWorkspace: false })
      b.rerender({ current: 'elsewhere' })
      b.rerender({ hasWorkspace: true })
      expect(b.onOpenWorkbenchOnLoad).not.toHaveBeenCalled()
    })
  })

  describe('selection highlight', () => {
    it('marks the workbench active when it is the current session and no workflow binds it', () => {
      mount({ workbenchSessionId: 'home-1', current: 'home-1' })
      expect(screen.getByRole('button', { name: en['workbench.label'] }).getAttribute('data-active')).toBe('true')
    })

    it('does not mark the workbench active when it is not the current session', () => {
      mount({ workbenchSessionId: 'home-1', current: 'other' })
      expect(screen.getByRole('button', { name: en['workbench.label'] }).getAttribute('data-active')).toBe('false')
    })

    it('yields the highlight to a workflow that already binds the current session', () => {
      const workflow: ServerMenuWorkflow = { id: 'w1', name: 'My Flow', order: 0, homeSessionId: 'home-1', navSnapshot: [], savedAt: 1 }
      mount({ workbenchSessionId: 'home-1', current: 'home-1', workflows: [workflow] })
      expect(screen.getByRole('button', { name: en['workbench.label'] }).getAttribute('data-active')).toBe('false')
      expect(screen.getByRole('button', { name: 'My Flow' }).getAttribute('data-active')).toBe('true')
    })
  })

  it('lists both navigation catalogs and opens a page on click', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(b.onOpenNavItem).toHaveBeenCalledWith({ kind: 'page', entryId: 'home' })
  })

  it('opens a view on click through the same menu', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Sales' }))
    expect(b.onOpenNavItem).toHaveBeenCalledWith({ kind: 'view', entryId: 'sales' })
  })

  it('recognizes a configured home view already shown as a component entry', () => {
    const b = mount({
      workbenchSessionId: 'home-1',
      byId: {
        'home-1': {
          displayTitle: 'Home',
          blank: true,
          projectionValues: { contentSurface: { entries: [{ kind: 'component', entryId: 'sales' }] } },
        },
      },
      current: 'home-1',
      home: { kind: 'view', entryId: 'sales' },
    })
    fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
    expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, true, true)
  })

  it('opens a workflow with its bound session\'s liveness', () => {
    const workflow: ServerMenuWorkflow = { id: 'w1', name: 'My Flow', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }
    const b = mount({ workflows: [workflow], byId: { s1: { displayTitle: 'S1' } }, current: 'other', phase: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'My Flow' }))
    expect(b.onOpenWorkflow).toHaveBeenCalledWith(workflow, true)
  })

  it('reports a workflow bound to a deleted session as not live', () => {
    const workflow: ServerMenuWorkflow = { id: 'w1', name: 'My Flow', order: 0, homeSessionId: 'gone', navSnapshot: [], savedAt: 1 }
    const b = mount({ workflows: [workflow], byId: {}, current: 'other', phase: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'My Flow' }))
    expect(b.onOpenWorkflow).toHaveBeenCalledWith(workflow, false)
  })

  it('marks a workflow unread only when its bound session has completed', () => {
    const workflow: ServerMenuWorkflow = { id: 'w1', name: 'My Flow', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1 }
    mount({ workflows: [workflow], byId: { s1: { displayTitle: 'S1', completed: true } }, current: 'other', phase: 'ready' })
    const row = screen.getByRole('button', { name: /My Flow/ })
    expect(row.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('surfaces a pending workflow-save error inline', () => {
    mount({ workflowsError: 'HTTP 503' })
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
  })

  it('reports a failed 移出列表 in the temporary section itself, in its own words', () => {
    mount({ temporaryFailed: true })
    const alert = screen.getByRole('alert')
    expect(alert.closest('[data-server-sidebar-section="temporary"]')).not.toBeNull()
    expect(alert.textContent).toBe(en['temporary.error'])
  })

  it('renders the avatar placeholder and the footer.action/settings seats', () => {
    mount()
    expect(screen.getByText(en['avatar.namePlaceholder'])).toBeTruthy()
    expect(screen.getByTestId('sidebar.footer.action')).toBeTruthy()
    expect(screen.getByTestId('sidebar.settings')).toBeTruthy()
  })

  it('merges the avatar identity and the settings seat into one row, name first', () => {
    mount()
    const identityRow = document.querySelector('[data-server-sidebar-section="identity"]')
    const children = identityRow === null ? [] : [...identityRow.children]
    expect(children).toHaveLength(2)
    // Left-to-right DOM order backs the row's `space-between` layout: name on
    // the left, the settings seat on the right.
    expect(children[0]?.contains(screen.getByText(en['avatar.namePlaceholder']))).toBe(true)
    expect(children[1]?.contains(screen.getByTestId('sidebar.settings'))).toBe(true)
  })

  it('asks the settings seat for its compact form, and the footer action row for its wide one', () => {
    const b = mount()
    // The identity band is one row at a column width that is a share of the
    // frame; the labeled trigger does not fit beside the name and the
    // sign-out label there (see `.identityRow` in the stylesheet).
    expect(b.renderSlot).toHaveBeenCalledWith('sidebar.settings', { wide: false })
    expect(b.renderSlot).not.toHaveBeenCalledWith('sidebar.settings', { wide: true })
    // The row above it owns its full width, so its occupants keep the labels.
    expect(b.renderSlot).toHaveBeenCalledWith('sidebar.footer.action', { wide: true })
  })
  describe('groups', () => {
    it('seats the stored groups under 我的工作流, pinned first', () => {
      mount({
        groups: [
          { id: 'g2', name: 'Later Group', pinned: false, order: 1 },
          { id: 'g1', name: 'Pinned Group', pinned: true, order: 5 },
        ],
      })
      const section = document.querySelector('[data-server-sidebar-section="workflows"]')
      const names = [...(section?.querySelectorAll('span') ?? [])]
        .map(node => node.textContent)
        .filter(text => text === 'Pinned Group' || text === 'Later Group')
      expect(names).toEqual(['Pinned Group', 'Later Group'])
    })

    it('mints a stable id for a group created from the section header', () => {
      const b = mount()
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reports' } })
      fireEvent.blur(screen.getByRole('textbox'))
      const created = b.onSaveMenu.mock.calls[0]?.[0].groups?.[0]
      expect(created?.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(created).toMatchObject({ name: 'Reports', pinned: false, order: 0 })
    })

    it('routes a group fold to the store action that remembers it', () => {
      const b = mount({ groups: [{ id: 'g1', name: 'Reports', pinned: false, order: 0 }] })
      fireEvent.click(screen.getAllByRole('button', { name: en['groups.collapse'] })[0]!)
      expect(b.setGroupCollapsed).toHaveBeenCalledWith('g1', true)
    })

    it('folds a group shut when the remembered view says so', () => {
      mount({
        groups: [{ id: 'g1', name: 'Reports', pinned: false, order: 0 }],
        view: { collapsed: { g1: true }, temporaryExpanded: false },
      })
      expect(screen.queryByText(en['groups.empty'])).toBeNull()
    })
  })

  describe('临时工作流', () => {
    const chat = (id: string, overrides: Partial<BenchSession> = {}): [string, BenchSession] => (
      [id, { displayTitle: id, title: `Chat ${id}`, updatedAt: 10, ...overrides }]
    )

    it('lists the conversations no other row already shows, most recent first', () => {
      mount({
        byId: Object.fromEntries([chat('a', { updatedAt: 1 }), chat('b', { updatedAt: 2 })]),
        current: 'b',
      })
      const section = document.querySelector('[data-server-sidebar-section="temporary"]')
      const rows = [...(section?.querySelectorAll('li') ?? [])]
      expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['Chat b', 'Chat a'])
    })

    it('leaves out a bound, workbench, subagent, archived or unselected blank conversation', () => {
      mount({
        workflows: [{
          id: 'w1', name: 'Bound', order: 0, homeSessionId: 'bound', navSnapshot: [], savedAt: 1,
        }],
        workbenchSessionId: 'bench',
        archivedSessionIds: ['gone'],
        byId: Object.fromEntries([
          chat('bound'), chat('bench'), chat('gone'),
          chat('child', { origin: 'subagent' }),
          chat('draft', { blank: true }),
          chat('kept'),
        ]),
      })
      const section = document.querySelector('[data-server-sidebar-section="temporary"]')
      expect([...(section?.querySelectorAll('li') ?? [])].map(row => row.querySelector('span')?.textContent))
        .toEqual(['Chat kept'])
    })

    it('keeps the blank draft that is on screen right now', () => {
      mount({ byId: Object.fromEntries([chat('draft', { blank: true })]), current: 'draft' })
      expect(screen.getByRole('button', { name: /Chat draft/ }).getAttribute('data-active')).toBe('true')
    })

    it('skips an id the row map does not carry', () => {
      mount({ ids: ['missing', 'kept'], byId: Object.fromEntries([chat('kept')]) })
      const section = document.querySelector('[data-server-sidebar-section="temporary"]')
      expect([...(section?.querySelectorAll('li') ?? [])]).toHaveLength(1)
    })

    it('shows fixed copy for a conversation with no durable title, never its display fallback', () => {
      mount({ byId: { s1: { displayTitle: '/srv/reports', updatedAt: 1 } } })
      expect(screen.getByRole('button', { name: new RegExp(en['temporary.untitled']) })).toBeTruthy()
      expect(screen.queryByText('/srv/reports')).toBeNull()
    })

    it('trims a padded durable title and treats a blank one as none', () => {
      mount({ byId: { s1: { displayTitle: 'x', title: '  Padded  ', updatedAt: 2 }, s2: { displayTitle: 'y', title: '   ', updatedAt: 1 } } })
      expect(screen.getByText('Padded')).toBeTruthy()
      expect(screen.getByText(en['temporary.untitled'])).toBeTruthy()
    })

    it('marks a conversation that finished unseen', () => {
      mount({ byId: { s1: { displayTitle: 'x', title: 'Chat', updatedAt: 1, completed: true } } })
      expect(screen.getByRole('button', { name: /Chat/ }).querySelector('[aria-hidden="true"]')).not.toBeNull()
    })

    it('opens one on click and archives one through its own injected action', () => {
      const b = mount({
        byId: { s1: { displayTitle: 'x', title: 'Chat', updatedAt: 1 }, 'home-1': { displayTitle: 'y' } },
        workbenchSessionId: 'home-1',
      })
      fireEvent.click(screen.getByRole('button', { name: /Chat/ }))
      expect(b.onOpenTemporary).toHaveBeenCalledWith('s1')
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismiss'] }))
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismissConfirm'] }))
      // The workbench facts travel with the click: archiving the conversation
      // on screen has to land somewhere, and this is where.
      expect(b.onDismissTemporary).toHaveBeenCalledWith('s1', 'home-1', true)
    })

    it('routes its own fold and its 显示更多 to the store actions that remember them', () => {
      const many = Object.fromEntries(
        Array.from({ length: 7 }, (_value, index) => chat(`s${String(index)}`, { updatedAt: index })),
      )
      const b = mount({ byId: many })
      const section = document.querySelector('[data-server-sidebar-section="temporary"]')
      expect([...(section?.querySelectorAll('li') ?? [])]).toHaveLength(5)
      fireEvent.click(screen.getByRole('button', { name: en['temporary.more'] }))
      expect(b.setTemporaryExpanded).toHaveBeenCalledWith(true)
      fireEvent.click(screen.getAllByRole('button', { name: en['groups.collapse'] }).at(-1)!)
      expect(b.setGroupCollapsed).toHaveBeenCalledWith(TEMPORARY_GROUP_ID, true)
    })

    it('shows every row once the remembered view says the rest was asked for', () => {
      mount({
        byId: Object.fromEntries(Array.from({ length: 7 }, (_value, index) => chat(`s${String(index)}`, { updatedAt: index }))),
        view: { collapsed: {}, temporaryExpanded: true },
      })
      const section = document.querySelector('[data-server-sidebar-section="temporary"]')
      expect([...(section?.querySelectorAll('li') ?? [])]).toHaveLength(7)
    })

    it('folds shut when the remembered view says so', () => {
      mount({
        byId: { s1: { displayTitle: 'x', title: 'Chat', updatedAt: 1 } },
        view: { collapsed: { [TEMPORARY_GROUP_ID]: true }, temporaryExpanded: false },
      })
      expect(screen.queryByRole('button', { name: /Chat/ })).toBeNull()
    })

    it('shows its own empty copy when nothing is temporary', () => {
      mount()
      expect(screen.getByText(en['temporary.empty'])).toBeTruthy()
    })
  })
})
