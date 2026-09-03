/**
 * Resolve or create the one session a click needs to act against, shared by
 * every entry point that must not require a session to already be open.
 *
 * With no session to reuse, this resolves the recent Workspace and hands it to
 * `ctx.uiWorkspace.connectWorkspace`, rather than calling
 * `dsh-client-ui-workspace`'s New Session action: `UiWorkspace.startSession`
 * is fire-and-forget and publishes the new session only through the sessions
 * list, while every caller here needs the resulting session id in hand.
 * Delegating the connect itself matters beyond code size — the service holds
 * the per-Workspace in-flight map that keeps a click arriving alongside the
 * mount-time auto-open from minting a second session. With no Workspace at all
 * (a fresh install that has never connected one), there is nowhere to create a
 * session into; the caller gets `undefined` back (see the package README's
 * Known Limitations).
 *
 * Which Workspace is recent has no such service seat: `UiWorkspace` exposes
 * only `startSession`'s internal use of it, so {@link recentWorkspace} below
 * restates `ui-workspace/src/client/navigation.ts`'s own module-private
 * `recentWorkspace`. A divergence there silently changes which Workspace a
 * click lands in, which is why `tests/session-resolution.client.spec.ts` pins
 * every branch of it (see the package README's Known Limitations).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/session-resolution
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls ui-workspace's ctx.uiWorkspace Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Options for {@link resolveOrCreateSession}. */
export interface ResolveSessionOptions {
  /**
   * Whether the current session (if any) is an acceptable target. A plain
   * page click acts against whatever conversation is already open
   * (`true`); the workbench's first open and a workflow's degraded
   * re-creation each need a dedicated, freshly connected session regardless
   * of what happens to be open right now (`false`).
   */
  reuseCurrent: boolean
  /** Console-warning text for the no-Workspace-at-all case. */
  onNoWorkspace: string
}

/**
 * Resolve a session to act against, creating one against the recent
 * Workspace when reuse is declined or there is no current session.
 * @param ctx - client root context (sessions, workspaces, uiWorkspace).
 * @param options - see {@link ResolveSessionOptions}.
 * @returns the session id to act against, or `undefined` when there is no
 * eligible current session and no Workspace to create one in.
 */
export async function resolveOrCreateSession(ctx: ClientContext, options: ResolveSessionOptions): Promise<SessionId | undefined> {
  if (options.reuseCurrent) {
    const current = ctx.sessions.list.getSnapshot().current
    if (current !== undefined) return current
  }
  const target = recentWorkspace(ctx)
  if (target === undefined) {
    console.warn(options.onNoWorkspace)
    return undefined
  }
  const sessionId = await ctx.uiWorkspace.connectWorkspace(target.workspaceId)
  ctx.sessions.open(sessionId)
  return sessionId
}

/**
 * The Workspace whose sessions were touched most recently, ties broken by
 * Host Workspace order, or `undefined` before either baseline settles and in a
 * deployment with no Workspace at all.
 * @param ctx - client root context (sessions, workspaces).
 * @returns the target Workspace for a new session.
 */
function recentWorkspace(ctx: ClientContext): WorkspaceView | undefined {
  const workspaces = ctx.workspaces.list.getSnapshot()
  const sessions = ctx.sessions.list.getSnapshot()
  if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') return undefined
  let selected: WorkspaceView | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const summary = sessions.byId[sessionId]
      if (summary !== undefined) latest = Math.max(latest, summary.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace
      selectedTime = latest
    }
  }
  return selected
}
