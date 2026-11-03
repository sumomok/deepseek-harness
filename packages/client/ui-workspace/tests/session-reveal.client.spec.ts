/**
 * Message reveals a Session navigation carries: one request per Session,
 * observable until the transcript consumes it, and a new identity on every
 * repeat so landing twice in one Session works.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { SessionReveals } from '../src/client/reveal.ts'

const SESSION = SessionId('sess-a')

describe('SessionReveals', () => {
  it('publishes a request to its Session and keeps the source identity stable', () => {
    const reveals = new SessionReveals()
    const source = reveals.source(SESSION)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)

    expect(reveals.source(SESSION)).toBe(source)
    expect(source.getSnapshot()).toBeNull()

    reveals.request(SESSION, SessionSeq(7))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toEqual({ id: 1, sessionId: SESSION, seq: SessionSeq(7) })
    unsubscribe()
  })

  it('raises a new request identity for a repeated reveal of the same message', () => {
    const reveals = new SessionReveals()
    const source = reveals.source(SESSION)
    const listener = vi.fn()
    source.subscribe(listener)

    reveals.request(SESSION, SessionSeq(7))
    const first = source.getSnapshot()
    reveals.request(SESSION, SessionSeq(7))
    const second = source.getSnapshot()

    expect(second?.id).not.toBe(first?.id)
    expect(second?.seq).toBe(SessionSeq(7))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('consumes only the request the transcript handled', () => {
    const reveals = new SessionReveals()
    const source = reveals.source(SESSION)
    reveals.request(SESSION, SessionSeq(7))
    reveals.request(SESSION, SessionSeq(9))

    // A late settlement for the superseded request must not clear the newer one.
    reveals.settle(SESSION, 1)
    expect(source.getSnapshot()?.seq).toBe(SessionSeq(9))

    reveals.settle(SESSION, 2)
    expect(source.getSnapshot()).toBeNull()
  })

  it('withdraws a pending request a later navigation without a message supersedes', () => {
    const reveals = new SessionReveals()
    const source = reveals.source(SESSION)
    reveals.request(SESSION, SessionSeq(7))

    reveals.withdraw(SESSION)

    expect(source.getSnapshot()).toBeNull()
  })

  it('keeps each Session on its own request', () => {
    const reveals = new SessionReveals()
    const other = SessionId('sess-b')
    reveals.request(SESSION, SessionSeq(7))

    expect(reveals.source(SESSION).getSnapshot()?.seq).toBe(SessionSeq(7))
    expect(reveals.source(other).getSnapshot()).toBeNull()
  })
})
