/**
 * The connection notices: what the banner says while the page has lost its
 * connection to the server, once it is back, and once the loss has lasted
 * long enough that waiting is unlikely to help.
 *
 * Only a loss after the page has been connected counts; a page that never
 * connected is still starting. A loss shorter than {@link LOSS_NOTICE_DELAY_MS}
 * shows nothing, which is what a server restart that recovers on the next
 * attempt looks like. A loss that lasts the configured number of seconds while
 * the browser reports itself online becomes the unreachable notice, which
 * offers a page reload; while the browser reports itself offline the notice
 * stays on reconnecting, because the network the visitor is on is what is
 * missing. Recovery after a shown notice shows the reconnected confirmation
 * for {@link RECOVERED_NOTICE_MS}.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/notice
 */

import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionNotice } from './banner-state.ts'
import type { PageRefreshBrowser } from './browser.ts'

/**
 * How long a loss lasts before the loss notice appears: the same moment the
 * settings panel's connection indicator holds its reconnecting state for, so
 * an attempt that succeeds at once does not flicker a notice.
 */
export const LOSS_NOTICE_DELAY_MS = 800

/** How long the reconnected confirmation stays, as long as the settings panel's indicator shows its own. */
export const RECOVERED_NOTICE_MS = 2_000

/** What {@link watchConnection} needs from its page and its owner. */
export interface ConnectionWatchOptions {
  /** The connection's state, as the connection service publishes it. */
  readonly state: ConnectionStateSource
  /** The page operations. */
  readonly browser: Pick<PageRefreshBrowser, 'schedule' | 'online' | 'onOnlineChange'>
  /** Seconds a loss lasts, with the browser online, before the unreachable notice. */
  readonly stuckAfterSeconds: number
  /**
   * Show or clear the connection notice.
   * @param notice - the notice, or `null` to clear it.
   */
  readonly showNotice: (notice: ConnectionNotice | null) => void
}

/**
 * Follow the connection and show its notices.
 * @param options - the connection state, the page operations, and the owner's callback.
 * @returns the disposer, which stops following, cancels every timer, and clears the notice.
 */
export function watchConnection(options: ConnectionWatchOptions): () => void {
  const { state, browser, stuckAfterSeconds, showNotice } = options
  let connectedOnce = false
  let losing = false
  let shown = false
  let stuck = false
  let lossTimers: (() => void)[] = []
  let cancelRecovered: (() => void) | undefined

  const showLoss = (): void => {
    if (shown) showNotice(stuck && browser.online() ? 'stuck' : 'lost')
  }
  const stopLossTimers = (): void => {
    for (const cancel of lossTimers) cancel()
    lossTimers = []
  }
  const recover = (): void => {
    losing = false
    stuck = false
    stopLossTimers()
    if (!shown) return
    shown = false
    showNotice('recovered')
    cancelRecovered = browser.schedule(RECOVERED_NOTICE_MS, () => {
      cancelRecovered = undefined
      showNotice(null)
    })
  }
  const lose = (): void => {
    losing = true
    cancelRecovered?.()
    cancelRecovered = undefined
    showNotice(null)
    lossTimers = [
      browser.schedule(LOSS_NOTICE_DELAY_MS, () => {
        shown = true
        showLoss()
      }),
      browser.schedule(stuckAfterSeconds * 1000, () => {
        shown = true
        stuck = true
        showLoss()
      }),
    ]
  }
  const follow = (): void => {
    const current = state.getSnapshot()
    if (current === 'connected') {
      connectedOnce = true
      if (losing) recover()
      return
    }
    // `connecting` and `disconnected` alternate while one loss is retried, and
    // `undefined` is the connection loop's own shutdown.
    if (current !== undefined && connectedOnce && !losing) lose()
  }

  const unsubscribe = state.subscribe(follow)
  const stopOnline = browser.onOnlineChange(showLoss)
  follow()
  return () => {
    unsubscribe()
    stopOnline()
    stopLossTimers()
    cancelRecovered?.()
    showNotice(null)
  }
}
