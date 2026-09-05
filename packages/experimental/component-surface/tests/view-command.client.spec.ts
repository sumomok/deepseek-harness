/**
 * `show-content-view` against the real command registry: the sidebar's
 * navigation menu executes this exact boundary (`ctx.commands.execute`), so
 * the coverage here exercises it rather than calling the handler in isolation
 * — registration metadata, the event a click writes, the sentence a click that
 * named no view earns, and disposal safety.
 *
 * What the appended event has to carry is the whole of what makes a view
 * replayable: the spec itself, not the id it was configured under. A
 * deployment that later edits or drops the view must still leave the log
 * reading as what the user actually saw.
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
import { SHOW_CONTENT_VIEW_COMMAND, showContentViewCommand } from '../src/view-command.ts'
import { indexViews } from '../src/views.ts'
import type { ContentView } from '../src/types.ts'

/** Two accepted view specs, distinct enough that an appended record names which view produced it. */
const SITES = { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }], columnNum: 1 } }] }
const ALERTS = { nodes: [{ id: 'ball', component: 'el.metric', props: { process: 42, text: '告警' } }] }

/** The deployment under test: two views, so naming one is a real choice. */
const VIEWS: ContentView[] = [
  { id: 'site-overview', title: '站点概览', spec: SITES },
  { id: 'alerts', title: '告警', spec: ALERTS },
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
  ctx.commands.register(showContentViewCommand(indexViews(VIEWS, undefined)))
  const session = Session.create(SessionId(`show-content-view-${++calls}`))
  return { ctx, agent: agentWithSession(session), session }
}

/** Execute `/show-content-view` through the same registry boundary the sidebar menu uses. */
async function run(ctx: Context, agent: Agent, rawInput: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, `/${SHOW_CONTENT_VIEW_COMMAND}${rawInput}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('show-content-view command was not registered')
  return execution
}

/** Every `content-component/shown` payload the session recorded, in order. */
function shown(session: Session): unknown[] {
  return session.events
    .filter((event: SessionEvent) => event.type === 'content-component/shown')
    .map((event: SessionEvent) => event.data)
}

describe('show-content-view command', () => {
  it('registers with a description written for the end user scrolling the slash menu', async () => {
    const { ctx, agent } = await bench()
    expect(ctx.commands.list(agent)).toContainEqual({
      name: 'show-content-view',
      description: '点侧栏里的条目就会打开，内容出现在对话旁边；这一行不用手动输入。',
      input: { hint: '名称' },
    })
  })

  it('records the whole view, so the column replays without the configuration that produced it', async () => {
    const { ctx, agent, session } = await bench()
    const execution = await run(ctx, agent, ' site-overview')
    // No sentence: the block arriving in the column is what the click asked
    // for, and a line narrating it would be noise beside it.
    expect(execution.result).toEqual({ kind: 'success' })
    expect(shown(session)).toEqual([{
      entryId: 'site-overview',
      title: '站点概览',
      spec: SITES,
      by: 'user',
    }])
  })

  it('records the input verbatim, the way every other command the sidebar runs does', async () => {
    const { ctx, agent, session } = await bench()
    await run(ctx, agent, ' alerts')
    const started = session.events.find((event: SessionEvent) => event.type === 'command/run')
    expect(started?.type === 'command/run' && started.data).toMatchObject({
      name: SHOW_CONTENT_VIEW_COMMAND,
      args: ' alerts',
      source: { kind: 'user' },
    })
  })

  it('appends again for a second click on the view already on screen', async () => {
    // Same entry id, so the column keeps one row for it; the append is what
    // moves that row back to the front of the switcher instead of doing
    // nothing at all.
    const { ctx, agent, session } = await bench()
    await run(ctx, agent, ' alerts')
    await run(ctx, agent, ' alerts')
    expect(shown(session)).toHaveLength(2)
  })

  it('answers a click that named no view with one sentence, and writes nothing', async () => {
    const { ctx, agent, session } = await bench()
    expect((await run(ctx, agent, ' metrics')).result).toEqual({ kind: 'error', text: '没有这个视图。' })
    expect(shown(session)).toEqual([])
  })

  it('answers an empty invocation the same way, because it is the same event to the person who clicked', async () => {
    const { ctx, agent, session } = await bench()
    expect((await run(ctx, agent, '   ')).result).toEqual({ kind: 'error', text: '没有这个视图。' })
    expect(shown(session)).toEqual([])
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const views = indexViews(VIEWS, undefined)
    const fiber = ctx.plugin({ inject: ['commands'], apply: (child: Context) => { child.commands.register(showContentViewCommand(views)) } })
    await fiber.await()
    const agent = agentWithSession(Session.create(SessionId(`show-content-view-hmr-${++calls}`)))
    expect(ctx.commands.find(agent, SHOW_CONTENT_VIEW_COMMAND)).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, SHOW_CONTENT_VIEW_COMMAND)).toBeUndefined()
  })
})
