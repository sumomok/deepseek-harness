/**
 * Show a configured content-column page from the sidebar menu, creating a
 * session first when none is current.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/open-page
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Command `@deepseek-ai/dsh-experimental-content-frame`'s node half registers
 * for a user-triggered page change. A literal copy of that package's
 * `SHOW_CONTENT_PAGE_COMMAND` rather than an imported value — see the module
 * doc in `pages.ts` for why.
 */
const SHOW_CONTENT_PAGE_COMMAND = 'show-content-page'

/**
 * Show one configured page, creating a session first when none is current.
 *
 * With no current session, this replicates the New Session button's target
 * resolution (current session's Workspace, then the recent Workspace —
 * `WorkspaceRuntime.startSession` in `dsh-client-runtime`) rather than
 * calling that action directly: `startSession` is fire-and-forget and
 * publishes the new session only through the sessions list, while this
 * caller needs the resulting session id in hand to execute the command
 * against. With no Workspace at all (a fresh install that has never
 * connected one), there is nowhere to create a session into; the click is a
 * contained no-op (see the package README's Known Limitations).
 * @param ctx - client root context (sessions, workspaces, remote.commands).
 * @param pageId - the page id to show.
 */
export async function openContentPage(ctx: ClientContext, pageId: string): Promise<void> {
  let sessionId = ctx.sessions.list.getSnapshot().current
  if (sessionId === undefined) {
    const target = ctx.workspaces.list.getSnapshot().recentWorkspaceId
    if (target === undefined) {
      console.warn('server-sidebar: no workspace available to open a new session for the page menu')
      return
    }
    try {
      sessionId = await ctx.workspaces.connectWorkspace(target)
    } catch (error) {
      console.warn('server-sidebar: failed to start a session for the page menu:', error)
      return
    }
    ctx.sessions.open(sessionId)
  }
  const result = await ctx.remote.commands.execute(sessionId, `/${SHOW_CONTENT_PAGE_COMMAND} ${pageId}`, [])
  if (!result.ok) {
    console.warn(`server-sidebar: show-content-page failed: ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`server-sidebar: show-content-page: ${result.value.result.text}`)
  }
}
