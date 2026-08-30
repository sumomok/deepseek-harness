/**
 * Server-menu HTTP client: the browser half of this package's own
 * workbench/workflow route. Same-package import of `../route.ts` — this is
 * this package's own wire agreement with itself, not the cross-package kind
 * `pages.ts` and `open-page.ts` avoid.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workflow-api
 */
import { SERVER_MENU_ROUTE } from '../route.ts'
import type { ServerMenuWorkflow } from '../workflows.ts'

export type { ServerMenuWorkflow } from '../workflows.ts'

/** The server-menu document as the browser half needs it: absent `workbenchSessionId` reads as `undefined`, never omitted. */
export interface ServerMenuState {
  /** Every workflow, in no particular storage order. */
  workflows: ServerMenuWorkflow[]
  /** The persistent workbench conversation's id, once one exists. */
  workbenchSessionId: string | undefined
}

/** The empty document a failed or absent read answers. */
const EMPTY_STATE: ServerMenuState = { workflows: [], workbenchSessionId: undefined }

/** Narrow one decoded array entry to a usable {@link ServerMenuWorkflow}. */
function isWorkflow(value: unknown): value is ServerMenuWorkflow {
  const candidate = value as Partial<ServerMenuWorkflow> | null
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.order === 'number'
    && typeof candidate.homeSessionId === 'string'
    && typeof candidate.savedAt === 'number'
    && Array.isArray(candidate.navSnapshot) && candidate.navSnapshot.every(id => typeof id === 'string')
}

/** Reduce a decoded server-menu document to its usable, filtered shape. */
function readState(body: { workflows?: unknown; workbenchSessionId?: unknown }): ServerMenuState {
  return {
    workflows: Array.isArray(body.workflows) ? body.workflows.filter(isWorkflow) : [],
    workbenchSessionId: typeof body.workbenchSessionId === 'string' ? body.workbenchSessionId : undefined,
  }
}

/**
 * Read the current server-menu document.
 *
 * Failure is contained rather than thrown, for the same reason
 * `pages.ts#readContentPages` contains its own: a deployment without the
 * settings capability composed (so this package's own node half never claims
 * the route) is an ordinary, expected composition, and the menu renders
 * empty rather than taking the sidebar down with it.
 * @returns the current document; the empty document when the route is
 * unreachable, answers non-200, or answers an unusable body.
 */
export async function readServerMenu(): Promise<ServerMenuState> {
  try {
    const response = await fetch(SERVER_MENU_ROUTE, { cache: 'no-store' })
    if (!response.ok) return EMPTY_STATE
    return readState(await response.json() as { workflows?: unknown; workbenchSessionId?: unknown })
  } catch {
    return EMPTY_STATE
  }
}

/**
 * Merge one patch into the server-menu document and answer the server's
 * authoritative resulting document. A patch changing only one field never
 * has to resend the other — the node route merges rather than replaces (see
 * `src/index.ts`).
 * @param patch - the fields to change; either or both of `workflows` (the
 * complete next list — the workflows array itself is still whole-value
 * replaced within the patch) and `workbenchSessionId`.
 * @returns the server's authoritative resulting document.
 * @throws {Error} when the request fails transport-level, answers non-200,
 * or answers a document with no usable shape; the message names the
 * server's own refusal text when one was given.
 */
export async function saveServerMenu(
  patch: Partial<{ workflows: readonly ServerMenuWorkflow[]; workbenchSessionId: string }>,
): Promise<ServerMenuState> {
  const response = await fetch(SERVER_MENU_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = await response.json().catch(() => undefined) as
    { workflows?: unknown; workbenchSessionId?: unknown; error?: unknown } | undefined
  if (!response.ok) {
    throw new Error(typeof body?.error === 'string' ? body.error : `server-menu save failed: HTTP ${String(response.status)}`)
  }
  if (body === undefined) {
    throw new Error('server-menu save answered no usable document')
  }
  return readState(body)
}
