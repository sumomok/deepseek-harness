// @vitest-environment jsdom
/**
 * ServerSidebarRoot's shell geometry, ported unchanged from
 * `dsh-client-ui-sidebar`'s own `SidebarRoot` spec (New Session routing, the
 * region's wide flag through collapse/expand, the rail's static cold start),
 * plus this package's own addition: the menu section seated between the New
 * Session button and the workspace region, and the session-liveness reads it
 * feeds from the standard `useSessions` seat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ServerSidebarRoot, type ServerSidebarRootComponentProps } from '../src/client/ServerSidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

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
  vi.useRealTimers()
})

const neverHook = (() => { throw new Error('must not be read in this bench') }) as never

interface Bench {
  collapsed: boolean
  width: number
  favorites: { sessionId: string; label: string; order: number }[]
  favoritesError: string | undefined
  current: string | undefined
  byId: Record<string, { displayTitle: string }>
}

function mount(overrides: Partial<Bench> = {}) {
  const startSession = vi.fn()
  const toggleSidebar = vi.fn()
  const onOpenPage = vi.fn(() => Promise.resolve())
  const onOpenSession = vi.fn()
  const onSaveFavorites = vi.fn(() => Promise.resolve())
  let regionOwner: { wide: boolean; expandSidebar: () => void } | undefined
  let current: Bench = {
    collapsed: false, width: 300, favorites: [], favoritesError: undefined, current: undefined, byId: {}, ...overrides,
  }
  const root = () => (
    <ServerSidebarRoot
      collapsed={current.collapsed} width={current.width}
      t={t}
      startSession={startSession} toggleSidebar={toggleSidebar}
      pages={PAGES} onOpenPage={onOpenPage} onOpenSession={onOpenSession} onSaveFavorites={onSaveFavorites}
      useStore={(<S,>(sel: (s: { favorites: Bench['favorites']; error: string | undefined }) => S): S =>
        sel({ favorites: current.favorites, error: current.favoritesError }))}
      actions={{ setFavorites: vi.fn(), setError: vi.fn() }}
      useSessions={((<S,>(sel: (s: { current: string | undefined; byId: Bench['byId'] }) => S): S =>
        sel({ current: current.current, byId: current.byId })) as unknown) as ServerSidebarRootComponentProps['useSessions']}
      useWorkspaces={neverHook}
      renderSlot={((
        key: string,
        owner: { wide: boolean; expandSidebar?: () => void },
        options?: { fallback?: ReactNode },
      ) => {
        if (key === 'sidebar.workspaces') { regionOwner = owner as { wide: boolean; expandSidebar: () => void } }
        return options?.fallback ?? <div data-testid={key} data-wide={owner.wide} />
      }) as ServerSidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    startSession,
    toggleSidebar,
    onOpenPage,
    onOpenSession,
    onSaveFavorites,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    rerender(next: Partial<Bench>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('ServerSidebarRoot shell', () => {
  it('routes New Session (capsule + wordmark) and the column toggle', () => {
    const b = mount()
    const starters = screen.getAllByRole('button', { name: 'New session' })
    expect(starters).toHaveLength(2)
    for (const button of starters) fireEvent.click(button)
    expect(b.startSession).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('shows the build revision alongside the generic brand fallback when the commit hash is set', () => {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', '0123456')
    mount()
    expect(screen.getByText('0123456')).toBeTruthy()
  })

  it('hands the workspaces region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mount()
    expect(b.regionOwner().wide).toBe(true)
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mount()
    b.rerender({ collapsed: true })
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    mount({ collapsed: true })
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('seats the menu between New Session and the workspace region, wide when the sidebar is wide', () => {
    mount()
    expect(screen.getByText('Home')).toBeTruthy()
    expect(document.querySelector('[data-server-sidebar-menu]')?.className).not.toContain('railRoot')
  })

  it('shows the menu as a rail trigger while collapsed', () => {
    mount({ collapsed: true })
    expect(screen.queryByText('Home')).toBeNull()
    expect(screen.getByRole('button', { name: en['menu.trigger'] })).toBeTruthy()
  })

  it('derives the add-favorite default label from the current session\'s live title', () => {
    mount({ current: 'session-a', byId: { 'session-a': { displayTitle: 'Live Title' } } })
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    const input = screen.getByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('Live Title')
  })

  it('opens a favorited session through the wired onOpenSession callback', () => {
    const b = mount({
      favorites: [{ sessionId: 'session-b', label: 'Pinned', order: 0 }],
      byId: { 'session-b': { displayTitle: 'Pinned Session' } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }))
    expect(b.onOpenSession).toHaveBeenCalledWith('session-b')
  })

  it('falls back to the session id as the label when the session has no title yet', () => {
    mount({ current: 'session-a', byId: {} })
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    const input = screen.getByRole('textbox')
    expect((input as HTMLInputElement).value).toBe('session-a')
  })

  it('surfaces a pending favorites-save error in the menu', () => {
    mount({ favoritesError: 'HTTP 503' })
    expect(screen.getByRole('alert').textContent).toContain('HTTP 503')
  })
})
