/**
 * page-refresh browser half: keeps an open page on the build its server is
 * running, and tells the visitor about the page's connection.
 *
 * Each time the connection to the server is established, and each time the
 * page returns to the foreground, the page requests the index it was served
 * from and compares the build that index carries with the build it booted
 * with. A different build reloads the page once; a build the page has already
 * reloaded for, or a tab that may not use session storage, gets the reload
 * offered in the banner instead. The same build changes nothing, which is what
 * a server restart without an upgrade serves.
 *
 * The banner is one `shell.overlay` entry: the update offer, the reloading
 * notice, and the connection notices — lost, reconnected, and unreachable with
 * a reload button.
 * @module @deepseek-ai/dsh-experimental-page-refresh/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { PAGE_REFRESH_CONFIG_GLOBAL } from '../config.ts'
import { createBannerStore } from './banner-state.ts'
import { windowPageRefreshBrowser } from './browser.ts'
import { installPageRefresh } from './install.ts'
import type { PageRefreshKey } from './locales.ts'
import { readPageRefreshSettings } from './settings.ts'

export type { PageRefreshKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The page-refresh banner's copy. */
    pageRefresh: PageRefreshKey
  }
}

/** Required service: the connection, whose establishment and state the plugin follows. */
export const inject = ['connection']

/**
 * Client plugin body: read the settings the served index carries, then start
 * the build check, the connection notices, and the banner for this page.
 * @param ctx - client root context.
 * @throws {Error} when the served index carries no usable settings.
 */
export function apply(ctx: ClientContext): void {
  installPageRefresh(ctx, {
    browser: windowPageRefreshBrowser(window),
    settings: readPageRefreshSettings(Reflect.get(globalThis, PAGE_REFRESH_CONFIG_GLOBAL)),
    banners: createBannerStore(),
    log: (message) => { ctx.logger.debug(message) },
  })
}
