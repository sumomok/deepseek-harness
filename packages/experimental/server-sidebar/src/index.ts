/**
 * @deepseek-ai/dsh-experimental-server-sidebar — node half.
 *
 * The whole point of this package is the browser half (`./client`): the
 * product console sidebar — a persistent 工作台 (workbench) entry, a
 * navigation group over `dsh-experimental-content-frame`'s configured pages
 * and `dsh-experimental-component-surface`'s configured views, and a
 * per-account "my workflows" menu. This node half carries the two
 * parts of that which cannot live entirely in the browser: the
 * workbench/workflow feature's durable half — the menu, and the HTTP route the
 * browser half reads and writes it through — and the identity field of this
 * plugin's `Config`, which a browser half never receives (the boot manifest
 * carries plugin names, not their `config` blocks) and therefore reads from a
 * second, read-only route.
 *
 * The menu is kept in one of two places. By default it is three volatile
 * fields of this plugin's own `Config`, written through the settings service
 * into the active profile's patch, for a deployment that runs one process per
 * signed-in person. With `perMember`, one process serves several console
 * members, and each member's menu is kept in that member's own store under the
 * `consoleMembers` service (`members.ts`); the three fields stay empty.
 *
 * Every service is an optional child: a composition without `ctx.settings`
 * keeps the sidebar itself (navigation still works, the workbench/workflow
 * menu of a process serving one person just has nothing to show or persist),
 * one without `ctx.webServer` additionally leaves the footer showing the
 * anonymous placeholder, and no absence fails the row.
 * @module @deepseek-ai/dsh-experimental-server-sidebar
 */

import type { Context, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
// Type-only: pulls the Loader's `Fiber.entry` merge.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { reportDirectoryMismatch, serveMemberMenus } from './members.ts'
import {
  decodeJson, MAX_SERVER_MENU_POST_CHARS, PATCH_SHAPE_ERROR, readPatch, renderThrown, resolvePatch, ROUTE_LABEL,
  type ServerMenuPatchBody,
} from './menu-patch.ts'
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
 * itself, where the menu is kept, and the three user-edited menu fields of a
 * process serving one person. The menu fields are volatile: the server-menu
 * route writes them through the settings service without remounting this
 * plugin, and every read takes the current value.
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
  /**
   * Keep one menu per console member instead of one for the whole process,
   * the meaning `dsh-experimental-auth-gate`'s field of the same name has.
   * Which member a request belongs to is the `consoleMembers` service's
   * answer, and each member's menu is kept in that member's store under the
   * unit `server-sidebar`; nothing is written through the settings service.
   * While that service is not running, the server-menu route answers 503.
   *
   * Requires {@link Config.workflows} and {@link Config.groups} empty and no
   * {@link Config.workbenchSessionId}: a menu written into this row would be
   * one every member shares. The default is false, which keeps one menu in
   * this row's fields.
   */
  perMember: boolean
}

/** The `config` block a composition writes for this row; the menu fields default to empty. */
export interface ConfigInput {
  displayNameClaim: string
  workflows?: ServerMenuWorkflow[]
  groups?: ServerMenuGroup[]
  workbenchSessionId?: string
  perMember?: boolean
}

export const Config: z<ConfigInput, Config> = z.object({
  displayNameClaim: z.string().required(),
  workflows: ServerMenuWorkflowsSchema.default([]).volatile(),
  groups: ServerMenuGroupsSchema.default([]).volatile(),
  workbenchSessionId: z.string().volatile(),
  perMember: z.boolean().default(false),
})

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
 * Reject a per-member row whose own configuration carries a menu.
 *
 * Loud at load, and naming fields only: a menu written into this row would be
 * served to nobody, and saved by nobody, once each member's menu is kept in
 * that member's store.
 * @param config - validated {@link Config}.
 * @throws {Error} when `perMember` is set and `workflows` or `groups` is
 * non-empty, or `workbenchSessionId` is set.
 */
function requireMemberMenuFields(config: Config): void {
  if (!config.perMember) return
  const menu = readMenu(config)
  const carried = [
    ...menu.workflows.length > 0 ? ['workflows'] : [],
    ...menu.groups.length > 0 ? ['groups'] : [],
    ...menu.workbenchSessionId === undefined ? [] : ['workbenchSessionId'],
  ]
  if (carried.length > 0) {
    throw new Error(`server-sidebar: ${carried.join(', ')} must be empty when perMember is set, because each member's menu is kept in that member's own store`)
  }
}

/**
 * Serve the menu of a process serving one person: the three volatile Config
 * fields over one same-origin route, written through the optional settings
 * service into this row's profile entry.
 * @param ctx - Host context that may acquire the settings and webserver services.
 * @param config - validated {@link Config}.
 */
function serveProfileMenu(ctx: Context, config: Config): void {
  // The profile entry the settings service writes the menu fields into;
  // absent when this plugin is mounted outside the Loader.
  const entryId = ctx.fiber.entry?.options.id

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
          answerJson(res, 400, { error: PATCH_SHAPE_ERROR })
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

/**
 * Serve the browser half its identity settings whenever the optional
 * webserver is composed, and serve the workbench/workflow menu over one
 * same-origin route: from this row's fields when the optional settings
 * service is composed too, or from each member's store with `perMember`.
 * @param ctx - Host context that may acquire the settings, webserver, and
 * member directory services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load: a claim nobody named is one the browser half would read
  // nothing out of on every page, with no diagnostic tying the anonymous
  // footer back to the composition.
  const identity: ServerIdentitySettings = { displayNameClaim: requireDisplayNameClaim(config.displayNameClaim) }
  // Loud at load as well: a per-member row carries no menu at all, and is
  // refused by field name before any check that would quote a value; a
  // profile edited by hand can carry a menu the route would never have written.
  requireMemberMenuFields(config)
  validateServerMenu(readMenu(config))
  const logger = ctx.logger('server-sidebar')
  reportDirectoryMismatch(ctx, config.perMember, logger)

  // Deployment configuration, the same for every member: it needs no member
  // and carries nothing any member saved.
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

  if (config.perMember) serveMemberMenus(ctx, logger)
  else serveProfileMenu(ctx, config)
}
