/**
 * @deepseek-ai/dsh-experimental-page-refresh — keeps an open console page on
 * the build its server is running.
 *
 * The node half has one job: it validates this row's settings and publishes
 * them into the served index as a page global, because a browser half receives
 * no cordis config. It registers no route — a deployment's reverse proxy
 * forwards only the shell's own exact paths to this process, so a new route
 * would need that proxy changed as well — and the browser half's build check
 * reads the served index itself.
 *
 * The browser half compares the build the page booted with against the build
 * the server now serves, reloads the page once when they differ, and shows the
 * connection state in one banner (see `./client`).
 * @module @deepseek-ai/dsh-experimental-page-refresh
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MAX_STUCK_AFTER_SECONDS, MAX_TIMER_DELAY_MS, PAGE_REFRESH_CONFIG_GLOBAL } from './config.ts'

export { PAGE_REFRESH_CONFIG_GLOBAL } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'page-refresh'

/**
 * Plugin config: when the browser half checks the build, how it reloads, and
 * which connection notices it shows. There is no switch for the whole plugin; a
 * deployment that does not want it disables the row.
 */
export interface Config {
  /**
   * Also check the build each time the page returns to the foreground, in
   * addition to each time the connection to the server is established. Default
   * `true`.
   */
  checkOnVisible: boolean
  /**
   * Milliseconds between deciding to reload and reloading. Default `0`, which
   * reloads at once: the page that has just found a different build may already
   * be failing to draw against the new server, so it does not wait. A positive
   * delay shows the reloading notice for that long first.
   */
  reloadDelayMs: number
  /**
   * Show the connection notices: the loss notice once a loss has lasted a
   * moment, the reconnected confirmation after it, and the unreachable notice
   * with its reload button. Default `true`.
   */
  disconnectNotice: boolean
  /**
   * Seconds a connection loss lasts, while the browser reports itself online,
   * before the loss notice becomes the unreachable notice with a page reload
   * button. A positive integer; default `60`.
   */
  stuckAfterSeconds: number
}

export const Config: z<Partial<Config>, Config> = z.object({
  checkOnVisible: z.boolean().default(true),
  reloadDelayMs: z.natural().max(MAX_TIMER_DELAY_MS).default(0),
  disconnectNotice: z.boolean().default(true),
  stuckAfterSeconds: z.natural().min(1).max(MAX_STUCK_AFTER_SECONDS).default(60),
})

/**
 * Publish the resolved settings into every index the web server renders.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The settings travel as plain data: the four fields, nothing derived.
  const value: Config = {
    checkOnVisible: config.checkOnVisible,
    reloadDelayMs: config.reloadDelayMs,
    disconnectNotice: config.disconnectNotice,
    stuckAfterSeconds: config.stuckAfterSeconds,
  }
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: PAGE_REFRESH_CONFIG_GLOBAL, value })
    })
  })
}
