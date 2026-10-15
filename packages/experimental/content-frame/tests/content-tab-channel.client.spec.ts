// @vitest-environment jsdom
/**
 * The browser half of the shared channel answering for a domain that has
 * nothing to weigh: the domain hands back an outcome alone, and the channel
 * composes the document around it and posts it to the report route.
 *
 * The page domain always serializes its own document, so this answer form is
 * reached only by a domain joining from another package; this file joins one
 * of its own.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentChannel, type ChannelCall } from '../src/client/access/channel.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ChannelOutcome } from '../src/access/wire.ts'

/** What the domain answers every call with. */
const OUTCOME: ChannelOutcome = { status: 'error', code: 'empty', message: 'the content column is empty' }

/** Every document posted to a channel route, in order. */
let posted: { route: string; body: unknown }[] = []

beforeEach(() => {
  posted = []
  vi.stubGlobal('fetch', vi.fn((input: URL, init: { readonly body: string }) => {
    const route = input.pathname
    const body: unknown = JSON.parse(init.body)
    posted.push({ route, body })
    const answer = route === CONTENT_CLAIM_ROUTE ? { claimed: true } : { accepted: true }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the tab channel', () => {
  it('composes the report around an outcome a domain answers with, and posts it to the report route', async () => {
    const channel = new ContentChannel()
    const seat = channel.join<ChannelCall>({
      name: 'outcome-only',
      ready: () => true,
      answer: () => Promise.resolve({ kind: 'outcome', outcome: OUTCOME }),
    })
    seat.offer({ calls: [{ callId: 'call_1', sessionId: 'session_1' }], openCalls: ['call_1'] })
    await vi.waitFor(() => { expect(posted).toHaveLength(2) })
    expect(posted[1]).toEqual({
      route: CONTENT_REPORT_ROUTE,
      body: { callId: 'call_1', tabId: channel.tabId, outcome: OUTCOME },
    })
    seat.park()
  })
})
