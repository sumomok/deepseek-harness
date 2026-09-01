/**
 * What the bounded body reader costs the process, measured on a real socket.
 *
 * A bare `node:http` server rather than the composed route, because the
 * measurement is `socket.bytesRead` and the webserver keeps its own server
 * private. The handler runs the same three helpers in the same order both read
 * routes do, so what is measured is the sequence they are wired in — the
 * routes' own statuses and sentences belong to the real-composition suite.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerJson, readJsonBody, rejectUntrustedPost, takeJsonBody, type BodyRead, type BodyRefusals,
} from '../src/access/http.ts'

/** The bound this server holds every body to. */
const LIMIT = 4096

/** A body far past the bound: large enough that draining it would be visible. */
const OVERSIZED = JSON.stringify({ text: 'y'.repeat(8 * 1024 * 1024) })

/** What this server answers a body it cannot use with. */
const REFUSALS: BodyRefusals = {
  oversize: `content-frame: the probe route refuses a body past ${LIMIT} bytes`,
  shape: 'content-frame: expected a JSON body',
}

/** How much of a refused body may reach this process before the socket goes. */
const DRAIN_BOUND = 1024 * 1024

/** What the reader left behind for one served request. */
interface Served {
  /** What the read ended as, or the failure it ended with. */
  read: BodyRead | { kind: 'threw'; message: string }
  /** Whether the reader destroyed the request on its way out. */
  destroyed: boolean
}

/** One bare server, its port, and what it recorded. */
interface Probe {
  port: number
  served: Served[]
  /** Bytes the answering socket has taken off the wire so far. */
  bytesRead: () => number
}

let server: Server | undefined

afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
})

/** Boot one bare server running the route helpers over the reader. */
async function boot(): Promise<Probe> {
  const served: Served[] = []
  let answering: Socket | undefined
  const listening = createServer((req, res) => {
    void (async () => {
      if (rejectUntrustedPost(req, res, 'the probe route')) return
      let read: BodyRead
      try {
        read = await readJsonBody(req, LIMIT)
      } catch (failed) {
        served.push({ read: { kind: 'threw', message: (failed as Error).message }, destroyed: req.destroyed })
        return
      }
      served.push({ read, destroyed: req.destroyed })
      const body = takeJsonBody(res, read, REFUSALS)
      if (body === undefined) return
      answerJson(res, 200, { taken: true })
    })()
  })
  server = listening
  listening.on('connection', (socket) => { answering = socket })
  await new Promise<void>((resolve) => { listening.listen(0, '127.0.0.1', resolve) })
  return {
    port: (listening.address() as AddressInfo).port,
    served,
    bytesRead: () => answering?.bytesRead ?? -1,
  }
}

/** One raw exchange, answered or cut short. */
interface Answer {
  /** The status, or zero when no answer reached this side. */
  status: number
  /** The answer's body, empty when none reached this side. */
  body: string
  /** The failure the client's own write ended with, when it had one. */
  failed: string | undefined
}

/**
 * POST one body, reporting rather than throwing when the socket goes away under
 * a client that is still writing — which is what a refusal past the bound does.
 */
function post(port: number, body: string, chunked = false): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    let answered: IncomingMessage | undefined
    let text = ''
    let failed: string | undefined
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve({ status: answered?.statusCode ?? 0, body: text, failed })
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/probe', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        answered = res
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', settle)
        res.on('error', settle)
      },
    )
    // The socket can fail twice over when the server closes on a client still
    // writing megabytes, and node forwards only the first failure to the
    // request; a second one with no listener would take the worker down.
    req.on('socket', (socket) => { socket.on('error', () => {}) })
    req.on('error', (error) => {
      failed = error.message
      settle()
    })
    if (!chunked) {
      req.end(body)
      return
    }
    // Written before it is ended: node declares a length for a body handed to
    // `end()` in one piece, and only a body it has already begun sending goes
    // out with no length at all.
    req.write(body)
    req.end()
  })
}

/** Let node finish the exchange, which is when it would drain the remainder. */
function afterTheExchange(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 250) })
}

/** How one exchange ended, for a case where two endings are both correct. */
function endingOf(answer: Answer): string {
  return answer.failed === undefined ? `answered ${String(answer.status)}` : 'cut'
}

describe('the bounded body reader on a real socket', () => {
  it('takes a body inside the bound, and answers one a little past it', async () => {
    const probe = await boot()
    const taken = await post(probe.port, JSON.stringify({ callId: 'c' }))
    expect({ status: taken.status, body: JSON.parse(taken.body) as unknown })
      .toEqual({ status: 200, body: { taken: true } })
    // Past the bound by a page or so: the client has already written all of it,
    // so the refusal still reaches it before the connection goes.
    const refused = await post(probe.port, JSON.stringify({ text: 'y'.repeat(LIMIT * 4) }))
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown })
      .toEqual({ status: 413, body: { error: REFUSALS.oversize } })
    expect(probe.served).toEqual([
      // A body that reached its end is destroyed by node's own stream teardown;
      // what the reader must not destroy is a read it stopped early.
      { read: { kind: 'json', value: { callId: 'c' } }, destroyed: true },
      { read: { kind: 'oversize' }, destroyed: false },
    ])
  })

  it('reads no more of a declared body far past the bound than the socket already held', async () => {
    const probe = await boot()
    const cut = await post(probe.port, OVERSIZED)
    // Two endings, and TCP picks: the refusal reaches a client whose eight
    // megabytes were already on the wire, or the close cuts its write short
    // first. Neither of them is what this bound is for.
    expect(['cut', 'answered 413']).toContain(endingOf(cut))
    expect(probe.served).toEqual([{ read: { kind: 'oversize' }, destroyed: false }])
    await afterTheExchange()
    expect(probe.bytesRead()).toBeLessThan(DRAIN_BOUND)
  })

  it('reads no more of a chunked body far past the bound, and leaves the request alive', async () => {
    const probe = await boot()
    const cut = await post(probe.port, OVERSIZED, true)
    expect(['cut', 'answered 413']).toContain(endingOf(cut))
    // Stopped, not destroyed: the route still owns the answer, and a destroyed
    // request is one it could not be sure of writing on.
    expect(probe.served).toEqual([{ read: { kind: 'oversize' }, destroyed: false }])
    await afterTheExchange()
    expect(probe.bytesRead()).toBeLessThan(DRAIN_BOUND)
  })

  it('fails the read when the caller disconnects before its body ends', async () => {
    const probe = await boot()
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: probe.port,
        path: '/probe',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '64' },
      })
      // The client goes away with the body half sent; nothing here is meant to
      // reach a response.
      req.on('error', () => { resolve() })
      req.write('{"callId":"c",')
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 20)
    })
    await expect.poll(() => probe.served.length, { timeout: 3000 }).toBe(1)
    expect(probe.served[0]?.read.kind).toBe('threw')
  })
})
