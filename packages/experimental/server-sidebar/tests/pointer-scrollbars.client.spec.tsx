// @vitest-environment jsdom
/**
 * Pointer-revealed scrollbars, ported unchanged from
 * `dsh-client-ui-sidebar`'s own `pointer-scrollbars.client.spec.tsx` — this
 * package's `ServerSidebarRoot` carries the same geometry verbatim (see its
 * module doc). The stylesheet rule this state drives is that package's own
 * concern, not re-asserted here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ServerSidebarRoot, type ServerSidebarRootComponentProps } from '../src/client/ServerSidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

const COLUMN_WIDTH = 280
const COLUMN_HEIGHT = 600

const t: ServerSidebarRootComponentProps['t'] = (key, vars?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = vars[name]
      return typeof value === 'string' ? value : ''
    })
}
const emptySessions = (<S,>(sel: (s: { current: undefined; byId: Record<string, never>; phase: 'ready' }) => S): S =>
  sel({ current: undefined, byId: {}, phase: 'ready' })) as unknown as ServerSidebarRootComponentProps['useSessions']

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * Render the shell and expose its column element.
 * @returns the column element and whether it currently carries the quiet state.
 */
function mountColumn(): { column: HTMLElement; quiet: () => boolean } {
  const view = render(
    <ServerSidebarRoot
      collapsed={false} width={300}
      t={t}
      pages={[]} onOpenPage={() => Promise.resolve()}
      onOpenWorkbench={() => Promise.resolve()} onOpenWorkflow={() => Promise.resolve()}
      onSaveWorkflows={() => Promise.resolve()}
      useStore={(<S,>(sel: (s: { workflows: never[]; workbenchSessionId: undefined; error: undefined }) => S): S =>
        sel({ workflows: [], workbenchSessionId: undefined, error: undefined }))}
      actions={{ setServerMenu: vi.fn(), setError: vi.fn() }}
      useSessions={emptySessions}
      useWorkspaces={() => { throw new Error('shell must not read global hooks in this bench') }}
      renderSlot={((_key: string, _owner: unknown, options?: { fallback?: ReactNode }) =>
        options?.fallback ?? <div data-testid="region" />) as ServerSidebarRootComponentProps['renderSlot']}
    />,
  )
  const column = view.container.firstElementChild
  if (!(column instanceof HTMLElement)) throw new Error('sidebar column not rendered')
  // jsdom lays nothing out, and the leave decision is geometric: pin the box
  // the shell reads so a coordinate can be inside or outside it.
  Object.defineProperty(column, 'getBoundingClientRect', {
    value: () => ({
      left: 0, top: 0, right: COLUMN_WIDTH, bottom: COLUMN_HEIGHT,
      x: 0, y: 0, width: COLUMN_WIDTH, height: COLUMN_HEIGHT, toJSON: () => ({}),
    }),
  })
  // CSS-module locals are hashed in this bench, so the state is read as a
  // substring of the class list rather than as an exact local name.
  return { column, quiet: () => [...column.classList].some(name => name.includes('quietBars')) }
}

/**
 * Cross the pointer into or out of the column. React synthesizes
 * `pointerenter`/`pointerleave` from `pointerover`/`pointerout`, so the raw
 * enter and leave events it does not listen to would assert nothing.
 * @param column - the sidebar column element.
 * @param direction - `in` to enter the column, `out` to leave it.
 */
function movePointer(column: HTMLElement, direction: 'in' | 'out'): void {
  const outside = document.body
  if (direction === 'in') fireEvent.pointerOver(column, { relatedTarget: outside })
  else fireEvent.pointerOut(column, { relatedTarget: outside })
}

/**
 * Move the pointer over the document, as a pointer crossing a fixed overlay
 * that is a DOM descendant of the column does.
 * @param x - client x coordinate.
 * @param y - client y coordinate.
 */
function movePointerOverDocument(x: number, y: number): void {
  fireEvent.pointerMove(document, { clientX: x, clientY: y })
}

describe('ServerSidebarRoot pointer-revealed scrollbars', () => {
  it('draws them only while the pointer is inside, and lingers on the way out', () => {
    vi.useFakeTimers()
    const { column, quiet } = mountColumn()
    expect(quiet()).toBe(true)
    movePointer(column, 'in')
    expect(quiet()).toBe(false)
    movePointer(column, 'out')
    act(() => { vi.advanceTimersByTime(1999) })
    expect(quiet()).toBe(false)
    act(() => { vi.advanceTimersByTime(1) })
    expect(quiet()).toBe(true)
  })

  it('cancels a pending hide when the pointer comes back', () => {
    vi.useFakeTimers()
    const { column, quiet } = mountColumn()
    movePointer(column, 'in')
    movePointer(column, 'out')
    act(() => { vi.advanceTimersByTime(1000) })
    movePointer(column, 'in')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(quiet()).toBe(false)
  })

  it('hides when the pointer moves outside the column box without leaving its subtree', () => {
    vi.useFakeTimers()
    const { column, quiet } = mountColumn()
    movePointer(column, 'in')
    expect(quiet()).toBe(false)
    movePointerOverDocument(COLUMN_WIDTH + 400, 300)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(quiet()).toBe(true)
  })

  it('does not restart the window when the pointer keeps moving outside', () => {
    vi.useFakeTimers()
    const { column, quiet } = mountColumn()
    movePointer(column, 'in')
    movePointer(column, 'out')
    act(() => { vi.advanceTimersByTime(1500) })
    movePointerOverDocument(COLUMN_WIDTH + 400, 300)
    act(() => { vi.advanceTimersByTime(600) })
    expect(quiet()).toBe(true)
  })

  it('keeps them drawn while the pointer moves inside the column box', () => {
    vi.useFakeTimers()
    const { column, quiet } = mountColumn()
    movePointer(column, 'in')
    movePointer(column, 'out')
    movePointerOverDocument(COLUMN_WIDTH - 10, 300)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(quiet()).toBe(false)
  })

  it('drops the pending hide when the column unmounts', () => {
    vi.useFakeTimers()
    const { column } = mountColumn()
    movePointer(column, 'in')
    movePointer(column, 'out')
    cleanup()
    expect(() => { vi.advanceTimersByTime(5000) }).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
