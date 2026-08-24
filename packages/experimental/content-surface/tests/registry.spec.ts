/**
 * The extractor registry against the real projection registry over real
 * sessions: what a registered table publishes, what registering a second
 * extractor after the log already exists does to the entries it should have
 * found, what unregistering one does, and what happens with no projection
 * registry composed at all.
 *
 * The late-registration case is the reason this registry re-registers its unit
 * instead of reading a live table: the projection registry caches one folded
 * cell per session and never revisits it, so a live table would leave every
 * session that existed before the second extractor permanently missing its
 * kind.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ContentSurfaceRegistry from '../src/index.ts'
import type { ContentSurfaceExtractor } from '../src/index.ts'
import type { ContentSurfaceEntry } from '../src/types.ts'

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

/** An extractor recognizing one event type and storing its `data` payload verbatim. */
function fakeExtractor(kind: string, type: string, dataVersion = 1): ContentSurfaceExtractor<{ id: string }> {
  return {
    kind,
    dataVersion,
    read: event => (event.type === type ? { entryId: (event.data as { id: string }).id, data: event.data as { id: string } } : undefined),
    resolve: data => ({ title: `${kind}:${data.id}`, payload: { id: data.id } }),
  }
}

/** One bench: the registry over a real session, plus what the browser would read. */
interface Bench {
  ctx: Context
  session: Session
  surface: () => readonly ContentSurfaceEntry[] | undefined
}

/** Mount the session store, the projection registry, and this package's registry. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ContentSurfaceRegistry).await()
  const session = store(ctx).create()
  return {
    ctx,
    session,
    surface: () => ctx.sessionProjections.snapshot(session).values.contentSurface?.entries,
  }
}

/** Append one event a fake extractor recognizes. */
function append(session: Session, type: string, id: string): void {
  ;(session as unknown as { append: (type: string, data: unknown) => void }).append(type, { id })
}

/** Titles of the published entries, newest first. */
function titles(entries: readonly ContentSurfaceEntry[] | undefined): string[] {
  return (entries ?? []).map(entry => entry.title)
}

describe('content surface registry', () => {
  it('publishes an empty stream while no extractor is registered', async () => {
    const { session, surface } = await bench()
    append(session, 'alpha/shown', 'one')
    expect(surface()).toEqual([])
  })

  it('publishes what a registered extractor recognizes, newest first', async () => {
    const { ctx, session, surface } = await bench()
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    append(session, 'alpha/shown', 'one')
    append(session, 'beta/shown', 'ignored')
    append(session, 'alpha/shown', 'two')
    expect(titles(surface())).toEqual(['alpha:two', 'alpha:one'])
  })

  it('keeps one entry per id, owned by the last record that named it', async () => {
    const { ctx, session, surface } = await bench()
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    append(session, 'alpha/shown', 'one')
    append(session, 'alpha/shown', 'two')
    append(session, 'alpha/shown', 'one')
    // Three records, two entries, and the re-shown one is the newest.
    expect(titles(surface())).toEqual(['alpha:one', 'alpha:two'])
  })

  it('gives a late extractor the history it should have found', async () => {
    const { ctx, session, surface } = await bench()
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    append(session, 'alpha/shown', 'one')
    append(session, 'beta/shown', 'two')
    // The session's cell was already folded without this kind.
    expect(titles(surface())).toEqual(['alpha:one'])

    ctx.contentSurface.register(fakeExtractor('beta', 'beta/shown'))
    expect(titles(surface())).toEqual(['beta:two', 'alpha:one'])
  })

  it('drops a kind and its entries when its registration disposes (HMR safety)', async () => {
    const { ctx, session, surface } = await bench()
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    const disposeBeta = ctx.contentSurface.register(fakeExtractor('beta', 'beta/shown'))
    append(session, 'alpha/shown', 'one')
    append(session, 'beta/shown', 'two')
    expect(titles(surface())).toEqual(['beta:two', 'alpha:one'])

    disposeBeta()
    expect(titles(surface())).toEqual(['alpha:one'])
  })

  it('withdraws the whole projection when the registry plugin unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = ctx.plugin(ContentSurfaceRegistry)
    await fiber.await()
    const session = store(ctx).create()
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    append(session, 'alpha/shown', 'one')
    expect(titles(ctx.sessionProjections.snapshot(session).values.contentSurface?.entries)).toEqual(['alpha:one'])

    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.contentSurface).toBeUndefined()
  })

  it('keeps the extractor table without a projection registry composed', async () => {
    const ctx = new Context()
    await ctx.plugin(ContentSurfaceRegistry).await()
    const dispose = ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    expect(() => { dispose() }).not.toThrow()
  })

  it('re-registers the unit under a version that follows the table', async () => {
    const { ctx, session } = await bench()
    const versions = new Set<number>()
    const record = (): void => {
      versions.add(ctx.sessionProjections.checkpoint(session)['contentSurface']?.ver as number)
    }
    ctx.contentSurface.register(fakeExtractor('alpha', 'alpha/shown'))
    record()
    const dispose = ctx.contentSurface.register(fakeExtractor('beta', 'beta/shown'))
    record()
    // A kind whose stored shape changed is a different fold under the same
    // name, and has to invalidate the checkpoint just as an added kind does.
    dispose()
    ctx.contentSurface.register(fakeExtractor('beta', 'beta/shown', 2))
    record()
    expect(versions.size).toBe(3)
  })
})
