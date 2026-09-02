/**
 * Resolve or create the one session a click needs to act against, shared by
 * every entry point that must not require a session to already be open.
 *
 * With no session to reuse, this resolves the recent Workspace and connects
 * to it, rather than calling `dsh-client-ui-workspace`'s New Session action:
 * `UiWorkspace.startSession` is fire-and-forget and publishes the new session
 * only through the sessions list, while every caller here needs the resulting
 * session id in hand. With no Workspace at all (a fresh install that has never
 * connected one), there is nowhere to create a session into; the caller gets
 * `undefined` back (see the package README's Known Limitations).
 *
 * Both steps below restate `dsh-client-ui-workspace`'s own resolution rather
 * than calling `ctx.uiWorkspace`: `overlay/customer.patch.yml` disables that
 * package outright, so injecting it would keep this package from loading in
 * the very composition it exists for. The restatement tracks
 * `ui-workspace/src/client/navigation.ts`; a divergence there silently changes
 * which Workspace a click lands in (see the package README's Known
 * Limitations).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/session-resolution
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

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
 * @param ctx - client root context (sessions, workspaces).
 * @param options - see {@link ResolveSessionOptions}.
 * @returns the session id to act against, or `undefined` when there is no
 * eligible current session and no Workspace to create one in.
 */
export async function resolveOrCreateSession(ctx: ClientContext, options: ResolveSessionOptions): Promise<SessionId | undefined> {
  if (options.reuseCurrent) {
    const current = ctx.sessions.list.getSnapshot().current
    if (current !== undefined) return current
  }
  const target = recentWorkspaceId(ctx)
  if (target === undefined) {
    console.warn(options.onNoWorkspace)
    return undefined
  }
  const sessionId = await connectWorkspace(ctx, target)
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
function recentWorkspaceId(ctx: ClientContext): WorkspaceId | undefined {
  const workspaces = ctx.workspaces.list.getSnapshot()
  const sessions = ctx.sessions.list.getSnapshot()
  if (workspaces.phase !== 'ready' || sessions.phase !== 'ready') return undefined
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces.items) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const summary = sessions.byId[sessionId]
      if (summary !== undefined) latest = Math.max(latest, summary.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

/**
 * Reuse this Workspace's unarchived blank session, or create one.
 * @param ctx - client root context (sessions, workspaces).
 * @param workspaceId - Workspace to connect to.
 * @returns a session addressable through the Session Controller.
 */
async function connectWorkspace(ctx: ClientContext, workspaceId: WorkspaceId): Promise<SessionId> {
  const workspaces = ctx.workspaces.list.getSnapshot()
  const workspace = workspaces.items.find(item => item.workspaceId === workspaceId)
  const sessions = ctx.sessions.list.getSnapshot()
  if (workspace !== undefined) {
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary !== undefined && summary.blank && summary.cwd === workspace.path
        && workspace.sessionIds.includes(summary.id)
        && !workspaces.archivedSessionIds.includes(summary.id)) return summary.id
    }
  }
  return ctx.sessions.create({ workspaceId })
}
