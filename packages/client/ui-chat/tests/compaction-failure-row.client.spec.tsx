// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, zh } from '../src/client/locale.ts'
import { CompactionFailureNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import type { CompactionFailureChatData } from '../src/client/contract/chat-nodes.ts'

afterEach(() => {
  cleanup()
})

function props(
  data: CompactionFailureChatData,
  t: ChatNodeViewProps<'compaction-failure'>['t'],
): ChatNodeViewProps<'compaction-failure'> {
  return {
    node: { kind: 'compaction-failure', data },
    t,
  } as unknown as ChatNodeViewProps<'compaction-failure'>
}

const failure = (reason: string | null): CompactionFailureChatData => ({
  seq: 11, time: 11_000, reason,
})

describe('CompactionFailureNodeView', () => {
  it('titles the notice from the locale and shows the backend reason verbatim', () => {
    const view = render(
      <CompactionFailureNodeView {...props(failure('summarizer unavailable'), makeTranslate(zh, commonZh))} />,
    )
    const status = view.getByRole('status')
    expect(status.textContent).toBe('上下文压缩失败summarizer unavailable')
    expect(view.getByTitle('summarizer unavailable')).toBeTruthy()
  })

  it('falls back to localized copy when the bracket recorded no detail', () => {
    const view = render(
      <CompactionFailureNodeView {...props(failure(null), makeTranslate(zh, commonZh))} />,
    )
    expect(view.getByRole('status').textContent).toBe('上下文压缩失败未记录失败原因')
  })

  it('renders the same notice in English', () => {
    const view = render(
      <CompactionFailureNodeView {...props(failure(null), makeTranslate(en, commonEn))} />,
    )
    expect(view.getByRole('status').textContent).toBe('Context compaction failedNo failure detail was recorded')
  })

  it('keeps a long reason on one line, reachable through its title', () => {
    const reason = 'compaction still above threshold after 2 compaction attempts; '.repeat(4).trim()
    const view = render(
      <CompactionFailureNodeView {...props(failure(reason), makeTranslate(zh, commonZh))} />,
    )
    const body = view.getByTitle(reason)
    expect(body.textContent).toBe(reason)
  })
})
