/**
 * The package-owned invariant: every `component` entry the content surface
 * holds must be one that session's log recorded — an accepted
 * `show_component` call, or the `content-component/shown` a view click
 * writes.
 *
 * The relation can genuinely break, which is why it is checked at all. The
 * fold is seeded from persisted checkpoints, and the content surface decides
 * whether a checkpoint still applies by hashing its extractor table into 31
 * bits — a collision its own README records as residual risk. The cases below
 * stand in for that with a foreign extractor claiming this kind, which is the
 * same failure with a shorter setup: the column ends up holding a block whose
 * call is nowhere in the log, and the browser seat cannot tell it from a real
 * one.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import { componentExtractor } from '../src/surface.ts'
import * as ComponentSurfaceInvariant from '../src/invariant.ts'

const SPEC = { nodes: [{ id: 'bar', component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } }] }

/**
 * An extractor claiming one kind from an event this package never writes —
 * the stand-in for a checkpoint written by a table this composition no longer
 * has.
 */
function foreignExtractor(kind: string): ContentSurfaceExtractor<{ entryId: string }> {
  return {
    kind,
    dataVersion: 1,
    read: event => (event.type === 'todo/write' ? { entryId: 'ghost', data: { entryId: 'ghost' } } : undefined),
    resolve: data => ({ title: data.entryId, payload: {} }),
  }
}

/** One composition: the store, the projection registry, and the router. */
async function bench(extractor?: ContentSurfaceExtractor<never>): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ContentSurfaceRegistry).await()
  if (extractor !== undefined) ctx.contentSurface.register(extractor)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  return { ctx, session: (ctx.get('sessions') as unknown as SessionStore).create() }
}

/** Append one `show_component` call to a session's log. */
function call(session: Session, callId: string, args: unknown): void {
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'show_component',
    arguments: JSON.stringify(args),
  })
}

/** Drive one audit the way a committed event reaches the companion. */
function audit(ctx: Context, session: Session): void {
  // `Session.append` reports a throwing listener to the logger and carries on,
  // so the reporter that must reach a caller is the dispatch one, exactly as
  // `content-surface`'s own companion is exercised.
  ctx.emit('session/event', session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent)
}

/**
 * What the audit says about an entry nothing in the log authorized: both
 * writers are named, so a reader knows the companion looked for each.
 */
const UNAUTHORIZED = 'that nothing in its log recorded: '
  + 'no accepted show_component call and no content-component/shown event'

describe('the component-entry invariant', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin(ComponentSurfaceInvariant)
    await fiber.await()
    expect(ComponentSurfaceInvariant.name).toBe('experimental-component-surface-invariant')
    expect(ComponentSurfaceInvariant.inject).toEqual(['invariants'])
    await fiber.dispose()
  })

  it('accepts a column whose every component entry names an accepted call', async () => {
    const { ctx, session } = await bench(componentExtractor() as unknown as ContentSurfaceExtractor<never>)
    await ctx.plugin(ComponentSurfaceInvariant).await()
    // An unrelated event in the same log, because the audit walks the whole log
    // and must count only the calls that produced entries.
    session.append('todo/write', { todos: [] })
    call(session, 'call_1', { id: 'budget', title: '预算确认', spec: SPEC })
    expect(() => { audit(ctx, session) }).not.toThrow()
  })

  it('ignores entries of kinds it does not own', async () => {
    const { ctx, session } = await bench(foreignExtractor('page') as unknown as ContentSurfaceExtractor<never>)
    await ctx.plugin(ComponentSurfaceInvariant).await()
    session.append('todo/write', { todos: [] })
    expect(() => { audit(ctx, session) }).not.toThrow()
  })

  it('ignores a dispatch that is not a committed session event', async () => {
    const { ctx } = await bench(foreignExtractor('component') as unknown as ContentSurfaceExtractor<never>)
    await ctx.plugin(ComponentSurfaceInvariant).await()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('ignores a composition with no content surface folded at all', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const session = (ctx.get('sessions') as unknown as SessionStore).create()
    await ctx.plugin(ComponentSurfaceInvariant).await()
    call(session, 'call_1', { id: 'budget', title: '预算确认', spec: SPEC })
    expect(() => { audit(ctx, session) }).not.toThrow()
  })

  it('rejects a component entry no accepted call in the log recorded', async () => {
    const { ctx, session } = await bench(foreignExtractor('component') as unknown as ContentSurfaceExtractor<never>)
    await ctx.plugin(ComponentSurfaceInvariant).await()
    session.append('todo/write', { todos: [] })
    expect(() => { audit(ctx, session) })
      .toThrow(`carries a component content entry "ghost" ${UNAUTHORIZED}`)
  })

  it('rejects the same entry on a log that already carried it before the companion loaded', async () => {
    const { ctx, session } = await bench(foreignExtractor('component') as unknown as ContentSurfaceExtractor<never>)
    session.append('todo/write', { todos: [] })
    // Reading the fold once at startup is what covers a log that was on disk:
    // the live listener never fires for an entry nothing appended.
    await expect(ctx.plugin(ComponentSurfaceInvariant).then(() => undefined))
      .rejects.toThrow(UNAUTHORIZED)
  })

  it('counts only calls the tool would have accepted', async () => {
    const { ctx, session } = await bench(componentExtractor() as unknown as ContentSurfaceExtractor<never>)
    await ctx.plugin(ComponentSurfaceInvariant).await()
    // A refused call is in the log and records no entry, so the audit's two
    // sides stay in step rather than each counting a different thing.
    call(session, 'call_1', { id: 'ghost', title: '预算确认', spec: { nodes: [] } })
    call(session, 'call_2', { id: 'budget', title: '预算确认', spec: SPEC })
    expect(() => { audit(ctx, session) }).not.toThrow()
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries.map(entry => entry.entryId))
      .toEqual(['budget'])
  })
})
