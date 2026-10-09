// @vitest-environment jsdom
/**
 * The content column's `component` seat against the real component row: what a
 * call's blocks look like in the column, what one pressed button reports, how
 * each block reads the gesture the session's log records against it, what a
 * later call under the same id replaces, what the seat draws while another kind
 * holds the column, and what it says about a payload this build cannot accept.
 *
 * The renderers are the real ones. There is no engine behind them and nothing
 * to fake: a block is a pure function of the properties the payload carries and
 * the state it is handed, so a stub would only re-state this file's own
 * fixtures. What is faked is the session feed, which is the framework's. The
 * one exception is a value one block publishes and another reads: the real
 * publisher is the deployment's data page, which draws nothing without that
 * deployment's backend, so those cases draw the two catalog entries through
 * stand-in renderers that publish on a click and show what they were handed.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as kitEn } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { installElementUI } from '@deepseek-ai/dsh-experimental-component-kit/src/client/element-ui.ts'
import { en } from '../src/client/locales.ts'
import { kitRendererTable, rendererTable } from './renderer-table.client.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'
import type { ComponentActionRecord } from '../src/action-state.ts'
import { pendingPressKey, type ActionDispatch, type PendingPresses } from '../src/client/action.ts'
import type { ComponentRendererTable } from '../src/client/registry.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'
import {
  COMPONENT_KIT_ENTRIES,
  CONFIRM_BAR_ID,
  CONFIRM_BAR_PRESS_ID,
  DATA_PAGE_EDITING_OUTPUT,
  DATA_PAGE_ID,
  FORM_PAGE_ID,
  RECORD_DETAIL_ID,
  TABLE_ID,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'

// One of the two components this seat draws is a Vue 2 component on element-ui,
// which the component row installs when its own client plugin starts.
beforeAll(installElementUI)

const t: ComponentSurfaceProps['t'] = makeTranslate(en)

/** The components this page draws, as the component row registers them. */
const KIT_COMPONENTS = kitRendererTable()

/** One confirmation-bar block, as a validated spec carries it. */
function confirmBar(id: string, title: string, buttons: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id, component: CONFIRM_BAR_ID, props: { title, buttons } }
}

/** One `component` entry, as the column's projection publishes it. */
function componentEntry(
  nodes: readonly Record<string, unknown>[],
  { entryId = 'budget', seq = 4, title = 'Budget approval' } = {},
): ComponentSurfaceProps['entry'] {
  return { kind: 'component', entryId, seq, title, payload: { spec: { nodes } } }
}

/** The gestures each session's log records, as one render's worth of feed. */
type Recorded = Readonly<Record<string, readonly ComponentActionRecord[]>>

/**
 * Stand in for the framework's `useSessions` selector hook over one feed of
 * folded gestures.
 * @param recorded - the `componentActions` value of each session in the list.
 * @returns the hook the seat calls.
 */
function sessionsHook(recorded: Recorded): ComponentSurfaceProps['useSessions'] {
  const state = {
    byId: Object.fromEntries(Object.entries(recorded)
      .map(([id, actions]) => [id, { projectionValues: { componentActions: { actions } } }])),
  }
  return ((selector: (snapshot: unknown) => unknown) => selector(state)) as ComponentSurfaceProps['useSessions']
}

/** One seat render: the selection, the session it belongs to, and that session's folded gestures. */
interface Seat {
  /** The entry the column selected, or undefined while another kind holds it. */
  entry: ComponentSurfaceProps['entry']
  /** The current session; the suite's own `a` unless a case is about its absence. */
  sessionId?: string | undefined
  /** The `componentActions` value each listed session carries. */
  recorded?: Recorded
  /** What the dispatch answers; `dispatched` unless a case is about a press that reached no log. */
  dispatch?: ActionDispatch
  /** The page's in-flight presses, shared with the caller where a case unmounts the seat and mounts it again. */
  pending?: PendingPresses
  /** The components the page draws; the component row's own unless a case draws stand-ins. */
  components?: ComponentRendererTable
}

/** What one mounted seat hands back to the case driving it. */
type Mounted = ReturnType<typeof render> & {
  /** Every gesture the seat reported, as the registration's face received it. */
  onAction: ReturnType<typeof vi.fn>
  /** The page's in-flight presses this mount wrote into. */
  pending: PendingPresses
  /** Redraw the same seat with another selection or another feed. */
  show: (next: Seat) => void
}

/** Render the seat for one selection, over an action sink that records what it is handed. */
function mount(seat: Seat): Mounted {
  const pending = seat.pending ?? new Map<string, number>()
  const onAction = vi.fn(() => Promise.resolve(seat.dispatch ?? 'dispatched'))
  const element = (next: Seat) => {
    const components = next.components ?? KIT_COMPONENTS
    return (
      <ComponentSurface {...{
        sessionId: 'sessionId' in next ? next.sessionId : 'a',
        entry: next.entry,
        useSessions: sessionsHook(next.recorded ?? {}),
        onAction,
        components,
        pending,
        t,
      } as unknown as ComponentSurfaceProps} />
    )
  }
  const view = render(element(seat))
  return { ...view, onAction, pending, show: (next: Seat) => { view.rerender(element(next)) } }
}

const APPROVE = [{ id: 'approve', label: 'Approve', tone: 'primary' }, { id: 'reject', label: 'Reject', tone: 'danger' }]

/** The one entry every gesture in this suite is reported from. */
const ASK = componentEntry([confirmBar('ask', 'Approve the budget?', APPROVE)])

/**
 * One folded gesture against that entry's block.
 * @param outcome - how far the log says the gesture got.
 * @param seq - its log position, which is later than the placing call's by default.
 * @returns the feed a session carrying that one gesture publishes.
 */
function recordedPress(outcome: ComponentActionRecord['outcome'], seq = 20): Recorded {
  return { a: [{ entryId: 'budget', nodeId: 'ask', seq, outcome }] }
}

/** Which buttons of the drawn bar refuse a press. */
function disabled(view: ReturnType<typeof render>): boolean[] {
  return view.getAllByRole('button').map(button => (button as HTMLButtonElement).disabled)
}

/** The line the drawn bar says about its own gesture, if any. */
function stateLine(view: ReturnType<typeof render>): string | null | undefined {
  return view.container.querySelector('[data-component-sent]')?.textContent
}

afterEach(cleanup)

describe('component content seat', () => {
  it('draws the call\'s blocks under the title the user reads', () => {
    const view = mount({ entry: ASK })
    expect(view.getByText('Budget approval')).toBeTruthy()
    expect(view.getByRole('heading').textContent).toBe('Approve the budget?')
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['Approve', 'Reject'])
  })

  it('stacks several blocks in the order the call wrote them', () => {
    const view = mount({
      entry: componentEntry([
        confirmBar('first', 'Step one', [{ id: 'go', label: 'Go' }]),
        confirmBar('second', 'Step two', [{ id: 'stop', label: 'Stop' }]),
      ]),
    })
    expect(view.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Step one', 'Step two'])
    expect([...view.container.querySelectorAll('[data-component-node]')]
      .map(block => block.getAttribute('data-component-node'))).toEqual(['first', 'second'])
  })

  it('shows what the later call under one id put there, not what the first did', () => {
    const view = mount({ entry: ASK })
    view.show({
      entry: componentEntry(
        [confirmBar('ask', 'Approve the revised budget?', [{ id: 'approve', label: 'Approve' }])],
        { seq: 9, title: 'Budget approval, revised' },
      ),
    })
    expect(view.getByText('Budget approval, revised')).toBeTruthy()
    expect(view.getByRole('heading').textContent).toBe('Approve the revised budget?')
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['Approve'])
  })

  it('reports a pressed button once, naming the session, the entry, and the block it happened in', () => {
    const view = mount({ entry: ASK })
    fireEvent.click(view.getByText('Approve'))
    expect(view.onAction.mock.calls).toEqual([['a', {
      entryId: 'budget',
      componentId: CONFIRM_BAR_ID,
      actionId: CONFIRM_BAR_PRESS_ID,
      nodeId: 'ask',
      payload: { buttonId: 'approve' },
    }]])
  })

  it('names the block that spoke when several are stacked', () => {
    const view = mount({
      entry: componentEntry([
        confirmBar('first', 'Step one', [{ id: 'go', label: 'Go' }]),
        confirmBar('second', 'Step two', [{ id: 'stop', label: 'Stop' }]),
      ]),
    })
    fireEvent.click(view.getByText('Stop'))
    expect(view.onAction.mock.calls[0]?.[1]).toMatchObject({ nodeId: 'second', payload: { buttonId: 'stop' } })
  })

  it('says a press is on its way until the log carries it — the record is a round trip away', () => {
    const view = mount({ entry: ASK })
    fireEvent.click(view.getByText('Approve'))
    expect(stateLine(view)).toBe(kitEn['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('leaves the other blocks of the same entry alone — a press answers the block it happened in', () => {
    const view = mount({
      entry: componentEntry([
        confirmBar('first', 'Step one', [{ id: 'go', label: 'Go' }]),
        confirmBar('second', 'Step two', [{ id: 'stop', label: 'Stop' }]),
      ]),
    })
    fireEvent.click(view.getByText('Go'))
    expect(disabled(view)).toEqual([true, false])
    expect(view.container.querySelectorAll('[data-component-sent]')).toHaveLength(1)
  })

  it('says what the log says became of the press', () => {
    for (const [outcome, line] of [
      ['sent', kitEn['confirmBar.sent']],
      ['queued', kitEn['confirmBar.queued']],
      ['refused', kitEn['confirmBar.refused']],
    ] as const) {
      const view = mount({ entry: ASK, recorded: recordedPress(outcome) })
      expect(stateLine(view)).toBe(line)
      cleanup()
    }
  })

  it('draws a pressed block as pressed when it is mounted afresh — the press is in the log, not in the block', () => {
    // What the seat is asked for every time the user picks another entry and
    // comes back: the column discards this kind's DOM, so a block answering its
    // own click would come back untouched and take the decision twice.
    const recorded = recordedPress('sent')
    const first = mount({ entry: ASK, recorded })
    expect(stateLine(first)).toBe(kitEn['confirmBar.sent'])
    cleanup()

    const again = mount({ entry: ASK, recorded })
    expect(stateLine(again)).toBe(kitEn['confirmBar.sent'])
    expect(disabled(again)).toEqual([true, true])
    fireEvent.click(again.getByText('Approve'))
    expect(again.onAction).not.toHaveBeenCalled()
  })

  it('lets a refused press be reported again, and says so while the second one travels', () => {
    const view = mount({ entry: ASK, recorded: recordedPress('refused') })
    expect(disabled(view)).toEqual([false, false])
    fireEvent.click(view.getByText('Approve'))
    expect(view.onAction).toHaveBeenCalledTimes(1)
    // The log still holds only the refused press, so the block says the newer
    // one is on its way rather than repeating the older answer.
    expect(stateLine(view)).toBe(kitEn['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('settles on the newer press once the log carries it', () => {
    const view = mount({ entry: ASK, recorded: recordedPress('refused', 20) })
    fireEvent.click(view.getByText('Approve'))
    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    expect(stateLine(view)).toBe(kitEn['confirmBar.sent'])
  })

  it('lets the block be answered again when the press reached no log at all', async () => {
    // The failure the fold cannot describe: an RPC that never ran, a gateway
    // that restarted, a session the host no longer holds. No `command/run` was
    // written, so no settlement is ever coming, and a block still waiting on
    // one would sit at `sending` with every button dead for the rest of the
    // session.
    const view = mount({ entry: ASK, dispatch: 'failed' })
    fireEvent.click(view.getByText('Approve'))
    expect(stateLine(view)).toBe(kitEn['confirmBar.sending'])
    await waitFor(() => { expect(stateLine(view)).toBe(kitEn['confirmBar.refused']) })
    expect(disabled(view)).toEqual([false, false])
    // And the page keeps no row for a press that is not on its way anywhere.
    expect(view.pending.size).toBe(0)

    fireEvent.click(view.getByText('Approve'))
    expect(view.onAction).toHaveBeenCalledTimes(2)
  })

  it('gives way to the log when a press it gave up on turns out to have been recorded', async () => {
    // `failed` is what the browser saw, not proof the host wrote nothing: the
    // command's record is written before the handler runs, so a transport that
    // dropped after it still leaves a settlement to fold. The block's own answer
    // is a guess that lasts exactly until the log has one.
    const view = mount({ entry: ASK, dispatch: 'failed' })
    fireEvent.click(view.getByText('Approve'))
    await waitFor(() => { expect(stateLine(view)).toBe(kitEn['confirmBar.refused']) })

    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    expect(stateLine(view)).toBe(kitEn['confirmBar.sent'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('keeps saying a press is on its way when the block is drawn afresh before its record arrives', async () => {
    // The window a tab round trip fits inside: the column discards this kind's
    // DOM, so waiting held in the block would go with it and the same decision
    // could be reported twice before the first report has landed.
    const pending: PendingPresses = new Map()
    const first = mount({ entry: ASK, pending })
    fireEvent.click(first.getByText('Approve'))
    await waitFor(() => { expect(pending.size).toBe(1) })
    expect([...pending.keys()]).toEqual([pendingPressKey('a', 'budget', 4, 'ask')])
    cleanup()

    const again = mount({ entry: ASK, pending })
    expect(stateLine(again)).toBe(kitEn['confirmBar.sending'])
    expect(disabled(again)).toEqual([true, true])
    fireEvent.click(again.getByText('Approve'))
    expect(again.onAction).not.toHaveBeenCalled()
  })

  it('leaves another session\'s blocks answerable while a press of this one travels', () => {
    // A session switch redraws the seat instead of unmounting it — the column is
    // a root slot that hides seats rather than dropping them — so two sessions
    // whose placing calls landed at the same log position draw blocks agreeing
    // on everything the entry and the node can say. The session is what tells
    // them apart, which is why it is in the block's React identity and not only
    // in the page's table.
    const pending: PendingPresses = new Map()
    const view = mount({ entry: ASK, pending })
    fireEvent.click(view.getByText('Approve'))
    expect(stateLine(view)).toBe(kitEn['confirmBar.sending'])

    view.show({ entry: ASK, sessionId: 'b' })
    expect(stateLine(view)).toBeUndefined()
    expect(disabled(view)).toEqual([false, false])
    fireEvent.click(view.getByText('Approve'))
    expect(view.onAction).toHaveBeenCalledTimes(2)
    expect(view.onAction.mock.calls[0]?.[0]).toBe('a')
    expect(view.onAction.mock.calls[1]?.[0]).toBe('b')
    expect([...pending.keys()]).toEqual([
      pendingPressKey('a', 'budget', 4, 'ask'),
      pendingPressKey('b', 'budget', 4, 'ask'),
    ])

    // And the first session's press is still where it was left.
    view.show({ entry: ASK })
    expect(stateLine(view)).toBe(kitEn['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('drops the page\'s record of a press once the log carries it', async () => {
    const pending: PendingPresses = new Map()
    const view = mount({ entry: ASK, pending })
    fireEvent.click(view.getByText('Approve'))
    expect(pending.size).toBe(1)

    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    await waitFor(() => { expect(pending.size).toBe(0) })
    expect(stateLine(view)).toBe(kitEn['confirmBar.sent'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('draws a fresh bar when a later call replaces the entry — the agent asking again is asking afresh', () => {
    // The gesture answered the call that was on display when it was made, and
    // its log position says so: a call recorded after it owns the entry now.
    const replaced = componentEntry([confirmBar('ask', 'Approve the revised budget?', APPROVE)], { seq: 40 })
    const view = mount({ entry: replaced, recorded: recordedPress('sent', 20) })
    expect(disabled(view)).toEqual([false, false])
    expect(stateLine(view)).toBeUndefined()
  })

  it('reads only its own session\'s gestures', () => {
    const view = mount({
      entry: ASK,
      recorded: { b: [{ entryId: 'budget', nodeId: 'ask', seq: 20, outcome: 'sent' }] },
    })
    expect(stateLine(view)).toBeUndefined()
    expect(disabled(view)).toEqual([false, false])
  })

  it('reports nothing while no session is current — there is none to report against', async () => {
    // A shape the column does not produce — it publishes entries per session —
    // so what is pinned is the seat's own guard, not a case a user can reach.
    const view = mount({ entry: ASK, sessionId: undefined })
    fireEvent.click(view.getByText('Approve'))
    expect(view.onAction).not.toHaveBeenCalled()
    // Nothing was recorded and nothing is coming, so the block settles itself
    // rather than waiting on a log entry no one wrote.
    await waitFor(() => { expect(stateLine(view)).toBe(kitEn['confirmBar.refused']) })
    expect(view.pending.size).toBe(0)
  })

  it('draws a record block through the vendored component the row carries', () => {
    const view = mount({
      entry: componentEntry([{
        id: 'facts',
        component: RECORD_DETAIL_ID,
        props: { dataList: [{ label: '编号', display: 'A-1' }, { label: '状态', display: '在用' }], columnNum: 1 },
      }]),
    })
    const block = view.container.querySelector(`[data-component-block="${RECORD_DETAIL_ID}"]`)
    expect(block?.getAttribute('data-component-node')).toBe('facts')
    // Not the seat's own markup: the labels and the values are drawn by the Vue
    // component inside element-ui form items, one column wide as the call asked.
    expect([...view.container.querySelectorAll('.form-item-content')].map(cell => cell.textContent))
      .toEqual(['A-1', '在用'])
    expect(view.container.querySelector('.el-col-24')).not.toBeNull()
    // And nothing about a record answers back, so the seat draws no control.
    expect(view.queryByRole('button')).toBeNull()
  })

  it('leaves a block as it found it when the gesture is not that block\'s own answer', async () => {
    // A table reports four gestures and the block holds one state. A tick is
    // not an answer: nothing settles it, so filing it as one would pin the
    // block at `sending` and refuse the row button under it for good.
    const table = {
      id: 'devices',
      component: TABLE_ID,
      props: {
        tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] },
        displayValueList: [{ zh_label: 'A-1' }, { zh_label: 'A-2' }],
        selectMode: 'checkbox',
        customOperations: [{ key: 'export', label: '导出' }],
      },
    }
    const view = mount({ entry: componentEntry([table]) })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    const boxes = view.container.querySelectorAll('.el-table__body-wrapper .el-checkbox__original')
    fireEvent.click(boxes[0] as HTMLElement)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(view.onAction).toHaveBeenCalledWith('a', expect.objectContaining({ actionId: 'select' }))
    expect(view.pending.size).toBe(0)
    expect(stateLine(view)).toBeUndefined()
  })

  it('draws nothing at all while another kind holds the column', () => {
    const view = mount({ entry: undefined })
    expect(view.container.firstChild).toBeNull()
  })

  it('explains an entry whose payload carries no spec this build accepts', () => {
    const view = mount({ entry: { kind: 'component', entryId: 'budget', seq: 4, title: 'Budget approval', payload: { spec: { nodes: [] } } } })
    expect(view.container.querySelector('[data-component-surface-error]')?.textContent).toBe(en['block.unreadable'])
    expect(view.queryByRole('button')).toBeNull()
  })

  it('explains an entry whose payload is not a document at all', () => {
    const view = mount({ entry: { kind: 'component', entryId: 'budget', seq: 4, title: 'Budget approval', payload: 'nothing' } })
    expect(view.container.querySelector('[data-component-surface-error]')?.textContent).toBe(en['block.unreadable'])
  })
})

describe('an output withdrawn through the seat', () => {
  /** What a row's modify button hands the form, as the data page publishes it. */
  const EDITING = { mode: 'modify', type: 'SpaceLayer', id: '41', name: '测试-1' }

  /** One catalog entry of the component row, by id. */
  function kitEntry(id: string): ComponentCatalogEntry {
    const entry = COMPONENT_KIT_ENTRIES.find(one => one.id === id)
    if (entry === undefined) throw new Error(`the component row registers no ${id}`)
    return entry
  }

  /** A data page stand-in: three buttons publishing what it edits, the same value again, and nothing. */
  function Publisher({ onOutput }: ComponentRendererProps) {
    return (
      <div>
        <button type="button" onClick={() => { onOutput(DATA_PAGE_EDITING_OUTPUT, EDITING) }}>publish</button>
        <button type="button" onClick={() => { onOutput(DATA_PAGE_EDITING_OUTPUT, { ...EDITING }) }}>again</button>
        <button type="button" onClick={() => { onOutput(DATA_PAGE_EDITING_OUTPUT, undefined) }}>withdraw</button>
      </div>
    )
  }

  /** Every properties object the form page stand-in was drawn with, in order. */
  const handed: Readonly<Record<string, unknown>>[] = []

  /** A form page stand-in: it writes down the properties it is drawn with and shows them. */
  function Reader({ props }: ComponentRendererProps) {
    handed.push(props)
    return <output data-reader>{JSON.stringify(props)}</output>
  }

  /** The page drawing the two stand-ins under the component row's own declarations. */
  const STANDINS = rendererTable([
    { entry: kitEntry(DATA_PAGE_ID), render: Publisher },
    { entry: kitEntry(FORM_PAGE_ID), render: Reader },
  ], makeTranslate(kitEn))

  /** A view's data page and the form page reading what it is editing. */
  const PAIR = componentEntry([
    { id: 'page', component: DATA_PAGE_ID, props: { relatedMeta: 'SpaceLayer', metaLabel: '空间图层' } },
    { id: 'form', component: FORM_PAGE_ID, props: { relatedMeta: 'SpaceLayer', request: { $from: 'node:page.editing' } } },
  ], { entryId: 'crud', title: '图层管理' })

  /** What the form page stand-in shows now. */
  function shown(view: ReturnType<typeof render>): unknown {
    return JSON.parse(view.container.querySelector('[data-reader]')?.textContent ?? 'null')
  }

  it('draws the form without the value before it, with it once published, and without it once withdrawn', () => {
    handed.length = 0
    const view = mount({ entry: PAIR, components: STANDINS })
    // Optional, so the block draws its own empty state rather than the seat's
    // waiting line.
    expect(view.container.querySelector('[data-component-surface-awaiting]')).toBeNull()
    expect(shown(view)).toEqual({ relatedMeta: 'SpaceLayer' })
    fireEvent.click(view.getByText('publish'))
    expect(shown(view)).toEqual({ relatedMeta: 'SpaceLayer', request: EDITING })
    fireEvent.click(view.getByText('withdraw'))
    expect(shown(view)).toEqual({ relatedMeta: 'SpaceLayer' })
    expect(view.container.querySelector('[data-component-surface-awaiting]')).toBeNull()
    // Each change was a new properties object, so a form keyed on it resets.
    expect(new Set(handed).size).toBe(3)
  })

  it('hands the form nothing new when the page publishes the value standing again', () => {
    handed.length = 0
    const view = mount({ entry: PAIR, components: STANDINS })
    fireEvent.click(view.getByText('publish'))
    const fed = handed.at(-1)
    fireEvent.click(view.getByText('again'))
    expect(handed.at(-1)).toBe(fed)
    expect(shown(view)).toEqual({ relatedMeta: 'SpaceLayer', request: EDITING })
  })
})
