/**
 * The `content` projection unit against the real registry: the fold over a
 * session log, the resolution against the page list running now (including a
 * page the deployment retired), the configured default standing in for the
 * cleared state, and removal when the row unloads (HMR safety).
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { indexPages } from '../src/pages.ts'
import { contentProjection } from '../src/projection.ts'
import type { ContentPage, ContentPageView } from '../src/types.ts'

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

const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Newest first.', url: '/content-app/reports/' },
]

interface Bench {
  ctx: Context
  session: Session
  /** The whole current value the browser would receive. */
  value: () => ContentPageView | undefined
}

/**
 * Mount the registry and this package's unit over a real session.
 * @param defaultPage - the deployment's `defaultPage`, when it configures one.
 * @param pages - the page list running now; defaults to {@link PAGES}.
 * @returns the bench.
 */
async function bench(defaultPage?: string, pages: ContentPage[] = PAGES): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const session = store(ctx).create()
  ctx.sessionProjections.register(contentProjection(indexPages(pages, defaultPage), defaultPage))
  return { ctx, session, value: () => ctx.sessionProjections.snapshot(session).values.content }
}

describe('content projection', () => {
  it('reports an empty column for a session that has shown nothing', async () => {
    const { value } = await bench()
    expect(value()).toEqual({ state: 'empty' })
  })

  it('stands the configured default in for the never-shown and cleared states', async () => {
    const { session, value } = await bench('dashboard')
    expect(value()).toEqual({ state: 'default', url: '/content-app/', title: 'Fleet dashboard' })
    session.append('content/shown', { page: 'reports' })
    expect(value()).toEqual({ state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports' })
    session.append('content/shown', { page: null })
    expect(value()).toEqual({ state: 'default', url: '/content-app/', title: 'Fleet dashboard' })
  })

  it('folds last-wins and ignores every other event', async () => {
    const { session, value } = await bench()
    session.append('content/shown', { page: 'dashboard' })
    session.append('turn/start', { turn: 1 })
    session.append('content/shown', { page: 'reports' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(value()).toEqual({ state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports' })
  })

  it('reports a retired page as missing rather than resolving it to something else', async () => {
    // The log says `reports`; this deployment no longer configures it.
    const { session, value } = await bench(undefined, [PAGES[0]!])
    session.append('content/shown', { page: 'reports' })
    expect(value()).toEqual({ state: 'missing', page: 'reports' })
    // Clearing still resolves: `missing` is about the id, not about the log.
    session.append('content/shown', { page: null })
    expect(value()).toEqual({ state: 'empty' })
  })

  it('leaves the snapshot when the owning fiber goes away (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const session = store(ctx).create()
    const pages = indexPages(PAGES, undefined)
    const fiber = ctx.plugin({
      inject: ['sessionProjections'],
      apply: (child: Context) => { child.sessionProjections.register(contentProjection(pages, undefined)) },
    })
    await fiber.await()
    expect(Object.keys(ctx.sessionProjections.snapshot(session).values)).toContain('content')
    await fiber.dispose()
    expect(Object.keys(ctx.sessionProjections.snapshot(session).values)).not.toContain('content')
  })
})
