// @vitest-environment jsdom
/**
 * The transcript row for one `content_read` call: the three stages a reader
 * sees, and the name the finished one carries.
 *
 * The row states the fact and nothing else — a failure keeps its explanation in
 * the model's result rather than repeating it where the user would read it
 * twice — so these cases are about which of the three lines appears.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContentReadRow, type ContentReadRowProps } from '../src/client/access/ContentReadRow.tsx'
import { zh } from '../src/client/locales.ts'

/** Render the row over one call block. */
function mount(block: unknown): ReturnType<typeof render> {
  const props = { callId: 'call_1', block, t: makeTranslate(zh) } as unknown as ContentReadRowProps
  return render(<ContentReadRow {...props} />)
}

/** The stage the row put in the DOM, and the line it drew. */
function stage(view: ReturnType<typeof render>): { stage: string | null; line: string | null } {
  const row = view.container.querySelector('[data-content-read-stage]')
  return { stage: row?.getAttribute('data-content-read-stage') ?? null, line: row?.textContent ?? null }
}

afterEach(() => {
  cleanup()
})

describe('the content_read transcript row', () => {
  it('says the read is running while the call has no result', () => {
    expect(stage(mount({ callId: 'call_1', name: 'content_read', argsRaw: '{}', turn: 1, step: 1 })))
      .toEqual({ stage: 'pending', line: zh['read.pending'] })
  })

  it('names the page the finished read looked at', () => {
    expect(stage(mount({ kind: 'tool-result', callId: 'call_1', isError: false, meta: { page: 'Home' } })))
      .toEqual({ stage: 'done', line: '看了一眼「Home」' })
  })

  it('names the column itself when the call recorded no page', () => {
    // A call dispatched from inside `run_code` carries no presentation payload:
    // the runtime projects one for top-level calls only.
    for (const meta of [undefined, null, {}, { page: '' }, { page: 7 }]) {
      expect(stage(mount({ kind: 'tool-result', callId: 'call_1', isError: false, meta })))
        .toEqual({ stage: 'done', line: zh['read.done.unknown'] })
      cleanup()
    }
  })

  it('says the read failed without repeating why', () => {
    const view = mount({
      kind: 'tool-result',
      callId: 'call_1',
      isError: true,
      content: [{ type: 'text', text: 'Error: The content column is empty.' }],
    })
    expect(stage(view)).toEqual({ stage: 'failed', line: zh['read.failed'] })
    expect(view.container.textContent).not.toContain('content column is empty')
  })
})
