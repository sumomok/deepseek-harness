// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { ApprovalDiffPreview, approvalDiffPreview } from '../src/client/tool/toolviews/approval-diff-row.tsx'

type PreviewProps = Parameters<typeof ApprovalDiffPreview>[0]

const SID = 's1' as SessionId
const CWD = '/w/project'
const t = makeTranslate(zh, commonZh) as PreviewProps['t']

afterEach(cleanup)

function listStore(cwd: string | undefined) {
  return createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: {
      [SID]: {
        id: SID, title: 'r', displayTitle: 'r', running: false, blank: false, updatedAt: 0,
        ...(cwd === undefined ? {} : { cwd }),
      },
    },
    current: undefined,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  })
}

function props(nodes: readonly unknown[], cwd: string | null = CWD, callId = 'call-1'): PreviewProps {
  const snapshot = { nodes: { values: () => nodes } }
  return {
    callId,
    sessionId: SID,
    useChat: (selector: (value: unknown) => unknown) => selector(snapshot),
    useSessions: bindSnapshotSelector(listStore(cwd ?? undefined)),
    t,
  } as unknown as PreviewProps
}

/** One running root Tool call as the Chat snapshot carries it. */
function running(name: string, args: unknown, callId = 'call-1') {
  return { kind: 'tool-call', data: { root: { callId, name, argsRaw: JSON.stringify(args) } } }
}

function lines(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-diff] > div > div')].map(row => row.textContent ?? '')
}

describe('ApprovalDiffPreview', () => {
  it('previews a pending write as the whole file it will contain', () => {
    const { container } = render(<ApprovalDiffPreview {...props([
      { kind: 'assistant-step', data: {} },
      running('write', { file_path: `${CWD}/notes.txt`, content: 'alpha\nbeta\n' }),
    ])} />)

    expect(lines(container)).toEqual(['notes.txt', 'alpha', 'beta'])
  })

  it('previews a pending edit as its removed and added text', () => {
    const { container } = render(<ApprovalDiffPreview {...props([
      running('edit', { file_path: `${CWD}/src/app.ts`, old_string: 'let a = 1', new_string: 'const a = 2' }),
    ])} />)

    expect(lines(container)).toEqual(['src/app.ts', 'let a = 1', 'const a = 2'])
  })

  it('previews both str_replace_editor subcommands that describe a change', () => {
    const create = render(<ApprovalDiffPreview {...props([
      running('str_replace_editor', { command: 'create', path: `${CWD}/new.md`, file_text: 'hello' }),
    ])} />)
    expect(lines(create.container)).toEqual(['new.md', 'hello'])
    cleanup()

    const replace = render(<ApprovalDiffPreview {...props([
      running('str_replace_editor', { command: 'str_replace', path: `${CWD}/new.md`, old_str: 'a', new_str: 'b' }),
    ])} />)
    expect(lines(replace.container)).toEqual(['new.md', 'a', 'b'])
  })

  it('keeps a path outside the workspace verbatim, with or without a known workspace', () => {
    const outside = render(<ApprovalDiffPreview {...props([
      running('write', { file_path: '/etc/hosts', content: 'x' }),
    ])} />)
    expect(lines(outside.container)[0]).toBe('/etc/hosts')
    cleanup()

    const noCwd = render(<ApprovalDiffPreview {...props([
      running('write', { file_path: `${CWD}/notes.txt`, content: 'x' }),
    ], null)} />)
    expect(lines(noCwd.container)[0]).toBe(`${CWD}/notes.txt`)
  })

  it('renders nothing for an absent, uncorrelated, or settled call', () => {
    const { container } = render(<ApprovalDiffPreview {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      running('write', { file_path: `${CWD}/other.txt`, content: 'x' }, 'call-2'),
      {
        kind: 'tool-call',
        data: {
          root: {
            kind: 'tool-result', callId: 'call-1',
            call: { name: 'write', argsRaw: '{"file_path":"/w/project/a.txt","content":"x"}' },
          },
        },
      },
    ])} />)

    expect(container.textContent).toBe('')
  })

  it('renders nothing when the pending arguments describe no change yet', () => {
    const { container } = render(<ApprovalDiffPreview {...props([
      running('write', { file_path: `${CWD}/notes.txt` }),
    ])} />)

    expect(container.textContent).toBe('')
  })
})

describe('approvalDiffPreview registration', () => {
  it('claims one approval-detail key per previewable file-mutation tool', async () => {
    const runtime = await SlotTestRuntime.create()
    await runtime.root.declare(
      { 'conversation.approval.detail': { kind: 'keyed', scope: 'session' } },
      () => null,
    )
    await runtime.mount(approvalDiffPreview)

    expect(runtime.slots.entries('conversation.approval.detail').map(entry => entry.options.key))
      .toEqual(['write', 'edit', 'str_replace_editor'])
    await runtime.dispose()
  })
})
