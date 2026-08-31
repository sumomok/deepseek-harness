// @vitest-environment jsdom
/**
 * `ServerSidebarRoot`'s three-section console: the brand row, the workbench
 * entry (decision ①'s auto-open-on-load, the blank-draft click path, and the
 * active highlight), the navigation and workflow groups it seats, and the
 * footer avatar row. Pointer-driven scrollbar behavior is
 * `pointer-scrollbars.client.spec.tsx`'s own concern, ported unchanged from
 * the original shell and not re-asserted here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ServerSidebarRoot, type ServerSidebarRootComponentProps } from '../src/client/ServerSidebarRoot.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerMenuWorkflow } from '../src/client/workflow-api.ts'

const t: ServerSidebarRootComponentProps['t'] = (key, vars?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = vars[name]
      return typeof value === 'string' ? value : ''
    })
}

const PAGES = [{ id: 'home', title: 'Home' }]

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

interface Bench {
  workflows: ServerMenuWorkflow[]
  workbenchSessionId: string | undefined
  workflowsError: string | undefined
  current: string | undefined
  byId: Record<string, { displayTitle: string; completed?: boolean; blank?: boolean }>
  phase: 'pending' | 'ready'
  /**
   * Defaults to an available Workspace, so pre-existing scenarios keep
   * auto-opening immediately (see workbenchIsLive/recentWorkspaceId gating).
   */
  recentWorkspaceId: string | undefined
}

function mount(overrides: Partial<Bench> = {}) {
  const onOpenPage = vi.fn(() => Promise.resolve())
  const onOpenWorkbenchOnLoad = vi.fn(() => Promise.resolve())
  const onOpenWorkbench = vi.fn(() => Promise.resolve())
  const onOpenWorkflow = vi.fn(() => Promise.resolve())
  const onSaveWorkflows = vi.fn(() => Promise.resolve())
  let current: Bench = {
    workflows: [],
    workbenchSessionId: undefined,
    workflowsError: undefined,
    current: undefined,
    byId: {},
    phase: 'ready',
    recentWorkspaceId: 'workspace-1',
    ...overrides,
  }
  const root = () => (
    <ServerSidebarRoot
      collapsed={false} width={240}
      t={t}
      pages={PAGES} onOpenPage={onOpenPage}
      onOpenWorkbenchOnLoad={onOpenWorkbenchOnLoad}
      onOpenWorkbench={onOpenWorkbench}
      onOpenWorkflow={onOpenWorkflow} onSaveWorkflows={onSaveWorkflows}
      useStore={(<S,>(
        sel: (s: { workflows: ServerMenuWorkflow[]; workbenchSessionId: string | undefined; error: string | undefined }) => S,
      ): S => sel({ workflows: current.workflows, workbenchSessionId: current.workbenchSessionId, error: current.workflowsError }))}
      actions={{ setServerMenu: vi.fn(), setError: vi.fn() }}
      useSessions={((<S,>(sel: (s: Bench) => S): S => sel(current)) as unknown) as ServerSidebarRootComponentProps['useSessions']}
      useWorkspaces={((<S,>(sel: (s: { recentWorkspaceId: string | undefined }) => S): S => (
        sel({ recentWorkspaceId: current.recentWorkspaceId })
      )) as unknown) as ServerSidebarRootComponentProps['useWorkspaces']}
      renderSlot={((
        key: string,
        _owner: unknown,
        options?: { fallback?: ReactNode },
      ) => options?.fallback ?? <div data-testid={key} />) as ServerSidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    onOpenPage,
    onOpenWorkbenchOnLoad,
    onOpenWorkbench,
    onOpenWorkflow,
    onSaveWorkflows,
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

  describe('workbench click: blank-draft semantics', () => {
    it('reopens the recorded session directly when it is live and still blank', () => {
      const b = mount({
        workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home', blank: true } }, current: 'home-1',
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, true)
    })

    it('creates a fresh session when the recorded session is live but no longer blank', () => {
      const b = mount({
        workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home', blank: false } }, current: 'home-1',
      })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true, false)
    })

    it('reports the recorded workbench id as not live (and not blank) once its session leaves the list', () => {
      const b = mount({ workbenchSessionId: 'home-1', byId: {}, current: 'other' })
      fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
      expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', false, false)
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
        recentWorkspaceId: undefined,
      })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith('home-1', true)
    })

    it('withholds the attempt while no live session and no Workspace are available, firing once one appears', () => {
      const b = mount({ phase: 'ready', current: undefined, recentWorkspaceId: undefined })
      expect(b.onOpenWorkbenchOnLoad).not.toHaveBeenCalled()
      b.rerender({ recentWorkspaceId: 'workspace-1' })
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledTimes(1)
      expect(b.onOpenWorkbenchOnLoad).toHaveBeenCalledWith(undefined, false)
    })

    it('never fires once current gets a value, even if a Workspace later appears', () => {
      const b = mount({ phase: 'ready', current: undefined, recentWorkspaceId: undefined })
      b.rerender({ current: 'elsewhere' })
      b.rerender({ recentWorkspaceId: 'workspace-1' })
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

  it('lists the configured pages and opens one on click', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(b.onOpenPage).toHaveBeenCalledWith('home')
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
})
