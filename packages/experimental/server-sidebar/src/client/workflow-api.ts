/**
 * Server-menu HTTP client: the browser half of this package's own
 * workbench/workflow route. Same-package import of `../route.ts` — this is
 * this package's own wire agreement with itself, not the cross-package kind
 * `nav-catalog.ts` and `open-nav.ts` avoid. Both requests resolve that route
 * against the page's deployment base, which is what a shell served under a
 * reverse-proxy path prefix needs.
 *
 * A decoded workflow is passed through as it arrived rather than rebuilt field
 * by field, so a field a given release of this browser half makes no use of
 * survives a read, an edit of some other field, and the write back.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workflow-api
 */
import { clientUrl } from '@deepseek-ai/dsh-client-connection/client'
import { SERVER_MENU_ROUTE } from '../route.ts'
import type { NavSnapshotItem, ServerMenuGroup, ServerMenuWorkflow } from '../workflows.ts'

export type { NavSnapshotItem, ServerMenuGroup, ServerMenuWorkflow } from '../workflows.ts'

/** The server-menu document as the browser half needs it: absent `workbenchSessionId` reads as `undefined`, never omitted. */
export interface ServerMenuState {
  /** Every workflow, in no particular storage order. */
  workflows: ServerMenuWorkflow[]
  /** Every stored group, in no particular storage order. */
  groups: ServerMenuGroup[]
  /** The persistent workbench conversation's id, once one exists. */
  workbenchSessionId: string | undefined
}

/**
 * One write to the server-menu document: any non-empty subset of its three
 * fields. Each array field is replaced whole within the patch — a caller
 * changing one group resends the complete group list, and a caller changing
 * only groups never resends the workflow list at all (the route merges the
 * fields it is given; see `src/index.ts`).
 */
export interface ServerMenuPatch {
  /** The complete next workflow list. */
  workflows?: readonly ServerMenuWorkflow[]
  /** The complete next group list. */
  groups?: readonly ServerMenuGroup[]
  /** The workbench conversation's id. */
  workbenchSessionId?: string
}

/** The empty document a failed or absent read answers. */
const EMPTY_STATE: ServerMenuState = { workflows: [], groups: [], workbenchSessionId: undefined }

/**
 * Narrow one decoded `navSnapshot` entry to a usable {@link NavSnapshotItem}.
 *
 * The pre-view `string` form fails this check like any other unusable entry:
 * the node half refuses such a document at load (see `../workflows.ts`), so a
 * browser that somehow reads one drops the workflow rather than replaying its
 * ids as pages behind an operator who never converted the document.
 */
function isNavSnapshotItem(value: unknown): value is NavSnapshotItem {
  const candidate = value as Partial<NavSnapshotItem> | null
  return typeof candidate === 'object' && candidate !== null
    && (candidate.kind === 'page' || candidate.kind === 'view')
    && typeof candidate.entryId === 'string'
}

/** Narrow one decoded array entry to a usable {@link ServerMenuWorkflow}. */
function isWorkflow(value: unknown): value is ServerMenuWorkflow {
  const candidate = value as Partial<ServerMenuWorkflow> | null
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.order === 'number'
    && typeof candidate.homeSessionId === 'string'
    && typeof candidate.savedAt === 'number'
    && (candidate.groupId === undefined || typeof candidate.groupId === 'string')
    && Array.isArray(candidate.navSnapshot) && candidate.navSnapshot.every(isNavSnapshotItem)
}

/**
 * Narrow one decoded array entry to a usable {@link ServerMenuGroup}. A group
 * missing `pinned` fails this check rather than defaulting: the schema fills
 * that default in on the way to storage, so a document served without it is
 * not one this route produced.
 */
function isGroup(value: unknown): value is ServerMenuGroup {
  const candidate = value as Partial<ServerMenuGroup> | null
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.pinned === 'boolean'
    && typeof candidate.order === 'number'
}

/** Reduce a decoded server-menu document to its usable, filtered shape. */
function readState(body: { workflows?: unknown; groups?: unknown; workbenchSessionId?: unknown }): ServerMenuState {
  return {
    workflows: Array.isArray(body.workflows) ? body.workflows.filter(isWorkflow) : [],
    groups: Array.isArray(body.groups) ? body.groups.filter(isGroup) : [],
    workbenchSessionId: typeof body.workbenchSessionId === 'string' ? body.workbenchSessionId : undefined,
  }
}

/**
 * Read the current server-menu document.
 *
 * Failure is contained rather than thrown, for the same reason
 * `nav-catalog.ts#readCatalog` contains its own: a deployment without the
 * settings capability composed (so this package's own node half never claims
 * the route) is an ordinary, expected composition, and the menu renders
 * empty rather than taking the sidebar down with it.
 * @returns the current document; the empty document when the route is
 * unreachable, answers non-200, or answers an unusable body.
 */
export async function readServerMenu(): Promise<ServerMenuState> {
  try {
    const response = await fetch(clientUrl(SERVER_MENU_ROUTE), { cache: 'no-store' })
    if (!response.ok) return EMPTY_STATE
    return readState(await response.json() as { workflows?: unknown; groups?: unknown; workbenchSessionId?: unknown })
  } catch {
    return EMPTY_STATE
  }
}

/**
 * Merge one patch into the server-menu document and answer the server's
 * authoritative resulting document. A patch changing only one field never
 * has to resend the other — the node route merges rather than replaces (see
 * `src/index.ts`).
 * @param patch - the fields to change (see {@link ServerMenuPatch}).
 * @returns the server's authoritative resulting document.
 * @throws {Error} when the request fails transport-level, answers non-200,
 * or answers a document with no usable shape; the message names the
 * server's own refusal text when one was given.
 */
export async function saveServerMenu(patch: ServerMenuPatch): Promise<ServerMenuState> {
  const response = await fetch(clientUrl(SERVER_MENU_ROUTE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = await response.json().catch(() => undefined) as
    { workflows?: unknown; groups?: unknown; workbenchSessionId?: unknown; error?: unknown } | undefined
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `server-menu save failed: HTTP ${String(response.status)}`)
  }
  if (body === undefined) {
    throw new Error('server-menu save answered no usable document')
  }
  return readState(body)
}
