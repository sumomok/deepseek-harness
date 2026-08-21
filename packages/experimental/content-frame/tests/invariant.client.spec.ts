/**
 * The package's durable-column invariants: what a `content/shown` payload may
 * be, on the live append path and on the log already on disk. The rule is
 * deliberately about the payload's shape only — whether the id still names a
 * configured page is the projection's business, not history's.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ContentFrameInvariant from '../src/invariant.ts'

/** A context with the companion installed and auditing. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContentFrameInvariant)
  return ctx
}

/** One appended column state, as the dispatch path delivers it. */
function event(page: unknown): SessionEvent {
  return { type: 'content/shown', seq: 0, time: 0, data: { page } } as SessionEvent
}

describe('content column invariants', () => {
  it('accepts a shown id and the cleared state, including an id no page list knows', async () => {
    const ctx = await setup()
    for (const page of ['reports', 'a-page-this-deployment-retired', null]) {
      expect(() => { ctx.emit('session/event', {} as Session, event(page)) }).not.toThrow()
    }
  })

  it.each([
    [42, /must be null or a non-empty, already-trimmed id/],
    ['', /must be null or a non-empty, already-trimmed id/],
    [' padded ', /must be null or a non-empty, already-trimmed id/],
  ])('rejects an incoherent durable column state', async (page, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(page)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } as SessionEvent)
    }).not.toThrow()
  })

  it('rejects an invalid existing column state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // Past the tool, which cannot produce this: the check exists for a log
    // written by something else, or by an older shape of this package.
    // Reached through `ctx.get` and cast: this package compiles in the Client
    // aggregate, where the cordis `Context.sessions` merge names the browser
    // service rather than the host store.
    ;(ctx.get('sessions') as unknown as SessionStore).create().append('content/shown', { page: ' padded ' })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ContentFrameInvariant).then(() => undefined))
      .rejects.toThrow(/must be null or a non-empty, already-trimmed id/)
  })
})
