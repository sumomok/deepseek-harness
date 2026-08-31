/**
 * `dismiss-content-entry` against the real command registry: content-column's
 * switcher strip executes this exact registry boundary
 * (`ctx.commands.execute`), so the coverage here exercises that boundary
 * rather than calling the handler in isolation — registration metadata, a
 * successful dismissal (recording `by: 'user'`), a malformed input with no
 * space to split on, an input whose kind or entryId half is empty, and HMR
 * disposal safety.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DISMISS_CONTENT_ENTRY_COMMAND, dismissContentEntryCommand } from '../src/command.ts'

let calls = 0

/** A minimal Agent the runtime can log lifecycle events against — only `.session` is ever read. */
function agentWithSession(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Boot the real command registry and register this package's command over it. */
async function bench(): Promise<{ ctx: Context; agent: Agent; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  ctx.commands.register(dismissContentEntryCommand())
  const session = Session.create(SessionId(`dismiss-content-entry-${++calls}`))
  return { ctx, agent: agentWithSession(session), session }
}

/** Execute `/dismiss-content-entry` through the same registry boundary the switcher strip uses. */
async function run(ctx: Context, agent: Agent, rawInput: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, `/${DISMISS_CONTENT_ENTRY_COMMAND}${rawInput}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('dismiss-content-entry command was not registered')
  return execution
}

/** Every `content-surface/dismissed` payload the session recorded, in order. */
function dismissed(session: Session): unknown[] {
  return session.events
    .filter((event: SessionEvent) => event.type === 'content-surface/dismissed')
    .map((event: SessionEvent) => event.data)
}

describe('dismiss-content-entry command', () => {
  it('registers with a discoverable description and input hint', async () => {
    const { ctx, agent } = await bench()
    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'dismiss-content-entry',
      description: 'Close one entry\'s tab in the content column\'s switcher strip. Used by the switcher\'s own close button; not meant to be typed by hand.',
      input: { hint: 'kind entryId' },
    })
  })

  it('dismisses a named entry and records it with the user as the writer', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, ' page reports')
    expect(execution.result).toEqual({ kind: 'success' })
    expect(dismissed(session)).toEqual([{ kind: 'page', entryId: 'reports', by: 'user' }])
  })

  it('keeps an entryId carrying its own spaces whole', async () => {
    const { ctx, agent, session } = await bench()
    await run(ctx, agent, ' chart weekly sales figures')
    expect(dismissed(session)).toEqual([{ kind: 'chart', entryId: 'weekly sales figures', by: 'user' }])
  })

  it.each([
    ' page',
    '   ',
  ])('refuses input with no space to split on and writes nothing', async (rawInput) => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, rawInput)
    expect(execution.result).toEqual({ kind: 'error', text: '/dismiss-content-entry requires "<kind> <entryId>"' })
    expect(dismissed(session)).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(dismissContentEntryCommand()) } })
    await fiber.await()
    const session = Session.create(SessionId(`dismiss-content-entry-hmr-${++calls}`))
    const agent = agentWithSession(session)
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeUndefined()
  })
})
