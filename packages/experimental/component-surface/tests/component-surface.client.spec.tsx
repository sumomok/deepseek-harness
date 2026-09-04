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
 * fixtures. What is faked is the session feed, which is the framework's.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { installElementUI } from '@deepseek-ai/dsh-experimental-component-kit/src/client/element-ui.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'
import type { ComponentActionRecord } from '../src/action-state.ts'
import { pendingPressKey, type ActionDispatch, type PendingPresses } from '../src/client/action.ts'
import { CONFIRM_BAR_ID, CONFIRM_BAR_PRESS_ID, RECORD_DETAIL_ID } from '../src/component-call.ts'

// One of the two components this seat draws is a Vue 2 component on element-ui,
// which the component row installs when its own client plugin starts.
beforeAll(installElementUI)

const t: ComponentSurfaceProps['t'] = makeTranslate(en)

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
  const element = (next: Seat) => (
    <ComponentSurface {...{
      sessionId: 'sessionId' in next ? next.sessionId : 'a',
      entry: next.entry,
      useSessions: sessionsHook(next.recorded ?? {}),
      onAction,
      pending,
      t,
    } as unknown as ComponentSurfaceProps} />
  )
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
    expect(stateLine(view)).toBe(en['confirmBar.sending'])
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
      ['sent', en['confirmBar.sent']],
      ['queued', en['confirmBar.queued']],
      ['refused', en['confirmBar.refused']],
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
    expect(stateLine(first)).toBe(en['confirmBar.sent'])
    cleanup()

    const again = mount({ entry: ASK, recorded })
    expect(stateLine(again)).toBe(en['confirmBar.sent'])
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
    expect(stateLine(view)).toBe(en['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('settles on the newer press once the log carries it', () => {
    const view = mount({ entry: ASK, recorded: recordedPress('refused', 20) })
    fireEvent.click(view.getByText('Approve'))
    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    expect(stateLine(view)).toBe(en['confirmBar.sent'])
  })

  it('lets the block be answered again when the press reached no log at all', async () => {
    // The failure the fold cannot describe: an RPC that never ran, a gateway
    // that restarted, a session the host no longer holds. No `command/run` was
    // written, so no settlement is ever coming, and a block still waiting on
    // one would sit at `sending` with every button dead for the rest of the
    // session.
    const view = mount({ entry: ASK, dispatch: 'failed' })
    fireEvent.click(view.getByText('Approve'))
    expect(stateLine(view)).toBe(en['confirmBar.sending'])
    await waitFor(() => { expect(stateLine(view)).toBe(en['confirmBar.refused']) })
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
    await waitFor(() => { expect(stateLine(view)).toBe(en['confirmBar.refused']) })

    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    expect(stateLine(view)).toBe(en['confirmBar.sent'])
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
    expect(stateLine(again)).toBe(en['confirmBar.sending'])
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
    expect(stateLine(view)).toBe(en['confirmBar.sending'])

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
    expect(stateLine(view)).toBe(en['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true])
  })

  it('drops the page\'s record of a press once the log carries it', async () => {
    const pending: PendingPresses = new Map()
    const view = mount({ entry: ASK, pending })
    fireEvent.click(view.getByText('Approve'))
    expect(pending.size).toBe(1)

    view.show({ entry: ASK, recorded: recordedPress('sent', 30) })
    await waitFor(() => { expect(pending.size).toBe(0) })
    expect(stateLine(view)).toBe(en['confirmBar.sent'])
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
    await waitFor(() => { expect(stateLine(view)).toBe(en['confirmBar.refused']) })
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
