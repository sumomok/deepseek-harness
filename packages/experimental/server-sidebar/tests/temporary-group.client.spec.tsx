// @vitest-environment jsdom
/**
 * `TemporaryGroup`'s rows (durable title or its fixed fallback, relative
 * time, unread dot, active highlight), its fold and 显示更多 controls, and the
 * two-click 移出列表 confirmation. Membership and order are decided before
 * this component sees a row (`temporarySessions` in
 * `workflow-actions.client.spec.ts`); `server-sidebar-root.client.spec.tsx`
 * covers the section seated inside the shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TemporaryGroup, relativeTime, type TemporaryGroupProps, type TemporaryRow } from '../src/client/TemporaryGroup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSidebarKey } from '../src/client/locales.ts'

const t: TemporaryGroupProps['t'] = (key: ServerSidebarKey, vars?: Record<string, string>) => {
  const template = en[key]
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '')
}

const NOW = 1_700_000_000_000

function row(overrides: Partial<TemporaryRow>): TemporaryRow {
  return { id: 's1', title: 'A chat', updatedAt: NOW, unread: false, active: false, ...overrides }
}

function baseProps(overrides: Partial<TemporaryGroupProps> = {}): TemporaryGroupProps {
  return {
    rows: [],
    collapsed: false,
    onSetCollapsed: vi.fn(),
    expanded: false,
    onSetExpanded: vi.fn(),
    onOpen: vi.fn(() => Promise.resolve()),
    onDismiss: vi.fn(() => Promise.resolve()),
    failed: false,
    t,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('relativeTime', () => {
  it('reports the coarsest unit that still says something', () => {
    expect(relativeTime(NOW - 30_000, NOW, t)).toBe(en['time.now'])
    expect(relativeTime(NOW - 5 * 60_000, NOW, t)).toBe('5 min ago')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW, t)).toBe('3 h ago')
    expect(relativeTime(NOW - 4 * 86_400_000, NOW, t)).toBe('4 d ago')
  })

  it('reads a timestamp in the future as just now rather than as a negative count', () => {
    expect(relativeTime(NOW + 90_000, NOW, t)).toBe(en['time.now'])
  })
})

describe('TemporaryGroup', () => {
  it('shows the empty copy when nothing is temporary', () => {
    render(<TemporaryGroup {...baseProps()} />)
    expect(screen.getByText(en['temporary.title'])).toBeTruthy()
    expect(screen.getByText(en['temporary.empty'])).toBeTruthy()
  })

  it('draws a row from its durable title and its relative time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    render(<TemporaryGroup {...baseProps({ rows: [row({ updatedAt: NOW - 2 * 3_600_000 })] })} />)
    const button = screen.getByRole('button', { name: /A chat/ })
    expect(button.textContent).toBe('A chat2 h ago')
  })

  it('falls back to fixed copy for a conversation with no durable title of its own', () => {
    render(<TemporaryGroup {...baseProps({ rows: [row({ title: undefined })] })} />)
    expect(screen.getByRole('button', { name: new RegExp(en['temporary.untitled']) })).toBeTruthy()
  })

  it('opens a conversation on click', () => {
    const onOpen = vi.fn(() => Promise.resolve())
    render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })], onOpen })} />)
    fireEvent.click(screen.getByRole('button', { name: /A chat/ }))
    expect(onOpen).toHaveBeenCalledWith('s7')
  })

  it('marks the open conversation and draws the unread dot only where there is unseen output', () => {
    const rows = [row({ id: 's1', active: true, unread: false }), row({ id: 's2', title: 'Other', unread: true })]
    render(<TemporaryGroup {...baseProps({ rows })} />)
    expect(screen.getByRole('button', { name: /A chat/ }).getAttribute('data-active')).toBe('true')
    const other = screen.getByRole('button', { name: /Other/ })
    expect(other.getAttribute('data-active')).toBe('false')
    expect(other.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  describe('移出列表', () => {
    it('asks for a second click before it archives anything', () => {
      const onDismiss = vi.fn(() => Promise.resolve())
      render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })], onDismiss })} />)
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismiss'] }))
      expect(onDismiss).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismissConfirm'] }))
      expect(onDismiss).toHaveBeenCalledWith('s7')
      expect(screen.queryByRole('button', { name: en['temporary.dismissConfirm'] })).toBeNull()
    })

    it('drops the armed row\'s relative time, so the confirm button does not squeeze its title away', () => {
      vi.useFakeTimers()
      vi.setSystemTime(NOW)
      render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7', title: 'Quarterly numbers' })] })} />)
      expect(screen.queryByText(en['time.now'])).not.toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismiss'] }))
      expect(screen.queryByText(en['time.now'])).toBeNull()
      expect(screen.queryByText('Quarterly numbers')).not.toBeNull()
    })

    it('puts 取消 where the icon was, so a second press at the same point cannot commit', () => {
      const onDismiss = vi.fn(() => Promise.resolve())
      render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })], onDismiss })} />)
      const dismiss = screen.getByRole('button', { name: en['temporary.dismiss'] })
      const actions = dismiss.closest('div')!
      fireEvent.click(dismiss)
      // 确定移出 opens to the left of 取消, so the last control in the row —
      // the one a double click's second press lands on — is the one that
      // takes the arming back. The e2e scenario presses the real double
      // click; this pins the order the geometry rests on.
      expect([...actions.querySelectorAll('button')].map(button => button.textContent ?? ''))
        .toEqual([en['temporary.dismissConfirm'], ''])
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismissCancel'] }))
      expect(onDismiss).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: en['temporary.dismiss'] })).toBeTruthy()
    })

    it('disarms on Escape from wherever the focus went', () => {
      const onDismiss = vi.fn(() => Promise.resolve())
      render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })], onDismiss })} />)
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismiss'] }))
      fireEvent.keyDown(document, { key: 'a' })
      expect(screen.queryByRole('button', { name: en['temporary.dismissConfirm'] })).not.toBeNull()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('button', { name: en['temporary.dismissConfirm'] })).toBeNull()
      expect(onDismiss).not.toHaveBeenCalled()
    })

    it('disarms when the section is folded shut', () => {
      const { rerender } = render(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })] })} />)
      fireEvent.click(screen.getByRole('button', { name: en['temporary.dismiss'] }))
      fireEvent.click(screen.getByRole('button', { name: en['groups.collapse'] }))
      rerender(<TemporaryGroup {...baseProps({ rows: [row({ id: 's7' })], collapsed: false })} />)
      expect(screen.queryByRole('button', { name: en['temporary.dismissConfirm'] })).toBeNull()
    })

    it('reports a failed archive in this section, in fixed words that are not about saving', () => {
      render(<TemporaryGroup {...baseProps({ rows: [row({})], failed: true })} />)
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toBe(en['temporary.error'])
      // The refusal a host runtime raises reads `session archive failed: …`;
      // nothing of it reaches the person using the console.
      expect(alert.textContent).not.toMatch(/\bsession\b/i)
      expect(alert.textContent).not.toMatch(/\bworkspace\b/i)
    })

    it('asks on one row at a time', () => {
      const rows = [row({ id: 's1' }), row({ id: 's2', title: 'Other' })]
      render(<TemporaryGroup {...baseProps({ rows })} />)
      fireEvent.click(screen.getAllByRole('button', { name: en['temporary.dismiss'] })[0]!)
      expect(screen.getAllByRole('button', { name: en['temporary.dismiss'] }).length).toBe(1)
      expect(screen.getAllByRole('button', { name: en['temporary.dismissConfirm'] }).length).toBe(1)
    })
  })

  describe('显示更多', () => {
    const many = Array.from({ length: 7 }, (_value, index) => row({ id: `s${String(index)}`, title: `Chat ${String(index)}` }))

    it('cuts the list to its first few and offers the rest', () => {
      const onSetExpanded = vi.fn()
      render(<TemporaryGroup {...baseProps({ rows: many, onSetExpanded })} />)
      expect(screen.getAllByRole('listitem').length).toBe(5)
      fireEvent.click(screen.getByRole('button', { name: en['temporary.more'] }))
      expect(onSetExpanded).toHaveBeenCalledWith(true)
    })

    it('shows every row and drops the control once the rest was asked for', () => {
      render(<TemporaryGroup {...baseProps({ rows: many, expanded: true })} />)
      expect(screen.getAllByRole('listitem').length).toBe(7)
      expect(screen.queryByRole('button', { name: en['temporary.more'] })).toBeNull()
    })

    it('offers nothing extra when the list already fits', () => {
      render(<TemporaryGroup {...baseProps({ rows: many.slice(0, 5) })} />)
      expect(screen.queryByRole('button', { name: en['temporary.more'] })).toBeNull()
    })
  })

  describe('folding', () => {
    it('reports the toggle in both directions', () => {
      const onSetCollapsed = vi.fn()
      const { rerender } = render(<TemporaryGroup {...baseProps({ onSetCollapsed })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.collapse'] }))
      expect(onSetCollapsed).toHaveBeenCalledWith(true)
      rerender(<TemporaryGroup {...baseProps({ onSetCollapsed, collapsed: true })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.expand'] }))
      expect(onSetCollapsed).toHaveBeenLastCalledWith(false)
    })

    it('draws no rows, no empty copy and no 显示更多 while folded shut', () => {
      const rows = Array.from({ length: 7 }, (_value, index) => row({ id: `s${String(index)}` }))
      render(<TemporaryGroup {...baseProps({ rows, collapsed: true })} />)
      expect(screen.queryAllByRole('listitem').length).toBe(0)
      expect(screen.queryByRole('button', { name: en['temporary.more'] })).toBeNull()
      cleanup()
      render(<TemporaryGroup {...baseProps({ collapsed: true })} />)
      expect(screen.queryByText(en['temporary.empty'])).toBeNull()
    })
  })
})
