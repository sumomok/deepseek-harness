/**
 * The switcher strip's two commands against the real command registry:
 * content-column executes this exact registry boundary
 * (`ctx.commands.execute`), so the coverage here exercises that boundary
 * rather than calling the handlers in isolation — registration metadata, the
 * two successful gestures (each recording `by: 'user'`), the dismissal notice
 * the agent reads and the order it lands in, a malformed input with no space
 * to split on, and HMR disposal safety.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  closedEntryNotice, DISMISS_CONTENT_ENTRY_COMMAND, dismissContentEntryCommand,
  SELECT_CONTENT_ENTRY_COMMAND, selectContentEntryCommand,
} from '../src/command.ts'
import type { ContentSurfaceEntry } from '../src/types.ts'

let calls = 0

/** One live entry, as the `contentSurface` view would carry it. */
function entry(kind: string, entryId: string, title: string): ContentSurfaceEntry {
  return { kind, entryId, seq: 1, title, payload: null }
}

/** What one injected notice landed as, and where the log stood when it did. */
interface Injected {
  /** The message the command injected. */
  message: UserMessage
  /** The session's next seq at injection time, which is past the recorded event. */
  atSeq: number
}

/** The bench: the real registry, one session, and what the command injected into the agent. */
interface Bench {
  ctx: Context
  agent: Agent
  session: Session
  injected: Injected[]
}

/**
 * Boot the real command registry and register this package's commands over it.
 * @param entries - the session's live entries, as the projection registry would
 * report them; an absent lookup stands in for a composition with no registry.
 * @returns the bench.
 */
async function bench(entries?: readonly ContentSurfaceEntry[]): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  ctx.commands.register(dismissContentEntryCommand(entries === undefined ? undefined : () => entries))
  ctx.commands.register(selectContentEntryCommand())
  const session = Session.create(SessionId(`content-surface-command-${++calls}`))
  const injected: Injected[] = []
  const agent = {
    id: session.id,
    session,
    inject: vi.fn((message: UserMessage) => { injected.push({ message, atSeq: session.seq }) }),
  } as unknown as Agent
  return { ctx, agent, session, injected }
}

/** Execute one of the two commands through the same registry boundary the switcher strip uses. */
async function run(ctx: Context, agent: Agent, command: string, rawInput: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, `/${command}${rawInput}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`${command} command was not registered`)
  return execution
}

/** Every payload of one type the session recorded, in order. */
function recorded(session: Session, type: string): unknown[] {
  return session.events
    .filter((event: SessionEvent) => (event.type as string) === type)
    .map((event: SessionEvent) => event.data)
}

/** Every `content-surface/dismissed` payload the session recorded, in order. */
function dismissed(session: Session): unknown[] {
  return recorded(session, 'content-surface/dismissed')
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
    const execution = await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, ' page reports')
    expect(execution.result).toEqual({ kind: 'success' })
    expect(dismissed(session)).toEqual([{ kind: 'page', entryId: 'reports', by: 'user' }])
  })

  it('keeps an entryId carrying its own spaces whole', async () => {
    const { ctx, agent, session } = await bench()
    await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, ' chart weekly sales figures')
    expect(dismissed(session)).toEqual([{ kind: 'chart', entryId: 'weekly sales figures', by: 'user' }])
  })

  it.each([
    ' page',
    '   ',
  ])('refuses input with no space to split on and writes nothing', async (rawInput) => {
    const { ctx, agent, session, injected } = await bench([entry('page', 'reports', 'Weekly reports')])
    const execution = await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, rawInput)
    expect(execution.result).toEqual({ kind: 'error', text: '/dismiss-content-entry requires "<kind> <entryId>"' })
    expect(dismissed(session)).toEqual([])
    expect(injected).toEqual([])
  })

  it('tells the agent what the user closed, naming the kind and the title the column showed', async () => {
    const { ctx, agent, session, injected } = await bench([entry('page', 'reports', 'Weekly reports')])
    await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, ' page reports')
    expect(injected).toHaveLength(1)
    const notice = injected[0]!
    expect(notice.message.content).toEqual([{
      type: 'text',
      text: 'The user closed the page "Weekly reports" in the content column.',
    }])
    // The same sentence the package composes, so a wording change moves both.
    expect(notice.message.content[0]).toMatchObject({ text: closedEntryNotice('page', 'Weekly reports') })
    expect(notice.message.source).toEqual({
      kind: 'plugin',
      plugin: 'content-surface',
      form: 'notice',
      summary: 'The user closed the page "Weekly reports" in the content column.',
    })
    // Appended first, injected second: the log carries the fact before the
    // sentence about it, and the notice is queued rather than delivered.
    const at = session.events.findIndex((event: SessionEvent) => event.type === 'content-surface/dismissed')
    expect(session.events[at]!.seq).toBeLessThan(notice.atSeq)
  })

  it('records the dismissal and says nothing when the pair names no live entry', async () => {
    const { ctx, agent, session, injected } = await bench([entry('page', 'reports', 'Weekly reports')])
    await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, ' page gone')
    expect(dismissed(session)).toEqual([{ kind: 'page', entryId: 'gone', by: 'user' }])
    expect(injected).toEqual([])
  })

  it('records the dismissal and says nothing without a projection registry to read a title from', async () => {
    const { ctx, agent, session, injected } = await bench()
    await run(ctx, agent, DISMISS_CONTENT_ENTRY_COMMAND, ' page reports')
    expect(dismissed(session)).toEqual([{ kind: 'page', entryId: 'reports', by: 'user' }])
    expect(injected).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(dismissContentEntryCommand()) } })
    await fiber.await()
    const session = Session.create(SessionId(`dismiss-content-entry-hmr-${++calls}`))
    const agent = { id: session.id, session } as unknown as Agent
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, DISMISS_CONTENT_ENTRY_COMMAND)).toBeUndefined()
  })
})

describe('select-content-entry command', () => {
  it('registers with a discoverable description and input hint', async () => {
    const { ctx, agent } = await bench()
    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'select-content-entry',
      description: 'Bring one entry\'s tab to the front of the content column\'s switcher strip. Used by the switcher\'s own tab buttons; not meant to be typed by hand.',
      input: { hint: 'kind entryId' },
    })
  })

  it('records the selected pair with the user as the writer', async () => {
    const { ctx, agent, session } = await bench([entry('page', 'reports', 'Weekly reports')])
    const execution = await run(ctx, agent, SELECT_CONTENT_ENTRY_COMMAND, ' page reports')
    expect(execution.result).toEqual({ kind: 'success' })
    expect(recorded(session, 'content-surface/selected'))
      .toEqual([{ kind: 'page', entryId: 'reports', by: 'user' }])
  })

  it('records a pair that names no live entry, which the fold answers by falling back', async () => {
    const { ctx, agent, session } = await bench([entry('page', 'reports', 'Weekly reports')])
    await run(ctx, agent, SELECT_CONTENT_ENTRY_COMMAND, ' chart gone')
    expect(recorded(session, 'content-surface/selected'))
      .toEqual([{ kind: 'chart', entryId: 'gone', by: 'user' }])
  })

  it('says nothing to the agent: which tab is in front rides the request context instead', async () => {
    const { ctx, agent, injected } = await bench([entry('page', 'reports', 'Weekly reports')])
    await run(ctx, agent, SELECT_CONTENT_ENTRY_COMMAND, ' page reports')
    expect(injected).toEqual([])
  })

  it('refuses input with no space to split on and writes nothing', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, SELECT_CONTENT_ENTRY_COMMAND, ' page')
    expect(execution.result).toEqual({ kind: 'error', text: '/select-content-entry requires "<kind> <entryId>"' })
    expect(recorded(session, 'content-surface/selected')).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(selectContentEntryCommand()) } })
    await fiber.await()
    const session = Session.create(SessionId(`select-content-entry-hmr-${++calls}`))
    const agent = { id: session.id, session } as unknown as Agent
    expect(ctx.commands.find(agent, SELECT_CONTENT_ENTRY_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, SELECT_CONTENT_ENTRY_COMMAND)).toBeUndefined()
  })
})
