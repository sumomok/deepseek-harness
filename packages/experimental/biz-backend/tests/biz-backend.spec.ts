/**
 * The data-backend read seam: what `ctx.bizBackend` puts on the wire, how it
 * classifies every answer, and what it never repeats back to a caller.
 *
 * `fetch` is replaced for these specs so each answer — including the ones a
 * real backend produces rarely, and the ones no backend produces at all — is
 * stated exactly. The request the service built is then read off the very
 * arguments it passed, which is the strongest available reading of "these
 * headers and no others".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  BizBackendService,
  type BizMetaResult,
  type BizSearchRequest,
  type BizSearchResult,
  type CredentialDropReason,
  type HeldCredential,
} from '../src/index.ts'

/** A JWT-shaped stand-in; nothing in this seam reads its claims. */
const TOKEN = 'aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'

/** A base carrying a deployment API prefix, which is the case a naive join loses. */
const BIZ_UPSTREAM = 'https://biz.example/ini-server/'

/** Where a read of the reference model lands under that base. */
const SEARCH_URL = 'https://biz.example/ini-server/nrms-datamanagement/api/resources/SpaceLayer/_search'

/** Where a description of the same model lands. */
const META_URL = 'https://biz.example/ini-server/nrms-schema-manage/api/meta/resclass/SpaceLayer'

/** Two rows in the shape the real backend answers with, stored and displayed. */
const RAW_ROWS = [{ int_id: '1134933624650219530', zh_label: '配送车-离线', belong_map_topic: '947543009150173184' }]
const DISPLAY_ROWS = [{ int_id: '1134933624650219530', zh_label: '配送车-离线', belong_map_topic: '公用专题' }]

/** One request the service issued. */
interface SeenRequest {
  url: string
  init: RequestInit
}

/** Answers one request; may throw to stand for a request that never completes. */
type Responder = () => Response | Promise<Response>

let seen: SeenRequest[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  seen = []
})

/**
 * Replace `fetch` with one that records every call and answers from the given
 * list, repeating its last entry once the list runs out.
 * @param responders - the answers, in call order.
 */
function serve(...responders: readonly Responder[]): void {
  let next = 0
  vi.stubGlobal('fetch', (input: unknown, init: RequestInit) => {
    seen.push({ url: String(input), init })
    const responder = responders[Math.min(next++, responders.length - 1)]
    /* v8 ignore next -- every spec that reaches fetch states at least one answer */
    if (responder === undefined) throw new Error('no answer was stated for this request')
    return (async () => responder())()
  })
}

/**
 * One JSON answer in the envelope this backend wraps everything in.
 * @param body - the document to serialize.
 * @param status - the HTTP status; 200 unless stated.
 * @returns the answer.
 */
function answer(body: unknown, status = 200): Responder {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** One answer whose body is not JSON at all. */
function textAnswer(body: string, status = 200): Responder {
  return () => new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

/** The token as this process holds it, plus a record of every drop. */
interface TestCredential extends HeldCredential {
  /** Reasons `drop` was called with, in order. */
  readonly dropped: readonly CredentialDropReason[]
}

/**
 * A held credential the specs can watch.
 * @param initial - the token held to begin with, or `undefined` for none.
 * @returns the credential.
 */
function testCredential(initial: string | undefined): TestCredential {
  let held = initial
  const dropped: CredentialDropReason[] = []
  return {
    read: () => held,
    /* v8 ignore next -- the token route is what sets one; these specs start from a held token */
    set: (token: string) => { held = token },
    drop: (reason: CredentialDropReason) => {
      dropped.push(reason)
      held = undefined
    },
    dropped,
  }
}

/**
 * A service reading the fixture upstream with the given credential.
 * @param credential - the token to spend.
 * @returns the service.
 */
function backendWith(credential: HeldCredential): BizBackendService {
  return new BizBackendService(new Context(), BIZ_UPSTREAM, credential)
}

/**
 * The JSON document one recorded request posted.
 * @param request - the recorded request.
 * @returns the decoded body.
 */
function sentBody(request: SeenRequest | undefined): unknown {
  return JSON.parse(request?.init.body as string)
}

/** A never-aborted signal, for the calls whose abort behavior is not the subject. */
function idleSignal(): AbortSignal {
  return new AbortController().signal
}

/** The bare read every spec starts from unless it states more. */
const READ: BizSearchRequest = { meta: 'SpaceLayer' }

describe('data-backend read', () => {
  it('installs itself as ctx.bizBackend and leaves with the row that made it', async () => {
    const ctx = new Context()
    await ctx.plugin({
      name: 'biz-backend-fixture',
      apply: (inner: Context) => { new BizBackendService(inner, BIZ_UPSTREAM, testCredential(TOKEN)) },
    })
    expect(ctx.get('bizBackend')).toBeInstanceOf(BizBackendService)
    // The row that constructed it is the row that owns it: disposing that
    // fiber takes the service with it, which is what lets a composition
    // withdraw the reads without restarting the process.
    await ctx.fiber.dispose()
    expect(ctx.get('bizBackend')).toBeUndefined()
  })

  it('presents the credential in both headers the backend reads it from, and identifies the browser in none', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    await backendWith(testCredential(TOKEN)).search(READ, idleSignal())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      CertificationToken: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    })
    // No cookie jar, no expansion of the browser's stored profile, and no
    // cache-busting parameter: three things the deployment's own page sends
    // that this seam deliberately does not.
    expect(seen[0]?.url).not.toContain('?')
  })

  it('builds the read under the configured API prefix rather than at the server root', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    await backendWith(testCredential(TOKEN)).search(READ, idleSignal())
    expect(seen[0]?.url).toBe(SEARCH_URL)
  })

  it('fills in every default a request leaves out', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    await backendWith(testCredential(TOKEN)).search(READ, idleSignal())
    expect(sentBody(seen[0])).toEqual({
      resclassenname: 'SpaceLayer',
      conditions: [],
      asc: null,
      desc: null,
      matchMode: 'AND',
      page: { currentPage: 1, pageSize: 200 },
    })
  })

  it('carries a fully stated request through as it stands', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    await backendWith(testCredential(TOKEN)).search({
      meta: 'SpaceLayer',
      source: ['int_id', 'zh_label'],
      conditions: [{ key: 'is_show', op: 'EQ', value: '1' }],
      matchMode: 'OR',
      page: { currentPage: 2, pageSize: 20 },
      asc: 'layer_order',
      desc: 'int_id',
    }, idleSignal())
    expect(sentBody(seen[0])).toEqual({
      resclassenname: 'SpaceLayer',
      source: ['int_id', 'zh_label'],
      conditions: [{ key: 'is_show', op: 'EQ', value: '1' }],
      asc: 'layer_order',
      desc: 'int_id',
      matchMode: 'OR',
      page: { currentPage: 2, pageSize: 20 },
    })
  })

  it('carries the caller\'s abort signal onto the request', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    const controller = new AbortController()
    await backendWith(testCredential(TOKEN)).search(READ, controller.signal)
    expect(seen[0]?.init.signal).toBe(controller.signal)
  })

  it('returns the rows twice over and the count of every page', async () => {
    serve(answer({
      code: 0,
      msg: 'success',
      data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS, page: { total: 89, currentPage: 1, pageSize: 20 } },
    }))
    expect(await backendWith(testCredential(TOKEN)).search(READ, idleSignal())).toEqual({
      rawValue: RAW_ROWS,
      displayValue: DISPLAY_ROWS,
      total: 89,
    })
  })

  it('returns the rows without a count when the answer reports none', async () => {
    for (const page of [undefined, null, {}, { total: 'many' }]) {
      seen = []
      serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS, page } }))
      const read = await backendWith(testCredential(TOKEN)).search(READ, idleSignal())
      expect(read).toEqual({ rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS })
    }
  })

  it('says whether a token is held at all, without spending it or reaching anything', async () => {
    // What a consumer asks before putting a question to a person: a read this
    // process could not perform is one nobody should be asked to allow.
    expect(backendWith(testCredential(TOKEN)).holdsCredential()).toBe(true)
    expect(backendWith(testCredential(undefined)).holdsCredential()).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('answers unauthenticated without making a request while no token is held', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    expect(await backendWith(testCredential(undefined)).search(READ, idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(0)
  })

  it('makes no request for a model name that is not one path segment', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    const backend = backendWith(testCredential(TOKEN))
    for (const meta of ['../../nrms-auth/api/renewal', 'Space/Layer', '', '1Layer']) {
      expect(await backend.search({ meta }, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: `"${meta}" is not a resource model name, so nothing was requested` })
    }
    expect(seen).toHaveLength(0)
  })

  it('bounds a model name it names back', async () => {
    serve(answer({ code: 0, data: {} }))
    const read = await backendWith(testCredential(TOKEN)).search({ meta: '/'.repeat(400) }, idleSignal())
    expect(read).toEqual({ kind: 'unreachable', detail: `"${'/'.repeat(200)}" is not a resource model name, so nothing was requested` })
  })

  it('answers rejected when the backend refuses the request, and keeps the credential', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 1, msg: '查询条件不合法' }))
    expect(await backendWith(credential).search(READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 200, code: 1, message: '查询条件不合法' })
    // A refused request is not a refused credential: this one is still held.
    expect(credential.read()).toBe(TOKEN)
    expect(credential.dropped).toEqual([])
  })

  it('bounds the message it repeats from the backend', async () => {
    serve(answer({ code: 1, msg: 'x'.repeat(400) }, 500))
    expect(await backendWith(testCredential(TOKEN)).search(READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 500, code: 1, message: 'x'.repeat(120) })
  })

  it('reports a refusal carrying no message of its own without one', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const msg of ['', 7, undefined]) {
      seen = []
      serve(answer({ code: 2, msg }))
      expect(await backend.search(READ, idleSignal())).toEqual({ kind: 'rejected', status: 200, code: 2 })
    }
  })

  it('answers refused and gives the credential up on an HTTP 401, whatever the body says', async () => {
    const credential = testCredential(TOKEN)
    // A code the refusal table does not carry, so the status alone is what
    // this drop can be attributed to.
    serve(answer({ code: 1, msg: '未授权，请登录' }, 401))
    const backend = backendWith(credential)
    expect(await backend.search(READ, idleSignal())).toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    // The drop is what the next call reads: the process stops presenting a
    // token this backend has already refused.
    expect(credential.read()).toBeUndefined()
    expect(await backend.search(READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(1)
  })

  it('answers rejected and keeps the credential on an HTTP 403', async () => {
    // The deployment's own client answers this one with 拒绝访问 and leaves the
    // stored token alone: one endpoint this visitor may not reach is not a
    // credential the backend has stopped accepting.
    const credential = testCredential(TOKEN)
    serve(answer({ code: 1, msg: '拒绝访问' }, 403))
    const backend = backendWith(credential)
    expect(await backend.search(READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 403, code: 1, message: '拒绝访问' })
    expect(credential.dropped).toEqual([])
    expect(credential.read()).toBe(TOKEN)
    // The next call spends it again rather than answering that none is held.
    expect(await backend.search(READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 403, code: 1, message: '拒绝访问' })
    expect(seen).toHaveLength(2)
  })

  it('answers refused and gives the credential up on a failing status carrying a credential code', async () => {
    // The deployment's own client drops the stored token on these two codes
    // from its error interceptor only, so the status has to have failed too —
    // and a 403 carrying one of them is the one route by which that status
    // gives the credential up.
    for (const [code, status] of [[2, 500], [3, 500], [3, 403]] as const) {
      seen = []
      const credential = testCredential(TOKEN)
      serve(answer({ code, msg: 'token invalid' }, status))
      const backend = backendWith(credential)
      expect(await backend.search(READ, idleSignal())).toEqual({ kind: 'refused', status })
      expect(credential.dropped).toEqual(['refused-by-backend'])
      expect(credential.read()).toBeUndefined()
      expect(await backend.search(READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    }
  })

  it('keeps the credential when the same code arrives on an answer the backend called successful', async () => {
    for (const code of [2, 3]) {
      seen = []
      const credential = testCredential(TOKEN)
      serve(answer({ code, msg: 'token invalid' }))
      expect(await backendWith(credential).search(READ, idleSignal()))
        .toEqual({ kind: 'rejected', status: 200, code, message: 'token invalid' })
      expect(credential.dropped).toEqual([])
      expect(credential.read()).toBe(TOKEN)
    }
  })

  it('answers unreachable when the request never completes', async () => {
    serve(() => { throw new Error('connect ECONNREFUSED') })
    expect(await backendWith(testCredential(TOKEN)).search(READ, idleSignal()))
      .toEqual({ kind: 'unreachable', detail: 'Error: connect ECONNREFUSED' })
  })

  it('bounds the detail it repeats from a failed request', async () => {
    serve(() => Promise.reject(new Error('x'.repeat(400))))
    expect(await backendWith(testCredential(TOKEN)).search(READ, idleSignal()))
      .toEqual({ kind: 'unreachable', detail: `Error: ${'x'.repeat(193)}` })
  })

  it('answers unreachable when the answer cannot be read', async () => {
    serve(() => new Response(
      new ReadableStream({ start: (controller) => { controller.error(new Error('stream closed')) } }),
      { status: 200 },
    ))
    const read = await backendWith(testCredential(TOKEN)).search(READ, idleSignal())
    expect(read).toMatchObject({ kind: 'unreachable' })
  })

  it('answers unreachable when the answer is not this backend\'s envelope', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const [body, status] of [
      ['<html>gateway timeout</html>', 504],
      ['"a string"', 200],
      ['null', 200],
      ['{"code":"zero"}', 200],
    ] as const) {
      seen = []
      serve(textAnswer(body, status))
      expect(await backend.search(READ, idleSignal())).toEqual({
        kind: 'unreachable',
        detail: `the HTTP ${String(status)} answer was not this backend's envelope`,
      })
    }
  })

  it('answers unreachable when the accepted answer carries no rows', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [
      null,
      'rows',
      { rawValue: 'rows', displayValue: [] },
      { rawValue: [], displayValue: 'rows' },
      { rawValue: [null], displayValue: [] },
      { rawValue: ['a row'], displayValue: [] },
    ]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.search(READ, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer carried no rows to read' })
    }
  })

  it('never repeats the credential in anything it returns', async () => {
    const answers: (BizSearchResult | BizMetaResult | object)[] = []
    for (const responder of [
      answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }),
      answer({ code: 1, msg: `rejected for ${TOKEN}` }),
      answer({ code: 0 }, 401),
      textAnswer('not json'),
      (): Response => { throw new Error(`failed for ${TOKEN}`) },
    ]) {
      seen = []
      serve(responder)
      answers.push(await backendWith(testCredential(TOKEN)).search(READ, idleSignal()))
    }
    // The backend echoing a credential back is exactly what a message bound
    // cannot be trusted to cut, so the whole set is checked rather than each.
    for (const returned of answers) expect(JSON.stringify(returned)).not.toContain('eyJzdWIi')
  })
})

describe('auth-gate data-backend model description', () => {
  it('reads both names of every attribute the model declares', async () => {
    serve(answer({
      code: 0,
      data: {
        resClassEnName: 'SpaceLayer',
        resClassCnName: '图层配置',
        attributes: [
          { attributeEnName: 'int_id', attributeCnName: '唯一标识', dataType: 'long', dispIndex: 0 },
          { attributeEnName: 'zh_label', attributeCnName: '名称', dataType: 'string', dispIndex: 1 },
        ],
      },
    }))
    expect(await backendWith(testCredential(TOKEN)).describe('SpaceLayer', idleSignal())).toEqual({
      attributes: [
        { attributeEnName: 'int_id', attributeCnName: '唯一标识' },
        { attributeEnName: 'zh_label', attributeCnName: '名称' },
      ],
    })
    expect(seen[0]?.url).toBe(META_URL)
    expect(seen[0]?.init.method).toBe('GET')
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      CertificationToken: `Bearer ${TOKEN}`,
    })
  })

  it('leaves out an element that carries neither name', async () => {
    serve(answer({
      code: 0,
      data: {
        attributes: [
          null,
          'int_id',
          { attributeEnName: 'int_id' },
          { attributeEnName: 7, attributeCnName: '唯一标识' },
          { attributeEnName: 'zh_label', attributeCnName: '名称' },
        ],
      },
    }))
    expect(await backendWith(testCredential(TOKEN)).describe('SpaceLayer', idleSignal()))
      .toEqual({ attributes: [{ attributeEnName: 'zh_label', attributeCnName: '名称' }] })
  })

  it('answers unreachable when the accepted answer lists no attributes', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [null, 'attributes', {}, { attributes: 'int_id' }]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.describe('SpaceLayer', idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer listed no attributes' })
    }
  })

  it('classifies its failures exactly as a read does', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).describe('SpaceLayer', idleSignal()))
      .toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    expect(await backendWith(testCredential(undefined)).describe('SpaceLayer', idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    expect(await backendWith(testCredential(TOKEN)).describe('Space Layer', idleSignal()))
      .toEqual({ kind: 'unreachable', detail: '"Space Layer" is not a resource model name, so nothing was requested' })
  })
})
