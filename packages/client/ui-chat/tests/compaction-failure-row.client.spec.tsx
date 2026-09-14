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

describe('CompactionFailureNodeView', () => {
  it('speaks to the user in locale copy and keeps the backend text out of the row', () => {
    const view = render(
      <CompactionFailureNodeView {...props({ reason: 'summarizer unavailable' }, makeTranslate(zh, commonZh))} />,
    )
    const status = view.getByRole('status')
    expect(status.textContent)
      .toBe('上下文压缩失败这次没能整理出摘要，对话内容没有变化，稍后会再试一次。')
    expect(status.textContent).not.toContain('summarizer')
  })

  it('carries the backend reason on title for diagnosis only', () => {
    const reason = 'compaction still above threshold after 2 compaction attempts'
    const view = render(
      <CompactionFailureNodeView {...props({ reason }, makeTranslate(zh, commonZh))} />,
    )
    expect(view.getByTitle(reason).textContent)
      .toBe('这次没能整理出摘要，对话内容没有变化，稍后会再试一次。')
  })

  it('omits the title when the bracket recorded no usable reason', () => {
    const view = render(
      <CompactionFailureNodeView {...props({ reason: null }, makeTranslate(zh, commonZh))} />,
    )
    const body = view.getByRole('status').querySelector('span:last-of-type')
    expect(body?.getAttribute('title')).toBeNull()
  })

  it('renders the same notice in English', () => {
    const view = render(
      <CompactionFailureNodeView {...props({ reason: null }, makeTranslate(en, commonEn))} />,
    )
    expect(view.getByRole('status').textContent).toBe(
      'Context compaction failedThe summary could not be written this time, '
      + 'so nothing in the conversation changed. It will be tried again.',
    )
  })
})
