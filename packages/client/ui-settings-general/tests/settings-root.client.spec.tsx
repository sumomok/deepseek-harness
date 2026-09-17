// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useEffect, useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsTriggerActionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { en, zh } from '../src/client/locales.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type Row = { id: string; order: number; label: string }
type Step = { id: string; order: number }

/**
 * Every section id the group table names, in ledger order, plus two ids it
 * never heard of. Three groups list their members in an order the ascending
 * `order` here contradicts, so a rail drawing ledger order instead of table
 * order reads differently. Labels stand in for the registrants' own copy.
 */
const EVERY_SECTION: Row[] = [
  { id: 'general', order: 0, label: 'General' },
  { id: 'vision-switch', order: 5, label: 'Vision' },
  { id: 'models', order: 10, label: 'Models' },
  { id: 'llm-permission-gateway', order: 15, label: 'Review settings' },
  { id: 'agent-presets', order: 20, label: 'Agent presets' },
  { id: 'mcp-servers', order: 25, label: 'MCP servers' },
  { id: 'contributed', order: 28, label: 'Contributed' },
  { id: 'plugins', order: 30, label: 'Plugins' },
  { id: 'balance', order: 35, label: 'Balance' },
  { id: 'at-file', order: 55, label: 'At file' },
  { id: 'screenshot-logins', order: 60, label: 'Screenshot logins' },
  { id: 'desktop-update', order: 70, label: 'Desktop update' },
  { id: 'contributed-late', order: 90, label: 'Late contribution' },
]

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.action': 'Open configuration file',
  'settings.close': 'Close',
}

type AttentionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useSessionPendingInteraction']>[0]>[0]
type ConnectionSnapshot = Parameters<Parameters<SettingsRootComponentProps['useConnectionState']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: SettingsRootComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount({
  wide = true,
  dictionary = en,
  connectionState = 'connected',
  onboardingActive = true,
  triggerAction,
  rows = [
    { id: 'general', order: 0, label: 'General' },
    { id: 'models', order: 10, label: 'Models' },
    { id: 'agent-presets', order: 20, label: 'Agent presets' },
  ],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ],
}: {
  wide?: boolean
  dictionary?: typeof en | typeof zh
  connectionState?: ConnectionSnapshot
  onboardingActive?: boolean
  /** Stand-in occupant of the same-row action seat, drawn from its owner props (absent = empty seat). */
  triggerAction?: (owner: SettingsTriggerActionOwnerProps) => ReactNode
  rows?: Row[]
  steps?: Step[]
} = {}) {
  // Mutable row source standing in for the bound useSections hook; bump()
  // plays a ledger change through the same observable contract.
  let current = rows
  let currentConnectionState = connectionState
  const listeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  const reconnect = vi.fn()
  const renderSlot = vi.fn(
    ((key: string, owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      if (key === 'settings.trigger.action') return triggerAction?.(owner as SettingsTriggerActionOwnerProps)
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  const props: SettingsRootComponentProps = {
    useSessions,
    useSessionPendingInteraction,
    usePanelInfo, useResource,
    useWorkspaces: unusedHook,
    wide,
    reconnect,
    t: makeTranslate(dictionary),
    useConnectionState: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        connectionListeners.add(listener)
        return () => { connectionListeners.delete(listener) }
      }, [])
      return select(currentConnectionState)
    },
    useOnboardingSteps: select => select(steps),
    useSections: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: Row[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  const setConnectionState = (next: typeof currentConnectionState) => {
    act(() => {
      currentConnectionState = next
      for (const fn of [...connectionListeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners, reconnect, setConnectionState }
}

/** The rail's group titles, in drawn order. */
function groupTitles(): (string | null)[] {
  return [...document.querySelectorAll('[role="group"]')]
    .map(group => group.querySelector('[class*="navGroupLabel"]')!.textContent)
}

/** Each group's member labels, in drawn order. */
function groupMembers(): (string | null)[][] {
  return [...document.querySelectorAll('[role="group"]')]
    .map(group => [...group.querySelectorAll('button')].map(cell => cell.textContent))
}

function openPanel(name = 'Settings') {
  const trigger = screen.getByRole('button', { name })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('SettingsRoot trigger', () => {
  it.each([
    { column: 'expanded English', wide: true, dictionary: en, name: 'Settings' },
    { column: 'collapsed English', wide: false, dictionary: en, name: 'Settings' },
    { column: 'expanded Chinese', wide: true, dictionary: zh, name: '设置' },
    { column: 'collapsed Chinese', wide: false, dictionary: zh, name: '设置' },
  ])('uses the locale name and accepts keyboard-style activation for the $column trigger', ({
    wide, dictionary, name,
  }) => {
    const { renderSlot } = mount({ wide, dictionary })
    const trigger = screen.getByRole('button', { name })
    expect(trigger.getAttribute('aria-label')).toBe(name)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    fireEvent.click(trigger, { detail: 0 })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name, expanded: true })).toBeTruthy()
  })

  it('shows outage, retry progress, and a two-second recovery confirmation', () => {
    vi.useFakeTimers()
    const mounted = mount()
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()

    mounted.setConnectionState('disconnected')
    const indicator = screen.getByRole('button', { name: 'Disconnected, reconnect now' })
    expect(indicator.textContent).toContain('Disconnected')
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.querySelector('svg')).toBeTruthy()
    fireEvent.click(indicator)
    expect(mounted.reconnect).toHaveBeenCalledOnce()

    mounted.setConnectionState('connecting')
    expect(screen.getByRole('button', { name: 'Reconnecting automatically, reconnect now' }).textContent)
      .toContain('Reconnecting...')

    mounted.setConnectionState('connected')
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1_999) })
    expect(screen.getByRole('status', { name: 'Connected' })).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the reconnect indicator out of the collapsed rail', () => {
    mount({ wide: false, connectionState: 'disconnected' })
    expect(screen.queryByRole('button', { name: 'Disconnected, reconnect now' })).toBeNull()
  })

  it('leaves the same-row action seat empty and boxless when nobody registers', () => {
    const { view, renderSlot } = mount()
    const row = view.container.querySelector('[class*="triggerRow"]')!
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger.action', {
      wide: true, openSection: expect.any(Function) as SettingsTriggerActionOwnerProps['openSection'],
    })
    const seat = row.lastElementChild!
    expect(seat.className).toContain('triggerActions')
    expect(seat.childElementCount).toBe(0)
    expect(seat.textContent).toBe('')
  })

  it('seats a same-row occupant after the trigger, at the row right edge', () => {
    const { view } = mount({ triggerAction: () => <button type="button">Update ready</button> })
    const row = view.container.querySelector('[class*="triggerRow"]')!
    const occupant = screen.getByRole('button', { name: 'Update ready' })
    // The trigger opens the row and the seat closes it: the flex:1 trigger
    // pushes everything after it against the row's right edge.
    expect(row.firstElementChild!.getAttribute('aria-haspopup')).toBe('dialog')
    expect(row.lastElementChild!.className).toContain('triggerActions')
    expect(row.lastElementChild!.contains(occupant)).toBe(true)
  })

  it('hands the fold state to the same-row seat and keeps its occupant mounted in the rail', () => {
    const { renderSlot } = mount({ wide: false, triggerAction: () => <button type="button">Update ready</button> })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger.action', {
      wide: false, openSection: expect.any(Function) as SettingsTriggerActionOwnerProps['openSection'],
    })
    // The rail row paints the seat away in CSS rather than unmounting it, so
    // an occupant's own state and subscriptions survive folding the column.
    expect(screen.getByRole('button', { name: 'Update ready' })).toBeTruthy()
  })

  it('opens the panel on one settings section through the opener the seat receives', () => {
    mount({
      triggerAction: ({ openSection }) => (
        <button type="button" onClick={() => { openSection('models') }}>Update ready</button>
      ),
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update ready' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
  })

  it('still opens the panel when the opener names a section nobody registered', () => {
    // The nav projection falls back to the first row, so an id no entry
    // claims activates nothing of its own instead of opening an empty panel.
    mount({
      triggerAction: ({ openSection }) => (
        <button type="button" onClick={() => { openSection('never-registered') }}>Update ready</button>
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update ready' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })
})

describe('SettingsRoot.module.css', () => {
  const styles = readFileSync(resolve(import.meta.dirname, '../src/client/SettingsRoot.module.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')

  /**
   * Declarations of one exact selector, keyed by property.
   * @param selector - exact selector text.
   * @returns the normalized declarations, or undefined when the selector is absent.
   */
  function declarations(selector: string): Map<string, string> | undefined {
    for (const [, selectorList = '', body = ''] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
      const found = new Map<string, string>()
      for (const part of body.split(';')) {
        const colon = part.indexOf(':')
        if (colon === -1) continue
        found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
      }
      return found
    }
    return undefined
  }

  it('keeps the same-row seat boxless in the wide row and unpainted in the rail', () => {
    // Boxless: an empty seat must not consume one of the row's 8px gaps, and
    // an occupant must become a flex child of the row rather than of a nested box.
    expect(declarations('.triggerRow')?.get('gap')).toBe('8px')
    expect(declarations('.triggerActions')?.get('display')).toBe('contents')
    expect(declarations('.trigger')?.get('flex')).toBe('1')
    // The rail row is exactly the trigger circle: 36px, nothing beside it.
    expect(declarations('.triggerRow.railRow')?.get('width')).toBe('36px')
    expect(declarations('.triggerRow.railRow .triggerActions')?.get('display')).toBe('none')
  })

  it('lets the nav rail scroll instead of clipping under the fixed panel height', () => {
    // The panel height comes from the viewport and the section ledger is
    // open-ended, so the cell stack has to shrink below its content and
    // scroll; a flex item refuses to do that while its min-height is auto.
    expect(declarations('.nav')?.get('min-height')).toBe('0')
    expect(declarations('.navList')?.get('min-height')).toBe('0')
    expect(declarations('.navList')?.get('overflow-y')).toBe('auto')
  })

  it('sets the two nav levels apart and aligns a member label under its group label', () => {
    // Group titles are quieter than cell labels, and the 36px inset puts a
    // glyphless member label in the same column as the group label above it.
    expect(declarations('.navList')?.get('gap')).toBe('12px')
    expect(declarations('.navGroup')?.get('gap')).toBe('4px')
    expect(declarations('.navGroupTitle')?.get('color')).toBe('var(--dsw-alias-label-tertiary)')
    expect(declarations('.navGroupTitle')?.get('font-size')).toBe('12px')
    expect(declarations('.navGroup .navCell')?.get('padding-left')).toBe('36px')
  })

  it('gives the wide row one hover surface that the action seat sits inside', () => {
    // One control rather than two: the row paints the hover fill across the
    // trigger and the seat together, and the trigger stops painting its own
    // fill inside that row so the two do not read as separate boxes.
    expect(declarations('.triggerRow')?.get('border-radius')).toBe('12px')
    expect(declarations('.triggerRow:not(.railRow):hover')?.get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(declarations('.triggerRow:not(.railRow) .trigger:hover')?.get('background')).toBe('transparent')
    // The rail row is excluded: there the trigger circle is its own surface.
    expect(declarations('.trigger:hover')?.get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('renders header actions before the shell-owned close control', () => {
    const { renderSlot } = mount()
    openPanel()
    expect(screen.getByText('Open configuration file')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledWith('settings.action', {})
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via a mask click and restores trigger focus', async () => {
    mount()
    const trigger = openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
  })

  it('closes via document-level Escape, restores trigger focus, and unhooks the listener', async () => {
    mount()
    const trigger = openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await vi.waitFor(() => { expect(document.activeElement).toBe(trigger) })
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel navigation', () => {
  it('projects rows, marks the first active, and renders only that section', () => {
    mount()
    openPanel()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('files every section under its group, in table order', () => {
    mount({ rows: EVERY_SECTION })
    openPanel()
    expect(groupTitles()).toEqual([
      'General', 'Models', 'Agent', 'Extensions', 'Account & usage', 'About', 'Other',
    ])
    // Members follow the table, not the ledger's `order`: Vision (5) draws
    // below Models (10), Review settings (15) below Agent presets (20), and
    // MCP servers (25) below Plugins (30), because each group's table lists
    // them that way. The trailing group keeps ledger order instead.
    expect(groupMembers()).toEqual([
      ['General', 'At file'],
      ['Models', 'Vision'],
      ['Agent presets', 'Review settings'],
      ['Plugins', 'MCP servers', 'Screenshot logins'],
      ['Balance'],
      ['Desktop update'],
      ['Contributed', 'Late contribution'],
    ])
  })

  it('draws every section exactly once across the groups', () => {
    mount({ rows: EVERY_SECTION })
    openPanel()
    // A section id listed by two groups of the table would draw two rows,
    // both marked current, with nothing in the types to catch it.
    const drawn = groupMembers().flat()
    expect(drawn).toHaveLength(EVERY_SECTION.length)
    expect(new Set(drawn).size).toBe(drawn.length)
  })

  it('keeps a section the table never named, in the trailing group, and opens it', () => {
    mount({ rows: EVERY_SECTION })
    openPanel()
    const unknown = screen.getByRole('button', { name: 'Contributed' })
    expect(screen.getByRole('group', { name: 'Other' }).contains(unknown)).toBe(true)
    fireEvent.click(unknown)
    expect(unknown.getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-contributed')).toBeTruthy()
  })

  it('draws no title for a group whose sections are all absent', () => {
    // The default fixture registers one section in each of three groups.
    mount()
    openPanel()
    expect(groupTitles()).toEqual(['General', 'Models', 'Agent'])
    expect(groupMembers()).toEqual([['General'], ['Models'], ['Agent presets']])
  })

  it('carries the rail glyphs on the group titles and none on a member row', () => {
    mount({ rows: EVERY_SECTION })
    openPanel()
    // Glyphs carry no id of their own, so the drawn paths are what tells them apart.
    const glyphs = [...document.querySelectorAll('[class*="navGroupTitle"]')]
      .map(title => title.querySelector('svg')?.innerHTML)
    expect(glyphs.every(glyph => glyph !== undefined && glyph !== '')).toBe(true)
    // Six named groups, six glyphs; the trailing catch-all shares General's gear.
    expect(new Set(glyphs.slice(0, 6)).size).toBe(6)
    expect(glyphs[6]).toBe(glyphs[0])
    for (const cell of document.querySelectorAll('[class*="navCell"]')) {
      expect(cell.querySelector('svg')).toBeNull()
    }
  })

  it('names each group for assistive technology without making the title a control', () => {
    mount({ rows: EVERY_SECTION })
    openPanel()
    const extensions = screen.getByRole('group', { name: 'Extensions' })
    const title = extensions.querySelector('[class*="navGroupTitle"]')!
    expect(extensions.getAttribute('aria-labelledby')).toBe(title.id)
    expect(title.tagName).toBe('DIV')
    expect(screen.getAllByRole('group')).toHaveLength(7)
  })

  it('takes the group titles from the active locale', () => {
    mount({ rows: EVERY_SECTION, dictionary: zh })
    openPanel('设置')
    expect(groupTitles()).toEqual(['通用', '模型', '智能体', '扩展', '账户与用量', '关于', '其他'])
  })

  it('switches the rendered section on nav click', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('button', { name: 'Models' }).getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    act(() => {
      (second?.[1] as { openSection: (id: string) => void }).openSection('models')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-models')).toBeTruthy()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })

  it('falls back to the first row when the active entry unregisters', () => {
    const { bump } = mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Models' }))
    bump([{ id: 'general', order: 0, label: 'General' }])
    expect(screen.queryByRole('button', { name: 'Models' })).toBeNull()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ rows: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(c => c[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})
