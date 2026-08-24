/**
 * This package's contribution to the content column's entry stream: the `page`
 * kind.
 *
 * An entry per page the agent has shown in a session, identified by the page
 * id, so re-showing a page moves its entry to the front of the stream instead
 * of adding a second one. Clearing the column (`content/shown` with a null
 * page) records nothing: the stream is what the session produced, and a clear
 * produced no page.
 *
 * Resolution runs at view time against the page list running now, exactly as
 * the `content` projection does and through the same function, so a deployment
 * that renames or retires a page does not rewrite what its logs say happened.
 * @module @deepseek-ai/dsh-experimental-content-frame/src/surface
 */

import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import type { PageIndex } from './pages.ts'
import { resolveShownPage } from './projection.ts'
import type { ContentPageView } from './types.ts'

/** Kind key this package owns in the content column, and in its keyed client slot. */
export const PAGE_KIND = 'page'

/**
 * Build the `page` extractor for one deployment's page list.
 * @param pages - the validated page index.
 * @returns the extractor to hand to `ctx.contentSurface.register`.
 */
export function pageExtractor(pages: PageIndex): ContentSurfaceExtractor<string> {
  return {
    kind: PAGE_KIND,
    dataVersion: 1,
    read: event => (event.type === 'content/shown' && event.data.page !== null
      ? { entryId: event.data.page, data: event.data.page }
      : undefined),
    resolve: (page) => {
      const view: ContentPageView = resolveShownPage(page, pages)
      // A retired page keeps its entry under the id the log recorded: the
      // switcher still names what the agent showed, and the column's own
      // renderer explains that the deployment no longer serves it.
      return { title: view.state === 'shown' ? view.title : page, payload: view }
    },
  }
}
