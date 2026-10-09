/**
 * `ctx.contentChannel` with more than one domain on it: the routes belong to
 * the service and are claimed once, by the first member that registers, and
 * every member after it joins the same pair; and the service answers the
 * session one call id was opened against, which is the lookup both routes read
 * before a caller may settle a call.
 *
 * The routes themselves are exercised over real HTTP by
 * `content-read-routes.client.spec.ts`; what this file pins is the sharing
 * between domains, which a single-member composition never reaches.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ContentChannel, type ChannelMember } from '../src/access/channel.ts'
import { placeEveryCaller } from '../src/access/members.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE } from '../src/access/wire.ts'

/** The session a case opens its call against. */
const SESSION = SessionId('session-1')

/** Deadlines short enough that a case settles its own call rather than waiting one out. */
const TIMEOUTS = { claimTimeoutMs: 5000, answerTimeoutMs: 5000, pinMs: 0 }

/** One registered route, as the stub server keeps it. */
interface RegisteredRoute {
  readonly path: string
}

/**
 * A channel over a stub webserver that keeps the routes it is handed.
 * @returns the channel and the routes registered on it.
 */
function bench(): { channel: ContentChannel; routes: Map<string, RegisteredRoute> } {
  const routes = new Map<string, RegisteredRoute>()
  const ctx = new Context()
  ctx.provide('webServer', {
    register: (route: RegisteredRoute) => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  } as never)
  return { channel: new ContentChannel(ctx, { place: placeEveryCaller }), routes }
}

/** One member of the channel, narrowed to what these cases read from it. */
function member(name: string, reportBytes: number): ChannelMember {
  return { name, reportBytes, parseReport: () => undefined }
}

describe('the shared content channel', () => {
  it('claims the route pair once and lets every later domain join it', () => {
    const { channel, routes } = bench()
    const first = channel.register(member('page', 1024))
    expect([...routes.keys()]).toEqual([CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE])
    channel.register(member('act_component', 4096))
    // The second registration adds a member without claiming a second route:
    // the paths stay this service's, which is what lets a domain that is not
    // the first one still be answered.
    expect([...routes.keys()]).toEqual([CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE])
    expect(typeof first.open).toBe('function')
  })

  it('answers the session a call id was opened against, while it waits and after it settles', async () => {
    const { channel } = bench()
    const table = channel.register(member('page', 1024))
    expect(channel.sessionOf('call-1')).toBeUndefined()
    const controller = new AbortController()
    const settlement = table.open('call-1', SESSION, controller.signal, TIMEOUTS)
    // The wait registers synchronously, so the route that reads the session
    // finds it before any browser has claimed the call.
    expect(channel.sessionOf('call-1')).toBe(SESSION)
    controller.abort()
    await expect(settlement).resolves.toEqual({ kind: 'aborted' })
    // A late claim or report still reads the session the call belonged to.
    expect(channel.sessionOf('call-1')).toBe(SESSION)
  })
})
