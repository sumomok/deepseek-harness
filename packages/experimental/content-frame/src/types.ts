/**
 * Pure types of the content-column domain: the ONE home of the `content/shown`
 * and `content/navigated` session-event declarations and the three projection
 * keys, free of this package's host-side value imports (zod, dsh-tools, node).
 * Two namespace projections serve it — `./types` for host consumers,
 * `./client` for client aggregates — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-experimental-content-frame/types
 */

import type { ActArgs, DomArgs, ElementArgs, ReadArgs } from './access/wire.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Which configured page is now in the shell's content column, or `null`
     * when it cleared. Whole-value replace: the last event wins and a log
     * with none folds to the cleared state. The id is recorded as the writer
     * named it, not resolved against the deployment's page list, so a log
     * written before a page was renamed still replays as what was actually
     * shown.
     */
    'content/shown': {
      page: string | null
      /**
       * Who produced this event: the agent's `content_show` tool, or the
       * user's sidebar page click through the `show-content-page` command.
       * Absent on a log written before this field existed, which reads as
       * `'agent'` — the tool was the only writer then.
       */
      by?: 'agent' | 'user'
    }
    /**
     * The document inside one page's frame moved to a different address. A
     * configured page is a shell around an application with routing of its
     * own, so the id `content/shown` records names which application is in the
     * column and says nothing about where in it the user has gone — a menu
     * click, a sign-in redirect and a route change all leave that id
     * untouched. The browser half watches the frame and records this event so
     * the agent learns the page moved while it was happening, rather than at
     * the next read whose ref no longer resolves.
     *
     * The address is same-origin and relative, for the reason the read tool
     * drops the origin too: every page the column can show is a path on the
     * dsh origin. `title` is the frame document's own title as it stood once
     * the move settled, which for an application that writes it late may still
     * be the previous route's.
     */
    'content/navigated': {
      /** The configured page id whose frame moved. */
      page: string
      /** Where the frame is now: path, query and fragment, origin dropped. */
      url: string
      /** The frame document's title at the time; possibly empty. */
      title: string
      /**
       * Who moved it. `'user'` is what the browser reports for every move it
       * observes, which today is all of them; `'agent'` is reserved for a move
       * the agent makes itself.
       */
      by: 'user' | 'agent'
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    content: string | null
    contentAccess: ContentAccessRequest[]
    contentPages: ContentPagesState
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
    /**
     * The page-channel calls this session has open: every call of this
     * channel's tools — the four reads and `content_act` — the log recorded
     * without a result yet, in log order. It is
     * how the host asks a browser to read or act on the page — no host reaches
     * a browser directly, so the request rides the session's own projection
     * stream and whichever seat is showing that session picks it up.
     */
    contentAccess: ContentAccessView
  }
}

/** Where one page's frame is, as the browser last reported it. */
export interface ContentPageLocation {
  /** Path, query and fragment inside the page, origin dropped. */
  readonly url: string
  /** The frame document's title then; possibly empty. */
  readonly title: string
}

/** What this session's log says about one configured page. */
export interface ContentPageRecord {
  /**
   * Who last put the page in the column. Absent when the log has only ever
   * reported the page moving — a frame can be navigated by an application that
   * redirects on load, before any `content/shown` names that page.
   */
  readonly by?: 'agent' | 'user'
  /** Where the frame went last; absent until the browser reports a move. */
  readonly location?: ContentPageLocation
}

/**
 * Host-only fold behind the content-column context: one record per page this
 * session's log has mentioned. It has no wire half — the browser knows where
 * its own frames are, and the one reader is the prompt context assembled on
 * this side.
 */
export type ContentPagesState = Record<string, ContentPageRecord>

/** One `content_read` call still waiting for a browser to answer it. */
export interface ContentReadRequest {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked; the seat dispatches on it. */
  readonly tool: 'content_read'
  /** What the call asked of the page. */
  readonly args: ReadArgs
}

/** One `content_act` call still waiting for a browser to run its steps. */
export interface ContentActRequest {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked; the seat dispatches on it. */
  readonly tool: 'content_act'
  /** The steps to run, and how a native dialog is to be answered while they run. */
  readonly args: ActArgs
}

/** One `content_read_dom` call still waiting for a browser to answer it. */
export interface ContentReadDomRequest {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked; the seat dispatches on it. */
  readonly tool: 'content_read_dom'
  /** The subtree to print, and where a cut tree continues from. */
  readonly args: DomArgs
}

/** One `content_read_attrs` call still waiting for a browser to answer it. */
export interface ContentReadAttrsRequest {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked; the seat dispatches on it. */
  readonly tool: 'content_read_attrs'
  /** The element whose attributes to print. */
  readonly args: ElementArgs
}

/** One `content_read_dom_content` call still waiting for a browser to answer it. */
export interface ContentReadDomContentRequest {
  /** The call to claim and report against. */
  readonly callId: string
  /** The tool that asked; the seat dispatches on it. */
  readonly tool: 'content_read_dom_content'
  /** The element whose text to print. */
  readonly args: ElementArgs
}

/** One open call of any of this channel's tools, as the seat receives it. */
export type ContentAccessRequest =
  | ContentReadRequest
  | ContentActRequest
  | ContentReadDomRequest
  | ContentReadAttrsRequest
  | ContentReadDomContentRequest

/**
 * One open call of a tool that only reads. The seat answers all four the same
 * way — claim, wait for the page, walk it, post — and differs only in what it
 * walks, which is why they share one path and `content_act` does not.
 */
export type ContentReadingRequest = Exclude<ContentAccessRequest, ContentActRequest>

/** One open call of a tool that prints the page's own markup. */
export type ContentMarkupRequest = Exclude<ContentReadingRequest, ContentReadRequest>

/** Whole current value of the `contentAccess` projection. */
export interface ContentAccessView {
  /** Every open call, oldest first. */
  readonly pending: readonly ContentAccessRequest[]
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
