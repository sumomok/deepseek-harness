/**
 * The package's durable-dismissal invariants: what a `content-surface/dismissed`
 * payload may be, on the live append path and on the log already on disk. The
 * rule is deliberately silent on whether `(kind, entryId)` names a live entry —
 * see `command.ts`'s own module doc for why.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ContentSurfaceInvariant from '../src/invariant.ts'

/** A context with the companion installed and auditing. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContentSurfaceInvariant)
  return ctx
}

/** One appended dismissal, as the dispatch path delivers it. */
function event(data: unknown): SessionEvent {
  return { type: 'content-surface/dismissed', seq: 0, time: 0, data } as SessionEvent
}

describe('content surface invariants', () => {
  it('accepts a well-formed dismissal', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, event({ kind: 'page', entryId: 'reports', by: 'user' }))
    }).not.toThrow()
  })

  it.each([
    [{ kind: '', entryId: 'reports', by: 'user' }, /kind must be a non-empty string/],
    [{ kind: 42, entryId: 'reports', by: 'user' }, /kind must be a non-empty string/],
    [{ kind: 'page', entryId: '', by: 'user' }, /entryId must be a non-empty string/],
    [{ kind: 'page', entryId: 'reports', by: 'agent' }, /by must be "user"/],
  ])('rejects an incoherent dismissal', async (data, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(data)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent)
    }).not.toThrow()
  })

  it('rejects an invalid existing dismissal on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // Reached through `ctx.get` and cast: this package's own tests compile
    // under vitest's shared workspace type resolution, where the cordis
    // `Context.sessions` merge can name the browser service rather than the
    // host store (see `registry.spec.ts`'s own `store()` helper).
    ;(ctx.get('sessions') as unknown as SessionStore).create()
      .append('content-surface/dismissed', { kind: '', entryId: 'reports', by: 'user' })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ContentSurfaceInvariant).then(() => undefined))
      .rejects.toThrow(/kind must be a non-empty string/)
  })
})
