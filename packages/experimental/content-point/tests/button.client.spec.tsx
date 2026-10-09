// @vitest-environment jsdom
/**
 * The 「指一下」 button: a click runs a point and files the place picked as one
 * draft in the attachment row; the button is pressed while the point runs, and
 * a second click cancels it; a refusal is reported in a toast and adds
 * nothing; a cancelled or failed point adds nothing and leaves the button
 * ready; unmounting the composer cancels a point still running.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PointButton } from '../src/client/PointButton.tsx'
import type { PointButtonProps } from '../src/client/PointButton.tsx'
import type { PointOutcome } from '../src/client/pick.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: PointButtonProps['t'] = makeTranslate(zh)

/**
 * Render the button over a point whose outcome the spec settles.
 * @returns the button, the pending point's controls, and the spies.
 */
function setup() {
  const points: { signal: AbortSignal; settle: (outcome: PointOutcome) => void; fail: (error: Error) => void }[] = []
  const point = vi.fn((signal: AbortSignal) => new Promise<PointOutcome>((settle, fail) => { points.push({ signal, settle, fail }) }))
  const draft = vi.fn((_label: string, _data: unknown) => 'draft-1' as DraftAttachmentId)
  const addAttachments = vi.fn((_ids: readonly DraftAttachmentId[]) => true)
  const refusal = vi.fn(() => '这个组件还不能指')
  const view = render(<PointButton inputActions={{ addAttachments }} point={point} draft={draft} refusal={refusal} t={t} />)
  const button = () => screen.getByRole('button', { name: '指一下' })
  return { view, button, points, point, draft, addAttachments, refusal }
}

describe('the 「指一下」 button', () => {
  it('files the place picked as one draft and adds it to the attachment row', async () => {
    const b = setup()
    fireEvent.click(b.button())
    expect(b.button().getAttribute('aria-pressed')).toBe('true')
    await act(async () => { b.points[0]?.settle({ kind: 'reference', label: '列「名称」', data: { v: 1 } }) })
    expect(b.draft).toHaveBeenCalledExactlyOnceWith('列「名称」', { v: 1 })
    expect(b.addAttachments).toHaveBeenCalledExactlyOnceWith(['draft-1'])
    expect(b.button().getAttribute('aria-pressed')).toBe('false')
  })

  it('cancels the point on a second click and adds nothing', async () => {
    const b = setup()
    fireEvent.click(b.button())
    fireEvent.click(b.button())
    expect(b.points[0]?.signal.aborted).toBe(true)
    expect(b.point).toHaveBeenCalledTimes(1)
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
})
