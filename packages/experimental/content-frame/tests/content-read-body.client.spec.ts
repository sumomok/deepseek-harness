/**
 * What a refused body costs the process, measured on a real socket.
 *
 * A bare `node:http` server rather than the composed route, because the
 * measurement is `socket.bytesRead` and the webserver's own server is not part
 * of its published face. The handler runs the same helpers in the same order
 * both read routes do, so what is measured is the sequence they are wired in —
 * the routes' own statuses and sentences belong to the real-composition suite.
 *
 * Two of the paths here are counterfactuals rather than product code: an answer
 * written over a body nothing read, with and without `connection: close`. They
 * are what the reader's and the refusal's own contracts are stated against.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { Buffer } from 'node:buffer'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerJson, readJsonBody, rejectMethod, rejectUntrustedPost, takeJsonBody, type BodyRead, type BodyRefusals,
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

/** The path answering with no read and no close, which is what node drains for. */
const UNDRAINED = '/undrained'

/** The path answering with no read and `connection: close`, which does not bound the drain. */
const CLOSED_UNREAD = '/closed-unread'

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
  /** The server's own header and body deadlines, which are what settle a stalled exchange. */
  deadlines: () => { requestTimeout: number; headersTimeout: number }
}

let servers: Server[] = []

afterEach(() => {
  for (const running of servers) {
    running.closeAllConnections()
    running.close()
  }
  servers = []
})

/** Boot one bare server running the route helpers over the reader. */
async function boot(): Promise<Probe> {
  const served: Served[] = []
  let answering: Socket | undefined
  const listening = createServer((req, res) => {
    void (async () => {
      if (req.url === UNDRAINED) {
        answerJson(res, 400, { refused: 'on the header alone' })
        return
      }
      if (req.url === CLOSED_UNREAD) {
        res.setHeader('connection', 'close')
        answerJson(res, 400, { refused: 'on the header alone' })
        return
      }
      if (req.method !== 'POST') {
        rejectMethod(req, res, 'POST', LIMIT)
        return
      }
      if (rejectUntrustedPost(req, res, 'the probe route', LIMIT)) return
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
  servers.push(listening)
  listening.on('connection', (socket) => { answering = socket })
  await new Promise<void>((resolve) => { listening.listen(0, '127.0.0.1', resolve) })
  return {
    port: (listening.address() as AddressInfo).port,
    served,
    bytesRead: () => answering?.bytesRead ?? -1,
    deadlines: () => ({ requestTimeout: listening.requestTimeout, headersTimeout: listening.headersTimeout }),
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

/** How one request is sent. */
interface Sent {
  /** Method; POST unless the case is about method gating. */
  method?: string
  /** Path; the read sequence unless the case is a counterfactual. */
  path?: string
  /** Headers; `application/json` unless the case is about the fence. */
  headers?: Record<string, string>
  /** Send the body with no declared length. */
  chunked?: boolean
}

/**
 * POST one body, reporting rather than throwing when the socket goes away under
 * a client that is still writing — which is what a refusal past the bound does.
 */
function post(port: number, body: string | Buffer, sent: Sent = {}): Promise<Answer> {
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
      {
        host: '127.0.0.1',
        port,
        path: sent.path ?? '/probe',
        method: sent.method ?? 'POST',
        headers: sent.headers ?? { 'content-type': 'application/json' },
      },
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
    if (sent.chunked !== true) {
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

/** Send the eight-megabyte body one way and report what the socket took off the wire. */
async function drained(sent: Sent): Promise<number> {
  const probe = await boot()
  await post(probe.port, OVERSIZED, sent)
  await afterTheExchange()
  return probe.bytesRead()
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
    const cut = await post(probe.port, OVERSIZED, { chunked: true })
    expect(['cut', 'answered 413']).toContain(endingOf(cut))
    // Stopped, not destroyed: the route still owns the answer, and a destroyed
    // request is one it could not be sure of writing on.
    expect(probe.served).toEqual([{ read: { kind: 'oversize' }, destroyed: false }])
    await afterTheExchange()
    expect(probe.bytesRead()).toBeLessThan(DRAIN_BOUND)
  })

  it('counts the bytes a chunk decodes to, which is never fewer than the bytes that arrived', async () => {
    const probe = await boot()
    // Four thousand bytes no UTF-8 decoder can accept, each becoming a
    // three-byte replacement character: inside the bound on the wire and past
    // it once decoded, which is the direction the bound is allowed to err in.
    const invalid = Buffer.alloc(4000, 0x80)
    await post(probe.port, invalid)
    // The same count of bytes that do decode arrives whole and is refused for
    // its shape instead, so what refused the one above is its size.
    await post(probe.port, 'y'.repeat(4000))
    expect(probe.served.map(entry => entry.read.kind)).toEqual(['oversize', 'not-json'])
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

  it('leaves a caller that stops mid-body to the server\'s own deadlines', async () => {
    const probe = await boot()
    const req = httpRequest({
      host: '127.0.0.1',
      port: probe.port,
      path: '/probe',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '64' },
    })
    req.on('error', () => {})
    req.write('{"callId":')
    await afterTheExchange()
    // The read has no deadline of its own, so nothing has settled: what ends
    // this exchange is the server's, which is why the reader states no wait.
    expect(probe.served).toEqual([])
    const { requestTimeout, headersTimeout } = probe.deadlines()
    expect({ request: requestTimeout > 0, headers: headersTimeout > 0 }).toEqual({ request: true, headers: true })
    req.destroy()
  })
})

describe('what an answer written over a body nothing read costs', () => {
  it('pays for the whole body when the connection stays open', async () => {
    // The counterfactual the reader is written against: refusing on the header
    // alone reads nothing in the route and everything in the process.
    expect(await drained({ path: UNDRAINED })).toBeGreaterThanOrEqual(OVERSIZED.length)
  })

  it('still outruns the bound when the answer closes the connection', async () => {
    // Which is why the refusal consumes the body itself rather than relying on
    // the header: node has resumed the request before the socket goes.
    const read = await drained({ path: CLOSED_UNREAD })
    expect({ pastTheBound: read > LIMIT, whole: read >= OVERSIZED.length })
      .toEqual({ pastTheBound: true, whole: false })
  })
})

describe('a refusal written before the body was read', () => {
  it('holds every one of them to the route\'s own bound', async () => {
    const reads = {
      method: await drained({ method: 'GET' }),
      crossSite: await drained({ headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }),
      notJson: await drained({ headers: { 'content-type': 'text/plain' } }),
    }
    expect(Object.entries(reads).map(([name, read]) => [name, read < DRAIN_BOUND]))
      .toEqual([['method', true], ['crossSite', true], ['notJson', true]])
  })

  it('reads a body inside the bound to its end, and answers it the same way', async () => {
    const probe = await boot()
    const refused = await post(probe.port, JSON.stringify({ callId: 'c' }), {
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    })
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown }).toEqual({
      status: 403,
      body: { error: 'content-frame: the probe route serves same-site requests only' },
    })
    await afterTheExchange()
    expect(probe.bytesRead()).toBeLessThan(DRAIN_BOUND)
  })
})
