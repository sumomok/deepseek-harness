/**
 * Component row, node half: the eight components this package contributes to
 * whatever places blocks in the content panel.
 *
 * The row registers its components into `ctx.componentCatalog` — what a call
 * may send each of them, what comes back from each of them, and what another
 * block may read from them — and its browser half registers the renderers that
 * draw the same eight. A deployment that composes the placement row without this
 * one has an empty catalog and is offered no tool at all, which is the whole
 * point of the seam: which components exist is a deployment's composition
 * rather than a table in the package that places them.
 *
 * Nothing here knows a content column, a session, or a tool. The definitions
 * name properties and actions and nothing about where a block is drawn.
 *
 * The row also serves its browser half the one setting a component here cannot
 * do without: `bizBasePath`, the path prefix the vendored data page
 * (`toy.data-page`) requests its table under, from the browser and with the
 * visitor's own credential. The page's request layer reads it once, at module
 * evaluation, so the browser half applies it before the page is first drawn;
 * what this half does is judge it at load and answer it on a route.
 *
 * Where a data backend is composed as well, the row answers one more route:
 * what the signed-in visitor may do on one table's data page, judged by
 * `ctx.bizBackend` from one read of that visitor's rights. Whose rights are
 * read is taken from the request, through the same seam: a request it admits
 * nobody for reads nothing and is answered 401. Without a backend the route is
 * not claimed, and the browser half draws every data page with the entrances it
 * could remove removed.
 * @module @deepseek-ai/dsh-experimental-component-kit
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves ctx.webServer for the optional settings route.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.componentCatalog, which this row's components are registered into.
import type {} from '@deepseek-ai/dsh-experimental-component-surface'
// Type-only: resolves ctx.bizBackend, which the ability route reads and judges the visitor's rights through.
import type {} from '@deepseek-ai/dsh-experimental-biz-backend'
import { COMPONENT_KIT_ENTRIES } from '@deepseek-ai/dsh-experimental-component-surface'
import { answerJson, rejectMethod } from './http.ts'
import { componentKitSource } from './manifest.ts'
import {
  COMPONENT_KIT_ABILITIES_ROUTE,
  COMPONENT_KIT_SETTINGS_ROUTE,
  DATA_PAGE_ABILITIES,
  requireBizBasePath,
  type ComponentKitSettings,
} from './route.ts'

export { componentKitSource, readComponentKitSource } from './manifest.ts'
export {
  COMPONENT_KIT_ABILITIES_ROUTE,
  COMPONENT_KIT_SETTINGS_ROUTE,
  DATA_PAGE_ABILITIES,
  NO_ABILITIES,
  readComponentKitSettings,
  readDataPageAbilities,
  requireBizBasePath,
} from './route.ts'
export type { ComponentKitSettings, DataPageAbilityTable } from './route.ts'

/** Stable Cordis plugin name. */
export const name = 'component-kit'

/** Plugin config: where the data page's requests go. */
export interface Config {
  /**
   * Root-absolute path prefix the `toy.data-page` component requests its table
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
 * either order ends up with the same eight components.
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
        answerJson(res, 200, settings)
      },
    }), 'component-kit: browser settings route')
  })
  ctx.inject(['webServer', 'bizBackend'], (backendCtx) => {
    backendCtx.effect(() => backendCtx.webServer.register({
      kind: 'exact',
      path: COMPONENT_KIT_ABILITIES_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          rejectMethod(res, 'GET')
          return
        }
        // Whose rights are read is the request's to say, never the process's:
        // a request naming nobody reads nothing rather than somebody else.
        const subject = backendCtx.bizBackend.subjectOfRequest(req)
        if (subject === undefined) {
          answerJson(res, 401, { error: 'component-kit: this request names no signed-in person whose rights could be read' })
          return
        }
        // A server-side request always carries its URL; the type is shared with client requests.
        const meta = new URL(String(req.url), 'http://component-kit.invalid').searchParams.get('meta')
        if (meta === null || meta === '') {
          answerJson(res, 400, { error: 'component-kit: expected the table as a non-empty `meta` query parameter' })
          return
        }
        // The read spends the visitor's credential, so a visitor who leaves
        // before it answers cancels it.
        const abort = new AbortController()
        res.on('close', () => { abort.abort() })
        const permissions = backendCtx.bizBackend.judge(await backendCtx.bizBackend.userRights(subject, abort.signal))
        const table = Object.fromEntries(DATA_PAGE_ABILITIES.map(key => [key, permissions.may(meta, key)]))
        answerJson(res, 200, table)
      },
    }), 'component-kit: data page ability route')
  })
}
