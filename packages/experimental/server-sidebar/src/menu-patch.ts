/**
 * Reading and resolving one server-menu patch, shared by the two places the
 * menu is kept: the volatile Config fields a process serving one person writes
 * through the settings service, and each member's own store in a process that
 * serves several (`members.ts`).
 * @module @deepseek-ai/dsh-experimental-server-sidebar/src/menu-patch
 */

import type { VolatileSnapshot } from '@deepseek-ai/cordis'
import {
  ServerMenuGroupsSchema, ServerMenuWorkflowsSchema, validateServerMenu,
  type ServerMenuGroup, type ServerMenuSettings, type ServerMenuWorkflow,
} from './workflows.ts'

/** How the server-menu route names itself in a refusal. */
export const ROUTE_LABEL = 'server-menu route'

/**
 * Bytes a server-menu patch can plausibly need: JSON overhead plus a
 * generous per-workflow allowance (a workflow's `navSnapshot` adds a handful
 * of `{kind, entryId}` pairs on top of its name and ids). A protocol bound,
 * not a deployment choice — a real user's workflow list is a handful of
 * conversations, not thousands.
 */
export const MAX_SERVER_MENU_POST_CHARS = 64 * 1024

/** The refusal of a body {@link readPatch} cannot read. */
export const PATCH_SHAPE_ERROR
  = 'server-sidebar: expected a JSON body shaped { workflows?: [...], groups?: [...], workbenchSessionId?: string }'

/** The fields one server-menu patch may carry; each array field is a whole-value replacement. */
export type ServerMenuPatchBody = Partial<{
  workflows: ServerMenuWorkflow[]
  groups: ServerMenuGroup[]
  workbenchSessionId: string
}>

/**
 * Whether a decoded JSON value is a data object (not an array, null, or a
 * primitive). Every value this module reads comes out of `JSON.parse` or a
 * JSON store, which never produce anything but a plain
 * (`Object.prototype`-rooted) object for an object literal — no prototype
 * check is needed for this value's actual origin.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one request body as JSON.
 * @param text - the body text.
 * @returns the decoded value, or `undefined` when the text is not JSON.
 */
export function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (_bodyIsNotJson) {
    return undefined
  }
}

/**
 * Render arbitrary thrown values without trusting their string coercion.
 * @param value - the thrown value.
 * @returns its message, or its string form when it is not an `Error`.
 */
export function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Narrow a decoded document to the patch shape the route accepts: any
 * non-empty subset of `{ workflows, groups, workbenchSessionId }`. Element
 * shapes are left to the schema and to `validateServerMenu` — this check only
 * decides which keys the merge carries and that each names a type the merge
 * can hold.
 * @param body - the decoded JSON document.
 * @returns the patch to merge, or `undefined` when the document names none of
 * the three keys, or names one with a type the merge cannot hold.
 */
export function readPatch(body: unknown): ServerMenuPatchBody | undefined {
  if (!isPlainObject(body)) return undefined
  const hasWorkflows = 'workflows' in body
  const hasGroups = 'groups' in body
  const hasWorkbenchSessionId = 'workbenchSessionId' in body
  if (!hasWorkflows && !hasGroups && !hasWorkbenchSessionId) return undefined
  if (hasWorkflows && !Array.isArray(body.workflows)) return undefined
  if (hasGroups && !Array.isArray(body.groups)) return undefined
  if (hasWorkbenchSessionId && typeof body.workbenchSessionId !== 'string') return undefined
  const patch: ServerMenuPatchBody = {}
  if (hasWorkflows) patch.workflows = body.workflows as ServerMenuWorkflow[]
  if (hasGroups) patch.groups = body.groups as ServerMenuGroup[]
  if (hasWorkbenchSessionId) patch.workbenchSessionId = body.workbenchSessionId as string
  return patch
}

/**
 * Resolve one patch's fields and check the menu they would leave behind.
 * @param current - the menu as it stands.
 * @param patch - the fields to replace.
 * @returns the patched fields, schema defaults filled, ready to write.
 * @throws {Error} when an element breaks the schema or the merged menu breaks
 * a cross-element constraint ({@link validateServerMenu}).
 */
export function resolvePatch(current: VolatileSnapshot<ServerMenuSettings>, patch: ServerMenuPatchBody): ServerMenuPatchBody {
  const fields: ServerMenuPatchBody = {
    ...patch.workflows === undefined ? {} : { workflows: ServerMenuWorkflowsSchema(patch.workflows) },
    ...patch.groups === undefined ? {} : { groups: ServerMenuGroupsSchema(patch.groups) },
    ...patch.workbenchSessionId === undefined ? {} : { workbenchSessionId: patch.workbenchSessionId },
  }
  validateServerMenu({ ...current, ...fields })
  return fields
}
