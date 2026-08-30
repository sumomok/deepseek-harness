// @vitest-environment jsdom
/**
 * `WorkflowGroup`'s rename/remove/move-up/move-down interactions and its
 * empty/error states. Ordering, unread dot, and open/save wiring get their
 * own focused assertions; `server-sidebar-root.client.spec.tsx` covers this
 * component seated inside the shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
    unreadHomeSessionIds: new Set(),
    onOpenWorkflow: vi.fn(() => Promise.resolve()),
    onSaveWorkflows: vi.fn(() => Promise.resolve()),
    error: undefined,
    t,
    ...overrides,
  }
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

  it('removes a workflow via its trash action', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w1', name: 'First' }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.remove'] })[0]!)
    expect(onSaveWorkflows).toHaveBeenCalledWith([workflows[1]])
  })

  it('moves a workflow up, swapping order with its predecessor', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w1', name: 'First', order: 0 }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.moveUp'] })[1]!)
    expect(onSaveWorkflows).toHaveBeenCalledWith([
      { ...workflows[0], order: 1 },
      { ...workflows[1], order: 0 },
    ])
  })

  it('moves a workflow down, swapping order with its successor', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [workflow({ id: 'w1', name: 'First', order: 0 }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.moveDown'] })[0]!)
    expect(onSaveWorkflows).toHaveBeenCalledWith([
      { ...workflows[0], order: 1 },
      { ...workflows[1], order: 0 },
    ])
  })

  it('leaves a third, untouched workflow exactly as it was', () => {
    const onSaveWorkflows = vi.fn(() => Promise.resolve())
    const workflows = [
      workflow({ id: 'w1', name: 'First', order: 0 }),
      workflow({ id: 'w2', name: 'Second', order: 1 }),
      workflow({ id: 'w3', name: 'Third', order: 2 }),
    ]
    render(<WorkflowGroup {...baseProps({ workflows, onSaveWorkflows })} />)
    fireEvent.click(screen.getAllByRole('button', { name: en['workflows.moveDown'] })[0]!)
    expect(onSaveWorkflows).toHaveBeenCalledWith([
      { ...workflows[0], order: 1 },
      { ...workflows[1], order: 0 },
      workflows[2],
    ])
  })

  it('disables moving the first row up and the last row down', () => {
    const workflows = [workflow({ id: 'w1', name: 'First', order: 0 }), workflow({ id: 'w2', name: 'Second', order: 1 })]
    render(<WorkflowGroup {...baseProps({ workflows })} />)
    expect((screen.getAllByRole('button', { name: en['workflows.moveUp'] })[0] as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getAllByRole('button', { name: en['workflows.moveDown'] })[1] as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces a pending save error as an alert with the message interpolated', () => {
    render(<WorkflowGroup {...baseProps({ error: 'HTTP 503' })} />)
    expect(screen.getByRole('alert').textContent).toBe(en['workflows.error'].replace('{message}', 'HTTP 503'))
  })
})
