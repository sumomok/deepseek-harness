// @vitest-environment jsdom
/**
 * `NavGroup`'s page listing and click-through — pure presentation, so this
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

afterEach(() => {
  cleanup()
})

describe('NavGroup', () => {
  it('shows the empty copy when no pages are configured', () => {
    render(<NavGroup pages={[]} onOpenPage={vi.fn(() => Promise.resolve())} t={t} />)
    expect(screen.getByText(en['nav.empty'])).toBeTruthy()
  })

  it('lists the configured pages in declaration order and opens one on click', () => {
    const onOpenPage = vi.fn(() => Promise.resolve())
    render(<NavGroup pages={[{ id: 'home', title: 'Home' }, { id: 'docs', title: 'Docs' }]} onOpenPage={onOpenPage} t={t} />)
    const rows = screen.getAllByRole('button', { name: /Home|Docs/ })
    expect(rows.map(row => row.textContent)).toEqual(['Home', 'Docs'])
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }))
    expect(onOpenPage).toHaveBeenCalledWith('docs')
  })
})
