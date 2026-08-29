/**
 * `show-content-page` against the real command registry: the sidebar's
 * page-navigation menu executes this exact registry boundary
 * (`ctx.commands.execute`), so the coverage here exercises that boundary
 * rather than calling the handler in isolation — registration metadata, a
 * successful show (recording `by: 'user'`, the reason this command exists),
 * an unknown id, a blank id, and HMR disposal safety.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { indexPages } from '../src/pages.ts'
import { SHOW_CONTENT_PAGE_COMMAND, showContentPageCommand } from '../src/command.ts'
import type { ContentPage } from '../src/types.ts'

/** The deployment under test: two pages, so an id choice is a real choice. */
const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status of every machine in the fleet.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Published reports, newest first.', url: '/content-app/reports/' },
]

let calls = 0

/** A minimal Agent the runtime can log lifecycle events against — only `.session` is ever read. */
function agentWithSession(session: Session): Agent {
  return { id: session.id, session } as unknown as Agent
}

/** Boot the real command registry and register this package's command over it. */
async function bench(): Promise<{ ctx: Context; agent: Agent; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  ctx.commands.register(showContentPageCommand(indexPages(PAGES, undefined)))
  const session = Session.create(SessionId(`show-content-page-${++calls}`))
  return { ctx, agent: agentWithSession(session), session }
}

/** Execute `/show-content-page` through the same registry boundary the sidebar menu uses. */
async function run(ctx: Context, agent: Agent, rawInput: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, `/${SHOW_CONTENT_PAGE_COMMAND}${rawInput}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('show-content-page command was not registered')
  return execution
}

/** Every `content/shown` payload the session recorded, in order. */
function shown(session: Session): unknown[] {
  return session.events
    .filter((event: SessionEvent) => event.type === 'content/shown')
    .map((event: SessionEvent) => event.data)
}

describe('show-content-page command', () => {
  it('registers with a discoverable description and input hint', async () => {
    const { ctx, agent } = await bench()
    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'show-content-page',
      description: 'Show one of this deployment\'s content-column pages. Used by the sidebar\'s page-navigation menu; not meant to be typed by hand.',
      input: { hint: 'page id' },
    })
  })

  it('shows a configured page and records it with the user as the writer', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, ' reports')
    expect(execution.result).toEqual({ kind: 'success', text: 'Now showing Weekly reports in the content column.' })
    expect(shown(session)).toEqual([{ page: 'reports', by: 'user' }])
  })

  it('refuses an unknown id and writes nothing', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, ' metrics')
    expect(execution.result).toEqual({ kind: 'error', text: '/show-content-page: unknown page "metrics"' })
    expect(shown(session)).toEqual([])
  })

  it('refuses a blank id and writes nothing', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, '   ')
    expect(execution.result).toEqual({ kind: 'error', text: '/show-content-page requires a page id' })
    expect(shown(session)).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const pages = indexPages(PAGES, undefined)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(showContentPageCommand(pages)) } })
    await fiber.await()
    const session = Session.create(SessionId(`show-content-page-hmr-${++calls}`))
    const agent = agentWithSession(session)
    expect(ctx.commands.find(agent, SHOW_CONTENT_PAGE_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, SHOW_CONTENT_PAGE_COMMAND)).toBeUndefined()
  })
})
