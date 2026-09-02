/**
 * The two HTTP paths both halves of this package are defined against: the node
 * half claims them as webserver routes, the browser half points the iframe at
 * one and reads its own settings from the other. Not configurable — the two
 * halves must agree on them and nothing outside this package addresses them.
 *
 * The settings document exists because a browser half receives no cordis
 * config: the boot manifest carries plugin names, not their `config` blocks,
 * so a `Config` field the browser must obey has to be served to it. The page
 * catalog travels the same route for the same reason: a deployment's own
 * sidebar surface (`@deepseek-ai/dsh-experimental-server-sidebar`) needs the
 * configured page list to build its page-navigation menu, and this route is
 * where a browser half already reads this plugin's configuration from — a
 * second route publishing the same list would let the two drift.
 */

import type { ContentPage } from './types.ts'

/** Prefix route the hosted application is served under; no trailing slash, which is the webserver's route form. */
export const CONTENT_APP_ROUTE = '/content-app'

/** Exact route serving {@link ContentFrameSettings} to this package's browser half. */
export const CONTENT_SETTINGS_ROUTE = '/content-frame/settings'

/** The browser-facing half of the page-read channel's configuration. */
export interface ContentFrameAccessSettings {
  /** The character budget one read's listing is rendered under. */
  outlineChars: number
  /**
   * How long the host holds a call open for a seat to claim, which is what
   * bounds a seat's own re-claiming: past it the call has been answered
   * "no console is open" and no claim can win it any more.
   */
  claimTimeoutMs: number
  /** How long the host waits for a claimed read, which is also how long the seat may spend producing it. */
  readTimeoutMs: number
  /**
   * How long a loaded page must go unchanged before a read walks it, and before
   * one step of a call counts as finished. Served because the wait happens in
   * the seat, and the deployment's own answer for how long its application
   * takes to draw a route belongs with its deadlines.
   */
  settleQuietMs: number
  /** How long the host waits for a claimed set of steps, which is also how long the seat may spend running them. */
  actTimeoutMs: number
  /** Most steps one call may carry, which is what the seat's own step list is bounded by. */
  maxSteps: number
  /**
   * How long one step may wait for the page to go quiet before the next step
   * runs. It is the per-step ceiling on {@link settleQuietMs}: a page that
   * keeps changing after a click is acted on again rather than waited on
   * forever.
   */
  settleMaxMs: number
}

/** The browser-facing half of this plugin's configuration. */
export interface ContentFrameSettings {
  /** How many (session, page) frames the column keeps alive at once; at least 1. */
  cacheSize: number
  /**
   * How often the seat asks the frame in front where it is, in milliseconds;
   * at least 1. It is what catches a route change made through
   * `history.pushState`, which fires no event a parent document can listen for.
   */
  navigationPollMs: number
  /** The configured pages, in declaration order — the whole catalog a page-navigation menu offers. */
  pages: ContentPage[]
  /**
   * Page id the sidebar shows automatically the first time a session lands
   * on a blank draft; absent when the deployment configures none. Names a
   * page in {@link pages}.
   */
  homePage?: string
  /**
   * The budget, the deadlines and the step bound a seat must obey; absent when
   * the deployment configures no page access, which is also how the browser
   * half knows not to install the reader at all.
   */
  pageAccess?: ContentFrameAccessSettings
}
