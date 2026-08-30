// @vitest-environment jsdom
/**
 * `SaveWorkflowAction`'s decision-③ visibility gate (hidden until the
 * current session has a user message) and its name-entry commit path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SaveWorkflowAction, type SaveWorkflowActionProps } from '../src/client/SaveWorkflowAction.tsx'
import { en } from '../src/client/locales.ts'

const t: SaveWorkflowActionProps['t'] = (key, vars?: Record<string, unknown>) => {
  const template = (en as Record<string, string>)[key] ?? key
  return vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = vars[name]
      return typeof value === 'string' ? value : ''
    })
}

interface Bench {
  hasUserMessage: boolean
  contentSurface: { entries: { kind: string; entryId: string; seq: number; title: string; payload: unknown }[] } | undefined
}

function mount(overrides: Partial<Bench> = {}, onSave = vi.fn(() => Promise.resolve())) {
  const bench: Bench = { hasUserMessage: false, contentSurface: undefined, ...overrides }
  const props: SaveWorkflowActionProps = {
    sessionId: 'session-a' as SaveWorkflowActionProps['sessionId'],
    useSession: ((<S,>(selector: (s: { chat: { legacy: { nodes: { kind: string }[] } } }) => S): S =>
      selector({ chat: { legacy: { nodes: bench.hasUserMessage ? [{ kind: 'user' }] : [] } } })) as unknown) as SaveWorkflowActionProps['useSession'],
    useProjection: ((_key: string) => bench.contentSurface) as SaveWorkflowActionProps['useProjection'],
    onSave,
    t,
  } as SaveWorkflowActionProps
  return { view: render(<SaveWorkflowAction {...props} />), onSave }
}

afterEach(() => {
  cleanup()
})

describe('SaveWorkflowAction', () => {
  it('renders nothing while the current session has no user message', () => {
    mount({ hasUserMessage: false })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the trigger once the session has a user message', () => {
    mount({ hasUserMessage: true })
    expect(screen.getByRole('button', { name: en['saveWorkflow.action'] })).toBeTruthy()
  })

  it('opens a name field on click and saves the trimmed name with the captured navigation snapshot on blur', () => {
    const { onSave } = mount({
      hasUserMessage: true,
      contentSurface: { entries: [{ kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: {} }] },
    })
    fireEvent.click(screen.getByRole('button', { name: en['saveWorkflow.action'] }))
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  My Workflow  ' } })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledWith('session-a', 'My Workflow', ['home'])
  })

  it('commits on Enter through the same blur path', () => {
    const { onSave } = mount({ hasUserMessage: true })
    fireEvent.click(screen.getByRole('button', { name: en['saveWorkflow.action'] }))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Named' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalled()
  })

  it('discards on Escape without saving', () => {
    const { onSave } = mount({ hasUserMessage: true })
    fireEvent.click(screen.getByRole('button', { name: en['saveWorkflow.action'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('leaves the name field open on an unrelated keystroke', () => {
    const { onSave } = mount({ hasUserMessage: true })
    fireEvent.click(screen.getByRole('button', { name: en['saveWorkflow.action'] }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('does not save when the trimmed name is empty', () => {
    const { onSave } = mount({ hasUserMessage: true })
    fireEvent.click(screen.getByRole('button', { name: en['saveWorkflow.action'] }))
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onSave).not.toHaveBeenCalled()
  })
})
