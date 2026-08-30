/**
 * @deepseek-ai/dsh-experimental-server-sidebar — node half.
 *
 * The whole point of this package is the browser half (`./client`): the
 * product console sidebar — a persistent 工作台 (workbench) entry, a
 * navigation group over `dsh-experimental-content-frame`'s configured pages,
 * and a per-account "my workflows" menu. This node half exists only to carry
 * the workbench/workflow feature's durable half — the settings namespace and
 * the one HTTP route the browser half reads and writes it through — which is
 * the one part of this package that cannot live entirely in the browser.
 *
 * Both are optional children: a composition without `ctx.settings` or
 * `ctx.webServer` keeps the sidebar itself (navigation still works, the
 * workbench/workflow menu just has nothing to show or persist), and no
 * absence fails the row.
 * @module @deepseek-ai/dsh-experimental-server-sidebar
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { SERVER_MENU_ROUTE } from './route.ts'
import {
  SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, validateServerMenu, type ServerMenuWorkflow,
} from './workflows.ts'

export { SERVER_MENU_ROUTE } from './route.ts'
export {
  SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, type ServerMenuSettings, type ServerMenuWorkflow,
} from './workflows.ts'

/** Stable Cordis plugin name. */
export const name = 'server-sidebar'

/** How the server-menu route names itself in a refusal. */
const ROUTE_LABEL = 'server-menu route'

/**
 * Bytes a server-menu patch can plausibly need: JSON overhead plus a
 * generous per-workflow allowance (a workflow's `navSnapshot` adds a handful
 * of page ids on top of its name and ids). A protocol bound, not a
 * deployment choice — a real user's workflow list is a handful of
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

/**
 * Narrow a decoded POST body to the patch shape the route accepts: any
 * subset of `{ workflows, workbenchSessionId }`.
 * @param body - the decoded JSON body.
 * @returns the patch to merge, or `undefined` when the body carries neither
 * key with a usable type.
 */
function readPatch(body: unknown): Partial<{ workflows: ServerMenuWorkflow[]; workbenchSessionId: string }> | undefined {
  if (!isPlainObject(body)) return undefined
  const hasWorkflows = 'workflows' in body
  const hasWorkbenchSessionId = 'workbenchSessionId' in body
  if (!hasWorkflows && !hasWorkbenchSessionId) return undefined
  if (hasWorkflows && !Array.isArray(body.workflows)) return undefined
  if (hasWorkbenchSessionId && typeof body.workbenchSessionId !== 'string') return undefined
  const patch: Partial<{ workflows: ServerMenuWorkflow[]; workbenchSessionId: string }> = {}
  if (hasWorkflows) patch.workflows = body.workflows as ServerMenuWorkflow[]
  if (hasWorkbenchSessionId) patch.workbenchSessionId = body.workbenchSessionId as string
  return patch
}

/**
 * Register the durable workbench/workflow section when the optional settings
 * service is composed, and serve it over one same-origin route when the
 * optional webserver is also composed.
 * @param ctx - Host context that may acquire the settings and webserver services.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings', 'webServer'], (childCtx) => {
    const scope = childCtx.settings.register(SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, {
      validate: validateServerMenu,
    })
    childCtx.effect(() => childCtx.webServer.register({
      kind: 'exact',
      path: SERVER_MENU_ROUTE,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          answerJson(res, 200, scope.get())
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
            error: 'server-sidebar: expected a JSON body shaped { workflows?: [...], workbenchSessionId?: string }',
          })
          return
        }
        try {
          // A merge, not a wholesale replace: a caller changing only
          // `workbenchSessionId` never has to resend the current workflow
          // list, and vice versa (settings/index.ts's `update` validates the
          // resolved, merged candidate — the duplicate-id invariant still
          // sees the complete post-merge workflow list either way).
          await scope.update(patch)
        } catch (error: unknown) {
          answerJson(res, 400, { error: `server-sidebar: ${renderThrown(error)}` })
          return
        }
        answerJson(res, 200, scope.get())
      },
    }), 'server-sidebar: server-menu route')
  })
}
