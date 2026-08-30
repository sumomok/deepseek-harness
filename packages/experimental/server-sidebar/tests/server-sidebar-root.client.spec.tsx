// @vitest-environment jsdom
/**
 * `ServerSidebarRoot`'s three-section console: the brand row, the workbench
 * entry (including decision ①'s once-per-mount auto-open), the navigation
 * and workflow groups it seats, and the footer avatar row. Pointer-driven
 * scrollbar behavior is `pointer-scrollbars.client.spec.tsx`'s own concern,
 * ported unchanged from the original shell and not re-asserted here.
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
  byId: Record<string, { displayTitle: string; completed?: boolean }>
  phase: 'pending' | 'ready'
}

function mount(overrides: Partial<Bench> = {}) {
  const onOpenPage = vi.fn(() => Promise.resolve())
  const onOpenWorkbench = vi.fn(() => Promise.resolve())
  const onOpenWorkflow = vi.fn(() => Promise.resolve())
  const onSaveWorkflows = vi.fn(() => Promise.resolve())
  let current: Bench = {
    workflows: [], workbenchSessionId: undefined, workflowsError: undefined, current: undefined, byId: {}, phase: 'ready', ...overrides,
  }
  const root = () => (
    <ServerSidebarRoot
      collapsed={false} width={240}
      t={t}
      pages={PAGES} onOpenPage={onOpenPage}
      onOpenWorkbench={onOpenWorkbench} onOpenWorkflow={onOpenWorkflow} onSaveWorkflows={onSaveWorkflows}
      useStore={(<S,>(
        sel: (s: { workflows: ServerMenuWorkflow[]; workbenchSessionId: string | undefined; error: string | undefined }) => S,
      ): S => sel({ workflows: current.workflows, workbenchSessionId: current.workbenchSessionId, error: current.workflowsError }))}
      actions={{ setServerMenu: vi.fn(), setError: vi.fn() }}
      useSessions={((<S,>(sel: (s: Bench) => S): S => sel(current)) as unknown) as ServerSidebarRootComponentProps['useSessions']}
      useWorkspaces={() => { throw new Error('must not be read in this bench') }}
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
  it('shows the generic brand fallback, plus the build revision when the commit hash is set', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    mount()
    expect(screen.getByText('DSH Local Build')).toBeTruthy()
    expect(screen.getByText('0123456')).toBeTruthy()
  })

  it('omits the build revision when no commit hash is set', () => {
    mount()
    expect(screen.queryByText(/^[0-9a-f]{7}$/)).toBeNull()
  })

  it('opens the workbench with the recorded id and its liveness on click', () => {
    const b = mount({ workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home' } }, current: 'home-1' })
    fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
    expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true)
  })

  it('reports the recorded workbench id as not live once its session leaves the list', () => {
    const b = mount({ workbenchSessionId: 'home-1', byId: {}, current: 'other' })
    fireEvent.click(screen.getByRole('button', { name: en['workbench.label'] }))
    expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', false)
  })

  it('auto-opens the workbench once the session list settles with no current session', () => {
    const b = mount({ phase: 'pending', current: undefined })
    expect(b.onOpenWorkbench).not.toHaveBeenCalled()
    b.rerender({ phase: 'ready' })
    expect(b.onOpenWorkbench).toHaveBeenCalledTimes(1)
    expect(b.onOpenWorkbench).toHaveBeenCalledWith(undefined, false)
  })

  it('auto-opens with the recorded id and its liveness when one is already recorded', () => {
    const b = mount({
      phase: 'pending', current: undefined, workbenchSessionId: 'home-1', byId: { 'home-1': { displayTitle: 'Home' } },
    })
    b.rerender({ phase: 'ready' })
    expect(b.onOpenWorkbench).toHaveBeenCalledWith('home-1', true)
  })

  it('does not auto-open the workbench when a session is already current', () => {
    const b = mount({ phase: 'ready', current: 'session-a' })
    expect(b.onOpenWorkbench).not.toHaveBeenCalled()
  })

  it('does not repeat the auto-open attempt on a later, unrelated re-render', () => {
    const b = mount({ phase: 'ready', current: undefined })
    expect(b.onOpenWorkbench).toHaveBeenCalledTimes(1)
    b.rerender({ workflows: [] })
    expect(b.onOpenWorkbench).toHaveBeenCalledTimes(1)
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
})
