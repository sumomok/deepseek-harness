/**
 * The one banner this plugin draws, as data: the build check and the
 * connection notices each own one field, and the banner shows the build
 * check's notice over the connection's.
 * @module @deepseek-ai/dsh-experimental-page-refresh/src/client/banner-state
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * The build check's notice: `update` offers a reload the check would not
 * perform itself, `reloading` precedes a configured reload delay.
 */
export type RefreshNotice = 'update' | 'reloading'

/**
 * The connection notice: `lost` while a loss lasts, `stuck` once it has lasted
 * the configured time with the browser online, `recovered` briefly after it.
 */
export type ConnectionNotice = 'lost' | 'stuck' | 'recovered'

/** Every notice the banner draws. */
export type PageNotice = RefreshNotice | ConnectionNotice

/** The banner's state: each source's current notice, or `null` for none. */
export interface BannerState {
  refresh: RefreshNotice | null
  connection: ConnectionNotice | null
}

/**
 * The notice the banner shows: the build check's, which concerns the page
 * itself, ahead of the connection's.
 * @param state - the banner state.
 * @returns the notice to draw, or `null` for none.
 */
export function visibleNotice(state: BannerState): PageNotice | null {
  return state.refresh ?? state.connection
}

/**
 * Create the banner's state, empty.
 * @returns the store the two sources write and the banner reads.
 */
export function createBannerStore(): SnapshotStore<BannerState> {
  return createSnapshotStore<BannerState>({ refresh: null, connection: null })
}
