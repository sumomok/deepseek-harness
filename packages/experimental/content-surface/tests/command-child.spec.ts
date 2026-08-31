/**
 * The optional `commands` child: `ctx.contentSurface` registers
 * `dismiss-content-entry` whenever a command runtime is composed, and keeps
 * the extractor table with no command registered when one is not.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ContentSurfaceRegistry from '../src/index.ts'
import { DISMISS_CONTENT_ENTRY_COMMAND } from '../src/command.ts'

/** A minimal Agent the runtime can look commands up against — only `.session` is ever read. */
function agentWithSession(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

describe('content surface commands child', () => {
  it('registers dismiss-content-entry whenever a command runtime is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(ContentSurfaceRegistry).await()
    const agent = agentWithSession(Session.create(SessionId('command-child-a')))
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()
  })

  it('withdraws the command when the row unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin(ContentSurfaceRegistry)
    await fiber.await()
    const agent = agentWithSession(Session.create(SessionId('command-child-b')))
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()

    await fiber.dispose()
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeUndefined()
  })

  it('keeps the extractor table without a command runtime composed', async () => {
    const ctx = new Context()
    await ctx.plugin(ContentSurfaceRegistry).await()
    expect(typeof ctx.contentSurface.register).toBe('function')
  })
})
