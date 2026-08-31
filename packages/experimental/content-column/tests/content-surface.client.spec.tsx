// @vitest-environment jsdom
/**
 * The content column under its props form, driven by a fake session feed and a
 * recording renderSlot stub. The assertions are the user-visible ones plus the
 * decision the router rests on: a seat is not unmounted when another kind takes
 * the column, and a session switch neither unmounts one nor carries the other
 * session's choice over.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContentSurface, type ContentSurfaceProps } from '../src/client/ContentSurface.tsx'
import { entryKeyOf } from '../src/client/surface-seats.ts'
import { zh } from '../src/client/locales.ts'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'

/** One published entry. */
function entry(kind: string, entryId: string, seq: number): ContentSurfaceEntry {
  return { kind, entryId, seq, title: `${kind} ${entryId}`, payload: { id: entryId } }
}

const CHART = entry('chart', 'sales', 9)
const PAGE = entry('page', 'reports', 4)
const OTHER = entry('page', 'home', 7)

/** The session facts the column reads, as one render's worth of feed. */
interface Feed {
  current?: string
  entries?: Record<string, readonly ContentSurfaceEntry[]>
}

/**
 * Stand in for the framework's `useSessions` selector hook over one feed.
 * @param feed - the session list state this render sees.
 * @returns the hook the column calls.
 */
function sessionsHook(feed: Feed): ContentSurfaceProps['useSessions'] {
  const state = {
    current: feed.current,
    byId: Object.fromEntries(Object.entries(feed.entries ?? {})
      .map(([id, entries]) => [id, { projectionValues: { contentSurface: { entries } } }])),
  }
  return ((selector: (snapshot: unknown) => unknown) => selector(state)) as ContentSurfaceProps['useSessions']
}

/** One renderSlot dispatch. */
type Dispatch = { key: string; entryKey: string | undefined; owner: unknown }

/** One `onDismiss` call. */
type DismissCall = { sessionId: string; kind: string; entryId: string }

/**
 * The last dispatch each seat received. The column folds its seat list during
 * render, so a pass that mounts a new seat is followed by a second one; what a
 * seat ends up with is the last call naming it.
 */
function perSeat(calls: readonly Dispatch[]): Dispatch[] {
  const latest = new Map<string, Dispatch>()
  for (const call of calls) latest.set(call.entryKey ?? '', call)
  return [...latest.values()]
}

/** Render the column for one feed, reusing an existing tree when given one. */
function mount(
  feed: Feed,
  registered: readonly string[],
  view?: { view: ReturnType<typeof render>; calls: Dispatch[]; dismissed: DismissCall[] },
): { view: ReturnType<typeof render>; calls: Dispatch[]; dismissed: DismissCall[] } {
  const calls = view?.calls ?? []
  const dismissed = view?.dismissed ?? []
  const renderSlot = (key: string, owner: object, opts?: { entryKey?: string; fallback?: ReactNode }) => {
    calls.push({ key, entryKey: opts?.entryKey, owner })
    return registered.includes(opts?.entryKey ?? '')
      ? <div data-testid={`seat-${opts?.entryKey ?? ''}`} />
      : opts?.fallback ?? null
  }
  const props = {
    useSessions: sessionsHook(feed),
    renderSlot,
    onDismiss: (sessionId: string, kind: string, entryId: string) => { dismissed.push({ sessionId, kind, entryId }) },
    t: makeTranslate(zh),
  } as unknown as ContentSurfaceProps
  const element = <ContentSurface {...props} />
  if (view === undefined) return { view: render(element), calls, dismissed }
  view.view.rerender(element)
  return { view: view.view, calls, dismissed }
}

/** The switcher's buttons, in the order the strip lists them. */
function strip(view: ReturnType<typeof render>): string[] {
  return [...view.container.querySelectorAll('[data-content-surface-entry]')]
    .map(button => button.getAttribute('data-content-surface-entry') ?? '')
}

/** The entry key the strip marks as selected, if any. */
function selected(view: ReturnType<typeof render>): string | null {
  return view.container.querySelector('[data-content-surface-selected]')?.getAttribute('data-content-surface-entry') ?? null
}

/** The seat the column is showing, if any. */
function activeSeat(view: ReturnType<typeof render>): string | null {
  return view.container.querySelector('[data-content-surface-active]')?.getAttribute('data-content-surface-seat') ?? null
}

/** Every mounted seat, in DOM order, as `kind → element`. */
function seats(view: ReturnType<typeof render>): Map<string, Element> {
  return new Map([...view.container.querySelectorAll('[data-content-surface-seat]')]
    .map(seat => [seat.getAttribute('data-content-surface-seat') ?? '', seat]))
}

/** One entry's close button, by its switcher key. */
function dismissButton(view: ReturnType<typeof render>, key: string): Element | null {
  return view.container.querySelector(`[data-content-surface-dismiss=${JSON.stringify(key)}]`)
}

afterEach(() => {
  cleanup()
})

describe('content column', () => {
  it('explains an empty column when no session is current', () => {
    const { view } = mount({}, ['page'])
    expect(view.container.querySelector('[data-content-surface-empty]')?.textContent).toBe(zh['column.empty'])
    expect(strip(view)).toEqual([])
  })

  it('explains an empty column for a session that produced nothing', () => {
    const { view } = mount({ current: 'a', entries: { a: [] } }, ['page'])
    expect(view.container.querySelector('[data-content-surface-empty]')?.textContent).toBe(zh['column.empty'])
  })

  it('lists the session\'s entries newest first and shows the newest', () => {
    const { view } = mount({ current: 'a', entries: { a: [CHART, OTHER, PAGE] } }, ['page', 'chart'])
    expect(strip(view)).toEqual(['chart sales', 'page home', 'page reports'])
    expect(selected(view)).toBe('chart sales')
    expect(activeSeat(view)).toBe('chart')
  })

  it('hands the selected entry to its own kind and nothing to the others', () => {
    const { calls } = mount({ current: 'a', entries: { a: [CHART, PAGE] } }, ['page', 'chart'])
    expect(perSeat(calls).map(call => [call.entryKey, (call.owner as { entry?: unknown }).entry])).toEqual([
      ['chart', CHART],
      ['page', undefined],
    ])
    expect(calls.every(call => call.key === 'content.surface.kind')).toBe(true)
    expect(new Set(calls.map(call => (call.owner as { sessionId?: string }).sessionId))).toEqual(new Set(['a']))
  })

  it('shows the entry the user picks and keeps every seat mounted across the switch', () => {
    const { view } = mount({ current: 'a', entries: { a: [CHART, PAGE] } }, ['page', 'chart'])
    const chartSeat = seats(view).get('chart')

    fireEvent.click(view.getByText('page reports'))
    expect(selected(view)).toBe('page reports')
    expect(activeSeat(view)).toBe('page')
    // The chart's seat is hidden, not gone — that is what keeps a renderer's
    // own DOM alive across the round trip.
    expect(seats(view).get('chart')).toBe(chartSeat)

    fireEvent.click(view.getByText('chart sales'))
    expect(activeSeat(view)).toBe('chart')
    expect(seats(view).get('chart')).toBe(chartSeat)
  })

  it('keeps one choice per session and never mounts a kind twice', () => {
    const feed = { current: 'a', entries: { a: [CHART, PAGE], b: [OTHER] } }
    const first = mount(feed, ['page', 'chart'])
    fireEvent.click(first.view.getByText('page reports'))
    expect(selected(first.view)).toBe('page reports')

    // The other session has never been chosen for, so it shows its own newest.
    mount({ ...feed, current: 'b' }, ['page', 'chart'], first)
    expect(selected(first.view)).toBe('page home')
    expect([...seats(first.view).keys()]).toEqual(['chart', 'page'])

    mount(feed, ['page', 'chart'], first)
    expect(selected(first.view)).toBe('page reports')
  })

  it('mounts a seat for a kind nothing renders and says so when it is selected', () => {
    const { view } = mount({ current: 'a', entries: { a: [entry('memo', 'one', 3)] } }, ['page'])
    expect(view.container.querySelector('[data-content-surface-seat="memo"]')?.textContent)
      .toBe(zh['entry.unsupported'].replace('{kind}', 'memo'))
  })

  it('keeps a seat mounted after its kind stops producing entries', () => {
    const first = mount({ current: 'a', entries: { a: [CHART, PAGE] } }, ['page', 'chart'])
    const pageSeat = seats(first.view).get('page')
    mount({ current: 'a', entries: { a: [CHART] } }, ['page', 'chart'], first)
    expect(seats(first.view).get('page')).toBe(pageSeat)
    expect(activeSeat(first.view)).toBe('chart')
  })

  it('closes a tab through a sibling button, never one nested inside the selection button', () => {
    const { view, dismissed } = mount({ current: 'a', entries: { a: [CHART, PAGE] } }, ['page', 'chart'])
    const closeButton = dismissButton(view, entryKeyOf(PAGE))
    expect(closeButton?.tagName).toBe('BUTTON')
    // Not a descendant of the selection button: a sibling in the tab wrapper.
    expect(closeButton?.closest('[data-content-surface-entry]')).toBeNull()

    fireEvent.click(closeButton as Element)
    expect(dismissed).toEqual([{ sessionId: 'a', kind: 'page', entryId: 'reports' }])
    // Nothing else moved: the close button dispatches, it does not select.
    expect(selected(view)).toBe('chart sales')
  })

  it('keeps data-content-surface-entry and data-content-surface-selected on the selection button, not the tab wrapper', () => {
    const { view } = mount({ current: 'a', entries: { a: [CHART] } }, ['chart'])
    const entryButton = view.container.querySelector('[data-content-surface-entry]')
    expect(entryButton?.tagName).toBe('BUTTON')
    expect(entryButton?.hasAttribute('data-content-surface-selected')).toBe(true)
    // The dismiss button is a sibling in the same wrapper, not a descendant.
    expect(entryButton?.querySelector('[data-content-surface-dismiss]')).toBeNull()
  })

  it('falls back to the newest surviving entry once the picked tab is closed', () => {
    const { view } = mount({ current: 'a', entries: { a: [CHART, PAGE] } }, ['page', 'chart'])
    fireEvent.click(view.getByText('page reports'))
    expect(selected(view)).toBe('page reports')

    // Dismissal happens in the log; this component only ever sees its effect
    // — the entry gone from the next render's feed — never the command itself.
    const next = mount({ current: 'a', entries: { a: [CHART] } }, ['page', 'chart'], { view, calls: [], dismissed: [] })
    expect(selected(next.view)).toBe('chart sales')
  })
})
