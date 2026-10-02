/**
 * The build check: compare the build this page booted with against the build
 * its server now serves, and reload the page once when they differ.
 *
 * The page booted with one build; the identity of that build is captured once,
 * when this plugin starts. Each check requests the index the document was
 * served from and reads the build it carries. The same build changes nothing.
 * A different build reloads the page, guarded so it cannot loop: before
 * reloading, the check stores the key of the build it is reloading for in this
 * tab's session storage, and a check that finds that same build again — the
 * reload did not bring the page onto it — offers the reload in the banner
 * instead of performing it. An answer that carries no readable build is no
 * evidence of anything and changes nothing.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/check
 */

import type { RefreshNotice } from './banner-state.ts'
import type { PageRefreshBrowser } from './browser.ts'
import { buildKey, readServedBuild, sameBuild, type BuildIdentity, type ServedBuild } from './identity.ts'

/**
 * Session-storage key holding the key of the build this tab last reloaded for.
 * Session storage is per tab, so a reload in one tab guards that tab alone.
 */
export const RELOADED_FOR_STORAGE_KEY = 'dsh-page-refresh:reloaded-for'

/** What a {@link BuildCheck} needs from its page and its owner. */
export interface BuildCheckOptions {
  /** The page operations. */
  readonly browser: Pick<
    PageRefreshBrowser,
    'fetchDocument' | 'moduleScriptsIn' | 'readSession' | 'writeSession' | 'removeSession' | 'reload' | 'schedule'
  >
  /** The URL the document was served from, and the one every check requests. */
  readonly documentUrl: string
  /** The build this page booted with. */
  readonly current: BuildIdentity
  /** Milliseconds between deciding to reload and reloading. */
  readonly reloadDelayMs: number
  /**
   * Show or clear the build check's notice.
   * @param notice - the notice, or `null` to clear it.
   */
  readonly showNotice: (notice: RefreshNotice | null) => void
  /**
   * Record one diagnostic that changes nothing on the page.
   * @param message - the diagnostic.
   */
  readonly log: (message: string) => void
}

/**
 * One page's build check. At most one request for the index is open at a time:
 * a trigger that arrives while one is open aborts it and starts a fresh check,
 * so the verdict always reflects the server as of the latest trigger and a
 * request that never answers cannot hold back the next one. Once the check has
 * decided to reload, later triggers do nothing; once it is disposed, nothing it
 * started reloads the page or shows a notice.
 */
export class BuildCheck {
  private inFlight: AbortController | undefined
  private reloading = false
  private disposed = false
  private cancelReload: (() => void) | undefined

  /** @param options - the page operations, the booted build, and the owner's callbacks. */
  constructor(private readonly options: BuildCheckOptions) {}

  /** Start a check, superseding the one in progress. */
  trigger(): void {
    if (this.disposed || this.reloading) return
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    void this.run(controller)
  }

  /**
   * Abort the check in progress and cancel a pending reload. A cancelled reload
   * also takes its record out of session storage: the tab never reloaded for
   * that build, so the next check that finds it reloads instead of offering to.
   */
  dispose(): void {
    this.disposed = true
    this.inFlight?.abort()
    this.inFlight = undefined
    if (this.cancelReload === undefined) return
    this.cancelReload()
    this.cancelReload = undefined
    try {
      this.options.browser.removeSession(RELOADED_FOR_STORAGE_KEY)
    } catch (_sessionStorageUnavailable) {
      // Storage that refuses the removal now accepted the write moments ago;
      // the record left behind turns the next reload for this build into an offer.
    }
  }

  private async run(controller: AbortController): Promise<void> {
    const { browser, documentUrl, log } = this.options
    let served: ServedBuild
    try {
      served = await readServedBuild(browser, documentUrl, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) log(`page-refresh: could not read ${documentUrl}: ${String(error)}`)
      return
    } finally {
      if (this.inFlight === controller) this.inFlight = undefined
    }
    // Superseded by a later trigger, or disposed, while the answer was read.
    if (controller.signal.aborted) return
    if (served.kind === 'unknown') {
      log(`page-refresh: no build read from ${documentUrl}: ${served.reason}`)
      return
    }
    if (sameBuild(this.options.current, served.identity)) this.onSameBuild()
    else this.onNewBuild(served.identity)
  }

  private onSameBuild(): void {
    this.options.showNotice(null)
    try {
      this.options.browser.removeSession(RELOADED_FOR_STORAGE_KEY)
    } catch (_sessionStorageUnavailable) {
      // A page that may not use session storage stored no reload key to clear.
    }
  }

  private onNewBuild(served: BuildIdentity): void {
    const { browser, log, reloadDelayMs, showNotice } = this.options
    const key = buildKey(served)
    let reloadedFor: string | null
    try {
      reloadedFor = browser.readSession(RELOADED_FOR_STORAGE_KEY)
    } catch (error) {
      log(`page-refresh: session storage is unavailable, offering the reload instead: ${String(error)}`)
      showNotice('update')
      return
    }
    if (reloadedFor === key) {
      log('page-refresh: this tab already reloaded for the served build, offering the reload instead')
      showNotice('update')
      return
    }
    try {
      browser.writeSession(RELOADED_FOR_STORAGE_KEY, key)
    } catch (error) {
      log(`page-refresh: session storage is unavailable, offering the reload instead: ${String(error)}`)
      showNotice('update')
      return
    }
    this.reloading = true
    if (reloadDelayMs === 0) {
      browser.reload()
      return
    }
    showNotice('reloading')
    this.cancelReload = browser.schedule(reloadDelayMs, () => {
      this.cancelReload = undefined
      browser.reload()
    })
  }
}
