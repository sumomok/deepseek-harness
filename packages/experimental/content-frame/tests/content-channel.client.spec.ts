/**
 * `ctx.contentChannel` with more than one domain on it: the routes belong to
 * the service and are claimed once, by the first member that registers, and
 * every member after it joins the same pair; the service answers the session
 * one call id was opened against, which is the lookup both routes read before
 * a caller may settle a call; a member reads the report of the call it opened,
 * while a settled call's report is offered to every member in turn; and a
 * member that is released stops reading while the routes stay claimed.
 *
 * The routes themselves are exercised over real HTTP by
 * `content-read-routes.client.spec.ts`; what this file pins is the sharing
 * between domains, which a single-member composition never reaches.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ContentChannel, type ChannelMember } from '../src/access/channel.ts'
import { placeEveryCaller } from '../src/access/members.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE } from '../src/access/wire.ts'

/** The session a case opens its call against. */
const SESSION = SessionId('session-1')

/** The tab every post here comes from. */
const TAB = 'tab_1'

/** Deadlines short enough that a case settles its own call rather than waiting one out. */
const TIMEOUTS = { claimTimeoutMs: 5000, answerTimeoutMs: 5000, pinMs: 0 }

/** One registered route, as the stub server keeps it. */
interface RegisteredRoute {
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
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

/**
 * One member whose reader answers only for a post carrying its own marker, so
 * a case can tell which member read a document.
 * @param name - the member's name, which is also its marker.
 * @returns the member.
 */
function readerOf(name: string): ChannelMember {
  return {
    name,
    reportBytes: 1024,
    parseReport: (value) => {
      const body = value as { marker?: unknown; callId?: unknown; tabId?: unknown }
      if (body.marker !== name) return undefined
      return {
        callId: String(body.callId),
        tabId: String(body.tabId),
        outcome: { status: 'error', code: 'engine', message: `read by ${name}` },
      }
    },
  }
}

/** One route pair served over a real socket, for a case that posts like the browser half. */
interface Served {
  /** The origin the routes answer on. */
  readonly base: string
  /**
   * Stop serving.
   * @returns a promise settling once the server has closed.
   */
  readonly close: () => Promise<void>
}

/**
 * Serve whatever routes the channel claimed over a real socket.
 * @param routes - the routes the channel registered on the stub server.
 * @returns the served origin and the way to close it.
 */
async function listening(routes: Map<string, RegisteredRoute>): Promise<Served> {
  const server = createServer((req, res) => {
    const route = routes.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

/**
 * Post one JSON document to one route.
 * @param base - the served origin.
 * @param route - the route to post to.
 * @param body - the document.
 * @returns the status and the decoded answer.
 */
async function post(
  base: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as unknown }
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
    expect(typeof first.calls.open).toBe('function')
  })

  it('answers the session a call id was opened against, while it waits and after it settles', async () => {
    const { channel } = bench()
    const table = channel.register(member('page', 1024)).calls
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

  it('withdraws a member when its registration is released, and keeps a later one under the same name', async () => {
    const { channel, routes } = bench()
    const first = channel.register(readerOf('page'))
    channel.register(readerOf('act'))
    const again = channel.register(readerOf('page'))
    first.release()
    const served = await listening(routes)
    try {
      // The released member's marker is read by nobody, so the body is not one
      // this channel takes — and the routes are still claimed without it.
      const gone = await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'none', tabId: TAB, marker: 'gone' })
      expect(gone.status).toBe(400)
      // The member registered under the same name later stays: its body is
      // read and refused as one no waiting call takes.
      expect(await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'none', tabId: TAB, marker: 'page' }))
        .toEqual({ status: 200, body: { accepted: false } })
      await again.release()
      await first.release()
    } finally {
      await served.close()
    }
  })

  it('reads a post with the member that opened the call, and every member only once the call has settled', async () => {
    const { channel, routes } = bench()
    // Registered before the owner, so a reader that asked the first member
    // rather than the call's own would answer for the wrong domain.
    channel.register(readerOf('bystander'))
    const owner = channel.register(readerOf('owner'))
    const served = await listening(routes)
    try {
      const waiting = owner.calls.open('call-1', SESSION, new AbortController().signal, TIMEOUTS)
      await post(served.base, CONTENT_CLAIM_ROUTE, { callId: 'call-1', tabId: TAB })
      expect(await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'call-1', tabId: TAB, marker: 'owner' }))
        .toEqual({ status: 200, body: { accepted: true } })
      await expect(waiting).resolves.toEqual({
        kind: 'reported',
        outcome: { status: 'error', code: 'engine', message: 'read by owner' },
      })

      // A waiting call's post is the owner's alone to read, even where an
      // earlier member would have taken the same document.
      const second = owner.calls.open('call-2', SESSION, new AbortController().signal, TIMEOUTS)
      await post(served.base, CONTENT_CLAIM_ROUTE, { callId: 'call-2', tabId: TAB })
      expect((await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'call-2', tabId: TAB, marker: 'bystander' })).status).toBe(400)
      expect(await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'call-2', tabId: TAB, marker: 'owner' }))
        .toEqual({ status: 200, body: { accepted: true } })
      await second

      // With the call settled no member owns it, so the document is offered to
      // every member in turn: a body one of them reads is one no waiting call
      // takes, and a body none reads is a shape refusal.
      expect(await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'call-1', tabId: TAB, marker: 'bystander' }))
        .toEqual({ status: 200, body: { accepted: false } })
      const shape = await post(served.base, CONTENT_REPORT_ROUTE, { callId: 'call-1', tabId: TAB, marker: 'nobody' })
      expect(shape.status).toBe(400)
    } finally {
      await served.close()
    }
  })
})
