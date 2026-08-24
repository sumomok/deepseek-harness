/**
 * The `showCharts` projection unit against the real registry: the fold over
 * both log shapes a `show_chart` call can take, the chart id each call belongs
 * to, the last-call-wins ownership the view derives, the calls it must not
 * count, and removal when the row unloads (HMR safety).
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { showChartsProjection } from '../src/projection.ts'
import type { ShowChartsView } from '../src/types.ts'

/**
 * The host session store. Reached through `ctx.get` and cast: this package
 * compiles in the Client aggregate, where the cordis `Context.sessions` merge
 * names the browser service rather than the host store.
 * @param ctx - the context the store was mounted on.
 * @returns the store.
 */
function store(ctx: Context): SessionStore {
  return ctx.get('sessions') as unknown as SessionStore
}

interface Bench {
  session: Session
  /** Append one top-level call, the shape a model calling the tool directly logs. */
  call: (callId: string, args: unknown, name?: string) => void
  /** Append one Code Mode sub-dispatch, the shape a model calling through `run_code` logs. */
  dispatch: (subCallId: string, args: unknown, name?: string) => void
  /** The whole current value the browser would receive. */
  value: () => ShowChartsView | undefined
}

/**
 * Mount the registry and this package's unit over a real session.
 * @returns the bench.
 */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const session = store(ctx).create()
  ctx.sessionProjections.register(showChartsProjection())
  return {
    session,
    call: (callId, args, name = 'show_chart') => {
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(callId),
        name,
        // The log carries the model's arguments as raw JSON; a spec feeding a
        // string feeds exactly what an unparseable log line carries.
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      })
    },
    dispatch: (subCallId, args, name = 'show_chart') => {
      session.append('tool/code-dispatch-start', {
        rootCallId: CallId('root'),
        parentCallId: CallId('root'),
        subCallId: CallId(subCallId),
        name,
        arguments: args,
      })
    },
    value: () => ctx.sessionProjections.snapshot(session).values.showCharts,
  }
}

const OPTION = { series: [{ type: 'bar', data: [1, 2, 3] }] }

describe('showCharts projection', () => {
  it('reports no charts for a session that drew none', async () => {
    const { value } = await bench()
    expect(value()).toEqual({ entries: [], latest: {} })
  })

  it('records a top-level call under the id it named', async () => {
    const { call, value } = await bench()
    call('call_1', { id: 'revenue', title: 'Weekly revenue', option: OPTION })
    expect(value()).toEqual({
      entries: [{ chartId: 'revenue', callId: 'call_1', title: 'Weekly revenue', seq: 0 }],
      latest: { revenue: 'call_1' },
    })
  })

  it('makes a call that named no id its own chart', async () => {
    const { call, value } = await bench()
    call('call_1', { option: OPTION })
    expect(value()).toEqual({
      entries: [{ chartId: 'call_1', callId: 'call_1', title: null, seq: 0 }],
      latest: { call_1: 'call_1' },
    })
  })

  it('records a Code Mode sub-dispatch under its sub-call id', async () => {
    const { dispatch, value } = await bench()
    // A model reaching the tool through `run_code` logs only this shape; a fold
    // reading `tool/call` alone would see no charts at all for that session.
    dispatch('<root>:code:1', { id: 'revenue', title: 'Weekly revenue', option: OPTION })
    expect(value()).toEqual({
      entries: [{ chartId: 'revenue', callId: '<root>:code:1', title: 'Weekly revenue', seq: 0 }],
      latest: { revenue: '<root>:code:1' },
    })
  })

  it('leaves the newest call owning a chart id, across both log shapes', async () => {
    const { call, dispatch, value } = await bench()
    call('call_1', { id: 'revenue', option: OPTION })
    dispatch('<root>:code:1', { id: 'revenue', option: OPTION })
    call('call_2', { id: 'traffic', option: OPTION })
    const view = value() as ShowChartsView
    expect(view.latest).toEqual({ revenue: '<root>:code:1', traffic: 'call_2' })
    // Every call stays in the list: the log is what happened, and the older row
    // is still in the transcript.
    expect(view.entries.map(entry => entry.callId)).toEqual(['call_1', '<root>:code:1', 'call_2'])
  })

  it('makes a call whose id is not a string its own chart', async () => {
    const { call, value } = await bench()
    call('call_1', { id: 7, option: OPTION })
    expect((value() as ShowChartsView).latest).toEqual({ call_1: 'call_1' })
  })

  it('reads an id padded with whitespace as the same chart', async () => {
    const { call, value } = await bench()
    call('call_1', { id: 'revenue', option: OPTION })
    call('call_2', { id: '  revenue  ', option: OPTION })
    expect((value() as ShowChartsView).latest).toEqual({ revenue: 'call_2' })
  })

  it('counts nothing for arguments no row could draw', async () => {
    const { call, dispatch, value } = await bench()
    call('call_1', 'not json')
    call('call_2', { title: 'no option' })
    call('call_3', { option: 'bar' })
    call('call_4', { option: [1] })
    call('call_5', { option: null })
    call('call_6', 42)
    dispatch('<root>:code:1', null)
    dispatch('<root>:code:2', 'plain text')
    dispatch('<root>:code:3', { title: 'no option' })
    expect(value()).toEqual({ entries: [], latest: {} })
  })

  it('counts nothing for another tool, or for an event that is not a call at all', async () => {
    const { call, dispatch, session, value } = await bench()
    call('call_1', { option: OPTION }, 'bash')
    dispatch('<root>:code:1', { option: OPTION }, 'bash')
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value()).toEqual({ entries: [], latest: {} })
  })

  it('carries the log seq of each recorded call', async () => {
    const { call, session, value } = await bench()
    session.append('turn/start', { turn: 1 })
    call('call_1', { option: OPTION })
    expect((value() as ShowChartsView).entries.map(entry => entry.seq)).toEqual([1])
  })

  it('leaves the snapshot when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = store(ctx).create()
    const fiber = ctx.plugin({
      inject: ['sessionProjections'],
      apply: (child: Context) => { child.sessionProjections.register(showChartsProjection()) },
    })
    await fiber.await()
    expect(Object.keys(ctx.sessionProjections.snapshot(session).values)).toContain('showCharts')
    await fiber.dispose()
    expect(Object.keys(ctx.sessionProjections.snapshot(session).values)).not.toContain('showCharts')
  })
})
