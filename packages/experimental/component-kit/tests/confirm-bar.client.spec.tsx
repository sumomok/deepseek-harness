// @vitest-environment jsdom
/**
 * `el.confirm-bar`: what it draws from a block's properties, what it reports
 * when a button is pressed, what it says in each of the states the placement
 * package hands it, and what it does with properties that do not carry what the
 * catalog declares.
 *
 * The last part is not a hostile-input test: the renderer table is one type for
 * every component, so a block's properties reach every renderer as
 * `Record<string, unknown>` and each one narrows what it declared. What is
 * pinned here is the narrowing, not a defense.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ConfirmBar } from '../src/client/ConfirmBar.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { ComponentActionState, ComponentRendererProps } from '../src/client/renderer.ts'

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** Render one block with the properties a call gave it, in the state it was handed. */
function mount(
  props: Readonly<Record<string, unknown>>,
  {
    onAction = () => {},
    state = 'idle',
  }: { onAction?: ComponentRendererProps['onAction']; state?: ComponentActionState } = {},
): ReturnType<typeof render> {
  return render(<ConfirmBar nodeId="ask" props={props} onAction={onAction} state={state} t={t} />)
}

/** Which buttons of the rendered row refuse a press. */
function disabled(view: ReturnType<typeof render>): boolean[] {
  return view.getAllByRole('button').map(button => (button as HTMLButtonElement).disabled)
}

/** The properties a whole confirmation bar carries. */
const FULL = {
  title: 'Publish the report?',
  message: 'It goes to everyone on the weekly list.',
  buttons: [
    { id: 'publish', label: 'Publish', tone: 'primary' },
    { id: 'later', label: 'Not now' },
    { id: 'discard', label: 'Discard', tone: 'danger' },
  ],
}

afterEach(cleanup)

describe('el.confirm-bar', () => {
  it('draws the prompt, the explanation, and every button label', () => {
    const view = mount(FULL)
    expect(view.getByRole('heading').textContent).toBe(FULL.title)
    expect(view.getByText(FULL.message)).toBeTruthy()
    expect(view.getAllByRole('button').map(button => button.textContent))
      .toEqual(['Publish', 'Not now', 'Discard'])
  })

  it('names the button row with this row\'s own copy — the only text it does not receive', () => {
    const view = mount(FULL)
    expect(view.getByRole('group', { name: en['confirmBar.actions'] })).toBeTruthy()
  })

  it('reports a press as the one action it declares, carrying the pressed button\'s id and nothing else', () => {
    const onAction = vi.fn()
    const view = mount(FULL, { onAction })
    fireEvent.click(view.getByText('Discard'))
    // The block it happened in is the placement's to bind, and the payload is
    // exactly the property the action declares — the whole of this row's half
    // of the trimming obligation.
    expect(onAction.mock.calls).toEqual([['press', { buttonId: 'discard' }]])
  })

  it('says nothing about a gesture, and takes one, while nothing has been reported', () => {
    const view = mount(FULL)
    expect(view.container.querySelector('[data-component-sent]')).toBeNull()
    expect(disabled(view)).toEqual([false, false, false])
  })

  it('says a gesture is on its way, and refuses a second one', () => {
    const view = mount(FULL, { state: 'sending' })
    expect(view.container.querySelector('[data-component-state="sending"]')?.textContent)
      .toBe(en['confirmBar.sending'])
    expect(disabled(view)).toEqual([true, true, true])
  })

  it('says a gesture reached the agent, and refuses a second one', () => {
    const view = mount(FULL, { state: 'sent' })
    expect(view.container.querySelector('[data-component-state="sent"]')?.textContent)
      .toBe(en['confirmBar.sent'])
    expect(disabled(view)).toEqual([true, true, true])
  })

  it('says a gesture is waiting for the user\'s next message, and refuses a second one', () => {
    const view = mount(FULL, { state: 'queued' })
    expect(view.container.querySelector('[data-component-state="queued"]')?.textContent)
      .toBe(en['confirmBar.queued'])
    expect(disabled(view)).toEqual([true, true, true])
  })

  it('says a gesture reached nobody, and lets it be reported again', () => {
    // The one settled state that stays pressable: nothing was recorded, so
    // pressing again is the only thing left to try.
    const onAction = vi.fn()
    const view = mount(FULL, { onAction, state: 'refused' })
    expect(view.container.querySelector('[data-component-state="refused"]')?.textContent)
      .toBe(en['confirmBar.refused'])
    expect(disabled(view)).toEqual([false, false, false])
    fireEvent.click(view.getByText('Publish'))
    expect(onAction.mock.calls).toEqual([['press', { buttonId: 'publish' }]])
  })

  it('keeps no pressed state of its own — a bar draws only the state it is handed', () => {
    // What a bar remembering its own press would get wrong: the placement
    // discards a block's DOM whenever the user looks at something else, so a
    // bar that answered its own click would come back untouched and take the
    // same decision twice.
    const onAction = vi.fn()
    const view = mount(FULL, { onAction })
    fireEvent.click(view.getByText('Publish'))
    expect(disabled(view)).toEqual([false, false, false])
    expect(view.container.querySelector('[data-component-sent]')).toBeNull()
  })

  it('says each state in the words the end user reads', () => {
    // The console's own surface is Chinese; the English dictionary is what the
    // lane driving this component in a browser reads.
    expect(zh['confirmBar.sending']).toBe('正在发送…')
    expect(zh['confirmBar.sent']).toBe('已发送到对话')
    expect(zh['confirmBar.queued']).toBe('已记下，你下次发消息时对话会看到')
    expect(zh['confirmBar.refused']).toBe('这个动作没能记下来，可以再试')
  })

  it('marks each block with the node id it was given, so a placement can find it in the DOM', () => {
    const view = mount(FULL)
    expect(view.container.querySelector('[data-component-node]')?.getAttribute('data-component-node')).toBe('ask')
  })

  it('gives each button the tone it declared, and an ordinary one to a button that declared none', () => {
    const view = mount(FULL)
    expect(view.getAllByRole('button').map(button => button.getAttribute('data-component-tone')))
      .toEqual(['primary', 'default', 'danger'])
    // Three tones, three classes: a tone is the whole className, never a
    // concatenation, so a class name cannot be built from an unknown tone.
    const classes = new Set(view.getAllByRole('button').map(button => button.className))
    expect(classes.size).toBe(3)
  })

  it('draws an unknown tone as an ordinary button', () => {
    const view = mount({ buttons: [{ id: 'go', label: 'Go', tone: 'shout' }] })
    expect(view.getByRole('button').getAttribute('data-component-tone')).toBe('default')
  })

  it('draws a block that carries only buttons', () => {
    const view = mount({ buttons: [{ id: 'ok', label: 'OK' }] })
    expect(view.queryByRole('heading')).toBeNull()
    expect(view.getByRole('button').textContent).toBe('OK')
  })

  it('leaves out anything the properties do not carry as text', () => {
    const view = mount({
      title: '',
      message: 42,
      buttons: [
        'not a button',
        null,
        { id: 'no-label' },
        { label: 'no id' },
        { id: 'ok', label: 'OK' },
      ],
    })
    expect(view.queryByRole('heading')).toBeNull()
    expect(view.getAllByRole('button').map(button => button.textContent)).toEqual(['OK'])
  })

  it('draws an empty button row when the properties carry no list at all', () => {
    const view = mount({ title: 'Nothing to press', buttons: 'publish' })
    expect(view.queryAllByRole('button')).toEqual([])
    expect(view.getByRole('group')).toBeTruthy()
  })
})
