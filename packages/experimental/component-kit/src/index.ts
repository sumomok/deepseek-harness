/**
 * Component row, node half. Almost a pure UI plugin: the row appears in the
 * host cordis.yml / Loader, which is what makes the browser half discoverable
 * through the package.json `dsh.client` declaration and the
 * `exports["./client"]` bundle, and it serves its browser half the one setting
 * a component here cannot do without.
 *
 * That setting is `bizBasePath`: the path prefix the vendored data page
 * (`toy.crud`) requests its table under, from the browser and with the
 * visitor's own credential. The page's request layer reads it once, at module
 * evaluation, so the browser half applies it before the page is first drawn;
 * what this half does is judge it at load and answer it on a route.
 *
 * Nothing here knows a content column, a session, or a tool. The row's whole
 * contribution is the renderer table its browser half exports, and the package
 * that places blocks requests that table through the loader's module table.
 * @module @deepseek-ai/dsh-experimental-component-kit
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves ctx.webServer for the optional settings route.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { answerJson, rejectMethod } from './http.ts'
import { COMPONENT_KIT_SETTINGS_ROUTE, requireBizBasePath, type ComponentKitSettings } from './route.ts'

export { COMPONENT_KIT_SETTINGS_ROUTE, readComponentKitSettings, requireBizBasePath } from './route.ts'
export type { ComponentKitSettings } from './route.ts'

/** Stable Cordis plugin name. */
export const name = 'component-kit'

/** Plugin config: where the data page's requests go. */
export interface Config {
  /**
   * Root-absolute path prefix the `toy.crud` data page requests its table
   * under, such as `/` or `/nrms-server/`; a trailing `/` is added where
   * missing. The page requests from the browser, so the prefix names a path on
   * the shell's own origin — the reverse proxy in front of the console is what
   * forwards it to the deployment's backend. A value the URL parser resolves
   * anywhere but the path it spells on this origin is refused at load rather
   * than repaired. Defaults to `/`.
   */
  bizBasePath?: string
}

export const Config: z<Config> = z.object({
  bizBasePath: z.string().default('/'),
})

/**
 * Judge the base path, then serve it to the browser half wherever a webserver
 * is composed.
 *
 * Loud at load: a base path that is not a path would send every request the
 * data page makes — each carrying the visitor's own credential — somewhere
 * this deployment did not name. The route waits for the webserver rather than
 * requiring it, so a composition drawing only the blocks that request nothing
 * still gets its renderer table.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const settings: ComponentKitSettings = { bizBasePath: requireBizBasePath(config.bizBasePath ?? '/') }
  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(() => serverCtx.webServer.register({
      kind: 'exact',
      path: COMPONENT_KIT_SETTINGS_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          rejectMethod(res, 'GET, HEAD')
          return
        }
        // The browser half reads this once per boot and the value comes from
        // the row it booted with, so a cached copy would outlive its own truth.
        answerJson(res, settings)
      },
    }), 'component-kit: browser settings route')
  })
}
