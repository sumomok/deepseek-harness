// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, zh } from '../src/client/locale.ts'
import { CompactionNodeView, CompactionRunningNodeView } from '../src/client/chat/MessageItem.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import type { CompactionSummaryNode } from '../src/client/contract/snapshot.ts'

afterEach(() => {
  cleanup()
})

function runningProps(
  t: ChatNodeViewProps<'compaction-running'>['t'],
): ChatNodeViewProps<'compaction-running'> {
  return {
    node: { kind: 'compaction-running', data: null },
    t,
  } as unknown as ChatNodeViewProps<'compaction-running'>
}

function landedProps(
  data: CompactionSummaryNode,
  t: ChatNodeViewProps<'compaction'>['t'],
): ChatNodeViewProps<'compaction'> {
  return {
    node: { kind: 'compaction', data },
    t,
  } as unknown as ChatNodeViewProps<'compaction'>
}

const LANDED: CompactionSummaryNode = {
  kind: 'compaction',
  seq: 12,
  time: 1_700_000_000_012,
  summary: 'landed summary',
  summaryEventSeq: 11,
  shadowedItemCount: 3,
  shadowedTokenCount: 4_200,
}

describe('CompactionRunningNodeView', () => {
  it('states that compaction is running and offers no summary', () => {
    const view = render(<CompactionRunningNodeView {...runningProps(makeTranslate(zh, commonZh))} />)
    const button = view.getByRole('button')
    expect(button.textContent).toBe('正在压缩…')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBeNull()
  })

  it('announces the running state to assistive technology', () => {
    const view = render(<CompactionRunningNodeView {...runningProps(makeTranslate(zh, commonZh))} />)
    expect(view.getByText('运行中')).toBeTruthy()
  })

  it('renders the running copy in English', () => {
    const view = render(<CompactionRunningNodeView {...runningProps(makeTranslate(en, commonEn))} />)
    expect(view.getByRole('button').textContent).toBe('Compacting context…')
  })
})

describe('CompactionNodeView after the bracket lands', () => {
  it('states the compacted counts beside the marker title', () => {
    const view = render(<CompactionNodeView {...landedProps(LANDED, makeTranslate(zh, commonZh))} />)
    expect(view.getByRole('button').textContent).toBe('上下文已压缩已压缩 3 条历史记录（约 4200 tokens）')
  })

  it('keeps the summary disclosure the landed marker already offered', () => {
    const view = render(<CompactionNodeView {...landedProps(LANDED, makeTranslate(en, commonEn))} />)
    const button = view.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.textContent).toBe('Context compactedCompacted 3 history items (~4200 tokens)')
  })
})
