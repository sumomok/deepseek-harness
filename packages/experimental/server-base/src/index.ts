/**
 * @deepseek-ai/dsh-experimental-server-base — tells the browser the one
 * deployment fact a served page cannot work out for itself: whether reaching
 * the page means owning the Host behind it.
 *
 * Off a loopback authority the client reads the page as somebody else's Host
 * and stands its operator-only surface down — the settings sections, the
 * settings document actions, and the produced-file open action. A deployment
 * that admits nobody but the Host's operator says so with `ownsHost`, and this
 * plugin serves the `__DSH_TRANSPORT__` carrier the client reads that
 * declaration from.
 *
 * The deployment path prefix is not this package's concern: the served index
 * carries `<base href="./">` from `dsh-host-frontend-static`, so a page loaded
 * under a prefix-stripping proxy resolves every URL it builds under the mount
 * it was loaded from.
 * @module @deepseek-ai/dsh-experimental-server-base
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'server-base'

/**
 * Service required before the carrier row can be contributed. The row only
 * reaches a browser through this service's index render, so a composition
 * without it leaves the row waiting rather than silently serving a page that
 * claims nothing.
 */
export const inject = ['webServer']

/** Plugin config: the deployment fact the served page is given. */
export interface Config {
  /**
   * Declare that whoever reaches the served page is this Host's operator. The
   * page then carries a `__DSH_TRANSPORT__` carrier whose `ownsHost` makes
   * `ctx.connection.isLoopback` true on an authority that is not loopback, so
   * the client offers the surface it otherwise keeps for the operator's own
   * machine: settings read and write the Host's settings document instead of a
   * process-local mirror that answers every read `unavailable`, the settings
   * document actions appear, and a produced-file chip offers to open its path
   * on the Host. Set it only where something in front of the page decides who
   * reaches it — the console sample pairs the dsh browser session cookie with
   * the proxy's `auth_request` login gate — because every visitor those admit
   * gets that surface. It moves no server-side check: the browser-trust fence
   * still refuses a Host that is neither loopback nor declared, and the Host's
   * settings RPC already answered any caller the deployment admitted. Omit it,
   * and the page is served exactly as it is without this claim; the default is
   * false.
   */
  ownsHost?: boolean
}

export const Config: z<Config> = z.object({
  ownsHost: z.boolean().default(false),
})

/**
 * Inline script installing the carrier that declares the page owns its Host.
 * `fetch` is the page's own, the same caller `client-connection` uses when no
 * carrier is present, so the RPC keeps its HTTP requests and its Gateway
 * WebSocket; no `openStream` and no `loadBundle`, so the plugin bundles keep
 * loading over HTTP. `??=` leaves whatever a shell assembled for itself — the
 * worker preview's postMessage tunnel — in place.
 */
const OWNS_HOST_SCRIPT
  = 'globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };'

/**
 * Contribute the ownership carrier to the served index where the deployment
 * claims the Host.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // A deployment that claims nothing is served the index exactly as the dist
  // server renders it.
  if (config.ownsHost !== true) return
  // Prepended, and ahead of every document script, which is where the carrier
  // has to be: `client-connection` reads the global once, at its own plugin
  // boot.
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: OWNS_HOST_SCRIPT })
  }, { prepend: true })
}
