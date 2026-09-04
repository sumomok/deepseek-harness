// @vitest-environment jsdom
/**
 * The content column's `component` seat against the real component row: what a
 * call's blocks look like in the column, what a later call under the same id
 * replaces, what the seat draws while another kind holds the column, and what
 * it says about a payload this build cannot accept.
 *
 * The renderers are the real ones. There is no engine behind them and nothing
 * to fake: a block is a pure function of the properties the payload carries, so
 * a stub would only re-state this file's own fixtures.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'
import { CONFIRM_BAR_ID } from '../src/component-call.ts'

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

/** Render the seat for one selection. */
function mount(entry: ComponentSurfaceProps['entry']): ReturnType<typeof render> {
  return render(<ComponentSurface {...{ sessionId: 'a', entry, t } as unknown as ComponentSurfaceProps} />)
}

const APPROVE = [{ id: 'approve', label: 'Approve', tone: 'primary' }, { id: 'reject', label: 'Reject', tone: 'danger' }]

afterEach(cleanup)

describe('component content seat', () => {
  it('draws the call\'s blocks under the title the user reads', () => {
    const view = mount(componentEntry([confirmBar('ask', 'Approve the budget?', APPROVE)]))
    expect(view.getByText('Budget approval')).toBeTruthy()
    expect(view.getByRole('heading').textContent).toBe('Approve the budget?')
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['Approve', 'Reject'])
  })

  it('stacks several blocks in the order the call wrote them', () => {
    const view = mount(componentEntry([
      confirmBar('first', 'Step one', [{ id: 'go', label: 'Go' }]),
      confirmBar('second', 'Step two', [{ id: 'stop', label: 'Stop' }]),
    ]))
    expect(view.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Step one', 'Step two'])
    expect([...view.container.querySelectorAll('[data-component-node]')]
      .map(block => block.getAttribute('data-component-node'))).toEqual(['first', 'second'])
  })

  it('shows what the later call under one id put there, not what the first did', () => {
    const view = mount(componentEntry([confirmBar('ask', 'Approve the budget?', APPROVE)]))
    view.rerender(
      <ComponentSurface {...{
        sessionId: 'a',
        entry: componentEntry(
          [confirmBar('ask', 'Approve the revised budget?', [{ id: 'approve', label: 'Approve' }])],
          { seq: 9, title: 'Budget approval, revised' },
        ),
        t,
      } as unknown as ComponentSurfaceProps} />,
    )
    expect(view.getByText('Budget approval, revised')).toBeTruthy()
    expect(view.getByRole('heading').textContent).toBe('Approve the revised budget?')
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['Approve'])
  })

  it('takes a pressed button nowhere — the entry stays exactly as it was', () => {
    const view = mount(componentEntry([confirmBar('ask', 'Approve the budget?', APPROVE)]))
    // There is no channel from a block back to the agent yet, so the seat is
    // the sink. What is pinned here is that pressing changes nothing visible
    // and raises nothing, which is the limitation the README records.
    fireEvent.click(view.getByText('Approve'))
    expect(view.getByRole('heading').textContent).toBe('Approve the budget?')
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['Approve', 'Reject'])
  })

  it('draws nothing at all while another kind holds the column', () => {
    const view = mount(undefined)
    expect(view.container.firstChild).toBeNull()
  })

  it('explains an entry whose payload carries no spec this build accepts', () => {
    const view = mount({ kind: 'component', entryId: 'budget', seq: 4, title: 'Budget approval', payload: { spec: { nodes: [] } } })
    expect(view.container.querySelector('[data-component-surface-error]')?.textContent).toBe(en['block.unreadable'])
    expect(view.queryByRole('button')).toBeNull()
  })

  it('explains an entry whose payload is not a document at all', () => {
    const view = mount({ kind: 'component', entryId: 'budget', seq: 4, title: 'Budget approval', payload: 'nothing' })
    expect(view.container.querySelector('[data-component-surface-error]')?.textContent).toBe(en['block.unreadable'])
  })
})
