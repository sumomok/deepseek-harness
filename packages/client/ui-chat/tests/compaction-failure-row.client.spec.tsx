// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, zh } from '../src/client/locale.ts'
import { CompactionNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'

afterEach(() => {
  cleanup()
})

const NO_PREVIEW = {
  useCompactionPreview: <S,>(select: (value: boolean) => S): S => select(false),
  openCompaction: async () => null,
}

function props(
  error: string,
  t: ChatNodeViewProps<'compaction'>['t'],
): ChatNodeViewProps<'compaction'> & typeof NO_PREVIEW {
  const node: ChatNode<'compaction'> = {
    key: 'compaction', id: 'compaction', target: 'chat', anchorSeq: 0,
    location: { kind: 'session' }, visibility: 'visible', kind: 'compaction',
    data: { kind: 'compaction-progress', status: 'ended', error },
  }
  return { node, t, ...NO_PREVIEW } as ChatNodeViewProps<'compaction'> & typeof NO_PREVIEW
}

describe('CompactionNodeView failure notice', () => {
  it('speaks to the user in locale copy and keeps the backend text out of the row', () => {
    const view = render(
      <CompactionNodeView {...props('summarizer unavailable', makeTranslate(zh, commonZh))} />,
    )
    const status = view.getByRole('status')
    expect(status.textContent)
      .toBe('上下文压缩失败这次没能整理出摘要，稍后会再试一次。')
    expect(status.textContent).not.toContain('summarizer')
  })

  it('carries the backend reason on title for diagnosis only', () => {
    const reason = 'compaction still above threshold after 2 compaction attempts'
    const view = render(
      <CompactionNodeView {...props(reason, makeTranslate(zh, commonZh))} />,
    )
    expect(view.getByTitle(reason).textContent)
      .toBe('这次没能整理出摘要，稍后会再试一次。')
  })

  it('omits the title when the bracket recorded no usable reason', () => {
    const view = render(
      <CompactionNodeView {...props('', makeTranslate(zh, commonZh))} />,
    )
    const body = view.getByRole('status').querySelector('span:last-of-type')
    expect(body?.getAttribute('title')).toBeNull()
  })

  it('renders the same notice in English', () => {
    const view = render(
      <CompactionNodeView {...props('', makeTranslate(en, commonEn))} />,
    )
    expect(view.getByRole('status').textContent)
      .toBe('Context compaction failedThe summary could not be written this time. It will be tried again.')
  })
})
