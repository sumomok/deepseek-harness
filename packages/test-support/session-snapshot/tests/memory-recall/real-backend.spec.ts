/** Real SQLite session-query backend integration for automatic prior-Session recall. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import { apply } from '@deepseek-ai/dsh-session-memory-recall'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal

function userEvent(text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(0),
    time: 1,
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

async function withSqliteContext(run: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    await run(ctx)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runPreStep(ctx: Context, session: ReturnType<SessionStore['create']>): Promise<UserMessage[]> {
  const user = createUserMessage({
    content: [{ type: 'text', text: 'How do we run the focused tests?' }],
    source: { kind: 'user' },
  })
  const decision = await ctx.waterfall('agent/pre-step', {
    agent: { session, options: {} } as Agent,
    messages: [user],
    turn: 1,
    step: 1,
    signal: SIGNAL,
  }, async () => ({ kind: 'enter', messages: [user] }))
  return decision.kind === 'enter' ? [...decision.messages] : []
}

it('recalls a same-cwd prior Session and excludes a different workspace', async () => {
  await withSqliteContext(async (ctx) => {
    ctx.sessions.create(SessionId('prior'), {
      seed: [userEvent('Use pnpm exec vitest for the focused compaction suite.')],
      meta: { cwd: '/work/project', createdAt: 1 },
    })
    ctx.sessions.create(SessionId('other'), {
      seed: [userEvent('This belongs to another workspace and must not be recalled.')],
      meta: { cwd: '/work/elsewhere', createdAt: 1 },
    })
    const caller = ctx.sessions.create(SessionId('caller'), {
      meta: { cwd: '/work/project', createdAt: 2 },
    })
    apply(ctx, { enabled: true, timeoutMs: 5_000 })

    const messages = await runPreStep(ctx, caller)
    const recall = messages.find(message => message.source.kind === 'memory-recall')

    expect(recall).toBeDefined()
    const text = recall?.content[0]?.type === 'text' ? recall.content[0].text : ''
    expect(text).toContain('Use pnpm exec vitest for the focused compaction suite.')
    expect(text).not.toContain('another workspace')
    expect(recall?.source.kind === 'memory-recall' && recall.source.hits)
      .toEqual([expect.objectContaining({ sessionId: SessionId('prior') })])
  })
})

it('does not inject anything when the corpus is empty', async () => {
  await withSqliteContext(async (ctx) => {
    const caller = ctx.sessions.create(SessionId('empty-caller'), {
      meta: { cwd: '/work/project', createdAt: 2 },
    })
    apply(ctx, { enabled: true, timeoutMs: 5_000 })
    expect(await runPreStep(ctx, caller)).toHaveLength(1)
  })
})
