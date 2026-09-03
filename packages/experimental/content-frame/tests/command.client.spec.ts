/**
 * The two browser-driven commands against the real command registry: the
 * sidebar's page-navigation menu and this package's own page seat execute this
 * exact registry boundary (`ctx.commands.execute`), so the coverage here
 * exercises that boundary rather than calling the handlers in isolation —
 * registration metadata, a successful show (recording `by: 'user'`, the reason
 * that event carries the field) and the notice it injects, every field
 * `content-navigated` checks on input that crossed a process, and HMR disposal
 * safety.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { indexPages } from '../src/pages.ts'
import {
  CONTENT_NAVIGATED_COMMAND, contentNavigatedCommand, SHOW_CONTENT_PAGE_COMMAND, showContentPageCommand,
} from '../src/command.ts'
import { openedPageNotice } from '../src/perception/text.ts'
import { MAX_HEADER_CHARS, MAX_URL_CHARS } from '../src/access/wire.ts'
import type { ContentPage } from '../src/types.ts'

/** The deployment under test: two pages, so an id choice is a real choice. */
const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status of every machine in the fleet.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Published reports, newest first.', url: '/content-app/reports/' },
]

let calls = 0

/** A minimal Agent the runtime can log lifecycle events against and take injected context from. */
function agentWithSession(session: Session, injected: UserMessage[]): Agent {
  return {
    id: session.id,
    session,
    inject: vi.fn((message: UserMessage) => { injected.push(message) }),
  } as unknown as Agent
}

/** The bench: the real registry, one session, and what a command injected into the agent. */
interface Bench {
  ctx: Context
  agent: Agent
  session: Session
  injected: UserMessage[]
}

/** Boot the real command registry and register both of this package's commands over it. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  const pages = indexPages(PAGES, undefined)
  ctx.commands.register(showContentPageCommand(pages))
  ctx.commands.register(contentNavigatedCommand(pages))
  const session = Session.create(SessionId(`content-frame-command-${++calls}`))
  const injected: UserMessage[] = []
  return { ctx, agent: agentWithSession(session, injected), session, injected }
}

/** Execute one command through the same registry boundary the browser uses. */
async function runCommand(ctx: Context, agent: Agent, command: string, rawInput: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, `/${command}${rawInput}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`${command} command was not registered`)
  return execution
}

/** Execute `/show-content-page` through the same registry boundary the sidebar menu uses. */
async function run(ctx: Context, agent: Agent, rawInput: string): Promise<CommandExecution> {
  return await runCommand(ctx, agent, SHOW_CONTENT_PAGE_COMMAND, rawInput)
}

/** Every payload of one type the session recorded, in order. */
function recorded(session: Session, type: string): unknown[] {
  return session.snapshotEvents()
    .filter((event: SessionEvent) => (event.type as string) === type)
    .map((event: SessionEvent) => event.data)
}

/** Every `content/shown` payload the session recorded, in order. */
function shown(session: Session): unknown[] {
  return recorded(session, 'content/shown')
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

  it('tells the agent which page the user opened, and puts the record on the log first', async () => {
    const { ctx, agent, session, injected } = await bench()
    let atSeq = 0
    ;(agent.inject as unknown as ReturnType<typeof vi.fn>).mockImplementation((message: UserMessage) => {
      injected.push(message)
      atSeq = session.seq
    })
    await run(ctx, agent, ' reports')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.content).toEqual([{
      type: 'text',
      text: 'The user opened the page "Weekly reports" in the content column (内容区); it is in front now.',
    }])
    // The same sentence the package composes, so a wording change moves both.
    expect(injected[0]!.content[0]).toMatchObject({ text: openedPageNotice('Weekly reports') })
    expect(injected[0]!.source).toEqual({
      kind: 'plugin',
      plugin: 'content-frame',
      form: 'notice',
      summary: 'The user opened the page "Weekly reports" in the content column (内容区); it is in front now.',
    })
    // Appended first, injected second: the log carries the fact before the
    // sentence about it, and the notice is queued rather than delivered.
    const events = session.snapshotEvents()
    const at = events.findIndex((event: SessionEvent) => event.type === 'content/shown')
    expect(events[at]!.seq).toBeLessThan(atSeq)
  })

  it('says nothing to the agent when the id names no configured page', async () => {
    const { ctx, agent, injected } = await bench()
    await run(ctx, agent, ' metrics')
    expect(injected).toEqual([])
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
    const agent = agentWithSession(session, [])
    expect(ctx.commands.find(agent, SHOW_CONTENT_PAGE_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, SHOW_CONTENT_PAGE_COMMAND)).toBeUndefined()
  })
})

describe('content-navigated command', () => {
  it('registers with a discoverable description and input hint', async () => {
    const { ctx, agent } = await bench()
    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'content-navigated',
      description: 'Record that the page in the content column moved to a different address inside itself. Used by the content column\'s own page seat; not meant to be typed by hand.',
      input: { hint: 'by page url title' },
    })
  })

  it('records where the frame went, keeping a title that carries its own spaces whole', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ' user reports /content-app/reports/#/device Fleet · devices')
    expect(execution.result).toEqual({ kind: 'success' })
    expect(recorded(session, 'content/navigated')).toEqual([{
      page: 'reports',
      url: '/content-app/reports/#/device',
      title: 'Fleet · devices',
      by: 'user',
    }])
  })

  it('records an empty title for a document that has none', async () => {
    const { ctx, agent, session } = await bench()
    await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ' user reports /content-app/reports/')
    expect(recorded(session, 'content/navigated'))
      .toEqual([{ page: 'reports', url: '/content-app/reports/', title: '', by: 'user' }])
  })

  it('takes the writer the hands slice reserves as well as the browser\'s own', async () => {
    const { ctx, agent, session } = await bench()
    await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ' agent reports /content-app/reports/#/x X')
    expect(recorded(session, 'content/navigated'))
      .toEqual([{ page: 'reports', url: '/content-app/reports/#/x', title: 'X', by: 'agent' }])
  })

  it('says nothing to the agent: where the frame is rides the request context instead', async () => {
    const { ctx, agent, injected } = await bench()
    await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ' user reports /content-app/reports/ Reports')
    expect(injected).toEqual([])
  })

  it.each([
    ['one field', ' user', '/content-navigated requires "<by> <page> <url> [title]"'],
    ['two fields', ' user reports', '/content-navigated requires "<by> <page> <url> [title]"'],
    ['an unknown writer', ' nobody reports /x X', '/content-navigated: by must be "user" or "agent"'],
    ['an unconfigured page', ' user metrics /x X', '/content-navigated: unknown page "metrics"'],
    [
      'an address that is not a path',
      ' user reports https://elsewhere/x X',
      `/content-navigated: url must be a path starting with "/", at most ${String(MAX_URL_CHARS)} printable characters`,
    ],
  ])('refuses %s and writes nothing', async (_case, rawInput, text) => {
    const { ctx, agent, session } = await bench()
    const execution = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, rawInput)
    expect(execution.result).toEqual({ kind: 'error', text })
    expect(recorded(session, 'content/navigated')).toEqual([])
  })

  it('refuses an address or a title past its bound, and takes the same input at it', async () => {
    const { ctx, agent, session } = await bench()
    const path = `/${'u'.repeat(MAX_URL_CHARS)}`
    const atBound = `/${'u'.repeat(MAX_URL_CHARS - 1)}`
    const longUrl = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ` user reports ${path} X`)
    expect(longUrl.result).toEqual({
      kind: 'error',
      text: `/content-navigated: url must be a path starting with "/", at most ${String(MAX_URL_CHARS)} printable characters`,
    })
    const longTitle = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ` user reports /x ${'t'.repeat(MAX_HEADER_CHARS + 1)}`)
    expect(longTitle.result).toEqual({
      kind: 'error',
      text: `/content-navigated: title must be at most ${String(MAX_HEADER_CHARS)} printable characters`,
    })
    expect(recorded(session, 'content/navigated')).toEqual([])

    await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ` user reports ${atBound} ${'t'.repeat(MAX_HEADER_CHARS)}`)
    expect(recorded(session, 'content/navigated')).toHaveLength(1)
  })

  it('refuses an address or a title carrying what a log should not', async () => {
    const { ctx, agent, session } = await bench()
    const control = String.fromCharCode(1)
    const badUrl = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ` user reports /x${control} X`)
    expect(badUrl.result).toMatchObject({ kind: 'error' })
    const badTitle = await runCommand(ctx, agent, CONTENT_NAVIGATED_COMMAND, ` user reports /x X${control}`)
    expect(badTitle.result).toMatchObject({ kind: 'error' })
    expect(recorded(session, 'content/navigated')).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const pages = indexPages(PAGES, undefined)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(contentNavigatedCommand(pages)) } })
    await fiber.await()
    const session = Session.create(SessionId(`content-navigated-hmr-${++calls}`))
    const agent = agentWithSession(session, [])
    expect(ctx.commands.find(agent, CONTENT_NAVIGATED_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, CONTENT_NAVIGATED_COMMAND)).toBeUndefined()
  })
})
