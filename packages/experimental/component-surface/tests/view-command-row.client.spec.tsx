// @vitest-environment jsdom
/**
 * What the `show-content-view` command draws in the chat: nothing for a click
 * the host took, the host's own sentence for one that named no view, and the
 * question a click on a data page is answered with.
 *
 * The lifecycle node is the chat view's own currency, built here the way the
 * conversation snapshot folds it. What a successful click shows the user is the
 * block arriving in the column beside the conversation; the two things this row
 * draws are the two nobody else says.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { consentNonce, encodeConsentQuestion } from '../src/consent-question.ts'
import { en } from '../src/client/locales.ts'
import { ViewCommandRow, type ViewCommandRowProps } from '../src/client/ViewCommandRow.tsx'

/** The refusal a click naming no configured view earns, as `view-command.ts` writes it. */
const NO_SUCH_VIEW = '没有这个视图。'

/** The card the host wrote for one data page, as `crudApprovalReason` builds it. */
const CARD = '打开「图层配置」的数据页，用你自己的登录身份读它的内容。\n数据表：SpaceLayer'

/** One drawn question, encoded the way the host settles the command with it. */
const QUESTION = encodeConsentQuestion({ view: 'layers', card: CARD, nonce: consentNonce('a'.repeat(32)) })

const t: ViewCommandRowProps['t'] = makeTranslate(en)

/** One folded `show-content-view` lifecycle node with the settlement under test. */
function commandNode(outcome: ViewCommandRowProps['node']['outcome']): ViewCommandRowProps['node'] {
  return {
    kind: 'command',
    seq: 7,
    time: 0,
    commandId: 'cmd-1' as ViewCommandRowProps['node']['commandId'],
    name: 'show-content-view',
    args: ' layers',
    outcome,
  }
}

/** Render the row for one settlement. */
function mount(
  outcome: ViewCommandRowProps['node']['outcome'],
  onConsent: ViewCommandRowProps['onConsent'] = () => {},
): ReturnType<typeof render> {
  return render(<ViewCommandRow {...{ node: commandNode(outcome), onConsent, t } as ViewCommandRowProps} />)
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

  it('puts the host\'s card to the person who clicked, with the two words they answer it with', () => {
    const view = mount({ kind: 'success', text: QUESTION })
    expect(view.container.querySelector('[data-content-view-consent]')?.getAttribute('data-content-view-consent')).toBe('layers')
    // The card verbatim, the line naming the table included: it is the one part
    // a person can check the rest against.
    expect(view.container.textContent).toContain('数据表：SpaceLayer')
    expect(view.getByText(en['consent.allow'])).toBeDefined()
    expect(view.getByText(en['consent.decline'])).toBeDefined()
  })

  it('carries the agreement back and then draws nothing, because the column is the answer', () => {
    const onConsent = vi.fn()
    const view = mount({ kind: 'success', text: QUESTION }, onConsent)
    fireEvent.click(view.container.querySelector('[data-content-view-allow]') as Element)
    expect(onConsent).toHaveBeenCalledTimes(1)
    expect(onConsent.mock.calls[0]?.[0]).toEqual({ view: 'layers', card: CARD, nonce: 'a'.repeat(32) })
    expect(view.container.firstChild).toBeNull()
  })

  it('sends nothing when the person declines, and leaves the one line saying so', () => {
    const onConsent = vi.fn()
    const view = mount({ kind: 'success', text: QUESTION }, onConsent)
    fireEvent.click(view.container.querySelector('[data-content-view-decline]') as Element)
    expect(onConsent).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-content-view-declined]')?.textContent).toBe(en['consent.declined'])
  })

  it('draws a settlement carrying this row\'s own marker and nothing readable after it as no question at all', () => {
    // A text that begins like a question and is not one reaches the row off a
    // durable log, so it is a state the row has to have an answer for.
    expect(mount({ kind: 'success', text: 'content-view-consent\n{' }).container.firstChild).toBeNull()
  })
})
