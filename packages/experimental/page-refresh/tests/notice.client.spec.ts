// @vitest-environment jsdom
/**
 * The connection notices against a connection state the spec moves by hand
 * and a clock the spec advances: nothing before the page has been connected,
 * nothing for a loss shorter than the notice delay, the loss notice, the
 * reconnected confirmation, the unreachable notice gated on the browser being
 * online, and disposal.
 */

import { describe, expect, it } from 'vitest'
import type { ConnectionState, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionNotice } from '../src/client/banner-state.ts'
import { LOSS_NOTICE_DELAY_MS, RECOVERED_NOTICE_MS, watchConnection } from '../src/client/notice.ts'
import { FakePage } from './fake-browser.client.ts'

/** A connection state the spec sets. */
class StateSource implements ConnectionStateSource {
  current: ConnectionState | undefined
  readonly listeners = new Set<() => void>()
  constructor(initial?: ConnectionState) { this.current = initial }
  getSnapshot(): ConnectionState | undefined { return this.current }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(next: ConnectionState | undefined): void {
    this.current = next
    for (const listener of [...this.listeners]) listener()
  }
}

/** Seconds a loss lasts before the unreachable notice in these specs. */
const STUCK_AFTER_SECONDS = 30

/** Watch a connection starting in `initial`, recording every notice change. */
function bench(initial?: ConnectionState) {
  const page = new FakePage()
  const state = new StateSource(initial)
  const notices: (ConnectionNotice | null)[] = []
  const stop = watchConnection({
    state,
    browser: page,
    stuckAfterSeconds: STUCK_AFTER_SECONDS,
    showNotice: (notice) => { notices.push(notice) },
  })
  /** The last notice shown, or `null`. */
  const shown = (): ConnectionNotice | null => notices.at(-1) ?? null
  return { page, state, notices, stop, shown }
}

describe('before the page has been connected', () => {
  it('says nothing while the first connection is still being attempted', () => {
    const { page, state, shown } = bench()
    state.set('connecting')
    state.set('disconnected')
    page.advance(STUCK_AFTER_SECONDS * 1000)
    expect(shown()).toBeNull()
    expect(page.pendingTimers()).toBe(0)
  })
})

describe('a loss after the page was connected', () => {
  it('says nothing for a loss shorter than the notice delay', () => {
    const { page, state, notices } = bench('connected')
    state.set('connecting')
    page.advance(LOSS_NOTICE_DELAY_MS - 1)
    state.set('connected')
    page.advance(RECOVERED_NOTICE_MS)
    expect(notices.filter(notice => notice !== null)).toEqual([])
    expect(page.pendingTimers()).toBe(0)
  })

  it('shows the loss notice once the loss has lasted the delay, then the confirmation for its time', () => {
    const { page, state, shown } = bench('connected')
    state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    expect(shown()).toBe('lost')
    state.set('connected')
    expect(shown()).toBe('recovered')
    page.advance(RECOVERED_NOTICE_MS - 1)
    expect(shown()).toBe('recovered')
    page.advance(1)
    expect(shown()).toBeNull()
  })

  it('keeps one loss through the retry attempts that alternate within it', () => {
    const { page, state, shown } = bench('connected')
    state.set('connecting')
    page.advance(500)
    state.set('disconnected')
    page.advance(300)
    // 800ms after the loss began, not after the latest retry.
    expect(shown()).toBe('lost')
    state.set('connecting')
    state.set('disconnected')
    expect(page.pendingTimers()).toBe(1)
  })

  it('becomes the unreachable notice after the configured time while the browser is online', () => {
    const { page, state, shown } = bench('connected')
    state.set('disconnected')
    page.advance(STUCK_AFTER_SECONDS * 1000 - 1)
    expect(shown()).toBe('lost')
    page.advance(1)
    expect(shown()).toBe('stuck')
    state.set('connected')
    expect(shown()).toBe('recovered')
  })

  it('stays on reconnecting while the browser is offline, and becomes unreachable once it is back online', () => {
    const { page, state, shown } = bench('connected')
    page.setOnline(false)
    state.set('disconnected')
    page.advance(STUCK_AFTER_SECONDS * 1000)
    expect(shown()).toBe('lost')
    page.setOnline(true)
    expect(shown()).toBe('stuck')
    page.setOnline(false)
    expect(shown()).toBe('lost')
  })

  it('ignores the network changing while no notice is shown', () => {
    const { page, state, notices } = bench('connected')
    page.setOnline(false)
    page.setOnline(true)
    state.set('disconnected')
    page.setOnline(false)
    expect(notices).toEqual([null])
  })

  it('withdraws the confirmation when the next loss begins', () => {
    const { page, state, shown } = bench('connected')
    state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    state.set('connected')
    expect(shown()).toBe('recovered')
    state.set('connecting')
    expect(shown()).toBeNull()
    page.advance(RECOVERED_NOTICE_MS)
    expect(shown()).toBe('lost')
  })

  it('ignores the connection loop shutting down', () => {
    const { page, state, notices } = bench('connected')
    state.set(undefined)
    page.advance(STUCK_AFTER_SECONDS * 1000)
    expect(notices).toEqual([])
  })
})

describe('disposal', () => {
  it('stops following, cancels every timer, and clears the notice', () => {
    const { page, state, notices, stop } = bench('connected')
    state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    stop()
    expect(notices.at(-1)).toBeNull()
    expect(page.pendingTimers()).toBe(0)
    expect(state.listeners.size).toBe(0)
    expect(page.network.size).toBe(0)
    state.set('connected')
    page.advance(STUCK_AFTER_SECONDS * 1000)
    expect(notices.at(-1)).toBeNull()
  })

  it('cancels a confirmation still on screen', () => {
    const { page, state, stop } = bench('connected')
    state.set('disconnected')
    page.advance(LOSS_NOTICE_DELAY_MS)
    state.set('connected')
    stop()
    expect(page.pendingTimers()).toBe(0)
  })
})
