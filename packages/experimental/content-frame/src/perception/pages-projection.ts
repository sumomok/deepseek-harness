/**
 * The `contentPages` projection unit: what one session's log says about each
 * page it has mentioned — who put it in the column, and where its frame went.
 *
 * Host-only, with no `wire` half at all. The browser is where the frames are
 * and needs none of this back; the one reader is the content-column context
 * assembled on this side of the process (`context.ts`), which is why the unit
 * exists as a fold rather than as two scans over the log at assembly time.
 *
 * The two events contribute different halves of the same record and neither
 * clears the other. A page shown again keeps the address its frame was last
 * seen at, because showing a cached page does not move it; an address reported
 * for a page no `content/shown` has named yet is stored on its own, because an
 * application that redirects on load can move a frame before the event that
 * put it there is folded here.
 * @module @deepseek-ai/dsh-experimental-content-frame/perception/pages-projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContentPageRecord, ContentPagesState } from '../types.ts'

/**
 * Fold state: one record per page the log has mentioned, keyed by page id.
 *
 * The transform is what makes an absent optional absent rather than present and
 * undefined: zod types an `.optional()` key as `T | undefined`, while the domain
 * says `by?: …`, and the two serialize identically on the JSON a checkpoint
 * carries.
 */
const stateSchema: ZodType<ContentPagesState> = zod.record(zod.string(), zod.object({
  by: zod.union([zod.literal('agent'), zod.literal('user')]).optional(),
  location: zod.object({ url: zod.string(), title: zod.string() }).optional(),
}).transform(({ by, location }) => ({
  ...by === undefined ? {} : { by },
  ...location === undefined ? {} : { location },
})))

/**
 * Replace one page's record, leaving every other page untouched.
 * @param state - the records before this event.
 * @param page - the page the event named.
 * @param record - that page's record after it.
 * @returns a new state object.
 */
function withPage(state: ContentPagesState, page: string, record: ContentPageRecord): ContentPagesState {
  return { ...state, [page]: record }
}

/**
 * Build the `contentPages` unit.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function contentPagesProjection(): ProjectionDefinition<'contentPages'> {
  return {
    key: 'contentPages',
    stateSchema,
    init: () => ({}),
    apply: (state: ContentPagesState, event: SessionEvent) => {
      if (event.type === 'content/shown') {
        const page = event.data.page
        // A cleared column names no page, so there is no record to write.
        if (page === null) return state
        const known = state[page]
        return withPage(state, page, {
          // A log written before `content/shown` carried a writer records the
          // tool, which was the only writer then.
          by: event.data.by ?? 'agent',
          ...known?.location === undefined ? {} : { location: known.location },
        })
      }
      if (event.type === 'content/navigated') {
        const known = state[event.data.page]
        return withPage(state, event.data.page, {
          ...known?.by === undefined ? {} : { by: known.by },
          location: { url: event.data.url, title: event.data.title },
        })
      }
      return state
    },
    stateVersion: 1,
  }
}
