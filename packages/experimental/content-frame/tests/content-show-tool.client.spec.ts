/**
 * `content_show` against the real tool runtime: the three execution paths
 * (show, clear, unknown id), what each one writes to the session log, and the
 * model-visible text — name, description, parameter schema, result text, and
 * the failure message — pinned verbatim, because those strings are the whole
 * contract the model reads.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { indexPages } from '../src/pages.ts'
import { contentShowTool } from '../src/tool.ts'
import type { ContentPage } from '../src/types.ts'

/** The deployment under test: two pages, so an id choice is a real choice. */
const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status of every machine in the fleet.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Published reports, newest first.', url: '/content-app/reports/' },
]

const signal = new AbortController().signal
let calls = 0

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(session: Session): NonNullable<ToolExecutionInput['agent']> {
  return { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>
}

/** Boot the tool over a real registry and a real session to append into. */
async function bench(): Promise<{ ctx: Context; session: Session; run: (page: string) => Promise<ToolExecutionResult> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId(`content-show-${++calls}`))
  ctx.tools.register(contentShowTool(indexPages(PAGES, undefined)))
  const agent = agentWithSession(session)
  return {
    ctx,
    session,
    run: (page: string) => ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'content_show',
      arguments: { page },
      agent,
      signal,
    }),
  }
}

/** The model-facing text of one settled execution. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** Every `content/shown` payload the session recorded, in order. */
function shown(session: Session): unknown[] {
  return session.events
    .filter((event: SessionEvent) => event.type === 'content/shown')
    .map((event: SessionEvent) => event.data)
}

describe('content_show', () => {
  it('shows a configured page and records it as the whole column state', async () => {
    const { session, run } = await bench()
    const result = await run('reports')
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ page: 'reports', title: 'Weekly reports' })
    expect(text(result)).toBe('Now showing Weekly reports in the content column.')
    expect(shown(session)).toEqual([{ page: 'reports', by: 'agent' }])
  })

  it('clears the column on the reserved id, recording the cleared state', async () => {
    const { session, run } = await bench()
    const result = await run('none')
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ page: 'none' })
    expect(text(result)).toBe('Content column cleared.')
    expect(shown(session)).toEqual([{ page: null, by: 'agent' }])
  })

  it('refuses an unknown id with the whole catalogue and writes nothing', async () => {
    const { session, run } = await bench()
    const result = await run('metrics')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown page "metrics". Available pages:')
    // The catalogue comes back in full so the next call can be right without
    // re-reading the tool description.
    expect(text(result)).toContain('- dashboard — Fleet dashboard — Live status of every machine in the fleet.')
    expect(text(result)).toContain('- reports — Weekly reports — Published reports, newest first.')
    expect(text(result)).toContain('Or pass "none" to empty the column.')
    // The column keeps showing whatever it showed: a rejected call is not a change.
    expect(shown(session)).toEqual([])
  })

  it('refuses a call with no owning session', async () => {
    const { ctx } = await bench()
    const result = await ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'content_show',
      arguments: { page: 'reports' },
      signal,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('content_show requires an owning agent session')
  })

  it('pins the model-visible schema verbatim', async () => {
    const { ctx } = await bench()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'content_show')
    expect(schema).toEqual({
      name: 'content_show',
      description: 'Show one of this deployment\'s pages in the content column of the user\'s GUI — the panel beside the '
        + 'conversation, which the user sees immediately without opening or scrolling anything. Use it to put a '
        + 'page in front of the user while you talk about it. The column keeps showing that page until you change '
        + 'it, and each session has its own column.\n\nPages:\n'
        + '- dashboard — Fleet dashboard — Live status of every machine in the fleet.\n'
        + '- reports — Weekly reports — Published reports, newest first.'
        + '\n\nPass `none` to empty the column instead of showing a page. '
        + 'Any other id that is not in the list above changes nothing and comes back as an error.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Id of the page to show, or "none" to empty the column.' },
        },
        required: ['page'],
      },
    })
  })

  it('presents the pending call as a pure function of its arguments', () => {
    const tool = contentShowTool(indexPages(PAGES, undefined))
    expect(tool.presentCall?.({ page: 'reports' })).toEqual({
      card: 'generic',
      title: 'Show reports in the content column',
      kind: 'other',
      rawInput: 'reports',
    })
    expect(tool.presentCall?.({ page: 'none' })).toEqual({
      card: 'generic',
      title: 'Clear the content column',
      kind: 'other',
      rawInput: 'none',
    })
    // Replay may reach the presenter with arguments an older schema allowed;
    // display must degrade to the generic card rather than throw.
    expect(tool.presentCall?.({})).toBeUndefined()
  })

  it('leaves the registry when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const pages = indexPages(PAGES, undefined)
    const fiber = ctx.plugin({ inject: ['tools'], apply: (child: Context) => { child.tools.register(contentShowTool(pages)) } })
    await fiber.await()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('content_show')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('content_show')
  })
})
