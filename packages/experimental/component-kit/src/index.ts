/**
 * Component row, node half: the six components this package contributes to
 * whatever places blocks in the content panel.
 *
 * The row registers its components into `ctx.componentCatalog` — what a call
 * may send each of them, what comes back from each of them, and what another
 * block may read from them — and its browser half registers the renderers that
 * draw the same six. A deployment that composes the placement row without this
 * one has an empty catalog and is offered no tool at all, which is the whole
 * point of the seam: which components exist is a deployment's composition
 * rather than a table in the package that places them.
 *
 * Nothing here knows a content column, a session, or a tool. The definitions
 * name properties and actions and nothing about where a block is drawn.
 *
 * The row also serves its browser half the one setting a component here cannot
 * do without: `bizBasePath`, the path prefix the vendored data page
 * (`toy.crud`) requests its table under, from the browser and with the
 * visitor's own credential. The page's request layer reads it once, at module
 * evaluation, so the browser half applies it before the page is first drawn;
 * what this half does is judge it at load and answer it on a route.
 * @module @deepseek-ai/dsh-experimental-component-kit
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves ctx.webServer for the optional settings route.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.componentCatalog, which this row's components are registered into.
import type {} from '@deepseek-ai/dsh-experimental-component-surface'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface'
import { answerJson, rejectMethod } from './http.ts'
import { componentKitSource } from './manifest.ts'
import { COMPONENT_KIT_SETTINGS_ROUTE, requireBizBasePath, type ComponentKitSettings } from './route.ts'

export { componentKitSource, readComponentKitSource } from './manifest.ts'
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
 * Register this row's components, judge the base path, then serve it to the
 * browser half wherever a webserver is composed.
 *
 * The catalog is waited for rather than required, for the reason the webserver
 * is: a composition that loads this row without a placement row has no catalog
 * to contribute to and still serves its settings, and one that loads them in
 * either order ends up with the same six components.
 *
 * Loud at load: a base path that is not a path would send every request the
 * data page makes — each carrying the visitor's own credential — somewhere
 * this deployment did not name.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['componentCatalog'], (catalogCtx) => {
    catalogCtx.componentCatalog.register({ entries: COMPONENT_KIT_ENTRIES, source: componentKitSource() })
  })
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
