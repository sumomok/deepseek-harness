// @vitest-environment jsdom
/**
 * What the `/component-action` command draws in the chat: nothing for a press
 * the host simply took, and the handler's own sentence for one it refused or
 * only queued.
 *
 * The lifecycle node is the chat view's own currency, built here the way the
 * conversation snapshot folds it. The cases are the whole of the row: a press
 * the agent is reading is narrated by the notice the agent claims, and the two
 * that carry a sentence are narrated by nobody else at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ActionCommandRow } from '../src/client/ActionCommandRow.tsx'

/** The refusal every unresolvable action earns, as `command.ts` writes it. */
const NOT_RECORDED = '这个动作没能记下来。'

/** What a press that only reached the inbox earns, as `command.ts` writes it. */
const QUEUED = '已记下，你下次发消息时对话会看到。'

/** One folded `component-action` lifecycle node with the settlement under test. */
function commandNode(outcome: CommandRowProps['node']['outcome']): CommandRowProps['node'] {
  return {
    kind: 'command',
    seq: 12,
    time: 0,
    commandId: 'cmd-1' as CommandRowProps['node']['commandId'],
    name: 'component-action',
    args: ' {"entryId":"budget"}',
    outcome,
  }
}

/** Render the row for one settlement. */
function mount(outcome: CommandRowProps['node']['outcome']): ReturnType<typeof render> {
  return render(<ActionCommandRow {...{ node: commandNode(outcome) } as CommandRowProps} />)
}

afterEach(cleanup)

describe('component-action command row', () => {
  it('draws the refusal the press earned, so the person who pressed is told nothing was recorded', () => {
    const view = mount({ kind: 'error', text: NOT_RECORDED })
    expect(view.container.querySelector('[data-component-action-refused]')?.textContent).toBe(NOT_RECORDED)
    // The command name is what `GenericCommandCard` would have headed the row
    // with; this row says what happened to the user instead.
    expect(view.queryByText('component-action')).toBeNull()
  })

  it('draws the notice that a press is waiting, apart from the refusal it is not', () => {
    // A queued press will be read, but not until the user writes again, and
    // nothing else in the conversation says so. It is not a failure, so it is
    // not drawn as one.
    const view = mount({ kind: 'success', text: QUEUED })
    expect(view.container.querySelector('[data-component-action-waiting]')?.textContent).toBe(QUEUED)
    expect(view.container.querySelector('[data-component-action-refused]')).toBeNull()
    expect(view.queryByText('component-action')).toBeNull()
  })

  it('draws nothing for a press the host took — what the conversation shows of it is the notice the agent claims', () => {
    expect(mount({ kind: 'success' }).container.firstChild).toBeNull()
  })

  it('draws nothing while the command is still executing', () => {
    expect(mount(null).container.firstChild).toBeNull()
  })

  it('draws nothing for a settlement carrying no sentence to draw', () => {
    // The chat view types a settlement's text as optional, because a `done`
    // whose `run` fell outside the window folds into a node with neither. This
    // row has one sentence to draw and no fallback of its own for that case.
    expect(mount({ kind: 'error' }).container.firstChild).toBeNull()
  })
})
