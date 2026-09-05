// @vitest-environment jsdom
/**
 * `WorkflowGroup`'s lanes (pinned groups, then the rest, then the ungrouped
 * rows), its group create/rename/pin/delete controls, its per-row
 * rename/remove/移动到… controls, and the drag-and-drop wiring around both.
 * The pure transforms behind every save — `createGroup`, `pinGroup`,
 * `deleteGroup`, `moveWorkflow`, `reorderWithinGroup` and the lane
 * selectors — are `workflow-actions.client.spec.ts`'s concern; this file
 * exercises which control routes to which one, with which arguments.
 * `server-sidebar-root.client.spec.tsx` covers this component seated inside
 * the shell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WorkflowGroup, type WorkflowGroupProps } from '../src/client/WorkflowGroup.tsx'
import { en } from '../src/client/locales.ts'
import type { ServerSidebarKey } from '../src/client/locales.ts'
import type { ServerMenuGroup, ServerMenuWorkflow } from '../src/client/workflow-api.ts'
import { MAX_GROUP_NAME_LENGTH } from '../src/menu-constants.ts'

const t: WorkflowGroupProps['t'] = (key: ServerSidebarKey, vars?: Record<string, string>) => {
  const template = en[key]
  if (vars === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => vars[name] ?? '')
}

function workflow(overrides: Partial<ServerMenuWorkflow>): ServerMenuWorkflow {
  return { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...overrides }
}

function group(overrides: Partial<ServerMenuGroup>): ServerMenuGroup {
  return { id: 'g1', name: 'Group One', pinned: false, order: 0, ...overrides }
}

function baseProps(overrides: Partial<WorkflowGroupProps> = {}): WorkflowGroupProps {
  return {
    workflows: [],
    groups: [],
    collapsed: {},
    onSetCollapsed: vi.fn(),
    current: undefined,
    unreadHomeSessionIds: new Set(),
    onOpenWorkflow: vi.fn(() => Promise.resolve()),
    onSaveMenu: vi.fn(() => Promise.resolve()),
    newGroupId: () => 'g-new',
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
function dragEventAt(type: 'dragover' | 'drop', element: Element, clientY: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY, configurable: true })
  act(() => { element.dispatchEvent(event) })
}

/** The header element of the lane whose group carries `name`. */
function laneHead(name: string): HTMLElement {
  const head = screen.getByText(name).parentElement
  if (head === null) throw new Error(`no lane head for ${name}`)
  return head
}

afterEach(() => {
  cleanup()
})

describe('WorkflowGroup', () => {
  it('shows the empty copy when there is neither a workflow nor a group', () => {
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

  it('renders the unread dot only for a workflow whose bound session has unseen output', () => {
    const workflows = [
      workflow({ id: 'w1', name: 'First', homeSessionId: 's1' }),
      workflow({ id: 'w2', name: 'Second', homeSessionId: 's2', order: 1 }),
    ]
    render(<WorkflowGroup {...baseProps({ workflows, unreadHomeSessionIds: new Set(['s2']) })} />)
    expect(screen.getByRole('button', { name: /Second/ }).querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'First' }).querySelector('[aria-hidden="true"]')).toBeNull()
  })

  describe('selection highlight', () => {
    it('marks the row active when its bound session is current', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({ name: 'First' })], current: 's1' })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('true')
    })

    it('does not mark the row active when a different session is current', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({ name: 'First' })], current: 'other' })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('false')
    })

    it('does not mark any row active with no current session', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({ name: 'First' })] })} />)
      expect(screen.getByRole('button', { name: 'First' }).getAttribute('data-active')).toBe('false')
    })
  })

  describe('lanes', () => {
    it('draws pinned groups first, then the rest by order, then the ungrouped rows', () => {
      const groups = [
        group({ id: 'later', name: 'Later', order: 2 }),
        group({ id: 'pinned', name: 'Pinned', order: 5, pinned: true }),
        group({ id: 'first', name: 'First Group', order: 1 }),
      ]
      const workflows = [
        workflow({ id: 'w1', name: 'In Later', groupId: 'later' }),
        workflow({ id: 'w2', name: 'In Pinned', groupId: 'pinned', order: 1 }),
        workflow({ id: 'w3', name: 'Loose', order: 2 }),
      ]
      render(<WorkflowGroup {...baseProps({ groups, workflows })} />)
      expect(screen.getAllByRole('listitem').map(row => row.querySelector('button')?.textContent))
        .toEqual(['In Pinned', 'In Later', 'Loose'])
      expect([...document.querySelectorAll('h3, span')]
        .map(node => node.textContent)
        .filter(text => text === 'Pinned' || text === 'First Group' || text === 'Later'))
        .toEqual(['Pinned', 'First Group', 'Later'])
    })

    it('files a workflow naming no stored group into the top-level lane', () => {
      const workflows = [workflow({ id: 'w1', name: 'Orphan', groupId: 'gone' })]
      render(<WorkflowGroup {...baseProps({ groups: [group({})], workflows })} />)
      expect(screen.getByRole('button', { name: 'Orphan' })).toBeTruthy()
      expect(screen.getByText(en['groups.empty'])).toBeTruthy()
    })

    it('marks a pinned lane and gives it a badge', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({ pinned: true })] })} />)
      expect(screen.getByRole('img', { name: en['groups.pinned'] })).toBeTruthy()
    })

    it('draws no badge on an unpinned lane', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({})] })} />)
      expect(screen.queryByRole('img', { name: en['groups.pinned'] })).toBeNull()
    })
  })

  describe('group controls', () => {
    it('creates a group from the section header, minting its id', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: '  Reports  ' } })
      fireEvent.blur(input)
      expect(onSaveMenu).toHaveBeenCalledWith({
        groups: [{ id: 'g-new', name: 'Reports', pinned: false, order: 0 }],
      })
    })

    it('commits a new group on Enter and abandons it on Escape', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(onSaveMenu).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reports' } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      expect(onSaveMenu).toHaveBeenCalledTimes(1)
    })

    it('does not create a group whose trimmed name is empty', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
      fireEvent.blur(screen.getByRole('textbox'))
      expect(onSaveMenu).not.toHaveBeenCalled()
    })

    it('caps both group-name fields at the length the durable schema refuses beyond', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({ name: 'Reports' })] })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe(String(MAX_GROUP_NAME_LENGTH))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: en['groups.rename'] }))
      expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe(String(MAX_GROUP_NAME_LENGTH))
    })

    it('leaves a group name field open on an unrelated keystroke', () => {
      render(<WorkflowGroup {...baseProps()} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.new'] }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
      expect(screen.getByRole('textbox')).toBeTruthy()
    })

    it('renames a group in place', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({}), group({ id: 'g2', name: 'Other', order: 1 })]
      render(<WorkflowGroup {...baseProps({ groups, onSaveMenu })} />)
      fireEvent.click(screen.getAllByRole('button', { name: en['groups.rename'] })[0]!)
      const input = screen.getByRole('textbox') as HTMLInputElement
      expect(input.value).toBe('Group One')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.blur(input)
      expect(onSaveMenu).toHaveBeenCalledWith({ groups: [{ ...groups[0]!, name: 'Renamed' }, groups[1]] })
    })

    it('commits a group rename on Enter, discards it on Escape, and refuses a blank one', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ groups: [group({})], onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.rename'] }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
      expect(screen.getByRole('textbox')).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      expect(onSaveMenu).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['groups.rename'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '  ' } })
      fireEvent.blur(screen.getByRole('textbox'))
      expect(onSaveMenu).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['groups.rename'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } })
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      expect(onSaveMenu).toHaveBeenCalledTimes(1)
    })

    it('pins a group, and offers to unpin it once it is', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ groups: [group({})], onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.pin'] }))
      expect(onSaveMenu).toHaveBeenCalledWith({ groups: [{ ...group({}), pinned: true }] })
      cleanup()
      render(<WorkflowGroup {...baseProps({ groups: [group({ pinned: true })], onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.unpin'] }))
      expect(onSaveMenu).toHaveBeenLastCalledWith({ groups: [{ ...group({}), pinned: false }] })
    })

    it('deletes a group and returns its members to the top level in one patch', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1' }), workflow({ id: 'w2', name: 'Loose', order: 1 })]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.remove'] }))
      expect(onSaveMenu).toHaveBeenCalledWith({
        groups: [],
        workflows: [workflow({ id: 'w1', name: 'Inside' }), workflows[1]],
      })
    })

    it('folds a group shut and reports the toggle, hiding its rows and its placeholder', () => {
      const onSetCollapsed = vi.fn()
      const groups = [group({})]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1' })]
      const { rerender } = render(<WorkflowGroup {...baseProps({ groups, workflows, onSetCollapsed })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.collapse'] }))
      expect(onSetCollapsed).toHaveBeenCalledWith('g1', true)
      rerender(<WorkflowGroup {...baseProps({ groups, workflows, onSetCollapsed, collapsed: { g1: true } })} />)
      expect(screen.queryByRole('button', { name: 'Inside' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: en['groups.expand'] }))
      expect(onSetCollapsed).toHaveBeenLastCalledWith('g1', false)
    })

    it('hides an empty lane placeholder while the lane is folded', () => {
      const groups = [group({})]
      render(<WorkflowGroup {...baseProps({ groups, collapsed: { g1: true } })} />)
      expect(screen.queryByText(en['groups.empty'])).toBeNull()
    })
  })

  describe('workflow row controls', () => {
    it('renames a workflow on blur, leaving the others untouched', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const workflows = [workflow({ id: 'w1', name: 'First' }), workflow({ id: 'w2', name: 'Second', order: 1 })]
      render(<WorkflowGroup {...baseProps({ workflows, onSaveMenu })} />)
      fireEvent.click(screen.getAllByRole('button', { name: en['workflows.rename'] })[0]!)
      const input = screen.getByRole('textbox') as HTMLInputElement
      expect(input.value).toBe('First')
      fireEvent.change(input, { target: { value: 'Renamed' } })
      fireEvent.blur(input)
      expect(onSaveMenu).toHaveBeenCalledWith({ workflows: [{ ...workflows[0]!, name: 'Renamed' }, workflows[1]] })
    })

    it('commits a workflow rename on Enter, discards it on Escape, keeps it open otherwise, and refuses a blank one', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
      expect(screen.getByRole('textbox')).toBeTruthy()
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      expect(onSaveMenu).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
      fireEvent.blur(screen.getByRole('textbox'))
      expect(onSaveMenu).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      expect(onSaveMenu).toHaveBeenCalledTimes(1)
    })

    it('is not draggable while its own row is mid-rename', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})] })} />)
      fireEvent.click(screen.getByRole('button', { name: en['workflows.rename'] }))
      expect(screen.getByRole('listitem').getAttribute('draggable')).toBe('false')
    })

    it('removes a workflow via its trash action', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const workflows = [workflow({ id: 'w1', name: 'First' }), workflow({ id: 'w2', name: 'Second', order: 1 })]
      render(<WorkflowGroup {...baseProps({ workflows, onSaveMenu })} />)
      fireEvent.click(screen.getAllByRole('button', { name: en['workflows.remove'] })[0]!)
      expect(onSaveMenu).toHaveBeenCalledWith({ workflows: [workflows[1]] })
    })
  })

  describe('the 移动到… menu', () => {
    it('lists every lane but the one the row already sits in, and files it under the one picked', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({}), group({ id: 'g2', name: 'Group Two', order: 1 })]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1' })]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.moveTo'] }))
      expect(screen.getAllByRole('menuitem').map(item => item.textContent))
        .toEqual(['Group Two', en['groups.ungrouped']])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Group Two' }))
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [{ ...workflows[0]!, groupId: 'g2', order: 0 }],
      })
    })

    it('moves a row out of every group when the ungrouped row is picked', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1' })]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.moveTo'] }))
      fireEvent.click(screen.getByRole('menuitem', { name: en['groups.ungrouped'] }))
      expect(onSaveMenu).toHaveBeenCalledWith({ workflows: [workflow({ id: 'w1', name: 'Inside', order: 0 })] })
    })

    it('closes on Escape without saving', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], groups: [group({})], onSaveMenu })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.moveTo'] }))
      expect(screen.getAllByRole('menuitem').length).toBe(1)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menuitem')).toBeNull()
      expect(onSaveMenu).not.toHaveBeenCalled()
    })

    // The trigger is only drawn while the row is hovered or holds the focus,
    // so a list left standing after the focus walked away would have no
    // visible owner: it is placed once, on open, and would sit there until an
    // Escape or a pointer press somewhere else.
    it('closes once the focus leaves the row entirely', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], groups: [group({})] })} />)
      const trigger = screen.getByRole('button', { name: en['groups.moveTo'] })
      fireEvent.click(trigger)
      const elsewhere = document.createElement('button')
      document.body.append(elsewhere)
      fireEvent.blur(trigger, { relatedTarget: elsewhere })
      expect(screen.queryByRole('menuitem')).toBeNull()
      elsewhere.remove()
    })

    it('stays open while the focus moves inside the row, and onto the list itself', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], groups: [group({})] })} />)
      const trigger = screen.getByRole('button', { name: en['groups.moveTo'] })
      fireEvent.click(trigger)
      fireEvent.blur(trigger, { relatedTarget: screen.getByRole('button', { name: en['workflows.rename'] }) })
      expect(screen.getAllByRole('menuitem').length).toBe(1)
      fireEvent.blur(trigger, { relatedTarget: screen.getAllByRole('menuitem')[0]! })
      expect(screen.getAllByRole('menuitem').length).toBe(1)
    })

    it('is left out entirely while the section has no other lane to move a row to', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})] })} />)
      expect(screen.getByRole('button', { name: en['workflows.rename'] })).toBeTruthy()
      expect(screen.queryByRole('button', { name: en['groups.moveTo'] })).toBeNull()
    })

    it('closes when the focus goes nowhere at all', () => {
      render(<WorkflowGroup {...baseProps({ workflows: [workflow({})], groups: [group({})] })} />)
      const trigger = screen.getByRole('button', { name: en['groups.moveTo'] })
      fireEvent.click(trigger)
      fireEvent.blur(trigger, { relatedTarget: null })
      expect(screen.queryByRole('menuitem')).toBeNull()
    })
  })

  describe('the group structure a reader hears', () => {
    it('names each lane by its own header, and lets the caret name the list it folds', () => {
      render(<WorkflowGroup {...baseProps({
        groups: [group({})], workflows: [workflow({ id: 'w1', name: 'Inside', groupId: 'g1' })],
      })} />)
      const lane = screen.getByRole('group', { name: 'Group One' })
      expect(lane.querySelector('li')?.textContent).toBe('Inside')
      const list = lane.querySelector('ul')
      expect(list?.id).toBe('server-sidebar-lane-g1-list')
      expect(screen.getByRole('button', { name: en['groups.collapse'] }).getAttribute('aria-controls'))
        .toBe('server-sidebar-lane-g1-list')
    })

    it('leaves the caret naming nothing while the lane draws no list, and the top level unnamed', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({})], workflows: [workflow({})] })} />)
      expect(screen.getByRole('button', { name: en['groups.collapse'] }).getAttribute('aria-controls')).toBeNull()
      // The ungrouped lane is the section itself, which its own heading names.
      expect(screen.getAllByRole('group')).toHaveLength(1)
    })

    it('keeps the lane named while its header is mid-rename', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({})], workflows: [workflow({ groupId: 'g1' })] })} />)
      fireEvent.click(screen.getByRole('button', { name: en['groups.rename'] }))
      expect(document.getElementById('server-sidebar-lane-g1-name'))
        .toBe(screen.getByRole('textbox', { name: en['groups.namePlaceholder'] }))
    })
  })

  describe('drag-and-drop', () => {
    // jsdom's default `getBoundingClientRect` is all zeros, so a row's own
    // vertical midpoint is `clientY === 0`; a negative `clientY` lands in
    // the top half ("before"), a positive one in the bottom half ("after").
    // The exact pixel geometry is `rowHalf`'s own concern (identical to
    // ui-workspace's own precedent) — this file only exercises which half
    // the wiring routes to which outcome.

    const three = () => [
      workflow({ id: 'w1', name: 'First', order: 0 }),
      workflow({ id: 'w2', name: 'Second', order: 1 }),
      workflow({ id: 'w3', name: 'Third', order: 2 }),
    ]

    it('drops on the top half: moves the dragged row before the hovered one', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const workflows = three()
      render(<WorkflowGroup {...baseProps({ workflows, onSaveMenu })} />)
      const rows = screen.getAllByRole('listitem')
      const dt = dataTransfer()
      fireEvent.dragStart(rows[2]!, { dataTransfer: dt })
      dragEventAt('dragover', rows[0]!, -1)
      dragEventAt('drop', rows[0]!, -1)
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [
          { ...workflows[0]!, order: 1 },
          { ...workflows[1]!, order: 2 },
          { ...workflows[2]!, order: 0 },
        ],
      })
      expect(dt.setData).toHaveBeenCalledWith('text/plain', 'w3')
    })

    it('drops on the bottom half of a middle row: moves the dragged row after it', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const workflows = three()
      render(<WorkflowGroup {...baseProps({ workflows, onSaveMenu })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      dragEventAt('dragover', rows[1]!, 1)
      dragEventAt('drop', rows[1]!, 1)
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [
          { ...workflows[0]!, order: 1 },
          { ...workflows[1]!, order: 0 },
          { ...workflows[2]!, order: 2 },
        ],
      })
    })

    it('shows a drop-position indicator on the hovered row while dragging, and clears both rows on drag end', () => {
      render(<WorkflowGroup {...baseProps({ workflows: three() })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      expect(rows[0]!.getAttribute('data-dragging')).toBe('true')
      dragEventAt('dragover', rows[1]!, -1)
      expect(rows[1]!.getAttribute('data-drop-position')).toBe('before')
      fireEvent.dragEnd(rows[0]!)
      expect(rows[0]!.getAttribute('data-dragging')).toBe('false')
      expect(rows[1]!.getAttribute('data-drop-position')).toBeNull()
    })

    it('indicates nothing for a drag over its own source row, or for a hover with no drag in flight', () => {
      // A real browser never fires `drop` for either either: `dragOverRow`
      // declines to call `preventDefault` for both, which is the browser's
      // own precondition for a drop.
      render(<WorkflowGroup {...baseProps({ workflows: three() })} />)
      const rows = screen.getAllByRole('listitem')
      dragEventAt('dragover', rows[1]!, -1)
      expect(rows[1]!.getAttribute('data-drop-position')).toBeNull()
      fireEvent.dragStart(rows[0]!, { dataTransfer: dataTransfer() })
      dragEventAt('dragover', rows[0]!, -1)
      expect(rows[0]!.getAttribute('data-drop-position')).toBeNull()
    })

    it('carries a row into another group when it is dropped on a row there', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [
        workflow({ id: 'w1', name: 'Inside', groupId: 'g1', order: 0 }),
        workflow({ id: 'w2', name: 'Loose', order: 0 }),
      ]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      const rows = screen.getAllByRole('listitem')
      fireEvent.dragStart(rows[1]!, { dataTransfer: dataTransfer() })
      dragEventAt('dragover', rows[0]!, -1)
      dragEventAt('drop', rows[0]!, -1)
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [
          { ...workflows[0]!, order: 1 },
          { ...workflows[1]!, groupId: 'g1', order: 0 },
        ],
      })
    })

    it('accepts a drop on a group header, landing the row first in that group', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [
        workflow({ id: 'w1', name: 'Inside', groupId: 'g1', order: 0 }),
        workflow({ id: 'w2', name: 'Loose', order: 0 }),
      ]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      const head = laneHead('Group One')
      fireEvent.dragStart(screen.getAllByRole('listitem')[1]!, { dataTransfer: dataTransfer() })
      dragEventAt('dragover', head, 0)
      expect(head.getAttribute('data-drop-lane')).toBe('true')
      dragEventAt('drop', head, 0)
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [
          { ...workflows[0]!, order: 1 },
          { ...workflows[1]!, groupId: 'g1', order: 0 },
        ],
      })
    })

    it('accepts a drop on an empty group placeholder', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [workflow({ id: 'w2', name: 'Loose', order: 0 })]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      const placeholder = screen.getByText(en['groups.empty'])
      fireEvent.dragStart(screen.getByRole('listitem'), { dataTransfer: dataTransfer() })
      dragEventAt('dragover', placeholder, 0)
      expect(placeholder.getAttribute('data-drop-lane')).toBe('true')
      dragEventAt('drop', placeholder, 0)
      expect(onSaveMenu).toHaveBeenCalledWith({ workflows: [{ ...workflows[0]!, groupId: 'g1', order: 0 }] })
    })

    it('offers the top level as a drop target only while a drag is in flight', () => {
      const onSaveMenu = vi.fn(() => Promise.resolve())
      const groups = [group({})]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1', order: 0 })]
      render(<WorkflowGroup {...baseProps({ groups, workflows, onSaveMenu })} />)
      // An empty top level is the ordinary state of a console whose workflows
      // are all filed, so nothing stands there until a row is being carried.
      expect(screen.queryByText(en['groups.dropToUngroup'])).toBeNull()
      fireEvent.dragStart(screen.getByRole('listitem'), { dataTransfer: dataTransfer() })
      const placeholder = screen.getByText(en['groups.dropToUngroup'])
      dragEventAt('dragover', placeholder, 0)
      expect(placeholder.getAttribute('data-drop-lane')).toBe('true')
      dragEventAt('drop', placeholder, 0)
      expect(onSaveMenu).toHaveBeenCalledWith({
        workflows: [{ ...workflows[0]!, groupId: undefined, order: 0 }],
      })
    })

    it('leaves the top-level placeholder unmarked until the drag hovers it', () => {
      const groups = [group({})]
      const workflows = [workflow({ id: 'w1', name: 'Inside', groupId: 'g1', order: 0 })]
      render(<WorkflowGroup {...baseProps({ groups, workflows })} />)
      fireEvent.dragStart(screen.getByRole('listitem'), { dataTransfer: dataTransfer() })
      expect(screen.getByText(en['groups.dropToUngroup']).getAttribute('data-drop-lane')).toBe('false')
    })

    it('ignores a lane hover with no drag in flight', () => {
      render(<WorkflowGroup {...baseProps({ groups: [group({})] })} />)
      const head = laneHead('Group One')
      dragEventAt('dragover', head, 0)
      expect(head.getAttribute('data-drop-lane')).toBe('false')
    })
  })

  it('surfaces a pending save error as an alert with the message interpolated', () => {
    render(<WorkflowGroup {...baseProps({ error: 'HTTP 503' })} />)
    expect(screen.getByRole('alert').textContent).toBe(en['workflows.error'].replace('{message}', 'HTTP 503'))
  })
})
