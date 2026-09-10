/**
 * The reportable state of the update channel: which event moves it where, and
 * the two states that refuse to be moved.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { UpdateState } from '../src/update-state.ts'

/** The running build every case reports as installed. */
const CURRENT = '0.1.0-rc.32'

/** The version the feed offers in every case that has one. */
const NEXT = '0.1.0-rc.33'

/** A fixed clock reading, so a recorded check time is comparable. */
const CHECKED_AT = '2026-09-11T02:00:00.000Z'

/**
 * A machine for one case.
 * @returns a fresh machine reporting the running build.
 */
function machine(): UpdateState {
  return new UpdateState(CURRENT)
}

describe('the snapshot', () => {
  it('names only the five phases the shell reports', () => {
    const state = machine()
    state.markUnavailable('development launch')
    // A reader's own "this deployment has no update channel" value is never
    // one of these: the shell only ever answers for a channel it has.
    expect(state.snapshot().phase).toBe('failed')
  })

  it('starts idle, naming only the running build', () => {
    expect(machine().snapshot()).toEqual({ phase: 'idle', currentVersion: CURRENT })
  })

  it('omits every field that does not apply rather than sending it as null', () => {
    const state = machine()
    state.checkStarted()
    state.checkSucceeded(CHECKED_AT)
    expect(Object.keys(state.snapshot()).sort()).toEqual(['checkedAt', 'currentVersion', 'phase'])
  })

  it('carries the transfer numbers while downloading and drops them once ready', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 42.5, transferred: 425, total: 1000 })
    expect(state.snapshot()).toMatchObject({
      phase: 'downloading',
      latestVersion: NEXT,
      percent: 42.5,
      transferredBytes: 425,
      totalBytes: 1000,
    })
    state.downloadReady(NEXT)
    expect(state.snapshot()).toEqual({ phase: 'ready', currentVersion: CURRENT, latestVersion: NEXT })
  })

  it('reports a transfer that has not learned the artifact size without a total', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    expect(state.snapshot()).toMatchObject({ percent: 0, transferredBytes: 0 })
    expect(state.snapshot().totalBytes).toBeUndefined()
  })

  it('carries the release notes the manifest gave for the version it names', () => {
    const state = machine()
    state.checkStarted()
    state.checkSucceeded(CHECKED_AT, NEXT, 'fixes the thing')
    expect(state.snapshot()).toMatchObject({ phase: 'idle', latestVersion: NEXT, releaseNotes: 'fixes the thing' })
  })
})

describe('a check', () => {
  it('moves idle to checking and back', () => {
    const state = machine()
    state.checkStarted()
    expect(state.snapshot().phase).toBe('checking')
    state.checkSucceeded(CHECKED_AT)
    expect(state.snapshot()).toEqual({ phase: 'idle', currentVersion: CURRENT, checkedAt: CHECKED_AT })
  })

  it('leaves a failure behind when it does not get through', () => {
    const state = machine()
    state.checkStarted()
    state.checkFailed(CHECKED_AT, 'ECONNRESET')
    expect(state.snapshot()).toEqual({
      phase: 'failed',
      currentVersion: CURRENT,
      reason: 'ECONNRESET',
      checkedAt: CHECKED_AT,
    })
  })

  it('starts over from a failure the next check can fix', () => {
    const state = machine()
    state.checkStarted()
    state.checkFailed(CHECKED_AT, 'ECONNRESET')
    state.checkStarted()
    expect(state.snapshot()).toEqual({ phase: 'checking', currentVersion: CURRENT, checkedAt: CHECKED_AT })
  })

  it('records only when it happened while a transfer is in flight', () => {
    const state = machine()
    state.downloadStarted(NEXT, 'fixes the thing')
    state.checkStarted()
    state.checkSucceeded(CHECKED_AT)
    expect(state.snapshot()).toMatchObject({
      phase: 'downloading',
      latestVersion: NEXT,
      releaseNotes: 'fixes the thing',
      checkedAt: CHECKED_AT,
    })
  })
})

describe('a downloaded update', () => {
  it('survives a later check that finds nothing', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadReady(NEXT)
    state.checkStarted()
    state.checkSucceeded(CHECKED_AT)
    expect(state.snapshot()).toEqual({
      phase: 'ready',
      currentVersion: CURRENT,
      latestVersion: NEXT,
      checkedAt: CHECKED_AT,
    })
    expect(state.isReady()).toBe(true)
  })

  it('is not replaced by a failed check', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadReady(NEXT)
    state.checkFailed(CHECKED_AT, 'ECONNRESET')
    expect(state.snapshot().phase).toBe('ready')
  })

  it('is not restarted by a second transfer', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadReady(NEXT)
    state.downloadStarted('0.1.0-rc.34')
    expect(state.snapshot()).toEqual({ phase: 'ready', currentVersion: CURRENT, latestVersion: NEXT })
  })
})

describe('a transfer', () => {
  it('keeps the last sample it was given', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 10, transferred: 100, total: 1000 })
    state.downloadProgress({ percent: 20, transferred: 200, total: 1000 })
    expect(state.snapshot()).toMatchObject({ percent: 20, transferredBytes: 200 })
  })

  it('drops a sample that arrives outside a transfer', () => {
    const state = machine()
    state.downloadProgress({ percent: 10, transferred: 100, total: 1000 })
    expect(state.snapshot()).toEqual({ phase: 'idle', currentVersion: CURRENT })
  })

  it('reports the failure that ended it and forgets the numbers', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 10, transferred: 100, total: 1000 })
    state.downloadFailed('ETIMEDOUT')
    expect(state.snapshot()).toEqual({
      phase: 'failed',
      currentVersion: CURRENT,
      latestVersion: NEXT,
      reason: 'ETIMEDOUT',
    })
  })

  it('cannot fail when none was running', () => {
    const state = machine()
    state.downloadFailed('ETIMEDOUT')
    expect(state.snapshot()).toEqual({ phase: 'idle', currentVersion: CURRENT })
  })

  it('clears the failure that preceded it', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadFailed('ETIMEDOUT')
    state.downloadStarted(NEXT)
    expect(state.snapshot().reason).toBeUndefined()
  })
})

describe('a build that cannot install an update', () => {
  it('reports the one failure phase, and nothing after it moves the channel', () => {
    const state = machine()
    state.markUnavailable('development launch')
    state.checkStarted()
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 10, transferred: 100, total: 1000 })
    state.downloadReady(NEXT)
    state.downloadFailed('ETIMEDOUT')
    expect(state.snapshot()).toEqual({
      phase: 'failed',
      currentVersion: CURRENT,
      reason: 'development launch',
    })
  })

  it('still reports the version the feed offers, which is all it can do about it', () => {
    const state = machine()
    state.markUnavailable('this build installs an update by replacing it by hand')
    state.checkSucceeded(CHECKED_AT, NEXT, 'fixes the thing')
    expect(state.snapshot()).toMatchObject({
      phase: 'failed',
      latestVersion: NEXT,
      releaseNotes: 'fixes the thing',
      checkedAt: CHECKED_AT,
    })
  })

  it('keeps the first reason it was given', () => {
    const state = machine()
    state.markUnavailable('first')
    state.markUnavailable('second')
    expect(state.snapshot().reason).toBe('first')
  })

  it('drops the numbers of the transfer it interrupts', () => {
    const state = machine()
    state.downloadStarted(NEXT)
    state.downloadProgress({ percent: 10, transferred: 100, total: 1000 })
    state.markUnavailable('in-place update unavailable: ERR_UPDATER_INVALID_SIGNATURE')
    expect(state.snapshot().percent).toBeUndefined()
    expect(state.isReady()).toBe(false)
  })

  it('is not the same as a failure the next check starts over from', () => {
    const state = machine()
    state.checkStarted()
    state.checkFailed(CHECKED_AT, 'ECONNRESET')
    state.checkStarted()
    expect(state.snapshot().phase).toBe('checking')
  })
})
