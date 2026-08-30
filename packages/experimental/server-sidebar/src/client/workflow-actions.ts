/**
 * Pure array transforms and session-orchestration for the workbench entry
 * and the "my workflows" menu group. Persistence (the HTTP round trip
 * through `workflow-api.ts`) and reactive-store wiring stay in
 * `client/index.ts`, which is the one place both this package's `sidebar`
 * registration and its `conversation.session.header.actions` registration
 * are composed together.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workflow-actions
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveOrCreateSession } from './session-resolution.ts'
import { replayNavSnapshot } from './open-page.ts'
import type { ServerMenuWorkflow } from './workflow-api.ts'

/**
 * Compute the next display order for an appended workflow: one past the current highest.
 * @param workflows - the current workflow list.
 * @returns the order value the newly appended workflow should carry.
 */
export function nextOrder(workflows: readonly ServerMenuWorkflow[]): number {
  return workflows.reduce((max, workflow) => Math.max(max, workflow.order), -1) + 1
}

/**
 * Sort workflows for display: user-dragged order, ties broken on id for a stable render.
 * @param workflows - the workflows to sort; not mutated.
 * @returns a new array sorted by `order` ascending, ties broken by `id`.
 */
export function sortedWorkflows(workflows: readonly ServerMenuWorkflow[]): ServerMenuWorkflow[] {
  return [...workflows].sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : 1))
}

/** Outcome of opening the workbench or a workflow: the session now open, and whether it was (re-)created. */
export interface OpenOutcome {
  /** The session now open. */
  sessionId: string
  /** Whether this call created a fresh session (workbench first use, or a workflow's degraded re-creation). */
  created: boolean
}

/**
 * Open the workbench: the one persistent conversation the workbench entry
 * always lands on. Creates one on first use, or re-creates it if the
 * previously recorded session is gone — the same weak-reference degrade a
 * workflow's `homeSessionId` gets (decision ⑧ applies to the workbench too,
 * since it is a weak reference by the same reasoning).
 * @param ctx - client root context.
 * @param workbenchSessionId - the recorded id, or `undefined` before first use.
 * @param isLive - whether that id names a session the workspace domain still lists.
 * @returns the outcome, or `undefined` when there was nowhere to create a
 * session (no Workspace at all) — a contained no-op.
 */
export async function openWorkbench(
  ctx: ClientContext, workbenchSessionId: string | undefined, isLive: boolean,
): Promise<OpenOutcome | undefined> {
  if (workbenchSessionId !== undefined && isLive) {
    ctx.sessions.open(workbenchSessionId as SessionId)
    return { sessionId: workbenchSessionId, created: false }
  }
  const sessionId = await resolveOrCreateSession(ctx, {
    reuseCurrent: false,
    onNoWorkspace: 'server-sidebar: no workspace available to open the workbench',
  })
  return sessionId === undefined ? undefined : { sessionId, created: true }
}

/**
 * Open a workflow: switch to its bound conversation when live, or degrade
 * (decision ⑧) by creating a fresh one and replaying the captured
 * navigation snapshot onto it — "only fill in what is missing" is trivially
 * satisfied because the fresh session starts empty.
 * @param ctx - client root context.
 * @param workflow - the workflow to open.
 * @param isLive - whether `workflow.homeSessionId` names a session the
 * workspace domain still lists.
 * @returns the outcome, or `undefined` when there was nowhere to create a
 * session (no Workspace at all) — a contained no-op.
 */
export async function openWorkflow(
  ctx: ClientContext, workflow: ServerMenuWorkflow, isLive: boolean,
): Promise<OpenOutcome | undefined> {
  if (isLive) {
    ctx.sessions.open(workflow.homeSessionId as SessionId)
    return { sessionId: workflow.homeSessionId, created: false }
  }
  const sessionId = await resolveOrCreateSession(ctx, {
    reuseCurrent: false,
    onNoWorkspace: 'server-sidebar: no workspace available to re-create this workflow\'s conversation',
  })
  if (sessionId === undefined) return undefined
  await replayNavSnapshot(ctx, sessionId, workflow.navSnapshot)
  return { sessionId, created: true }
}
