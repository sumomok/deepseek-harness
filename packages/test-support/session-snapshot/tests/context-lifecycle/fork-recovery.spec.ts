import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionEventSearchRequest, SessionSearchExecContext } from '@deepseek-ai/dsh-session-query'
import { describe, expect, it, vi } from 'vitest'
import { Microcompact } from '../../../../compaction/compaction-microcompact/src/index.ts'

const MODEL = 'fork-recovery'
class Query extends SessionQueryEngine {
  override searchSessions(): Promise<{ items: never[] }> { return Promise.resolve({ items: [] }) }
  override searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.resolve({
      session: { version: 4, id: request.sessionId ?? SessionId('missing'), createdAt: 1, isSeeded: false },
      items: [],
    })
  }
}
function agent(session: Session): Agent { return { session, options: {} } as Agent }
function appendTurn(session: Session, turn: number, results: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `turn ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  for (let index = 0; index < results; index += 1) {
    const callId = ToolCallId(`call-${turn}-${index}`)
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'inherited readable '.repeat(100) }], isError: false }) }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
async function mount(): Promise<{ ctx: Context; parent: Session; child: Session; noticeSeq: number }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Query)
  await ctx.plugin(ToolSessionQuery)
  new TokenMeter(ctx)
  new Microcompact(ctx, {
    enabled: true,
    minIdleSeconds: 0,
    keepRecentToolUses: 5,
    minClearableToolUses: 20,
    clearAtLeastTokens: 10,
    allowHostOnlyReadback: false,
  })
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const parent = ctx.sessions.create(SessionId('fork-parent'), { meta: { createdAt: 1, cwd: '/work' } })
  appendTurn(parent, 1, 0)
  vi.setSystemTime(1_000 + 3_900_000)
  appendTurn(parent, 2, 25)
  const preview = await ctx.microcompact.preview(parent)
  expect(preview.entries).toHaveLength(20)
  ctx.microcompact.apply(parent, preview)
  const notice = preview.entries[0]!.replacement.content[0]
  if (notice?.type !== 'text') throw new Error('expected notice')
  const child = ctx.sessions.fork(parent.id, undefined, SessionId('fork-child'))
  vi.useRealTimers()
  return { ctx, parent, child, noticeSeq: preview.entries[0]!.addressSeq }
}
describe('fork inherited address readback', () => {
  it('reads the parent address from the fork child and the inherited seq from the child', async () => {
    const { ctx, parent, child, noticeSeq } = await mount()
    const read = async (sessionId: SessionId, seq: number) => ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: sessionId, seq }, callId: ToolCallId('read'), signal: new AbortController().signal, agent: agent(child),
    })
    const parentRead = await read(parent.id, noticeSeq)
    const parentText = parentRead.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    console.log('PARENT_READ', parentText.slice(0, 200))
    expect(parentText).toContain('inherited readable')
    const childRead = await read(child.id, noticeSeq)
    const childText = childRead.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    console.log('CHILD_READ', childText.slice(0, 200))
    expect(childText).toContain('inherited readable')
  })
})

describe('fork authorization boundary', () => {
  it('allows same-cwd siblings, denies another cwd, and cannot resolve a parent address without the parent live', async () => {
    const { ctx, parent, child, noticeSeq } = await mount()
    const execute = (caller: Session, sessionId: SessionId, seq: number) => ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: sessionId, seq }, callId: ToolCallId('read'), signal: new AbortController().signal, agent: agent(caller),
    })

    const sibling = ctx.sessions.create(SessionId('same-cwd-sibling'), { meta: { createdAt: 1, cwd: '/work' } })
    expect((await execute(sibling, parent.id, noticeSeq)).isError).not.toBe(true)

    const outsider = ctx.sessions.create(SessionId('other-cwd'), { meta: { createdAt: 1, cwd: '/other' } })
    const denied = await execute(outsider, parent.id, noticeSeq)
    expect(denied.isError).toBe(true)
    expect(denied.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toMatch(/outside the caller workspace|unauthorized/i)

    // Reopen only the fork child's inherited log in a fresh Context: the
    // child still carries the event, but the parent-id address cannot resolve.
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await second.plugin(Query)
    await second.plugin(ToolSessionQuery)
    const orphan = second.sessions.create(child.id, {
      seed: child.snapshotEvents(),
      inheritedEventCount: child.inheritedEventCount,
      meta: { createdAt: 1, cwd: '/work', parentSession: parent.id, isSeeded: true },
    })
    const orphanRead = await second.tools.execute({
      name: 'session_event_read', arguments: { session_id: orphan.id, seq: noticeSeq }, callId: ToolCallId('read-orphan'),
      signal: new AbortController().signal, agent: agent(orphan),
    })
    expect(orphanRead.isError).not.toBe(true)
    expect(orphanRead.content.map(block => block.type === 'text' ? block.text : '').join('\n')).toContain('inherited readable')
    const parentGone = await second.tools.execute({
      name: 'session_event_read', arguments: { session_id: parent.id, seq: noticeSeq }, callId: ToolCallId('read-parent-gone'),
      signal: new AbortController().signal, agent: agent(orphan),
    })
    expect(parentGone.isError).toBe(true)
    expect(parentGone.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toMatch(/outside the caller workspace|unauthorized/i)
    await second.fiber.dispose()
    await ctx.fiber.dispose()
  })
})
