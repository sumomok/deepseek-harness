/**
 * The two-phase wait a `content_read` call sits in: the claim window that tells
 * "no console is open" from "the console went quiet", the report window after
 * it, and the rule that keeps one session's consecutive reads on one tab.
 *
 * Time is faked because every assertion here is about a deadline; the table's
 * own `Date.now()` moves with it.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingCalls, type CallSettlement, type CallTimeouts } from '../src/access/pending.ts'
import { PREFERRED_TAB_WINDOW_MS, type ReadOutcome } from '../src/access/wire.ts'

const TIMEOUTS: CallTimeouts = { claimTimeoutMs: 3000, answerTimeoutMs: 15000, pinMs: 300000 }

/** One listing, which the table carries through without looking at it. */
const OUTCOME: ReadOutcome = { status: 'error', code: 'empty', message: 'the content column is empty' }

let table: PendingCalls
let aborter: AbortController

beforeEach(() => {
  vi.useFakeTimers()
  table = new PendingCalls()
  aborter = new AbortController()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Open one wait and hand back the promise plus a way to see it settle. */
function open(callId: string, sessionId = 'session_1'): Promise<CallSettlement> {
  return table.open(callId, sessionId, aborter.signal, TIMEOUTS)
}

describe('the claim window', () => {
  it('answers that no console is open once the window passes', async () => {
    const settled = open('call_1')
    await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs - 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toEqual({ kind: 'unclaimed' })
  })

  it('tells a claim for a call it has never seen from one it has already answered', async () => {
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' }))
      .toEqual({ claimed: false, reason: 'unknown' })
    const settled = open('call_1')
    await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs)
    await settled
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' }))
      .toEqual({ claimed: false, reason: 'settled' })
  })

  it('remembers only the most recent settled calls, so a very late claim reads as unknown again', async () => {
    for (let index = 0; index <= 64; index += 1) {
      const settled = open(`call_${index}`)
      await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs)
      await settled
    }
    expect(await table.claim({ callId: 'call_0', tabId: 'tab_a' }))
      .toEqual({ claimed: false, reason: 'unknown' })
    expect(await table.claim({ callId: 'call_64', tabId: 'tab_a' }))
      .toEqual({ claimed: false, reason: 'settled' })
  })

  it('refuses a second wait for a call already in the table, rather than stranding the first', async () => {
    const settled = open('call_1')
    await expect(open('call_1')).rejects.toThrow('content-frame: call call_1 is already waiting')
    // The first execution is still the one the table answers; a silent replace
    // would have left it blocked with every wake-up path pointing elsewhere.
    await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs)
    expect(await settled).toEqual({ kind: 'unclaimed' })
  })

  it('gives the read to one tab and refuses every other bid for it', async () => {
    const settled = open('call_1')
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' })).toEqual({ claimed: true })
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_b' })).toEqual({ claimed: false, reason: 'taken' })
    // A second bid from the winner is refused too: it already owns the read.
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' })).toEqual({ claimed: false, reason: 'taken' })
    table.report({ callId: 'call_1', tabId: 'tab_a', outcome: OUTCOME })
    await settled
  })
})

describe('the report window', () => {
  it('waits the whole report deadline once a tab has claimed the read', async () => {
    const settled = open('call_1')
    await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs - 1)
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' })).toEqual({ claimed: true })
    // The claim window's own deadline is gone: only the report deadline stands.
    await vi.advanceTimersByTimeAsync(TIMEOUTS.answerTimeoutMs - 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toEqual({ kind: 'unanswered' })
  })

  it('settles the call with the outcome the claiming tab posted', async () => {
    const settled = open('call_1')
    await table.claim({ callId: 'call_1', tabId: 'tab_a' })
    expect(table.report({ callId: 'call_1', tabId: 'tab_a', outcome: OUTCOME })).toEqual({ accepted: true })
    expect(await settled).toEqual({ kind: 'reported', outcome: OUTCOME })
  })

  it('changes nothing for a report no waiting call asked for', async () => {
    // Never opened.
    expect(table.report({ callId: 'call_x', tabId: 'tab_a', outcome: OUTCOME })).toEqual({ accepted: false })
    const settled = open('call_1')
    await table.claim({ callId: 'call_1', tabId: 'tab_a' })
    // A tab that did not claim it.
    expect(table.report({ callId: 'call_1', tabId: 'tab_b', outcome: OUTCOME })).toEqual({ accepted: false })
    table.report({ callId: 'call_1', tabId: 'tab_a', outcome: OUTCOME })
    await settled
    // The same tab, a second time.
    expect(table.report({ callId: 'call_1', tabId: 'tab_a', outcome: OUTCOME })).toEqual({ accepted: false })
  })

  it('refuses a report for a call that was never claimed', async () => {
    const settled = open('call_1')
    expect(table.report({ callId: 'call_1', tabId: 'tab_a', outcome: OUTCOME })).toEqual({ accepted: false })
    await vi.advanceTimersByTimeAsync(TIMEOUTS.claimTimeoutMs)
    expect(await settled).toEqual({ kind: 'unclaimed' })
  })
})

describe('cancellation', () => {
  it('answers a cancelled execution without registering a wait at all', async () => {
    aborter.abort()
    expect(await open('call_1')).toEqual({ kind: 'aborted' })
    expect(await table.claim({ callId: 'call_1', tabId: 'tab_a' })).toEqual({ claimed: false, reason: 'unknown' })
  })

  it('ends a wait the moment its execution is cancelled, in either phase', async () => {
    const unclaimed = open('call_1')
    aborter.abort()
    expect(await unclaimed).toEqual({ kind: 'aborted' })

    aborter = new AbortController()
    const claimed = open('call_2')
    await table.claim({ callId: 'call_2', tabId: 'tab_a' })
    aborter.abort()
    expect(await claimed).toEqual({ kind: 'aborted' })
    expect(table.report({ callId: 'call_2', tabId: 'tab_a', outcome: OUTCOME })).toEqual({ accepted: false })
  })
})

describe('the preferred tab', () => {
  /** Give `tab_a` the session's pin by letting it answer one read. */
  async function pinTabA(callId: string, sessionId = 'session_1'): Promise<void> {
    const settled = open(callId, sessionId)
    await table.claim({ callId, tabId: 'tab_a' })
    table.report({ callId, tabId: 'tab_a', outcome: OUTCOME })
    await settled
  }

  it('holds another tab\'s claim briefly, and the pinned tab takes the read', async () => {
    await pinTabA('call_1')
    const settled = open('call_2')
    const held = table.claim({ callId: 'call_2', tabId: 'tab_b' })
    expect(await table.claim({ callId: 'call_2', tabId: 'tab_a' })).toEqual({ claimed: true })
    expect(await held).toEqual({ claimed: false, reason: 'taken' })
    table.report({ callId: 'call_2', tabId: 'tab_a', outcome: OUTCOME })
    await settled
  })

  it('gives the read to the other tab when the pinned one does not come', async () => {
    await pinTabA('call_1')
    const settled = open('call_2')
    const held = table.claim({ callId: 'call_2', tabId: 'tab_b' })
    await vi.advanceTimersByTimeAsync(PREFERRED_TAB_WINDOW_MS)
    expect(await held).toEqual({ claimed: true })
    // Answering moves the pin, so the next read goes to `tab_b` at once.
    table.report({ callId: 'call_2', tabId: 'tab_b', outcome: OUTCOME })
    await settled
    const next = open('call_3')
    expect(await table.claim({ callId: 'call_3', tabId: 'tab_b' })).toEqual({ claimed: true })
    table.report({ callId: 'call_3', tabId: 'tab_b', outcome: OUTCOME })
    await next
  })

  it('refuses a second unpinned tab while one is already held', async () => {
    await pinTabA('call_1')
    const settled = open('call_2')
    const held = table.claim({ callId: 'call_2', tabId: 'tab_b' })
    expect(await table.claim({ callId: 'call_2', tabId: 'tab_c' })).toEqual({ claimed: false, reason: 'taken' })
    await vi.advanceTimersByTimeAsync(PREFERRED_TAB_WINDOW_MS)
    expect(await held).toEqual({ claimed: true })
    table.report({ callId: 'call_2', tabId: 'tab_b', outcome: OUTCOME })
    await settled
  })

  it('tells a held claim the call ended under it', async () => {
    await pinTabA('call_1')
    const settled = open('call_2')
    const held = table.claim({ callId: 'call_2', tabId: 'tab_b' })
    aborter.abort()
    expect(await held).toEqual({ claimed: false, reason: 'settled' })
    expect(await settled).toEqual({ kind: 'aborted' })
  })

  it('lets any tab take the read once the pin has run out', async () => {
    await pinTabA('call_1')
    await vi.advanceTimersByTimeAsync(TIMEOUTS.pinMs)
    const settled = open('call_2')
    // No hold at all: the pin is gone, so this is a session with no preference.
    expect(await table.claim({ callId: 'call_2', tabId: 'tab_b' })).toEqual({ claimed: true })
    table.report({ callId: 'call_2', tabId: 'tab_b', outcome: OUTCOME })
    await settled
  })

  it('pins per session, so a second session\'s first read is not held for another session\'s tab', async () => {
    await pinTabA('call_1')
    const settled = open('call_2', 'session_2')
    expect(await table.claim({ callId: 'call_2', tabId: 'tab_b' })).toEqual({ claimed: true })
    table.report({ callId: 'call_2', tabId: 'tab_b', outcome: OUTCOME })
    await settled
  })

  it('keeps a pin for only the most recent sessions, so a session read once never holds a row forever', async () => {
    for (let index = 0; index <= 64; index += 1) {
      await pinTabA(`call_${index}`, `session_${index}`)
    }
    const settled = open('call_late', 'session_0')
    // The oldest pin is gone, so this reads as a session with no preference:
    // an unpinned tab wins at once instead of being held for one that may
    // never come back.
    expect(await table.claim({ callId: 'call_late', tabId: 'tab_b' })).toEqual({ claimed: true })
    table.report({ callId: 'call_late', tabId: 'tab_b', outcome: OUTCOME })
    await settled
  })
})
