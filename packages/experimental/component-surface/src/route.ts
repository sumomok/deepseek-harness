/**
 * The one HTTP path this package serves, and the document it answers with.
 *
 * Not configurable: the reader is the shell's own sidebar
 * (`@deepseek-ai/dsh-experimental-server-sidebar`), which keeps a literal copy
 * of this path the way it already keeps `content-frame`'s, and nothing else
 * addresses it. A browser half receives no cordis config — the boot manifest
 * carries plugin names, not their `config` blocks — so a configured catalog a
 * browser must know about has to be served to it.
 *
 * The document is the catalog and nothing more. A view's spec never travels
 * this route: what a click puts in the column is appended by the command, on
 * the host, out of the same index this route lists — so a page cannot ask for
 * a view the deployment did not configure, and the spec has exactly one way in
 * (see `view-command.ts`).
 * @module @deepseek-ai/dsh-experimental-component-surface/src/route
 */

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { answerJson, rejectMethod } from './http.ts'

/** Exact route serving {@link ComponentViewsDocument} to the deployment's sidebar. */
export const COMPONENT_VIEWS_ROUTE = '/component-surface/views'

/** One configured view as the catalog lists it: what a menu needs to draw a row and name it back. */
export interface ComponentViewListing {
  /** The id to pass to `show-content-view`. */
  id: string
  /** The line the user reads in the menu, and on the entry's tab once it is shown. */
  title: string
}

/** The catalog a navigation menu is built from. */
export interface ComponentViewsDocument {
  /** Every configured view, in declaration order — the order a menu offers them in. */
  views: ComponentViewListing[]
  /**
   * View the sidebar shows automatically the first time a session lands on a
   * blank draft; absent when the deployment configures none. Names a view in
   * {@link views}.
   */
  homeView?: string
}

/**
 * Build the route that answers one already-resolved catalog.
 *
 * The document is captured at load and never recomputed: its values come from
 * the row's own config, which cannot change without a reload, so every request
 * for the life of the process has the same answer.
 * @param document - the catalog to serve, built from the resolved view index.
 * @returns the route to hand to `ctx.webServer.register`.
 */
export function viewCatalogRoute(document: ComponentViewsDocument): WebRoute {
  return {
    kind: 'exact',
    path: COMPONENT_VIEWS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rejectMethod(res, 'GET, HEAD')
        return
      }
      answerJson(res, document)
    },
  }
}
