// @vitest-environment jsdom
/**
 * MenuSection's two forms (wide inline, rail icon + floating panel) and the
 * add/rename/remove/stale-favorite interactions inside each.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MenuSection, type MenuSectionProps } from '../src/client/MenuSection.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSidebarKey } from '../src/client/locales.ts'

const t: MenuSectionProps['t'] = (key: ServerSidebarKey, vars?: Record<string, string>) => {
  const template = en[key]
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '')
}

const PAGES = [{ id: 'home', title: 'Home' }, { id: 'docs', title: 'Docs' }]
const CURRENT = { id: 'session-a', title: 'Current Session' }

function baseProps(overrides: Partial<MenuSectionProps> = {}): MenuSectionProps {
  return {
    wide: true,
    pages: PAGES,
    favorites: [],
    favoritesError: undefined,
    current: CURRENT,
    liveSessionIds: new Set(['session-a']),
    onOpenPage: vi.fn(() => Promise.resolve()),
    onOpenSession: vi.fn(),
    onSaveFavorites: vi.fn(() => Promise.resolve()),
    t,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

describe('MenuSection wide form', () => {
  it('lists the configured pages and opens one on click', () => {
    const onOpenPage = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onOpenPage })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    expect(onOpenPage).toHaveBeenCalledWith('docs')
  })

  it('shows the empty-pages copy when no pages are configured', () => {
    render(<MenuSection {...baseProps({ pages: [] })} />)
    expect(screen.getByText(en['menu.pages.empty'])).toBeTruthy()
  })

  it('shows the empty-favorites copy when there are none', () => {
    render(<MenuSection {...baseProps()} />)
    expect(screen.getByText(en['menu.favorites.empty'])).toBeTruthy()
  })

  it('renders favorites sorted by order and opens one on click', () => {
    const onOpenSession = vi.fn()
    const favorites = [
      { sessionId: 's2', label: 'Second', order: 1 },
      { sessionId: 's1', label: 'First', order: 0 },
    ]
    render(<MenuSection {...baseProps({
      favorites, onOpenSession, liveSessionIds: new Set(['s1', 's2']),
    })}
    />)
    const rows = screen.getAllByRole('button', { name: /First|Second/ })
    expect(rows.map(row => row.textContent)).toEqual(['First', 'Second'])
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
  })

  it('breaks a tied display order on session id, comparing every pair both ways', () => {
    render(<MenuSection {...baseProps({
      favorites: [
        { sessionId: 'zeta', label: 'Zeta', order: 0 },
        { sessionId: 'mike', label: 'Mike', order: 0 },
        { sessionId: 'delta', label: 'Delta', order: 0 },
        { sessionId: 'bravo', label: 'Bravo', order: 0 },
        { sessionId: 'alpha', label: 'Alpha', order: 0 },
      ],
      liveSessionIds: new Set(['zeta', 'mike', 'delta', 'bravo', 'alpha']),
    })}
    />)
    const rows = screen.getAllByRole('button', { name: /Alpha|Bravo|Delta|Mike|Zeta/ })
    expect(rows.map(row => row.textContent)).toEqual(['Alpha', 'Bravo', 'Delta', 'Mike', 'Zeta'])
  })

  it('leaves an already-ordered tied pair as-is', () => {
    render(<MenuSection {...baseProps({
      favorites: [
        { sessionId: 'alpha', label: 'Alpha', order: 0 },
        { sessionId: 'bravo', label: 'Bravo', order: 0 },
      ],
      liveSessionIds: new Set(['alpha', 'bravo']),
    })}
    />)
    const rows = screen.getAllByRole('button', { name: /Alpha|Bravo/ })
    expect(rows.map(row => row.textContent)).toEqual(['Alpha', 'Bravo'])
  })

  it('renders a favorite whose session no longer exists as disabled and removable, not dropped', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [{ sessionId: 'gone', label: 'Ghost', order: 0 }]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set() })} />)
    const staleButton = screen.getByRole('button', { name: /Ghost/ }) as HTMLButtonElement
    expect(staleButton.disabled).toBe(true)
    expect(screen.getByText(en['menu.favorites.stale'])).toBeTruthy()
    // No rename affordance for a stale row, but remove still works.
    expect(screen.queryByRole('button', { name: en['menu.favorites.rename'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.remove'] }))
    expect(onSaveFavorites).toHaveBeenCalledWith([])
  })

  it('disables the add-favorite action with no current session', () => {
    render(<MenuSection {...baseProps({ current: undefined })} />)
    const button = screen.getByRole('button', { name: en['menu.favorites.add'] })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables the add-favorite action once the current session is already favorited', () => {
    render(<MenuSection {...baseProps({ favorites: [{ sessionId: 'session-a', label: 'Mine', order: 0 }] })} />)
    const button = screen.getByRole('button', { name: en['menu.favorites.add'] })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('adds the current session under the typed label on blur, defaulting the field to its title', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onSaveFavorites })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('Current Session')
    fireEvent.change(input, { target: { value: 'My Pinned Chat' } })
    fireEvent.blur(input)
    expect(onSaveFavorites).toHaveBeenCalledWith([{ sessionId: 'session-a', label: 'My Pinned Chat', order: 0 }])
  })

  it('commits the add on Enter through the same blur path', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onSaveFavorites })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSaveFavorites).toHaveBeenCalled()
  })

  it('discards the add on Escape without saving', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onSaveFavorites })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('leaves the add field open on an unrelated keystroke', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onSaveFavorites })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('does not save an add whose trimmed label is empty', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({ onSaveFavorites })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('assigns the next favorite one past the current highest order', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    render(<MenuSection {...baseProps({
      onSaveFavorites,
      favorites: [{ sessionId: 'other', label: 'Other', order: 4 }],
      liveSessionIds: new Set(['session-a', 'other']),
    })}
    />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.add'] }))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onSaveFavorites).toHaveBeenCalledWith([
      { sessionId: 'other', label: 'Other', order: 4 },
      { sessionId: 'session-a', label: 'Current Session', order: 5 },
    ])
  })

  it('renames a favorite on blur, leaving the others untouched', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [
      { sessionId: 's1', label: 'First', order: 0 },
      { sessionId: 's2', label: 'Second', order: 1 },
    ]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1', 's2']) })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['menu.favorites.rename'] })[0]!)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('First')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    expect(onSaveFavorites).toHaveBeenCalledWith([
      { sessionId: 's1', label: 'Renamed', order: 0 },
      { sessionId: 's2', label: 'Second', order: 1 },
    ])
  })

  it('discards a rename on Escape without saving', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [{ sessionId: 's1', label: 'First', order: 0 }]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1']) })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('commits a rename on Enter through the same blur path', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [{ sessionId: 's1', label: 'First', order: 0 }]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1']) })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSaveFavorites).toHaveBeenCalled()
  })

  it('leaves a rename in place on an unrelated keystroke', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [{ sessionId: 's1', label: 'First', order: 0 }]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1']) })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('does not save a rename whose trimmed label is empty', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [{ sessionId: 's1', label: 'First', order: 0 }]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1']) })} />)
    fireEvent.click(screen.getByRole('button', { name: en['menu.favorites.rename'] }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onSaveFavorites).not.toHaveBeenCalled()
  })

  it('removes a favorite via its trash action', () => {
    const onSaveFavorites = vi.fn(() => Promise.resolve())
    const favorites = [
      { sessionId: 's1', label: 'First', order: 0 },
      { sessionId: 's2', label: 'Second', order: 1 },
    ]
    render(<MenuSection {...baseProps({ favorites, onSaveFavorites, liveSessionIds: new Set(['s1', 's2']) })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['menu.favorites.remove'] })[0]!)
    expect(onSaveFavorites).toHaveBeenCalledWith([{ sessionId: 's2', label: 'Second', order: 1 }])
  })

  it('surfaces a pending save error as an alert with the message interpolated', () => {
    render(<MenuSection {...baseProps({ favoritesError: 'HTTP 503' })} />)
    expect(screen.getByRole('alert').textContent).toBe(en['menu.favorites.error'].replace('{message}', 'HTTP 503'))
  })
})

describe('MenuSection rail form', () => {
  it('starts closed and opens a dismissible panel with the menu body on trigger click', () => {
    render(<MenuSection {...baseProps({ wide: false })} />)
    expect(screen.queryByText(en['menu.pages.title'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['menu.trigger'] }))
    expect(screen.getByText(en['menu.pages.title'])).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText(en['menu.pages.title'])).toBeNull()
  })
})
