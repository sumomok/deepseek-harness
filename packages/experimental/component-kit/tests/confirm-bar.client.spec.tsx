// @vitest-environment jsdom
/**
 * `el.confirm-bar`: what it draws from a block's properties, what it reports
 * when a button is pressed, and what it does with properties that do not carry
 * what the catalog declares.
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
import { en } from '../src/client/locales.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** Render one block with the properties a call gave it. */
function mount(
  props: Readonly<Record<string, unknown>>,
  onAction: ComponentRendererProps['onAction'] = () => {},
): ReturnType<typeof render> {
  return render(<ConfirmBar nodeId="ask" props={props} onAction={onAction} t={t} />)
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

  it('reports the pressed button\'s id together with the block it happened in', () => {
    const onAction = vi.fn()
    const view = mount(FULL, onAction)
    fireEvent.click(view.getByText('Discard'))
    expect(onAction).toHaveBeenCalledWith('discard', 'ask')
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
