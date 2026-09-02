/**
 * The optional `commands` child: `ctx.contentSurface` registers both switcher
 * commands whenever a command runtime is composed, keeps the extractor table
 * with no command registered when one is not, and — over a real projection
 * registry — hands the dismissal the entry titles its notice names.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import ContentSurfaceRegistry from '../src/index.ts'
import { DISMISS_CONTENT_ENTRY_COMMAND, SELECT_CONTENT_ENTRY_COMMAND } from '../src/command.ts'

/** A minimal Agent the runtime can look commands up against — only `.session` is ever read. */
function agentWithSession(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** The fake event one test extractor recognizes as a `note` entry. */
const NOTE_SHOWN = 'note/shown'

describe('content surface commands child', () => {
  it('registers both switcher commands whenever a command runtime is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(ContentSurfaceRegistry).await()
    const agent = agentWithSession(Session.create(SessionId('command-child-a')))
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()
    expect(ctx.commands.find(agent, SELECT_CONTENT_ENTRY_COMMAND)).toBeDefined()
  })

  it('withdraws both commands when the row unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin(ContentSurfaceRegistry)
    await fiber.await()
    const agent = agentWithSession(Session.create(SessionId('command-child-b')))
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()

    await fiber.dispose()
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeUndefined()
    expect(ctx.commands.find(agent, SELECT_CONTENT_ENTRY_COMMAND)).toBeUndefined()
  })

  it('names the closed entry from the projection registry the composition actually has', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(ContentSurfaceRegistry).await()
    ctx.contentSurface.register({
      kind: 'note',
      dataVersion: 1,
      read: (event: SessionEvent) => ((event.type as string) === NOTE_SHOWN
        ? { entryId: 'draft', data: 'Draft note' }
        : undefined),
      resolve: (data: string) => ({ title: data, payload: null }),
    })
    const session = Session.create(SessionId('command-child-c'))
    const injected: UserMessage[] = []
    const agent = {
      id: session.id,
      session,
      inject: vi.fn((message: UserMessage) => { injected.push(message) }),
    } as unknown as Agent
    session.append(NOTE_SHOWN as 'turn/start', { turn: 1 })

    await ctx.commands.execute(agent, `/${DISMISS_CONTENT_ENTRY_COMMAND} note draft`, [], new AbortController().signal)
    expect(injected.map(message => message.content)).toEqual([[{
      type: 'text',
      text: 'The user closed the note "Draft note" in the content column.',
    }]])
  })

  it('keeps the extractor table without a command runtime composed', async () => {
    const ctx = new Context()
    await ctx.plugin(ContentSurfaceRegistry).await()
    expect(typeof ctx.contentSurface.register).toBe('function')
  })
})
