/**
 * Show a configured content-column page from the sidebar's navigation
 * group, creating a session first when none is current.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/open-page
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveOrCreateSession } from './session-resolution.ts'

/**
 * Command `@deepseek-ai/dsh-experimental-content-frame`'s node half registers
 * for a user-triggered page change. A literal copy of that package's
 * `SHOW_CONTENT_PAGE_COMMAND` rather than an imported value — see the module
 * doc in `pages.ts` for why.
 */
const SHOW_CONTENT_PAGE_COMMAND = 'show-content-page'

/**
 * Execute `/show-content-page <pageId>` directly against a known session,
 * warning (never throwing) on a failed dispatch or a rejected page id — the
 * shared tail every caller in this module needs once it has a session id in
 * hand.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to act against.
 * @param pageId - the page id to show.
 */
async function showContentPageOn(ctx: ClientContext, sessionId: SessionId, pageId: string): Promise<void> {
  const result = await ctx.remote.commands.execute(sessionId, `/${SHOW_CONTENT_PAGE_COMMAND} ${pageId}`, [])
  if (!result.ok) {
    console.warn(`server-sidebar: show-content-page failed: ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`server-sidebar: show-content-page: ${result.value.result.text}`)
  }
}

/**
 * Show one configured page, creating a session first when none is current
 * (see `session-resolution.ts` for the resolution order).
 * @param ctx - client root context (sessions, workspaces, remote.commands).
 * @param pageId - the page id to show.
 */
export async function openContentPage(ctx: ClientContext, pageId: string): Promise<void> {
  let sessionId
  try {
    sessionId = await resolveOrCreateSession(ctx, {
      reuseCurrent: true,
      onNoWorkspace: 'server-sidebar: no workspace available to open a new session for the page menu',
    })
  } catch (error) {
    console.warn('server-sidebar: failed to start a session for the page menu:', error)
    return
  }
  if (sessionId === undefined) return
  await showContentPageOn(ctx, sessionId, pageId)
}

/**
 * Show the deployment's configured home page on a session already known —
 * the workbench's auto-open-on-click path, which resolves its own session
 * before this runs and so needs no resolution of its own (contrast
 * {@link openContentPage}).
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to show the home page on.
 * @param homePage - the configured home page id.
 */
export async function openHomePage(ctx: ClientContext, sessionId: string, homePage: string): Promise<void> {
  // `OpenOutcome.sessionId` (workflow-actions.ts) carries the plain-string
  // shape every open-or-create outcome shares (it also feeds the
  // workflow-api wire), so it is cast to the branded id here rather than
  // widening this function's own signature to it.
  await showContentPageOn(ctx, sessionId as SessionId, homePage)
}

/**
 * Replay a workflow's captured navigation snapshot into a session, in
 * order — the last page replayed ends up on display, matching what was on
 * display when the workflow was saved. Used only for the degraded
 * re-creation path (decision ⑧): the target session is freshly created and
 * therefore empty, so a full sequential replay is exactly "fill in what is
 * missing" with nothing to remove.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to replay into.
 * @param navSnapshot - page ids, oldest first.
 */
export async function replayNavSnapshot(ctx: ClientContext, sessionId: string, navSnapshot: readonly string[]): Promise<void> {
  for (const pageId of navSnapshot) {
    // Wire boundary: `sessionId` crossed this package's own workflow-api
    // route as plain JSON, so it is cast to the branded id here rather than
    // trusted from an imported type.
    const result = await ctx.remote.commands.execute(sessionId as SessionId, `/${SHOW_CONTENT_PAGE_COMMAND} ${pageId}`, [])
    if (!result.ok) {
      console.warn(`server-sidebar: workflow replay failed for page "${pageId}": ${result.error.code}: ${result.error.message}`)
    } else if (result.value !== undefined && result.value.result.kind === 'error') {
      console.warn(`server-sidebar: workflow replay: ${result.value.result.text}`)
    }
  }
}
