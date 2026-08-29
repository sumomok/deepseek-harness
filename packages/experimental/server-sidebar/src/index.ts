/**
 * @deepseek-ai/dsh-experimental-server-sidebar — node half.
 *
 * The whole point of this package is the browser half (`./client`): a
 * drop-in replacement for the shipped `dsh-client-ui-sidebar` root
 * registration that adds a page-navigation menu over
 * `dsh-experimental-content-frame`'s configured pages and a per-account
 * favorite-session menu. This node half exists only to carry the favorites
 * feature's durable half — the settings namespace and the one HTTP route the
 * browser half reads and writes it through — which is the one part of this
 * package that cannot live entirely in the browser.
 *
 * Both are optional children: a composition without `ctx.settings` or
 * `ctx.webServer` keeps the sidebar itself (page navigation still works, the
 * favorites menu just has nothing to show or persist), and no absence fails
 * the row.
 * @module @deepseek-ai/dsh-experimental-server-sidebar
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { SERVER_MENU_FAVORITES_ROUTE } from './route.ts'
import {
  SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, validateFavorites, type ServerMenuFavorite,
} from './favorites.ts'

export { SERVER_MENU_FAVORITES_ROUTE } from './route.ts'
export { SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, type ServerMenuFavorite, type ServerMenuSettings } from './favorites.ts'

/** Stable Cordis plugin name. */
export const name = 'server-sidebar'

/** How the favorites route names itself in a refusal. */
const ROUTE_LABEL = 'favorites route'

/**
 * Bytes a favorites document can plausibly need: JSON overhead plus a
 * generous per-favorite allowance. A protocol bound, not a deployment
 * choice — a real user's favorites list is a handful of sessions, not
 * thousands.
 */
const MAX_FAVORITES_POST_CHARS = 64 * 1024

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
 * Register the durable favorites section when the optional settings service
 * is composed, and serve it over one same-origin route when the optional
 * webserver is also composed.
 * @param ctx - Host context that may acquire the settings and webserver services.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings', 'webServer'], (childCtx) => {
    const scope = childCtx.settings.register(SERVER_SIDEBAR_NAMESPACE, ServerMenuSettingsSchema, {
      validate: validateFavorites,
    })
    childCtx.effect(() => childCtx.webServer.register({
      kind: 'exact',
      path: SERVER_MENU_FAVORITES_ROUTE,
      handler: async (req, res) => {
        if (req.method === 'GET' || req.method === 'HEAD') {
          answerJson(res, 200, { favorites: scope.get().favorites })
          return
        }
        if (req.method !== 'POST') {
          rejectMethod(res, 'GET, HEAD, POST')
          return
        }
        if (rejectCrossSite(req, res, ROUTE_LABEL)) return
        if (rejectNonJson(req, res, ROUTE_LABEL)) return
        const text = await readBoundedText(req, MAX_FAVORITES_POST_CHARS)
        if (text === undefined) {
          answerJson(res, 413, { error: `server-sidebar: the ${ROUTE_LABEL} body is too large` })
          return
        }
        const body = decodeJson(text)
        if (!isPlainObject(body) || !Array.isArray(body.favorites)) {
          answerJson(res, 400, { error: 'server-sidebar: expected a JSON body shaped { favorites: [...] }' })
          return
        }
        const favorites = body.favorites as ServerMenuFavorite[]
        try {
          await scope.replace({ favorites })
        } catch (error: unknown) {
          answerJson(res, 400, { error: `server-sidebar: ${renderThrown(error)}` })
          return
        }
        answerJson(res, 200, { favorites: scope.get().favorites })
      },
    }), 'server-sidebar: favorites route')
  })
}
