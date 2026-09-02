/**
 * The `content:column` context over the real system prompt and the real
 * projection registry: what a request carries about the column, assembled from
 * this session's own log and nothing else.
 *
 * The assembled composition — the Loader booting both halves of this package
 * over a served route — is `content-app-route.client.spec.ts`; what this file
 * adds is the deployment variants that composition does not have: a reader
 * offered, a frame still at the address its page was opened at, another kind in
 * front, and an assembly with no session at all.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ContentSurfaceRegistry, { type ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import { indexPages } from '../src/pages.ts'
import { pageExtractor } from '../src/surface.ts'
import { contentPagesProjection } from '../src/perception/pages-projection.ts'
import { CONTENT_COLUMN_CONTEXT_ORDER, registerColumnContext } from '../src/perception/context.ts'
import type { ColumnContextBounds } from '../src/perception/text.ts'
import type { ContentPage } from '../src/types.ts'

/** The deployment under test: two pages, so a page id is a real choice. */
const PAGES: ContentPage[] = [
  { id: 'home', title: 'Home', description: 'The entry page.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Published reports.', url: '/content-app/reports/' },
]

/**
 * A second kind in the column, standing in for the kinds other packages
 * register. It reads an event the page kind ignores, because the fold gives one
 * event to the first extractor that claims it.
 */
const OTHER_KIND: ContentSurfaceExtractor<{ page: string }> = {
  kind: 'note',
  dataVersion: 1,
  read: event => (event.type === 'content/navigated'
    ? { entryId: `note-${event.data.page}`, data: { page: event.data.page } }
    : undefined),
  resolve: ({ page }) => ({ title: `Note on ${page}`, payload: {} }),
}

/** What a deployment that configures neither context field spends. */
const BOUNDS: ColumnContextBounds = { entries: 10, fieldChars: 120 }

let sessions = 0

/** What one bench composes beyond the two seams the context reads. */
interface BenchUnits {
  /** Whether the page-history fold is registered; without it no entry has a writer. */
  readonly pageHistory?: boolean
  /** Whether a second kind is registered beside the page kind. */
  readonly otherKind?: boolean
}

/** A composition with both seams the context reads, and this package's own units over them. */
async function bench(canRead: boolean, units: BenchUnits = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(ContentSurfaceRegistry).await()
  const pages = indexPages(PAGES, undefined)
  ctx.contentSurface.register(pageExtractor(pages))
  if (units.otherKind === true) ctx.contentSurface.register(OTHER_KIND)
  if (units.pageHistory !== false) ctx.sessionProjections.register(contentPagesProjection())
  registerColumnContext(ctx, pages, canRead, BOUNDS)
  return { ctx, session: Session.create(SessionId(`column-context-${++sessions}`)) }
}

/** The `content:column` entry of one assembly, or undefined when it contributed nothing. */
async function contextText(ctx: Context, session?: Session): Promise<string | undefined> {
  const assembly = await ctx.systemPrompt.assemble(
    session === undefined ? {} : { agent: { session } as never },
  )
  return assembly.contexts.find(entry => entry.name === 'content:column')?.text
}

describe('the content-column context', () => {
  it('contributes nothing to an assembly with no session to describe', async () => {
    const { ctx } = await bench(true)
    expect(await contextText(ctx)).toBe('')
  })

  it('says the column is empty for a session that produced nothing', async () => {
    const { ctx, session } = await bench(true)
    expect(await contextText(ctx, session)).toContain('is empty. content_show puts a page there.')
  })

  it('names the reader only where the deployment offers one', async () => {
    for (const [canRead, closing] of [
      [true, 'content_read reads the entry in front; content_show puts a page in front.'],
      [false, 'content_show puts a page in front.'],
    ] as const) {
      const { ctx, session } = await bench(canRead)
      session.append('content/shown', { page: 'home', by: 'agent' })
      const text = await contextText(ctx, session)
      expect(text?.split('\n').at(canRead ? -2 : -1)).toBe(closing)
      expect(text?.includes('never a ref')).toBe(canRead)
    }
  })

  it('says nothing about the address while the frame is where its page was opened', async () => {
    const { ctx, session } = await bench(false)
    session.append('content/shown', { page: 'home', by: 'user' })
    session.append('content/navigated', { page: 'home', url: '/content-app/', title: 'Console', by: 'user' })
    expect(await contextText(ctx, session)).toBe(
      'The content column (内容区 — the column between the sidebar and this conversation) '
      + 'holds, newest first:\n'
      + '- "Home" (page, opened by the user)  ← in front\n'
      + 'content_show puts a page in front.',
    )
  })

  it('reads the entry in front off the log, not off the newest entry', async () => {
    const { ctx, session } = await bench(false)
    session.append('content/shown', { page: 'home', by: 'agent' })
    session.append('content/shown', { page: 'reports', by: 'agent' })
    session.append('content-surface/selected', { kind: 'page', entryId: 'home', by: 'user' })
    expect(await contextText(ctx, session)).toBe(
      'The content column (内容区 — the column between the sidebar and this conversation) '
      + 'holds, newest first:\n'
      + '- "Weekly reports" (page, opened by you)\n'
      + '- "Home" (page, opened by you)  ← in front\n'
      + 'content_show puts a page in front.',
    )
  })

  it('names another kind\'s entry as what it is, inventing no writer for it', async () => {
    const { ctx, session } = await bench(false, { otherKind: true })
    session.append('content/shown', { page: 'home', by: 'user' })
    session.append('content/navigated', { page: 'home', url: '/content-app/reports/', title: 'R', by: 'user' })
    expect(await contextText(ctx, session)).toBe(
      'The content column (内容区 — the column between the sidebar and this conversation) '
      + 'holds, newest first:\n'
      + '- "Note on home" (note)  ← in front\n'
      + '- "Home" (page, opened by the user)\n'
      + '    the app inside is now at /content-app/reports/, title "R"\n'
      + 'content_show puts a page in front.',
    )
  })

  it('still lists what the column holds where nothing folds the page history', async () => {
    // Both units ship together today; what this pins is that the context
    // degrades to the entries themselves rather than to a failed assembly.
    const { ctx, session } = await bench(false, { pageHistory: false })
    session.append('content/shown', { page: 'home', by: 'user' })
    session.append('content/navigated', { page: 'home', url: '/content-app/reports/', title: 'R', by: 'user' })
    expect(await contextText(ctx, session)).toBe(
      'The content column (内容区 — the column between the sidebar and this conversation) '
      + 'holds, newest first:\n'
      + '- "Home" (page)  ← in front\n'
      + 'content_show puts a page in front.',
    )
  })

  it('follows the approval policy rather than leading it, so a moving column keeps the cached prefix', async () => {
    // A context is materialized after retained history; the order says where in
    // that tail it sits.
    expect(CONTENT_COLUMN_CONTEXT_ORDER).toBe(130)
  })

  it('describes nothing once the row is unloaded (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjections)
    const fiber = ctx.plugin({
      apply: (child: Context) => { registerColumnContext(child, indexPages(PAGES, undefined), false, BOUNDS) },
    })
    await fiber.await()
    const session = Session.create(SessionId(`column-context-hmr-${++sessions}`))
    expect(await contextText(ctx, session)).not.toBeUndefined()

    await fiber.dispose()
    expect(await contextText(ctx, session)).toBeUndefined()
  })
})
