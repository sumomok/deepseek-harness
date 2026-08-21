/**
 * Pure types of the content-column domain: the ONE home of the `content/shown`
 * session-event declaration and the `content` projection key, free of this
 * package's host-side value imports (zod, dsh-tools, node). Two namespace
 * projections serve it — `./types` for host consumers, `./client` for client
 * aggregates — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-experimental-content-frame/types
 */

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Which configured page the agent put in the shell's content column from
     * this point on, or `null` when it cleared the column. Whole-value
     * replace: the last event wins and a log with none folds to the cleared
     * state. The id is recorded as the agent named it, not resolved against
     * the deployment's page list, so a log written before a page was renamed
     * still replays as what the agent actually did.
     */
    'content/shown': { page: string | null }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    content: string | null
  }
  interface SessionProjectionMap {
    /**
     * What the shell's content column shows for this session: the last
     * `content/shown` id resolved against the deployment's current page list,
     * with the configured default page standing in for the cleared state. The
     * host resolves it because the page list is host configuration the browser
     * never receives.
     */
    content: ContentPageView
  }
}

/**
 * Whole current value of the `content` projection. Every arm carries exactly
 * what the column needs to render it, so the browser resolves nothing.
 */
export type ContentPageView =
  /** The agent put this configured page on display. */
  | { readonly state: 'shown'; readonly page: string; readonly url: string; readonly title: string }
  /** Nothing is shown and the deployment configured a default page, which is on display instead. */
  | { readonly state: 'default'; readonly url: string; readonly title: string }
  /** Nothing is shown and the deployment configured no default page: the column is empty. */
  | { readonly state: 'empty' }
  /** The shown id no longer names a configured page — the deployment's page list changed under the log. */
  | { readonly state: 'missing'; readonly page: string }

/** One page the agent may put in the content column. */
export interface ContentPage {
  /** Stable id the agent passes to `content_show`; unique within the deployment. */
  readonly id: string
  /** Human-facing name of the page, shown to the user and named back to the agent in the tool result. */
  readonly title: string
  /** What the page is for, in the agent's terms — this is what the tool description offers it to choose from. */
  readonly description: string
  /** Same-origin path of the page, from the site root (`/content-app/reports/`). */
  readonly url: string
}
