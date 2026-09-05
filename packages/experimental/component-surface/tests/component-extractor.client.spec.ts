/**
 * The `component` kind against the real content-surface router over a real
 * session log: which logged calls become entries, which entry each one owns,
 * and what a second call on one id does to the stream the column reads.
 *
 * The supersede rule itself is the router's — one record per (kind, entryId) —
 * so what these cases prove is that this extractor names the same entry a
 * correcting call names, which is the whole of what makes a correction land on
 * the block the user is looking at rather than beside it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { COMPONENT_KIND } from '../src/component-call.ts'
import { componentExtractor, type ComponentSurfaceData } from '../src/surface.ts'

/** One accepted confirmation-bar spec, and a second one differing only in its text. */
const FIRST = { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { title: '本月预算', buttons: [{ id: 'ok', label: '确认' }] } }] }
const SECOND = { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { title: '下月预算', buttons: [{ id: 'ok', label: '确认' }] } }] }

/** One accepted record spec: the component nothing comes back from. */
const RECORD = { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }], columnNum: 1 } }] }

interface Bench {
  session: Session
  /** Append one top-level call, the shape a model calling the tool directly logs. */
  call: (callId: string, args: unknown, name?: string) => void
  /** Append one Code Mode sub-dispatch, the shape a model calling through `run_code` logs. */
  dispatch: (subCallId: string, args: unknown, name?: string) => void
  /** The live entry stream the column reads. */
  entries: () => readonly ContentSurfaceEntry[]
}

/** Mount the session store, the projection registry, the router, and this kind. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ContentSurfaceRegistry).await()
  ctx.contentSurface.register(componentExtractor())
  const session = (ctx.get('sessions') as unknown as SessionStore).create()
  return {
    session,
    call: (callId, args, name = 'show_component') => {
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(callId),
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      })
    },
    dispatch: (subCallId, args, name = 'show_component') => {
      session.append('tool/code-dispatch-start', {
        rootCallId: CallId('root'),
        parentCallId: CallId('root'),
        subCallId: CallId(subCallId),
        name,
        arguments: args,
      })
    },
    entries: () => ctx.sessionProjections.snapshot(session).values.contentSurface?.entries ?? [],
  }
}

describe('the component kind', () => {
  it('records a top-level call under the entry id it named', async () => {
    const { call, entries } = await bench()
    call('call_1', { id: 'budget', title: '预算确认', spec: FIRST })
    expect(entries()).toEqual([{
      kind: COMPONENT_KIND,
      entryId: 'budget',
      seq: 0,
      title: '预算确认',
      payload: { spec: FIRST },
    }])
  })

  it('records a record block the same way as one that answers back', async () => {
    // Which component a call names is nothing to the extractor: it reads the
    // call's identity and hands the spec on. Pinned because a display-only
    // component reports nothing, and a fold that treated the two differently
    // would leave the record with no entry to be drawn in.
    const { call, entries } = await bench()
    call('call_1', { id: 'site-a1', title: '站点详情', spec: RECORD })
    expect(entries()).toEqual([{
      kind: COMPONENT_KIND,
      entryId: 'site-a1',
      seq: 0,
      title: '站点详情',
      payload: { spec: RECORD },
    }])
  })

  it('records a Code Mode dispatch of the same tool the same way', async () => {
    // A model reaching the tool through `run_code` logs only this shape; a
    // reader recognizing one shape would find no components at all there.
    const { dispatch, entries } = await bench()
    dispatch('<root>:code:1', { id: 'budget', title: '预算确认', spec: FIRST })
    expect(entries()).toEqual([{
      kind: COMPONENT_KIND,
      entryId: 'budget',
      seq: 0,
      title: '预算确认',
      payload: { spec: FIRST },
    }])
  })

  it('leaves one entry when a second call corrects the first, carrying the newer document', async () => {
    const { call, entries } = await bench()
    call('call_1', { id: 'budget', title: '预算确认', spec: FIRST })
    const before = entries()
    call('call_2', { id: 'budget', title: '下月预算', spec: SECOND })
    const after = entries()
    expect(after).toHaveLength(before.length)
    expect(after[0]?.entryId).toBe('budget')
    expect(after[0]?.seq).toBeGreaterThan(before[0]?.seq ?? 0)
    expect(after[0]?.title).toBe('下月预算')
    expect(after[0]?.payload).toEqual({ spec: SECOND })
  })

  it('gives two calls naming different ids two entries, newest first', async () => {
    const { call, entries } = await bench()
    call('call_1', { id: 'budget', title: '预算确认', spec: FIRST })
    call('call_2', { id: 'headcount', title: '编制确认', spec: FIRST })
    expect(entries().map(entry => entry.entryId)).toEqual(['headcount', 'budget'])
  })

  it('records nothing for a call the tool would have refused', async () => {
    const { call, dispatch, entries } = await bench()
    // Refused calls are in the log all the same — the loop records the call,
    // not the outcome — and an entry for one would be a block the seat has
    // nothing to draw.
    call('call_1', { id: 'budget', title: '预算确认', spec: { nodes: [{ id: 'bar', component: 'toy.chart', props: {} }] } })
    call('call_2', { title: '预算确认', spec: FIRST })
    dispatch('<root>:code:1', { id: 'budget', title: '预算确认', spec: { nodes: [] } })
    expect(entries()).toEqual([])
  })

  it('records nothing for another tool, an unreadable call, or an unrelated event', async () => {
    const { session, call, dispatch, entries } = await bench()
    call('call_1', { id: 'budget', title: '预算确认', spec: FIRST }, 'bash')
    dispatch('<root>:code:1', { id: 'budget', title: '预算确认', spec: FIRST }, 'bash')
    call('call_2', '{"id":')
    session.append('turn/start', { turn: 1 })
    expect(entries()).toEqual([])
  })
})

describe('one stored component record', () => {
  it('resolves into the switcher line and the spec its renderer receives', () => {
    // No catalog lookup: a record persisted before a component was renamed must
    // still resolve, and it is the seat that reports a block it cannot draw.
    expect(componentExtractor().resolve({ title: '预算确认', spec: FIRST }))
      .toEqual({ title: '预算确认', payload: { spec: FIRST } })
  })

  // The router hands `resolve` whatever the fold holds, and a persisted
  // checkpoint is plain JSON whose declared type is a claim. A throw here would
  // not cost this entry, it would cost the whole contentSurface view — every
  // kind's entries with it — so each of these answers with an entry the seat
  // draws its unreadable notice for.
  it.each([
    ['no record at all', null],
    ['a primitive', 42],
    ['a record with no title', { spec: FIRST }],
    ['a record whose title is not a line of text', { title: 7, spec: FIRST }],
    ['a record with no spec', { title: '预算确认' }],
    ['a record whose spec is null', { title: '预算确认', spec: null }],
  ])('answers with an unreadable entry for %s', (_case, stored) => {
    // The cast is the erased call the router actually makes: `resolve` gets the
    // stored value back with nothing between it and the checkpoint.
    expect(componentExtractor().resolve(stored as ComponentSurfaceData))
      .toEqual({ title: '无法显示的内容', payload: undefined })
  })
})
