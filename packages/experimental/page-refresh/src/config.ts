/**
 * This plugin's fixed values, kept out of both halves' entry modules: the id
 * the host's boot graph lists this plugin under, the page global the node half
 * publishes its resolved settings under, and the bounds that keep every
 * configured delay inside what a browser timer waits for.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/config
 */

/**
 * The id the host's boot graph lists this plugin's client bundle under: its
 * package name. A served graph that does not list it would boot a page that
 * never checks its build again.
 */
export const PAGE_REFRESH_ENTRY_ID = '@deepseek-ai/dsh-experimental-page-refresh'

/**
 * Page global the node half assigns the resolved settings to, through one
 * `webserver/index-inject` row rendered ahead of every document script.
 */
export const PAGE_REFRESH_CONFIG_GLOBAL = '__DSH_PAGE_REFRESH_CONFIG__'

/**
 * Longest delay a browser timer waits for. `setTimeout` treats a longer delay as
 * zero and fires on the next tick, so both configured delays are bounded by it.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Longest `stuckAfterSeconds` whose timer still waits the full time. */
export const MAX_STUCK_AFTER_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000)
