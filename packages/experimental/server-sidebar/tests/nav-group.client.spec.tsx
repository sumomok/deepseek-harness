// @vitest-environment jsdom
/**
 * `NavGroup`'s merged listing and click-through — pure presentation, so this
 * covers everything the component itself does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NavGroup } from '../src/client/NavGroup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSidebarKey } from '../src/client/locales.ts'

const t = (key: ServerSidebarKey, vars?: Record<string, string>): string => {
  const template = en[key]
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '')
}

const ITEMS = [
  { kind: 'page', entryId: 'home', title: 'Home' },
  { kind: 'page', entryId: 'docs', title: 'Docs' },
  { kind: 'view', entryId: 'sales', title: 'Sales' },
] as const

afterEach(() => {
  cleanup()
})

describe('NavGroup', () => {
  it('shows the empty copy when the deployment configured nothing', () => {
    render(<NavGroup items={[]} onOpenNavItem={vi.fn(() => Promise.resolve())} t={t} />)
    expect(screen.getByText(en['nav.empty'])).toBeTruthy()
  })

  it('lists both catalogs in menu order and marks each row with the kind it came from', () => {
    render(<NavGroup items={ITEMS} onOpenNavItem={vi.fn(() => Promise.resolve())} t={t} />)
    const rows = screen.getAllByRole('button', { name: /Home|Docs|Sales/ })
    expect(rows.map(row => row.textContent)).toEqual(['Home', 'Docs', 'Sales'])
    expect(rows.map(row => row.dataset.serverSidebarNavKind)).toEqual(['page', 'page', 'view'])
  })

  it('hands a page click the page target', () => {
    const onOpenNavItem = vi.fn(() => Promise.resolve())
    render(<NavGroup items={ITEMS} onOpenNavItem={onOpenNavItem} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    expect(onOpenNavItem).toHaveBeenCalledWith({ kind: 'page', entryId: 'docs' })
  })

  it('hands a view click the view target', () => {
    const onOpenNavItem = vi.fn(() => Promise.resolve())
    render(<NavGroup items={ITEMS} onOpenNavItem={onOpenNavItem} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sales' }))
    expect(onOpenNavItem).toHaveBeenCalledWith({ kind: 'view', entryId: 'sales' })
  })

  it('keys a page and a view that share an id apart', () => {
    render(<NavGroup
      items={[{ kind: 'page', entryId: 'sales', title: 'Sales page' }, { kind: 'view', entryId: 'sales', title: 'Sales view' }]}
      onOpenNavItem={vi.fn(() => Promise.resolve())}
      t={t}
    />)
    expect(screen.getAllByRole('button', { name: /Sales/ }).map(row => row.textContent))
      .toEqual(['Sales page', 'Sales view'])
  })
})
