/**
 * @deepseek-ai/dsh-experimental-server-sidebar — node half.
 *
 * The whole point of this package is the browser half (`./client`): the
 * product console sidebar — a persistent 工作台 (workbench) entry, a
 * navigation group over `dsh-experimental-content-frame`'s configured pages
 * and `dsh-experimental-component-surface`'s configured views, and a
 * per-account "my workflows" menu. This node half carries the two
 * parts of that which cannot live entirely in the browser: the
 * workbench/workflow feature's durable half — three volatile fields of this
 * plugin's own `Config`, written through the settings service into the active
 * profile's patch, and the HTTP route the browser half reads and writes them
 * through — and the identity field of that `Config`, which a browser half
 * never receives (the boot manifest carries plugin names, not their `config`
 * blocks) and therefore reads from a second, read-only route.
 *
 * Both services are optional children: a composition without `ctx.settings`
 * keeps the sidebar itself (navigation still works, the workbench/workflow
 * menu just has nothing to show or persist), one without `ctx.webServer`
 * additionally leaves the footer showing the anonymous placeholder, and no
 * absence fails the row.
 * @module @deepseek-ai/dsh-experimental-server-sidebar
 */

import type { Context, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
// Type-only: pulls the Loader's `Fiber.entry` merge.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { SERVER_IDENTITY_ROUTE, SERVER_MENU_ROUTE, type ServerIdentitySettings } from './route.ts'
import {
  ServerMenuGroupsSchema, ServerMenuWorkflowsSchema, validateServerMenu,
  type ServerMenuGroup, type ServerMenuSettings, type ServerMenuWorkflow,
} from './workflows.ts'

export { SERVER_IDENTITY_ROUTE, SERVER_MENU_ROUTE, type ServerIdentitySettings } from './route.ts'
export { MAX_GROUP_NAME_LENGTH, TEMPORARY_GROUP_ID } from './menu-constants.ts'
export {
  NAV_SNAPSHOT_CONVERTER, SERVER_SIDEBAR_NAMESPACE, ServerMenuGroupsSchema, ServerMenuSettingsSchema,
  ServerMenuWorkflowsSchema, legacyNavSnapshotMessage,
  type NavSnapshotItem, type NavSnapshotKind, type ServerMenuGroup, type ServerMenuSettings,
  type ServerMenuWorkflow,
} from './workflows.ts'
// `nav-snapshot-migration.ts` is deliberately NOT re-exported here: the
// one-time converter the durable format's refusal names is reached through the
// `convert-nav-snapshot` package script over `bin.ts`, and re-exporting it
// would pull `yaml` and `node:fs` into every deployment's plugin bundle for a
// tool no deployment runs.

/** Stable Cordis plugin name. */
export const name = 'server-sidebar'

/**
 * Plugin config: the one browser-facing value this shell cannot work out for
 * itself, and the three user-edited menu fields. The menu fields are volatile:
 * the server-menu route writes them through the settings service without
 * remounting this plugin, and every read takes the current value.
 */
export interface Config {
  /**
   * Claim of the deployment's access token that carries the signed-in
   * person's display name, as the sidebar's footer shows it (`login_uname`
   * for the toy-core sign-on this deployment runs). Deployment-varying: a
   * different sign-on names it differently, and no claim is standard enough
   * to default to.
   */
  displayNameClaim: string
  /** The user's named workflows; see {@link ServerMenuSettings.workflows}. */
  workflows: Volatile<ServerMenuWorkflow[]>
  /** The user's workflow groups; see {@link ServerMenuSettings.groups}. */
  groups: Volatile<ServerMenuGroup[]>
  /** The workbench conversation's id; see {@link ServerMenuSettings.workbenchSessionId}. */
  workbenchSessionId: Volatile<string | undefined>
}

/** The `config` block a composition writes for this row; the menu fields default to empty. */
export interface ConfigInput {
  displayNameClaim: string
  workflows?: ServerMenuWorkflow[]
  groups?: ServerMenuGroup[]
  workbenchSessionId?: string
}

export const Config: z<ConfigInput, Config> = z.object({
  displayNameClaim: z.string().required(),
  workflows: ServerMenuWorkflowsSchema.default([]).volatile(),
  groups: ServerMenuGroupsSchema.default([]).volatile(),
  workbenchSessionId: z.string().volatile(),
})

/** How the server-menu route names itself in a refusal. */
const ROUTE_LABEL = 'server-menu route'

/**
 * Bytes a server-menu patch can plausibly need: JSON overhead plus a
 * generous per-workflow allowance (a workflow's `navSnapshot` adds a handful
 * of `{kind, entryId}` pairs on top of its name and ids). A protocol bound,
 * not a deployment choice — a real user's workflow list is a handful of
 * conversations, not thousands.
 */
const MAX_SERVER_MENU_POST_CHARS = 64 * 1024

/**
 * Whether a decoded JSON value is a data object (not an array, null, or a
 * primitive). `decodeJson`'s only source is `JSON.parse`, which never
 * produces anything but a plain (`Object.prototype`-rooted) object for an
 * object literal — no prototype check is needed for this value's actual
 * origin.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode one request body as JSON.
 * @param text - the body text.
 * @returns the decoded value, or `undefined` when the text is not JSON.
 */
function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (_bodyIsNotJson) {
    return undefined
  }
}

/** Render arbitrary thrown values without trusting their string coercion. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** The fields one server-menu patch may carry; each array field is a whole-value replacement. */
type ServerMenuPatchBody = Partial<{
  workflows: ServerMenuWorkflow[]
  groups: ServerMenuGroup[]
  workbenchSessionId: string
}>

/**
 * Narrow a decoded POST body to the patch shape the route accepts: any
 * non-empty subset of `{ workflows, groups, workbenchSessionId }`. Element
 * shapes are left to the schema and to `validateServerMenu` — this check only
 * decides which keys the merge carries and that each names a type the merge
 * can hold.
 * @param body - the decoded JSON body.
 * @returns the patch to merge, or `undefined` when the body names none of the
 * three keys, or names one with a type the merge cannot hold.
 */
function readPatch(body: unknown): ServerMenuPatchBody | undefined {
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
 * Reject a claim name the browser half could read nothing out of.
 * @param displayNameClaim - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is blank, which would leave every signed-in person
 * shown as the anonymous placeholder with nothing to say why.
 */
function requireDisplayNameClaim(displayNameClaim: string): string {
  if (displayNameClaim.trim().length === 0) {
    throw new Error('server-sidebar: displayNameClaim must name a claim of the deployment\'s access token')
  }
  return displayNameClaim
}

/**
 * Read the menu's current values off the volatile Config fields.
 * @param config - validated {@link Config}.
 * @returns the menu as the server-menu route answers it.
 */
function readMenu(config: Config): VolatileSnapshot<ServerMenuSettings> {
  const workbenchSessionId = config.workbenchSessionId.get()
  return {
    workflows: config.workflows.get(),
    groups: config.groups.get(),
    ...workbenchSessionId === undefined ? {} : { workbenchSessionId },
  }
}

/**
 * Resolve one patch's fields and check the menu they would leave behind.
 * @param current - the menu as it stands.
 * @param patch - the fields to replace.
 * @returns the patched fields, schema defaults filled, ready to write.
 * @throws {Error} when an element breaks the schema or the merged menu breaks
 * a cross-element constraint ({@link validateServerMenu}).
 */
function resolvePatch(current: VolatileSnapshot<ServerMenuSettings>, patch: ServerMenuPatchBody): ServerMenuPatchBody {
  const fields: ServerMenuPatchBody = {
    ...patch.workflows === undefined ? {} : { workflows: ServerMenuWorkflowsSchema(patch.workflows) },
    ...patch.groups === undefined ? {} : { groups: ServerMenuGroupsSchema(patch.groups) },
    ...patch.workbenchSessionId === undefined ? {} : { workbenchSessionId: patch.workbenchSessionId },
  }
  validateServerMenu({ ...current, ...fields })
  return fields
}

/**
 * Serve the browser half its identity settings whenever the optional
 * webserver is composed, and serve the workbench/workflow menu over one
 * same-origin route when the optional settings service is composed too.
 * @param ctx - Host context that may acquire the settings and webserver services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load: a claim nobody named is one the browser half would read
  // nothing out of on every page, with no diagnostic tying the anonymous
  // footer back to the composition.
  const identity: ServerIdentitySettings = { displayNameClaim: requireDisplayNameClaim(config.displayNameClaim) }
  // Loud at load as well: a profile edited by hand can carry a menu the
  // route would never have written.
  validateServerMenu(readMenu(config))
  // The profile entry the settings service writes the menu fields into;
  // absent when this plugin is mounted outside the Loader.
  const entryId = ctx.fiber.entry?.options.id

  ctx.inject(['webServer'], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: 'exact',
      path: SERVER_IDENTITY_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          rejectMethod(res, 'GET, HEAD')
          return
        }
        // The browser half reads this once per boot and the value comes from
        // the row it booted with, so a cached copy would outlive its own truth.
        answerJson(res, 200, identity)
      },
    }), 'server-sidebar: identity route')
  })

  ctx.inject(['settings', 'webServer'], (childCtx) => {
    if (entryId === undefined) {
      throw new Error('server-sidebar: the server-menu route persists into a profile entry; mount this plugin through the Loader')
    }
    // The menu has its own editor (the sidebar); a generated settings page
    // for these fields would offer a second, unvalidated one.
    childCtx.effect(() => childCtx.settings.configure({ auto: false }, ctx.fiber), 'server-sidebar: settings page policy')
    childCtx.effect(() => childCtx.webServer.register({
      kind: 'exact',
      path: SERVER_MENU_ROUTE,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          answerJson(res, 200, readMenu(config))
          return
        }
        if (req.method !== 'POST') {
          rejectMethod(res, 'GET, HEAD, POST')
          return
        }
        if (rejectCrossSite(req, res, ROUTE_LABEL)) return
        if (rejectNonJson(req, res, ROUTE_LABEL)) return
        const text = await readBoundedText(req, MAX_SERVER_MENU_POST_CHARS)
        if (text === undefined) {
          answerJson(res, 413, { error: `server-sidebar: the ${ROUTE_LABEL} body is too large` })
          return
        }
        const patch = readPatch(decodeJson(text))
        if (patch === undefined) {
          answerJson(res, 400, {
            error: 'server-sidebar: expected a JSON body shaped { workflows?: [...], groups?: [...], workbenchSessionId?: string }',
          })
          return
        }
        let fields: ServerMenuPatchBody
        try {
          // A merge, not a wholesale replace: a caller changing only
          // `workbenchSessionId` never has to resend the current workflow
          // list, and vice versa. The duplicate-id and group-reference
          // constraints still see the complete post-merge menu, so a
          // groups-only patch that would orphan a workflow's `groupId` is
          // refused here rather than persisting.
          fields = resolvePatch(readMenu(config), patch)
        } catch (error: unknown) {
          answerJson(res, 400, { error: `server-sidebar: ${renderThrown(error)}` })
          return
        }
        try {
          await childCtx.settings.update(entryId, fields)
        } catch (error: unknown) {
          answerJson(res, 500, { error: `server-sidebar: the server-menu could not be saved: ${renderThrown(error)}` })
          return
        }
        answerJson(res, 200, readMenu(config))
      },
    }), 'server-sidebar: server-menu route')
  })
}
