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

/**
 * Reorder workflows by drag-and-drop: move `dragId`'s workflow to sit
 * immediately before `beforeId`'s current display position, then rewrite
 * every workflow's `order` to its resulting display position (0..n-1) — a
 * full rewrite, not a pairwise swap, so a drop anywhere in the list produces
 * a clean, contiguous order regardless of gaps or ties the previous order
 * values carried.
 * @param workflows - the current workflow list; not mutated.
 * @param dragId - the dragged workflow's id.
 * @param beforeId - the id of the row the dragged one should land before;
 * `undefined`, equal to `dragId`, or naming no workflow all append to the end.
 * @returns a new array with every workflow's `order` rewritten to its
 * resulting display position; a plain copy, order untouched, when `dragId`
 * names no workflow.
 */
export function reordered(
  workflows: readonly ServerMenuWorkflow[], dragId: string, beforeId: string | undefined,
): ServerMenuWorkflow[] {
  const ordered = sortedWorkflows(workflows)
  const dragged = ordered.find(workflow => workflow.id === dragId)
  if (dragged === undefined) return [...workflows]
  const rest = ordered.filter(workflow => workflow.id !== dragId)
  const targetIndex = beforeId === undefined || beforeId === dragId
    ? -1
    : rest.findIndex(workflow => workflow.id === beforeId)
  const insertAt = targetIndex === -1 ? rest.length : targetIndex
  const rearranged = [...rest.slice(0, insertAt), dragged, ...rest.slice(insertAt)]
  const orderById = new Map(rearranged.map((workflow, index) => [workflow.id, index]))
  return workflows.map((workflow) => {
    const order = orderById.get(workflow.id)
    // `rearranged` holds exactly the same workflow set as `ordered` (== every
    // workflow in `workflows`), just reshuffled — every id here is present.
    /* v8 ignore next -- defensive: rearranged always holds the complete workflow set. */
    if (order === undefined) return { ...workflow }
    return { ...workflow, order }
  })
}

/** Outcome of opening the workbench or a workflow: the session now open, and whether it was (re-)created. */
export interface OpenOutcome {
  /** The session now open. */
  sessionId: string
  /** Whether this call created a fresh session (workbench first use, or a workflow's degraded re-creation). */
  created: boolean
}

/**
 * Defensively-typed shape of one content-surface entry, read off
 * `SessionSummary.projectionValues.contentSurface.entries` (see
 * `ServerSidebarRoot.tsx`'s own read, which mirrors
 * `dsh-experimental-server-layout`'s `ShellFrame`): `isCleanWorkbenchDraft`
 * and `hasShownHomePage` only ever compare these two fields, so nothing else
 * about the real `ContentSurfaceEntry`
 * (`@deepseek-ai/dsh-experimental-content-surface/types`) needs to reach
 * this module.
 */
export interface ContentSurfaceEntryLike {
  /** The extractor kind that produced the entry; `'page'` for content-frame's own pages. */
  readonly kind?: unknown
  /** Identity within the kind; a page entry's id is the page id. */
  readonly entryId?: unknown
}

/**
 * Whether a workbench draft counts as clean for {@link openWorkbenchOnClick}'s
 * reuse decision: it has not run a conversation turn, and its content column
 * carries nothing beyond the deployment's own configured home page — a page
 * click, a chart the agent drew, or any other page all disqualify it, while
 * the home page itself does not, since a clean click's own auto-open step
 * (`client/index.ts`'s `onOpenWorkbench`) is expected to have put it there.
 * @param isBlank - `SessionSummary.blank`: whether the session has run a turn.
 * @param entries - the session's content-surface entries (see {@link ContentSurfaceEntryLike}).
 * @param homePage - the deployment's configured home page id, or `undefined`
 * when none is configured — with no home page, any entry at all disqualifies
 * the draft, since none can satisfy the exception.
 * @returns whether the draft is clean.
 */
export function isCleanWorkbenchDraft(
  isBlank: boolean, entries: readonly ContentSurfaceEntryLike[], homePage: string | undefined,
): boolean {
  return isBlank && entries.every(entry => entry.kind === 'page' && entry.entryId === homePage)
}

/**
 * Whether entries already carry the deployment's configured home page as a
 * shown page — consulted only when a click reuses a clean draft, so the
 * click path's own home-page auto-open step (`client/index.ts`'s
 * `onOpenWorkbench`) does not re-append an identical `content/shown` record
 * onto a draft that already carries one.
 * @param entries - the session's content-surface entries (see {@link ContentSurfaceEntryLike}).
 * @param homePage - the deployment's configured home page id, or `undefined`
 * when none is configured.
 * @returns whether one entry is the home page, shown as a page.
 */
export function hasShownHomePage(entries: readonly ContentSurfaceEntryLike[], homePage: string | undefined): boolean {
  return homePage !== undefined && entries.some(entry => entry.kind === 'page' && entry.entryId === homePage)
}

/**
 * Shared workbench open-or-create mechanism: reopen the recorded session
 * when `reuse` holds, otherwise create a fresh one against the recent
 * Workspace and report it as newly created. `openWorkbenchOnLoad` and
 * `openWorkbenchOnClick` differ only in what `reuse` requires of the
 * recorded session — see each for its own semantics.
 * @param ctx - client root context.
 * @param workbenchSessionId - the recorded id, or `undefined` before first use.
 * @param reuse - whether the recorded session qualifies for reuse; when
 * `false` (or `workbenchSessionId` is `undefined`), a fresh session is
 * always created.
 * @returns the outcome, or `undefined` when there was nowhere to create a
 * session (no Workspace at all) — a contained no-op.
 */
async function openOrCreateWorkbench(
  ctx: ClientContext, workbenchSessionId: string | undefined, reuse: boolean,
): Promise<OpenOutcome | undefined> {
  if (reuse && workbenchSessionId !== undefined) {
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
 * Open the workbench when the sidebar first loads with no session selected:
 * continuity semantics. Reopens the recorded session whenever it is still
 * live, whatever content it already carries — the page resumes exactly
 * where it left off. Re-creates only when the recorded session is gone, the
 * same weak-reference degrade a workflow's `homeSessionId` gets (decision ⑧
 * applies to the workbench too, since it is a weak reference by the same
 * reasoning). Contrast {@link openWorkbenchOnClick}, which additionally
 * requires the recorded session to still be clean.
 * @param ctx - client root context.
 * @param workbenchSessionId - the recorded id, or `undefined` before first use.
 * @param isLive - whether that id names a session the workspace domain still lists.
 * @returns the outcome, or `undefined` when there was nowhere to create a
 * session (no Workspace at all) — a contained no-op.
 */
export async function openWorkbenchOnLoad(
  ctx: ClientContext, workbenchSessionId: string | undefined, isLive: boolean,
): Promise<OpenOutcome | undefined> {
  return openOrCreateWorkbench(ctx, workbenchSessionId, isLive)
}

/**
 * Open the workbench on an explicit click: clean-draft semantics. A click
 * always lands on a clean page, so the recorded session reopens only when it
 * is both live and still clean (see {@link isCleanWorkbenchDraft}: no turn
 * run, and its content column carries nothing beyond the deployment's own
 * configured home page); otherwise a fresh session is created and the caller
 * must repoint `workbenchSessionId` at it (see `client/index.ts`'s `created`
 * handling). The displaced session is not deleted — see the package README's
 * Workflows section for what keeps it reachable. Contrast
 * {@link openWorkbenchOnLoad}, which reopens a live session regardless of its
 * content.
 * @param ctx - client root context.
 * @param workbenchSessionId - the recorded id, or `undefined` before first use.
 * @param isLive - whether that id names a session the workspace domain still lists.
 * @param isClean - whether that session is a clean draft (see
 * {@link isCleanWorkbenchDraft}); irrelevant (and never consulted) when
 * `isLive` is `false`.
 * @returns the outcome, or `undefined` when there was nowhere to create a
 * session (no Workspace at all) — a contained no-op.
 */
export async function openWorkbenchOnClick(
  ctx: ClientContext, workbenchSessionId: string | undefined, isLive: boolean, isClean: boolean,
): Promise<OpenOutcome | undefined> {
  return openOrCreateWorkbench(ctx, workbenchSessionId, isLive && isClean)
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
