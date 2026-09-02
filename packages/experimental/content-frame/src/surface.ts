/**
 * This package's contribution to the content column's entry stream: the `page`
 * kind.
 *
 * An entry per page shown in a session, identified by the page id, so
 * re-showing a page — by the agent's tool or the user's sidebar command —
 * moves its entry to the front of the stream instead of adding a second one.
 * Clearing the column (`content/shown` with a null page) records nothing: the
 * stream is what the session produced, and a clear produced no page.
 *
 * Resolution runs at view time against the page list running now, exactly as
 * the `content` projection does and through the same function, so a deployment
 * that renames or retires a page does not rewrite what its logs say happened.
 * @module @deepseek-ai/dsh-experimental-content-frame/src/surface
 */

import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import type { ContentSurfaceView } from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { FrontEntry } from './access/text.ts'
import type { PageIndex } from './pages.ts'
import { resolveShownPage } from './projection.ts'
import type { ContentPageView } from './types.ts'

/**
 * Resolve the entry a column has in front, of whatever kind, for the one
 * refusal that names it.
 *
 * The stream publishes `front` as a `(kind, entryId)` pair and the titles live
 * on the entries, so naming what is in front means one lookup across both.
 * @param view - the session's `contentSurface` value, absent where no
 * projection registry is composed.
 * @returns the entry, or `undefined` for an empty column and for a `front`
 * naming an entry the stream no longer holds.
 */
export function frontEntry(view: ContentSurfaceView | undefined): FrontEntry | undefined {
  if (view === undefined) return undefined
  const front = view.front
  if (front === undefined) return undefined
  return view.entries.find(entry => entry.kind === front.kind && entry.entryId === front.entryId)
}

/** Kind key this package owns in the content column, and in its keyed client slot. */
export const PAGE_KIND = 'page'

/**
 * Stored half of one `page` entry: the recorded id plus who recorded it.
 * `by` was added after `dataVersion: 1` shipped (the `content/shown` event
 * carried no writer at the time), which is why the extractor bumped to 2 —
 * an older checkpoint's bare-string record cannot answer `.page`/`.by` and
 * must be discarded rather than handed to this shape's `resolve`.
 */
interface PageEntryData {
  /** The recorded page id. */
  readonly page: string
  /** Who showed it; defaulted at `read` time for a pre-`by` log. */
  readonly by: 'agent' | 'user'
}

/**
 * Build the `page` extractor for one deployment's page list.
 * @param pages - the validated page index.
 * @returns the extractor to hand to `ctx.contentSurface.register`.
 */
export function pageExtractor(pages: PageIndex): ContentSurfaceExtractor<PageEntryData> {
  return {
    kind: PAGE_KIND,
    dataVersion: 2,
    read: event => (event.type === 'content/shown' && event.data.page !== null
      ? { entryId: event.data.page, data: { page: event.data.page, by: event.data.by ?? 'agent' } }
      : undefined),
    resolve: ({ page, by }) => {
      const view: ContentPageView = resolveShownPage(page, pages)
      // A retired page keeps its entry under the id the log recorded: the
      // switcher still names what was shown, and the column's own renderer
      // explains that the deployment no longer serves it. `by` rides along
      // in the payload for a renderer that wants to distinguish the two
      // writers; today's page renderer does not (README limitations).
      return { title: view.state === 'shown' ? view.title : page, payload: { ...view, by } }
    },
  }
}
