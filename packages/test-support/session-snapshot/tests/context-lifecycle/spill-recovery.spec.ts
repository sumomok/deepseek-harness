import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSearchPage, SessionEventSearchRequest, SessionSearchExecContext } from '@deepseek-ai/dsh-session-query'
import { LocalSpillStore, sweepSpillRoots } from '@deepseek-ai/dsh-spill-local'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'

class Query extends SessionQueryEngine {
  override searchSessions(): Promise<{ items: never[] }> { return Promise.resolve({ items: [] }) }
  override searchEvents(_request: SessionEventSearchRequest, _exec?: SessionSearchExecContext): Promise<SessionEventSearchPage> {
    return Promise.resolve({ session: { version: 4, id: SessionId('missing'), createdAt: 1, isSeeded: false }, items: [] })
  }
}
function agent(session: Session): Agent { return { session, options: {} } as Agent }
async function mountQuery(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Query)
  await ctx.plugin(ToolSessionQuery)
  return ctx
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dsh-spill-recovery-')); roots.push(value); return value }

describe('spill retention and address separation', () => {
  it('sweeps an expired spill but keeps a fresh one and never resurrects the file', async () => {
    const ctx = new Context()
    const dir = await root()
    await ctx.plugin(LocalSpillStore, { root: dir, cleanupPeriodDays: 0 })
    const old = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('spill-old') }, source: { kind: 'tool', toolName: 'bash', callId: ToolCallId('c'), label: 'result' },
      suggestedName: 'old.txt', content: 'old spilled body',
    })
    const fresh = await ctx.spillStore.saveText({
      owner: { sessionId: SessionId('spill-fresh') }, source: { kind: 'tool', toolName: 'bash', callId: ToolCallId('d'), label: 'result' },
      suggestedName: 'fresh.txt', content: 'fresh spilled body',
    })
    const oldDate = new Date(Date.now() - 2 * 86_400_000)
    await utimes(old.locator, oldDate, oldDate)
    await sweepSpillRoots({
      roots: [{ path: dir, pruneWhenEmpty: false }],
      cutoffMs: Date.now() - 86_400_000,
      warn: () => undefined,
    })
    await expect(readFile(old.locator, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(fresh.locator, 'utf8')).toBe('fresh spilled body')
    await ctx.fiber.dispose()
  })

  it('keeps a spilled result event readable after its file is deleted', async () => {
    const ctx = await mountQuery()
    const session = ctx.sessions.create(SessionId('spill-event'), { meta: { createdAt: 1, cwd: '/work' } })
    const spill = await (async () => {
      const dir = await root()
      await ctx.plugin(LocalSpillStore, { root: dir, cleanupPeriodDays: 0 })
      return ctx.spillStore.saveText({
        owner: { sessionId: session.id }, source: { kind: 'tool', toolName: 'bash', callId: ToolCallId('c'), label: 'result' },
        suggestedName: 'result.txt', content: 'event body survives',
      })
    })()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('c'),
        content: [{ type: 'text', text: `event body survives at ${spill.locator}` }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    const seq = session.surface.nodes.at(-1)!
    await rm(spill.locator)
    const read = await ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: session.id, seq }, callId: ToolCallId('read'),
      signal: new AbortController().signal, agent: agent(session),
    })
    const text = read.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('event body survives')
    expect(text).toContain('untrusted data')

    const missing = await ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: 'spill-missing', seq: 0 }, callId: ToolCallId('read-missing'),
      signal: new AbortController().signal, agent: agent(session),
    })
    expect(missing.isError).toBe(true)
    expect(missing.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toMatch(/outside the caller workspace|no event at seq|not found/i)
    await ctx.fiber.dispose()
  })

  it('reads a live session without persistence and fails unknown ids explicitly', async () => {
    const ctx = await mountQuery()
    const session = ctx.sessions.create(SessionId('diskless-live'), { meta: { createdAt: 1, cwd: '/work' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'diskless body' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const seq = session.surface.nodes[0]!
    const read = await ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: session.id, seq }, callId: ToolCallId('read-live'),
      signal: new AbortController().signal, agent: agent(session),
    })
    expect(read.content.map(block => block.type === 'text' ? block.text : '').join('\n')).toContain('diskless body')
    const missing = await ctx.tools.execute({
      name: 'session_event_read', arguments: { session_id: 'diskless-unknown', seq: 0 }, callId: ToolCallId('read-unknown'),
      signal: new AbortController().signal, agent: agent(session),
    })
    expect(missing.isError).toBe(true)
    expect(missing.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toMatch(/outside the caller workspace|no event at seq|not found/i)
    await ctx.fiber.dispose()
  })
})
