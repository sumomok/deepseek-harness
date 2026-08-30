// @vitest-environment jsdom
/**
 * `WorkflowGroup`'s rename/remove/drag-reorder interactions, the active
 * highlight, and its empty/error states. Ordering, unread dot, and
 * open/save wiring get their own focused assertions; the pure `reordered`
 * transform's own edge cases are `workflow-actions.client.spec.ts`'s
 * concern — this file exercises the drag-event wiring around it.
 * `server-sidebar-root.client.spec.tsx` covers this component seated inside
 * the shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act, cleanup, fireEvent, render, screen,
} from '@testing-library/react'
import { WorkflowGroup, type WorkflowGroupProps } from '../src/client/WorkflowGroup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSidebarKey } from '../src/client/locales.ts'
import type { ServerMenuWorkflow } from '../src/client/workflow-api.ts'

const t: WorkflowGroupProps['t'] = (key: ServerSidebarKey, vars?: Record<string, string>) => {
  const template = en[key]
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '')
}

function workflow(overrides: Partial<ServerMenuWorkflow>): ServerMenuWorkflow {
  return { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...overrides }
}

function baseProps(overrides: Partial<WorkflowGroupProps> = {}): WorkflowGroupProps {
  return {
    workflows: [],
    current: undefined,
    unreadHomeSessionIds: new Set(),
    onOpenWorkflow: vi.fn(() => Promise.resolve()),
    onSaveWorkflows: vi.fn(() => Promise.resolve()),
    error: undefined,
    t,
    ...overrides,
  }
}

/**
 * A minimal HTML5 `DataTransfer` double: jsdom does not implement the real
 * interface, and the component only ever calls `setData` (to mark the drag
 * as its own) and reads `effectAllowed` as a plain property.
 */
function dataTransfer(): { effectAllowed: string; setData: ReturnType<typeof vi.fn> } {
  return { effectAllowed: '', setData: vi.fn() }
}

/**
 * Dispatch a native `dragover`/`drop` carrying `clientY`: jsdom has no
 * `DragEvent` constructor, so `@testing-library/dom`'s own `fireEvent`
 * falls back to a plain `Event` for these types and only special-cases
 * `dataTransfer`/`clipboardData` — `clientY` from its `init` argument is
 * silently dropped (see its `createEvent`). Defining `clientY` directly on
 * a plain `Event` before dispatch reaches `rowHalf` exactly as a real
 * `DragEvent`'s constructor-applied field would, since React's synthetic
 * event reads it by plain property access either way. Wrapped in `act`
 * (the same pattern `input-bar.client.spec.tsx` uses for its own
 * testing-library-unsupported native event, `beforeinput`) since dispatching
 * outside `fireEvent` bypasses its `act`-wrapping event wrapper.
 */
function dragOverAt(element: Element, clientY: number): void {
  const event = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true })
  act(() => { element.dispatchEvent(event) })
}

/** Same rationale as {@link dragOverAt}, for the `drop` event. */
function dropAt(element: Element, clientY: number): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true })
  act(() => { element.dispatchEvent(event) })
}

afterEach(() => {
  cleanup()
})

describe('WorkflowGroup', () => {
  it('shows the empty copy when there are no workflows', () => {
    render(<WorkflowGroup {...baseProps()} />)
    expect(screen.getByText(en['workflows.empty'])).toBeTruthy()
  })

  it('renders workflows sorted by order and opens one on click', () => {
    const onOpenWorkflow = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w2', name: 'Second', order: 1 }), workflow({ id: 'w1', name: 'First', order: 0 })]
    render(<WorkflowGroup {...baseProps({ workflows, onOpenWorkflow })} />)
    const rows = screen.getAllByRole('button', { name: /First|Second/ })
    expect(rows.map(row => row.textContent)).toEqual(['First', 'Second'])
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(onOpenWorkflow).toHaveBeenCalledWith(workflows[1])
  })

  it('breaks a tied order on id', () => {
    const workflows = [workflow({ id: 'zeta', name: 'Zeta', order: 0 }), workflow({ id: 'alpha', name: 'Alpha', order: 0 })]
    render(<WorkflowGroup {...baseProps({ workflows })} />)
    const rows = screen.getAllByRole('button', { name: /Alpha|Zeta/ })
    expect(rows.map(row => row.textContent)).toEqual(['Alpha', 'Zeta'])
  })

  it('renders the unread dot only for a workflow whose bound session has unseen output', () => {
    const workflows = [workflow({ id: 'w1', name: 'First', homeSessionId: 's1' }), workflow({ id: 'w2', name: 'Second', homeSessionId: 's2', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, unreadHomeSessionIds: new Set(['s2']) })} />)
    const secondRow = screen.getByRole('button', { name: /Second/ })
    expect(secondRow.querySelector('[aria-hidden="true"]')).not.toBeNull()
    const firstRow = screen.getByRole('button', { name: 'First' })
    expect(firstRow.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  describe('selection highlight', () => {
    it('marks the row active when its bound session is current', () => {
      const workflows = [workflow({ id: 'w1', name: 'First', homeSessionId: 's1' })]
      render(<WorkflowGroup {...baseProps({ workflows, current: 's1' })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('true')
    })

    it('does not mark the row active when a different session is current', () => {
      const workflows = [workflow({ id: 'w1', name: 'First', homeSessionId: 's1' })]
      render(<WorkflowGroup {...baseProps({ workflows, current: 'other' })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('false')
    })

    it('does not mark any row active with no current session', () => {
      const workflows = [workflow({ id: 'w1', name: 'First', homeSessionId: 's1' })]
      render(<WorkflowGroup {...baseProps({ workflows, current: undefined })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('false')
    })
  })

  it('renames a workflow on blur, leaving the others untouched', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w1', name: 'First' }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.rename'] })[0]!)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('First')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    expect(onSaveWorkflows).toHaveBeenCalledWith([
      { ...workflows[0], name: 'Renamed' },
      workflows[1],
    ])
  })

  it('commits a rename on Enter through the same blur path', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], onSaveWorkflows })} />)
    fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onSaveWorkflows).toHaveBeenCalled()
  })

  it('discards a rename on Escape without saving', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], onSaveWorkflows })} />)
    fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onSaveWorkflows).not.toHaveBeenCalled()
  })

  it('leaves a rename in place on an unrelated keystroke', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], onSaveWorkflows })} />)
    fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(onSaveWorkflows).not.toHaveBeenCalled()
  })

  it('does not save a rename whose trimmed name is empty', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], onSaveWorkflows })} />)
    fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onSaveWorkflows).not.toHaveBeenCalled()
  })

  it('is not draggable while its own row is mid-rename', () => {
    render(<WorkflowGroup {...baseProps({ workflows: [workflow({ id: 'w1', name: 'First' })] })} />)
    fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
    expect(screen.getByRole('listitem').getAttribute('draggable')).toBe('false')
  })

  it('removes a workflow via its trash action', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w1', name: 'First' }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.remove'] })[0]!)
    expect(onSaveWorkflows).toHaveBeenCalledWith([workflows[1]])
  })

  describe('drag-and-drop reorder', () => {
    // jsdom's default `getBoundingClientRect` is all zeros, so a row's own
    // vertical midpoint is `clientY === 0`; a negative `clientY` lands in
    // the top half ("before"), a positive one in the bottom half ("after").
    // The exact pixel geometry is `rowHalf`'s own concern (identical to
    // ui-workspace's own precedent) — this file only exercises which half
    // the wiring routes to which outcome.

    it('drops on the top half: moves the dragged row before the hovered one', () => {
      const onSaveWorkflows = vi.fn(() => Promise.resolve())
      const workflows = [
        workflow({ id: 'w1', name: 'First', order: 0 }),
        workflow({ id: 'w2', name: 'Second', order: 1 }),
        workflow({ id: 'w3', name: 'Third', order: 2 }),
      ]
      render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
      const rows = screen.getAllByRole('listitem')
      const dt = dataTransfer()
      fireEvent.dragStart(rows[2]!, { dataTransfer: dt })
      dragOverAt(rows[0]!, -1)
      dropAt(rows[0]!, -1)
      expect(onSaveWorkflows).toHaveBeenCalledWith([
        { ...workflows[0], order: 1 },
        { ...workflows[1], order: 2 },
        { ...workflows[2], order: 0 },
      ])
      expect(dt.setData).toHaveBeenCalledWith('text/plain', 'w3')
    })

    it('drops on the bottom half of a middle row: moves the dragged row after it, before its successor', () => {
      const onSaveWorkflows = vi.fn(() => Promise.resolve())
      const workflows = [
        workflow({ id: 'w1', name: 'First', order: 0 }),
        workflow({ id: 'w2', name: 'Second', order: 1 }),
        workflow({ id: 'w3', name: 'Third', order: 2 }),
      ]
      render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      dragOverAt(rows[1]!, 1)
      dropAt(rows[1]!, 1)
      expect(onSaveWorkflows).toHaveBeenCalledWith([
        { ...workflows[0], order: 1 },
        { ...workflows[1], order: 0 },
        { ...workflows[2], order: 2 },
      ])
    })

    it('drops on the bottom half of the last row: appends the dragged row to the end', () => {
      const onSaveWorkflows = vi.fn(() => Promise.resolve())
      const workflows = [
        workflow({ id: 'w1', name: 'First', order: 0 }),
        workflow({ id: 'w2', name: 'Second', order: 1 }),
        workflow({ id: 'w3', name: 'Third', order: 2 }),
      ]
      render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      dragOverAt(rows[2]!, 1)
      dropAt(rows[2]!, 1)
      expect(onSaveWorkflows).toHaveBeenCalledWith([
        { ...workflows[0], order: 2 },
        { ...workflows[1], order: 0 },
        { ...workflows[2], order: 1 },
      ])
    })

    it('shows a drop-position indicator on the hovered row while dragging, and clears both rows on drag end', () => {
      const workflows = [workflow({ id: 'w1', name: 'First', order: 0 }), workflow({ id: 'w2', name: 'Second', order: 1 })]
      render(<WorkflowGroup {...baseProps({ workflows })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      expect(rows[0]!.getAttribute('data-dragging')).toBe('true')
      dragOverAt(rows[1]!, -1)
      expect(rows[1]!.getAttribute('data-drop-position')).toBe('before')
      fireEvent.dragEnd(rows[0]!)
      expect(rows[0]!.getAttribute('data-dragging')).toBe('false')
      expect(rows[1]!.getAttribute('data-drop-position')).toBeNull()
    })

    it('does not indicate a drop position when a drag hovers its own source row', () => {
      // A real browser never fires `drop` here either, since `dragOver`
      // declines to call `preventDefault` for this pairing — the same
      // reason `drop`'s own `draggedId === null` guard stays untested (see
      // its comment): both describe combinations a genuine drag can never
      // reach through this component's own wiring.
      const workflows = [workflow({ id: 'w1', name: 'First', order: 0 }), workflow({ id: 'w2', name: 'Second', order: 1 })]
      render(<WorkflowGroup {...baseProps({ workflows })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      dragOverAt(rows[0]!, -1)
      expect(rows[0]!.getAttribute('data-drop-position')).toBeNull()
    })
  })

  it('surfaces a pending save error as an alert with the message interpolated', () => {
    render(<WorkflowGroup {...baseProps({ error: 'HTTP 503' })} />)
    expect(screen.getByRole('alert').textContent).toBe(en['workflows.error'].replace('{message}', 'HTTP 503'))
  })
})
