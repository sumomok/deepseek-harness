// @vitest-environment jsdom
/**
 * What the `show-content-view` command draws in the chat: nothing for a click
 * the host took, and the host's own sentence for one that named no view.
 *
 * The lifecycle node is the chat view's own currency, built here the way the
 * conversation snapshot folds it. What a successful click shows the user is the
 * block arriving in the column beside the conversation; the refusal is the one
 * thing nobody else says, because a person who clicked a menu row and watched
 * nothing happen has no other way to learn why.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ViewCommandRow } from '../src/client/ViewCommandRow.tsx'

/** The refusal a click naming no configured view earns, as `view-command.ts` writes it. */
const NO_SUCH_VIEW = '没有这个视图。'

/** One folded `show-content-view` lifecycle node with the settlement under test. */
function commandNode(outcome: CommandRowProps['node']['outcome']): CommandRowProps['node'] {
  return {
    kind: 'command',
    seq: 7,
    time: 0,
    commandId: 'cmd-1' as CommandRowProps['node']['commandId'],
    name: 'show-content-view',
    args: ' site-overview',
    outcome,
  }
}

/** Render the row for one settlement. */
function mount(outcome: CommandRowProps['node']['outcome']): ReturnType<typeof render> {
  return render(<ViewCommandRow {...{ node: commandNode(outcome) } as CommandRowProps} />)
}

afterEach(cleanup)

describe('show-content-view command row', () => {
  it('draws the refusal, so the person who clicked is told there is nothing to show', () => {
    const view = mount({ kind: 'error', text: NO_SUCH_VIEW })
    expect(view.container.querySelector('[data-content-view-refused]')?.textContent).toBe(NO_SUCH_VIEW)
    // The command name is what `GenericCommandCard` would have headed the row
    // with; this row says what happened to the user instead.
    expect(view.queryByText('show-content-view')).toBeNull()
  })

  it('draws nothing for a click the host took — what the conversation shows of it is the block in the column', () => {
    expect(mount({ kind: 'success' }).container.firstChild).toBeNull()
  })

  it('draws nothing for a settlement carrying a sentence the host did not refuse with', () => {
    // The command answers a taken click with no text at all, so this case only
    // arises for a future settlement; drawing it in the error colour would call
    // a success a failure.
    expect(mount({ kind: 'success', text: '已打开。' }).container.firstChild).toBeNull()
  })

  it('draws nothing while the command is still executing', () => {
    expect(mount(null).container.firstChild).toBeNull()
  })

  it('draws nothing for a settlement carrying no sentence to draw', () => {
    // The chat view types a settlement's text as optional, because a `done`
    // whose `run` fell outside the window folds into a node with neither.
    expect(mount({ kind: 'error' }).container.firstChild).toBeNull()
  })
})
