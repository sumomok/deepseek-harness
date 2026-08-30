/**
 * Resolve or create the one session a click needs to act against, shared by
 * every entry point that must not require a session to already be open.
 *
 * With no session to reuse, this replicates the New Session button's target
 * resolution (current session's Workspace, then the recent Workspace —
 * `WorkspaceRuntime.startSession` in `dsh-client-runtime`) rather than
 * calling that action directly: `startSession` is fire-and-forget and
 * publishes the new session only through the sessions list, while every
 * caller here needs the resulting session id in hand. With no Workspace at
 * all (a fresh install that has never connected one), there is nowhere to
 * create a session into; the caller gets `undefined` back (see the package
 * README's Known Limitations).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/session-resolution
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

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
  const target = ctx.workspaces.list.getSnapshot().recentWorkspaceId
  if (target === undefined) {
    console.warn(options.onNoWorkspace)
    return undefined
  }
  const sessionId = await ctx.workspaces.connectWorkspace(target)
  ctx.sessions.open(sessionId)
  return sessionId
}
