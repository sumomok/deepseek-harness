/**
 * Wire the build check, the connection notices, and the banner into one
 * client context. Nothing here draws or reloads by itself: the check and the
 * notices run on the page operations they are handed and write the banner
 * state, and the banner is one `shell.overlay` entry reading that state.
 *
 * The check and the notices depend on the connection service alone; the banner
 * waits separately for the slot and locale services, so a page whose React tree
 * failed to draw still checks its build and still reloads.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/install
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the connection service's face and the `connection/reset` event.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the `locale` service merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `shell.overlay` slot the banner registers into.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `slots` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Config } from '../index.ts'
import type { BannerState } from './banner-state.ts'
import type { PageRefreshBrowser } from './browser.ts'
import { BuildCheck } from './check.ts'
import { bootEntriesOf, documentUrlOf } from './identity.ts'
import { en, NS, zh } from './locales.ts'
import { watchConnection } from './notice.ts'
import { PageRefreshBanner, type PageRefreshBannerFace } from './PageRefreshBanner.tsx'

/** What one page's installation runs on. */
export interface PageRefreshInstall {
  /** The page operations. */
  readonly browser: PageRefreshBrowser
  /** The validated settings. */
  readonly settings: Config
  /** The banner state the check and the notices write. */
  readonly banners: SnapshotStore<BannerState>
  /**
   * Record one diagnostic that changes nothing on the page.
   * @param message - the diagnostic.
   */
  readonly log: (message: string) => void
}

/**
 * Start this plugin's behavior in one client context. Every listener, timer,
 * and request it starts belongs to that context and ends with it.
 * @param ctx - the client context; it must provide the connection service.
 * @param install - the page operations, the settings, the banner state, and the diagnostic sink.
 */
export function installPageRefresh(ctx: ClientContext, install: PageRefreshInstall): void {
  const { browser, settings, banners, log } = install
  // The build this page booted with is read once, now: it is what the page is
  // running, whatever the server serves later.
  const entries = bootEntriesOf(browser.bootGraph())
  if (entries === undefined) {
    log('page-refresh: the page booted without a readable boot graph, so no build is checked')
  } else {
    const check = new BuildCheck({
      browser,
      documentUrl: documentUrlOf(browser.navigationUrl(), browser.currentHref()),
      current: { entries, shell: browser.moduleScripts() },
      reloadDelayMs: settings.reloadDelayMs,
      showNotice: (notice) => { banners.update((draft) => { draft.refresh = notice }) },
      log,
    })
    ctx.effect(() => () => { check.dispose() }, 'page-refresh: build check')
    // Emitted on every established connection, the first one included.
    ctx.on('connection/reset', () => { check.trigger() })
    if (settings.checkOnVisible) {
      ctx.effect(() => browser.onVisible(() => { check.trigger() }), 'page-refresh: foreground check')
    }
  }
  if (settings.disconnectNotice) {
    // The client connection service has no Context merge of its own (the Host
    // merges the same key), so it is read by name like its other consumers.
    const connection = ctx.get('connection') as ConnectionHandle
    ctx.effect(() => watchConnection({
      state: connection.state,
      browser,
      stuckAfterSeconds: settings.stuckAfterSeconds,
      showNotice: (notice) => { banners.update((draft) => { draft.connection = notice }) },
    }), 'page-refresh: connection notices')
  }
  ctx.inject(['slots', 'locale'], (ui) => {
    ui.effect(() => ui.locale.register(NS, { zh, en }), 'page-refresh: dictionaries')
    ui.slots.inject('shell.overlay', () => ui.slots.register({
      name: 'shell.overlay',
      id: 'page-refresh.banner',
      locale: NS,
      inject: (): PageRefreshBannerFace => ({
        hooks: { pageRefresh: banners },
        reloadPage: () => { browser.reload() },
      }),
    }, PageRefreshBanner))
  })
}
