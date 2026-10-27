import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Microcompact } from '../../../../compaction/compaction-microcompact/src/index.ts'

const MODEL = 'test-model'

class Query extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.resolve({ session: header(request.sessionId), items: [] })
  }
}

function header(id: SessionId): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/work' }
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function appendTurn(session: Session, turn: number, results: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  for (let index = 0; index < results; index += 1) {
    const callId = ToolCallId(`call-${String(turn)}-${String(index)}`)
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'readable '.repeat(200) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('idle microcompact address readback', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('leaves a session pointer that the real session_event_read tool resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(Query)
    await ctx.plugin(AgentRegistry)
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
    const session = ctx.sessions.create(SessionId('microcompact-readback'), { meta: { createdAt: 1, cwd: '/work' } })
    vi.setSystemTime(1_000)
    appendTurn(session, 1, 0)
    vi.setSystemTime(1_000 + 3_900_000)
    appendTurn(session, 2, 25)

    const compact = ctx.microcompact
    const preview = await compact.preview(session)
    expect(preview.entries).toHaveLength(20)
    const originalSeq = preview.entries[0]!.addressSeq
    const applied = compact.apply(session, preview)
    expect(applied.cleared).toHaveLength(20)

    const result = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('readback'), name: 'session_event_read', arguments: JSON.stringify({ session_id: session.id, seq: originalSeq }) }],
      signal: new AbortController().signal,
      agent: agent(session),
    })
    const outcome = result.results[0]!.result
    const text = outcome.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('readable '.repeat(200))
    expect(text).toContain('untrusted data')
  })
})
