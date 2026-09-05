/**
 * Put one navigation target in the content column, creating a session first
 * when none is current.
 *
 * The two navigation kinds are opened by two different commands — the
 * content-frame page catalog's `show-content-page` and the component-surface
 * view catalog's `show-content-view` — and both names are literal copies of
 * the owning packages' own constants rather than imported values (see
 * `nav-catalog.ts`'s module doc for why, and this package's tests for the
 * drift guard). Everything else about the two is the same, so one dispatch
 * table is the whole difference between them.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/open-nav
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NavSnapshotItem, NavSnapshotKind } from '../workflows.ts'
import { resolveOrCreateSession } from './session-resolution.ts'

/**
 * Command each navigation kind's owning package registers for a
 * user-triggered content change: content-frame's `SHOW_CONTENT_PAGE_COMMAND`
 * and component-surface's `SHOW_CONTENT_VIEW_COMMAND` (see the module doc).
 */
const COMMAND: Record<NavSnapshotKind, string> = {
  page: 'show-content-page',
  view: 'show-content-view',
}

/**
 * Execute one navigation target's own command directly against a known
 * session, warning (never throwing) on a failed dispatch or a rejected id —
 * the shared tail every caller in this module needs once it has a session id
 * in hand.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to act against.
 * @param target - the navigation target to show.
 * @param label - how a warning names this call site.
 */
async function showOn(ctx: ClientContext, sessionId: SessionId, target: NavSnapshotItem, label: string): Promise<void> {
  const command = COMMAND[target.kind]
  const result = await ctx.remote.commands.execute(sessionId, `/${command} ${target.entryId}`, [])
  if (!result.ok) {
    console.warn(`server-sidebar: ${label} failed for ${command} "${target.entryId}": ${result.error.code}: ${result.error.message}`)
    return
  }
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`server-sidebar: ${label}: ${result.value.result.text}`)
  }
}

/**
 * Show one menu row's target, creating a session first when none is current
 * (see `session-resolution.ts` for the resolution order).
 * @param ctx - client root context (sessions, workspaces, remote.commands).
 * @param target - the navigation target the clicked row names.
 */
export async function openNavItem(ctx: ClientContext, target: NavSnapshotItem): Promise<void> {
  let sessionId
  try {
    sessionId = await resolveOrCreateSession(ctx, {
      reuseCurrent: true,
      onNoWorkspace: 'server-sidebar: no workspace available to open a new session for the navigation menu',
    })
  } catch (error) {
    console.warn('server-sidebar: failed to start a session for the navigation menu:', error)
    return
  }
  if (sessionId === undefined) return
  await showOn(ctx, sessionId, target, 'navigation')
}

/**
 * Show the deployment's configured automatic home on a session already known
 * — the workbench's auto-open-on-click path, which resolves its own session
 * before this runs and so needs no resolution of its own (contrast
 * {@link openNavItem}).
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to show the home target on.
 * @param home - the configured home target (see `nav-catalog.ts`'s `mergeNavCatalogs`).
 */
export async function openHome(ctx: ClientContext, sessionId: string, home: NavSnapshotItem): Promise<void> {
  // `OpenOutcome.sessionId` (workflow-actions.ts) carries the plain-string
  // shape every open-or-create outcome shares (it also feeds the
  // workflow-api wire), so it is cast to the branded id here rather than
  // widening this function's own signature to it.
  await showOn(ctx, sessionId as SessionId, home, 'home')
}

/**
 * Replay a workflow's captured navigation snapshot into a session, in
 * order — the last target replayed ends up on display, matching what was on
 * display when the workflow was saved. Used only for the degraded
 * re-creation path (decision ⑧): the target session is freshly created and
 * therefore empty, so a full sequential replay is exactly "fill in what is
 * missing" with nothing to remove.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session to replay into.
 * @param navSnapshot - the captured navigation stops, oldest first.
 */
export async function replayNavSnapshot(
  ctx: ClientContext, sessionId: string, navSnapshot: readonly NavSnapshotItem[],
): Promise<void> {
  for (const target of navSnapshot) {
    // Wire boundary: `sessionId` crossed this package's own workflow-api
    // route as plain JSON, so it is cast to the branded id here rather than
    // trusted from an imported type.
    await showOn(ctx, sessionId as SessionId, target, 'workflow replay')
  }
}
