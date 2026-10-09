// @vitest-environment jsdom
/**
 * The 「指一下」 button: a click runs a point and files the place picked as one
 * draft in the attachment row; the button is pressed while the point runs, and
 * a second click cancels it — through the real picker too, with no refusal
 * shown; a refusal is reported in a toast and adds nothing; a cancelled or
 * failed point adds nothing and leaves the button ready; unmounting the
 * composer cancels a point still running. Pressing the button keeps the focus;
 * it is disabled while the composer submits; at 16 of this plugin's references
 * it reports that instead of pointing; a draft the composer refuses is released
 * and reported.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MAX_PROMPT_REFERENCES } from '@deepseek-ai/dsh-attachment'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DraftAttachmentId, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PointButton } from '../src/client/PointButton.tsx'
import type { PointButtonProps } from '../src/client/PointButton.tsx'
import { PICK_TAIL_GUARD_MS } from '@haoran/dsh-point-anchor/page'
import { REFERENCE_LIMIT } from '../src/client/limit.ts'
import { point } from '../src/client/pick.ts'
import type { PointOutcome } from '../src/client/pick.ts'
import { zh } from '../src/client/locales.ts'
import { clickTrusted, mountConsole, probe } from './console-fixture.client.ts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

const t: PointButtonProps['t'] = makeTranslate(zh)

/** The input state of an idle composer with an empty row. */
const IDLE: InputState = { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] }

/**
 * Render the button over a point whose outcome the spec settles, or over the real point.
 * @param options - whether to run the real point, the row's drafts, whether the composer takes drafts, and where to render.
 * @returns the button, the pending point's controls, and the spies.
 */
function setup(options: { real?: boolean; ids?: readonly string[]; takes?: boolean; container?: HTMLElement } = {}) {
  const points: { signal: AbortSignal; settle: (outcome: PointOutcome) => void; fail: (error: Error) => void }[] = []
  const names = { component: () => 'c', seat: () => 's', role: (role: string) => role, cellControl: () => 'cc', tableItem: () => 'ti' }
  const run = options.real === true
    ? vi.fn((signal: AbortSignal) => point(document, { names, signal }))
    : vi.fn((signal: AbortSignal) => new Promise<PointOutcome>((settle, fail) => { points.push({ signal, settle, fail }) }))
  const ids = (options.ids ?? []).map(id => id as DraftAttachmentId)
  const ours = new Set(ids)
  const draft = vi.fn((_label: string, _data: unknown) => 'draft-1' as DraftAttachmentId)
  const drafted = vi.fn((row: readonly DraftAttachmentId[]) => row.filter(id => ours.has(id)).length)
  const release = vi.fn((_id: DraftAttachmentId) => {})
  const addAttachments = vi.fn((_ids: readonly DraftAttachmentId[]) => options.takes ?? true)
  const refusal = vi.fn(() => '这个组件还不能指')
  const input = createSnapshotStore<InputState>({ ...IDLE, attachmentIds: ids })
  const view = render(
    <PointButton
      inputActions={{ addAttachments }}
      useInput={bindSnapshotSelector(input)}
      point={run}
      draft={draft}
      drafted={drafted}
      release={release}
      refusal={refusal}
      t={t}
    />,
    options.container === undefined ? {} : { container: options.container },
  )
  const button = () => screen.getByRole('button', { name: '指一下' })
  return { view, button, points, run, draft, drafted, release, addAttachments, refusal, input, ours }
}

describe('the 「指一下」 button', () => {
  it('stops at the host\'s prompt bound', () => {
    expect(REFERENCE_LIMIT).toBe(MAX_PROMPT_REFERENCES)
  })

  it('files the place picked as one draft and adds it to the attachment row', async () => {
    const b = setup()
    fireEvent.click(b.button())
    expect(b.button().getAttribute('aria-pressed')).toBe('true')
    await act(async () => { b.points[0]?.settle({ kind: 'reference', label: '列「名称」', data: { v: 1 } }) })
    expect(b.draft).toHaveBeenCalledExactlyOnceWith('列「名称」', { v: 1 })
    expect(b.addAttachments).toHaveBeenCalledExactlyOnceWith(['draft-1'])
    expect(b.release).not.toHaveBeenCalled()
    expect(b.button().getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps the focus where it was when pressed', () => {
    const b = setup()
    expect(fireEvent.mouseDown(b.button())).toBe(false)
  })

  it('is disabled while the composer submits, and ready again after', () => {
    const b = setup()
    act(() => { b.input.set({ ...IDLE, phase: 'submitting' }) })
    expect((b.button() as HTMLButtonElement).disabled).toBe(true)
    act(() => { b.input.set(IDLE) })
    expect((b.button() as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports, and starts no point, with 16 of this plugin\'s references in the row', () => {
    const b = setup({ ids: Array.from({ length: 16 }, (_, index) => `d${String(index)}`) })
    fireEvent.click(b.button())
    expect(b.run).not.toHaveBeenCalled()
    expect(screen.getByText('已经指了 16 处，先移除一处再指')).toBeTruthy()
  })

  it('files nothing, and reports, when the row reached 16 while the point ran', async () => {
    const b = setup({ ids: Array.from({ length: 15 }, (_, index) => `d${String(index)}`) })
    fireEvent.click(b.button())
    b.ours.add('d15' as DraftAttachmentId)
    act(() => { b.input.set({ ...IDLE, attachmentIds: [...b.input.getSnapshot().attachmentIds, 'd15' as DraftAttachmentId] }) })
    await act(async () => { b.points[0]?.settle({ kind: 'reference', label: 'x', data: {} }) })
    expect(b.draft).not.toHaveBeenCalled()
    expect(screen.getByText('已经指了 16 处，先移除一处再指')).toBeTruthy()
  })

  it('releases and reports a draft the composer refuses', async () => {
    const b = setup({ takes: false })
    fireEvent.click(b.button())
    await act(async () => { b.points[0]?.settle({ kind: 'reference', label: 'x', data: {} }) })
    expect(b.release).toHaveBeenCalledExactlyOnceWith('draft-1')
    expect(screen.getByText('输入框正在发送，这一处没有加上')).toBeTruthy()
  })

  it('cancels the point on a second click and adds nothing', async () => {
    const b = setup()
    fireEvent.click(b.button())
    fireEvent.click(b.button())
    expect(b.points[0]?.signal.aborted).toBe(true)
    expect(b.run).toHaveBeenCalledTimes(1)
    await act(async () => { b.points[0]?.settle({ kind: 'cancelled' }) })
    expect(b.addAttachments).not.toHaveBeenCalled()
    expect(b.button().getAttribute('aria-pressed')).toBe('false')
  })

  it('reports a refusal in a toast and adds nothing', async () => {
    const b = setup()
    fireEvent.click(b.button())
    await act(async () => { b.points[0]?.settle({ kind: 'refused', reason: 'popup' }) })
    expect(b.refusal).toHaveBeenCalledWith('popup')
    expect(screen.getByText('这一处指不了：这个组件还不能指')).toBeTruthy()
    expect(b.addAttachments).not.toHaveBeenCalled()
    fireEvent.click(b.button())
    await act(async () => { b.points[1]?.settle({ kind: 'refused', reason: 'popup' }) })
    expect(screen.getAllByText('这一处指不了：这个组件还不能指')).toHaveLength(1)
  })

  it('takes the toast down once it has shown', async () => {
    vi.useFakeTimers()
    try {
      const b = setup()
      fireEvent.click(b.button())
      await act(async () => { b.points[0]?.settle({ kind: 'refused', reason: 'popup' }) })
      expect(screen.queryByText('这一处指不了：这个组件还不能指')).not.toBeNull()
      await act(async () => { await vi.runAllTimersAsync() })
      expect(screen.queryByText('这一处指不了：这个组件还不能指')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is ready again after a point that fails', async () => {
    const b = setup()
    fireEvent.click(b.button())
    await act(async () => { b.points[0]?.fail(new Error('boom')) })
    expect(b.button().getAttribute('aria-pressed')).toBe('false')
    expect(b.addAttachments).not.toHaveBeenCalled()
  })

  it('cancels a point still running when the composer unmounts, and takes no outcome after', async () => {
    const b = setup()
    fireEvent.click(b.button())
    const running = b.points[0]
    b.view.unmount()
    expect(running?.signal.aborted).toBe(true)
    await act(async () => { running?.settle({ kind: 'reference', label: 'x', data: {} }) })
    expect(b.draft).not.toHaveBeenCalled()
    await waitFor(() => { expect(b.addAttachments).not.toHaveBeenCalled() })
  })

  it('takes no failure after the composer unmounts', async () => {
    const b = setup()
    fireEvent.click(b.button())
    const running = b.points[0]
    b.view.unmount()
    await act(async () => { running?.fail(new Error('late')) })
    expect(b.addAttachments).not.toHaveBeenCalled()
  })

  it('cancels a real pick on a second trusted click, and shows no refusal', async () => {
    mountConsole(document)
    const b = setup({ real: true, container: probe(document, 'send').parentElement as HTMLElement })
    await act(async () => { clickTrusted(b.button()) })
    expect(b.button().getAttribute('aria-pressed')).toBe('true')
    await act(async () => { clickTrusted(b.button()) })
    await waitFor(() => { expect(b.button().getAttribute('aria-pressed')).toBe('false') })
    expect(await b.run.mock.results[0]?.value).toEqual({ kind: 'cancelled' })
    expect(b.run).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('这一处指不了')
    // The picker's listeners outlive the pick by its tail guard; the next spec starts after them.
    await new Promise(resolve => setTimeout(resolve, PICK_TAIL_GUARD_MS + 100))
  })
})
