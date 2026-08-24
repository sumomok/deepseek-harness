/**
 * The two HTTP paths both halves of this package are defined against: the node
 * half claims them as webserver routes, the browser half points the iframe at
 * one and reads its own settings from the other. Not configurable — the two
 * halves must agree on them and nothing outside this package addresses them.
 *
 * The settings document exists because a browser half receives no cordis
 * config: the boot manifest carries plugin names, not their `config` blocks,
 * so a `Config` field the browser must obey has to be served to it.
 */

/** Prefix route the hosted application is served under; no trailing slash, which is the webserver's route form. */
export const CONTENT_APP_ROUTE = '/content-app'

/** Exact route serving {@link ContentFrameSettings} to this package's browser half. */
export const CONTENT_SETTINGS_ROUTE = '/content-frame/settings'

/** The browser-facing half of this plugin's configuration. */
export interface ContentFrameSettings {
  /** How many (session, page) frames the column keeps alive at once; at least 1. */
  cacheSize: number
}
