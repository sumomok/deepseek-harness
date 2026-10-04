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

import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  BIZ_OPERATIONS,
  BizBackendService,
  BizOperationRules,
  requireBizOperationRules,
  type BizBackendFailure,
  type BizMetaResult,
  type BizOperation,
  type BizSubject,
  type BizUserRights,
  type BizSearchRequest,
  type BizSearchResult,
  type CredentialDropReason,
  type CredentialResolver,
  type HeldCredential,
  type PrincipalKey,
} from '../src/index.ts'

/** The rule table a deployment that writes none gets. */
const DEFAULT_RULES = BizOperationRules({})

/** A JWT-shaped stand-in; nothing in this seam reads its claims. */
const TOKEN = 'aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'

/** A base carrying a deployment API prefix, which is the case a naive join loses. */
const BIZ_UPSTREAM = 'https://biz.example/ini-server/'

/** Where a read of the reference model lands under that base. */
const SEARCH_URL = 'https://biz.example/ini-server/nrms-datamanagement/api/resources/SpaceLayer/_search'

/** Where a description of the same model lands. */
const META_URL = 'https://biz.example/ini-server/nrms-schema-manage/api/meta/resclass/SpaceLayer'

/** Where a read of the same model's default query scheme lands, query string included. */
const SCHEME_URL = 'https://biz.example/ini-server/nrms-schema-manage/api/schema/schema'
  + '?schemaType=1&metaEnName=SpaceLayer&schemaName=&isDefault=1'

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

/** The subject every spec that is not about subjects reads for: a tool call's session. */
const SUBJECT: BizSubject = { kind: 'session', sessionId: SessionId('session-1') }

/**
 * A resolver handing every subject the one slot a single-person process holds.
 * @param credential - that slot.
 * @returns the resolver.
 */
function soleSlot(credential: HeldCredential): CredentialResolver {
  return { resolve: () => credential, principalOfRequest: () => brandString<PrincipalKey>('sole-visitor') }
}

/**
 * A service reading the fixture upstream with the given credential.
 * @param credential - the token to spend, held as the one slot every subject resolves to.
 * @returns the service.
 */
function backendWith(credential: HeldCredential): BizBackendService {
  return new BizBackendService(new Context(), BIZ_UPSTREAM, soleSlot(credential), DEFAULT_RULES)
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
      apply: (inner: Context) => { new BizBackendService(inner, BIZ_UPSTREAM, soleSlot(testCredential(TOKEN)), DEFAULT_RULES) },
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
    await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())
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
    await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())
    expect(seen[0]?.url).toBe(SEARCH_URL)
  })

  it('fills in every default a request leaves out', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())
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
    await backendWith(testCredential(TOKEN)).search(SUBJECT, {
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
    await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, controller.signal)
    expect(seen[0]?.init.signal).toBe(controller.signal)
  })

  it('returns the rows twice over and the count of every page', async () => {
    serve(answer({
      code: 0,
      msg: 'success',
      data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS, page: { total: 89, currentPage: 1, pageSize: 20 } },
    }))
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())).toEqual({
      rawValue: RAW_ROWS,
      displayValue: DISPLAY_ROWS,
      total: 89,
    })
  })

  it('returns the rows without a count when the answer reports none', async () => {
    for (const page of [undefined, null, {}, { total: 'many' }]) {
      seen = []
      serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS, page } }))
      const read = await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())
      expect(read).toEqual({ rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS })
    }
  })

  it('says whether a token is held at all, without spending it or reaching anything', async () => {
    // What a consumer asks before putting a question to a person: a read this
    // process could not perform is one nobody should be asked to allow.
    expect(backendWith(testCredential(TOKEN)).holdsCredential(SUBJECT)).toBe(true)
    expect(backendWith(testCredential(undefined)).holdsCredential(SUBJECT)).toBe(false)
    expect(seen).toHaveLength(0)
  })

  it('answers unauthenticated without making a request while no token is held', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    expect(await backendWith(testCredential(undefined)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(0)
  })

  it('makes no request for a model name that is not one path segment', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [] } }))
    const backend = backendWith(testCredential(TOKEN))
    for (const meta of ['../../nrms-auth/api/renewal', 'Space/Layer', '', '1Layer']) {
      expect(await backend.search(SUBJECT, { meta }, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: `"${meta}" is not a resource model name, so nothing was requested` })
    }
    expect(seen).toHaveLength(0)
  })

  it('bounds a model name it names back', async () => {
    serve(answer({ code: 0, data: {} }))
    const read = await backendWith(testCredential(TOKEN)).search(SUBJECT, { meta: '/'.repeat(400) }, idleSignal())
    expect(read).toEqual({ kind: 'unreachable', detail: `"${'/'.repeat(200)}" is not a resource model name, so nothing was requested` })
  })

  it('answers rejected when the backend refuses the request, and keeps the credential', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 1, msg: '查询条件不合法' }))
    expect(await backendWith(credential).search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 200, code: 1, message: '查询条件不合法' })
    // A refused request is not a refused credential: this one is still held.
    expect(credential.read()).toBe(TOKEN)
    expect(credential.dropped).toEqual([])
  })

  it('bounds the message it repeats from the backend', async () => {
    serve(answer({ code: 1, msg: 'x'.repeat(400) }, 500))
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 500, code: 1, message: 'x'.repeat(120) })
  })

  it('reports a refusal carrying no message of its own without one', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const msg of ['', 7, undefined]) {
      seen = []
      serve(answer({ code: 2, msg }))
      expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({ kind: 'rejected', status: 200, code: 2 })
    }
  })

  it('answers refused and gives the credential up on an HTTP 401, whatever the body says', async () => {
    const credential = testCredential(TOKEN)
    // A code the refusal table does not carry, so the status alone is what
    // this drop can be attributed to.
    serve(answer({ code: 1, msg: '未授权，请登录' }, 401))
    const backend = backendWith(credential)
    expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    // The drop is what the next call reads: the process stops presenting a
    // token this backend has already refused.
    expect(credential.read()).toBeUndefined()
    expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(1)
  })

  it('answers rejected and keeps the credential on an HTTP 403', async () => {
    // The deployment's own client answers this one with 拒绝访问 and leaves the
    // stored token alone: one endpoint this visitor may not reach is not a
    // credential the backend has stopped accepting.
    const credential = testCredential(TOKEN)
    serve(answer({ code: 1, msg: '拒绝访问' }, 403))
    const backend = backendWith(credential)
    expect(await backend.search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'rejected', status: 403, code: 1, message: '拒绝访问' })
    expect(credential.dropped).toEqual([])
    expect(credential.read()).toBe(TOKEN)
    // The next call spends it again rather than answering that none is held.
    expect(await backend.search(SUBJECT, READ, idleSignal()))
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
      expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({ kind: 'refused', status })
      expect(credential.dropped).toEqual(['refused-by-backend'])
      expect(credential.read()).toBeUndefined()
      expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    }
  })

  it('keeps the credential when the same code arrives on an answer the backend called successful', async () => {
    for (const code of [2, 3]) {
      seen = []
      const credential = testCredential(TOKEN)
      serve(answer({ code, msg: 'token invalid' }))
      expect(await backendWith(credential).search(SUBJECT, READ, idleSignal()))
        .toEqual({ kind: 'rejected', status: 200, code, message: 'token invalid' })
      expect(credential.dropped).toEqual([])
      expect(credential.read()).toBe(TOKEN)
    }
  })

  it('answers unreachable when the request never completes', async () => {
    serve(() => { throw new Error('connect ECONNREFUSED') })
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'unreachable', detail: 'Error: connect ECONNREFUSED' })
  })

  it('bounds the detail it repeats from a failed request', async () => {
    serve(() => Promise.reject(new Error('x'.repeat(400))))
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ kind: 'unreachable', detail: `Error: ${'x'.repeat(193)}` })
  })

  it('answers unreachable when the answer cannot be read', async () => {
    serve(() => new Response(
      new ReadableStream({ start: (controller) => { controller.error(new Error('stream closed')) } }),
      { status: 200 },
    ))
    const read = await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal())
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
      expect(await backend.search(SUBJECT, READ, idleSignal())).toEqual({
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
      [],
      { rawValue: 'rows', displayValue: [] },
      { rawValue: [], displayValue: 'rows' },
      { rawValue: [null], displayValue: [] },
      { rawValue: ['a row'], displayValue: [] },
      { rawValue: [], displayValue: null },
      { rawValue: null, displayValue: [] },
      // Neither key at all is an envelope this backend has never been seen
      // answering with, so it stays an answer this seam cannot read rather
      // than being reported as a row count nothing measured.
      {},
      { page: { total: null } },
    ]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.search(SUBJECT, READ, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer carried no rows to read' })
    }
  })

  it('answers zero rows for the answer this backend gives a read that matched nothing', async () => {
    // Measured against the deployment: conditions matching no row answer HTTP
    // 200 with both row lists null and a null total beside them, not two empty
    // lists. Reading that as an unparseable answer tells a caller its data
    // source is broken when its filters simply matched nothing.
    serve(answer({
      code: 0,
      msg: 'success',
      data: { rawValue: null, displayValue: null, page: { currentPage: 1, pageSize: 200, total: null, pageCount: null } },
    }))
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ rawValue: [], displayValue: [], total: 0 })
  })

  it('keeps two empty lists as zero rows, with whatever total the answer carried', async () => {
    serve(answer({ code: 0, data: { rawValue: [], displayValue: [], page: { total: 0 } } }))
    expect(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
      .toEqual({ rawValue: [], displayValue: [], total: 0 })
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
      answers.push(await backendWith(testCredential(TOKEN)).search(SUBJECT, READ, idleSignal()))
    }
    // The backend echoing a credential back is exactly what a message bound
    // cannot be trusted to cut, so the whole set is checked rather than each.
    for (const returned of answers) expect(JSON.stringify(returned)).not.toContain('eyJzdWIi')
  })
})

describe('the subject a read is performed for', () => {
  /** A second person's token, distinct from {@link TOKEN}. */
  const OTHER_TOKEN = 'b3RoZXI.eyJzdWIiOiJ1LTIifQ.c2ln'

  /** The two subjects these cases tell apart: a tool call's session and a browser request's person. */
  const SESSION: BizSubject = { kind: 'session', sessionId: SessionId('session-of-a') }
  const PERSON: BizSubject = { kind: 'principal', principal: brandString<PrincipalKey>('person-b') }

  /** What one resolver was asked, in order. */
  interface Asked {
    readonly subjects: BizSubject[]
  }

  /**
   * A resolver giving each subject kind its own slot, or none where the case states none.
   * @param slots - the slot each subject kind resolves to.
   * @returns the resolver and what it was asked.
   */
  function bySubject(slots: { readonly session?: HeldCredential; readonly principal?: HeldCredential }): CredentialResolver & Asked {
    const subjects: BizSubject[] = []
    return {
      subjects,
      resolve: (subject) => {
        subjects.push(subject)
        return slots[subject.kind]
      },
      principalOfRequest: () => undefined,
    }
  }

  /**
   * A service reading the fixture upstream through one resolver.
   * @param resolver - where each read finds its slot.
   * @returns the service.
   */
  function backendThrough(resolver: CredentialResolver): BizBackendService {
    return new BizBackendService(new Context(), BIZ_UPSTREAM, resolver, DEFAULT_RULES)
  }

  /**
   * The bearer value one recorded request presented.
   * @param request - the recorded request.
   * @returns the `authorization` header it carried.
   */
  function presented(request: SeenRequest | undefined): unknown {
    return (request?.init.headers as Record<string, string> | undefined)?.authorization
  }

  it('spends the one slot a single-person process holds, whichever subject a read names', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    const backend = backendWith(testCredential(TOKEN))
    for (const subject of [SESSION, PERSON]) {
      expect(backend.holdsCredential(subject)).toBe(true)
      expect(await backend.search(subject, READ, idleSignal())).toEqual({ rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS })
    }
    expect(seen.map(presented)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])
  })

  it('asks the resolver about the subject the read names, once per read', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    const resolver = bySubject({ session: testCredential(TOKEN) })
    await backendThrough(resolver).search(SESSION, READ, idleSignal())
    expect(resolver.subjects).toEqual([SESSION])
  })

  it('answers unauthenticated for a subject the resolver holds no slot for, and presents nobody else\'s token', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    const held = testCredential(TOKEN)
    const backend = backendThrough(bySubject({ session: held }))
    expect(backend.holdsCredential(PERSON)).toBe(false)
    expect(await backend.search(PERSON, READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(await backend.describe(PERSON, 'SpaceLayer', idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(await backend.listModels(PERSON, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(await backend.userRights(PERSON, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(0)
    // The slot another subject resolves to is left exactly as it was.
    expect(held.read()).toBe(TOKEN)
    expect(held.dropped).toEqual([])
  })

  it('answers unauthenticated for a subject whose own slot is empty, with another slot still holding a token', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    const backend = backendThrough(bySubject({ session: testCredential(TOKEN), principal: testCredential(undefined) }))
    expect(backend.holdsCredential(PERSON)).toBe(false)
    expect(await backend.search(PERSON, READ, idleSignal())).toEqual({ kind: 'unauthenticated' })
    expect(seen).toHaveLength(0)
  })

  it('spends each subject\'s own token', async () => {
    serve(answer({ code: 0, data: { rawValue: RAW_ROWS, displayValue: DISPLAY_ROWS } }))
    const backend = backendThrough(bySubject({ session: testCredential(TOKEN), principal: testCredential(OTHER_TOKEN) }))
    await backend.search(SESSION, READ, idleSignal())
    await backend.search(PERSON, READ, idleSignal())
    expect(seen.map(presented)).toEqual([`Bearer ${TOKEN}`, `Bearer ${OTHER_TOKEN}`])
  })

  it('drops only the slot the refused read resolved to, on either refusal', async () => {
    for (const refusal of [answer({ code: 1 }, 401), answer({ code: 3 }, 500)]) {
      seen = []
      serve(refusal)
      const mine = testCredential(TOKEN)
      const theirs = testCredential(OTHER_TOKEN)
      const backend = backendThrough(bySubject({ session: mine, principal: theirs }))
      expect(await backend.search(SESSION, READ, idleSignal())).toMatchObject({ kind: 'refused' })
      expect(mine.dropped).toEqual(['refused-by-backend'])
      expect(theirs.dropped).toEqual([])
      expect(theirs.read()).toBe(OTHER_TOKEN)
      expect(backend.holdsCredential(PERSON)).toBe(true)
    }
  })

  it('drops the slot the read spent, even when the subject would resolve elsewhere by the time the answer arrives', async () => {
    serve(answer({ code: 1 }, 401))
    const spent = testCredential(TOKEN)
    const later = testCredential(OTHER_TOKEN)
    let resolved = 0
    const backend = backendThrough({
      resolve: () => (resolved++ === 0 ? spent : later),
      principalOfRequest: () => undefined,
    })
    expect(await backend.userRights(SESSION, idleSignal())).toEqual({ kind: 'refused', status: 401 })
    expect(spent.dropped).toEqual(['refused-by-backend'])
    expect(later.dropped).toEqual([])
  })

  it('names a browser request\'s subject by the person the resolver admits it as, and names none it admits nobody for', () => {
    const request = new IncomingMessage(new Socket())
    const asked: IncomingMessage[] = []
    const person = brandString<PrincipalKey>('person-b')
    const admitting = backendThrough({
      resolve: () => undefined,
      principalOfRequest: (req) => {
        asked.push(req)
        return person
      },
    })
    expect(admitting.subjectOfRequest(request)).toEqual({ kind: 'principal', principal: person })
    expect(asked).toEqual([request])
    expect(backendThrough(bySubject({})).subjectOfRequest(request)).toBeUndefined()
    expect(seen).toHaveLength(0)
  })
})

describe('auth-gate data-backend model description', () => {
  it('reads both names and the stored type of every attribute the model declares', async () => {
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
    expect(await backendWith(testCredential(TOKEN)).describe(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({
      attributes: [
        { attributeEnName: 'int_id', attributeCnName: '唯一标识', dataType: 'long' },
        { attributeEnName: 'zh_label', attributeCnName: '名称', dataType: 'string' },
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
    expect(await backendWith(testCredential(TOKEN)).describe(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ attributes: [{ attributeEnName: 'zh_label', attributeCnName: '名称' }] })
  })

  it('answers unreachable when the accepted answer lists no attributes', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [null, 'attributes', {}, { attributes: 'int_id' }]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.describe(SUBJECT, 'SpaceLayer', idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer listed no attributes' })
    }
  })

  it('classifies its failures exactly as a read does', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).describe(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    expect(await backendWith(testCredential(undefined)).describe(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    expect(await backendWith(testCredential(TOKEN)).describe(SUBJECT, 'Space Layer', idleSignal()))
      .toEqual({ kind: 'unreachable', detail: '"Space Layer" is not a resource model name, so nothing was requested' })
  })
})

describe('auth-gate data-backend default query scheme', () => {
  /**
   * One stored scheme, as the schema service wraps it.
   * @param gridItems - the scheme's column list.
   * @returns the answer.
   */
  function schemeAnswer(gridItems: unknown): Responder {
    return answer({ code: 0, msg: 'success', data: [{ schemaId: 'sc-1', schemaType: 1, grid: { gridItems } }] })
  }

  it('asks the schema service for the one default scheme of the resource-list kind', async () => {
    serve(schemeAnswer([{ relatedMetaAttr: 'zh_label', alias: '名称' }]))
    expect(await backendWith(testCredential(TOKEN)).describeScheme(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ columns: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] })
    expect(seen[0]?.url).toBe(SCHEME_URL)
    expect(seen[0]?.init.method).toBe('GET')
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      CertificationToken: `Bearer ${TOKEN}`,
    })
  })

  it('reads both ways this backend writes a scheme column\'s yes-or-no fields', async () => {
    serve(schemeAnswer([
      { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '0' },
      { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: true, isSortable: false },
      { relatedMetaAttr: 'belong_scene', alias: '所属场景', isShow: 'yes', isSortable: 2 },
    ]))
    expect(await backendWith(testCredential(TOKEN)).describeScheme(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({
      columns: [
        { relatedMetaAttr: 'zh_label', alias: '名称', isShow: true, isSortable: false },
        { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: true, isSortable: false },
        // Neither reading, so neither field is published and a caller reads the
        // column as one the scheme said nothing about.
        { relatedMetaAttr: 'belong_scene', alias: '所属场景' },
      ],
    })
  })

  it('leaves out an element naming no attribute, and a header that is not one', async () => {
    serve(schemeAnswer([
      null,
      'zh_label',
      { alias: '名称' },
      { relatedMetaAttr: '' },
      { relatedMetaAttr: 7, alias: '名称' },
      { relatedMetaAttr: 'layer_id', alias: '' },
      { relatedMetaAttr: 'belong_scene', alias: 41 },
    ]))
    expect(await backendWith(testCredential(TOKEN)).describeScheme(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ columns: [{ relatedMetaAttr: 'layer_id' }, { relatedMetaAttr: 'belong_scene' }] })
  })

  it('answers unreachable when the answer carries no scheme with columns in it', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [
      null,
      'a scheme',
      [],
      [null],
      ['a scheme'],
      [{ schemaId: 'sc-1' }],
      [{ grid: 'gridItems' }],
      [{ grid: {} }],
      [{ grid: { gridItems: 'zh_label' } }],
      // A list of columns none of which names an attribute leaves a caller
      // with nothing to draw, which is what having no scheme means to it.
      [{ grid: { gridItems: [null, { alias: '名称' }] } }],
    ]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.describeScheme(SUBJECT, 'SpaceLayer', idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the model has no default query scheme' })
    }
  })

  it('classifies its failures exactly as the other two reads do', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).describeScheme(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    expect(await backendWith(testCredential(undefined)).describeScheme(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    expect(await backendWith(testCredential(TOKEN)).describeScheme(SUBJECT, 'Space Layer', idleSignal()))
      .toEqual({ kind: 'unreachable', detail: '"Space Layer" is not a resource model name, so nothing was requested' })
  })
})

describe('the deployment\'s own catalog of resource models', () => {
  it('asks for the stored resource kind and keeps only the fields this seam publishes', async () => {
    serve(answer({
      code: 0,
      data: [{
        resClassEnName: 'SpaceLayer',
        resClassCnName: '空间图层',
        classDiagramType: 'TRANSO',
        classDiagramTypeCnName: '传输专业',
        dsTableName: 'SPACE_LAYER',
        parentClassEnName: 'ResBase',
        remark: '图层配置',
        resClassDescription: '更长的说明',
        // Everything below arrives attached and is dropped at the read.
        attributes: [{ attributeEnName: 'zh_label' }],
        attributeObjMap: { zh_label: {} },
        metaOperationMap: {},
        metaSchemaMap: {},
      }],
    }))
    expect(await backendWith(testCredential(TOKEN)).listModels(SUBJECT, idleSignal())).toEqual({
      models: [{
        resClassEnName: 'SpaceLayer',
        resClassCnName: '空间图层',
        classDiagramType: 'TRANSO',
        classDiagramTypeCnName: '传输专业',
        dsTableName: 'SPACE_LAYER',
        parentClassEnName: 'ResBase',
        remark: '图层配置',
        resClassDescription: '更长的说明',
      }],
    })
    expect(seen[0]?.url).toBe(
      'https://biz.example/ini-server/nrms-schema-manage/api/meta/resclassname?resClassCnName=&resClassType=1')
    expect(seen[0]?.init.method).toBe('GET')
    expect(seen[0]?.init.headers).toEqual({
      accept: 'application/json',
      authorization: `Bearer ${TOKEN}`,
      CertificationToken: `Bearer ${TOKEN}`,
    })
  })

  it('leaves out an entry naming no model, and publishes an unnamed model with an empty shown name', async () => {
    serve(answer({
      code: 0,
      data: [null, 'SpaceLayer', {}, { resClassEnName: '' }, { resClassEnName: 'SITE' }, { resClassEnName: 'CITY', resClassCnName: 7 }],
    }))
    expect(await backendWith(testCredential(TOKEN)).listModels(SUBJECT, idleSignal())).toEqual({
      models: [{ resClassEnName: 'SITE', resClassCnName: '' }, { resClassEnName: 'CITY', resClassCnName: '' }],
    })
  })

  it('reads a catalog of no models as an answer rather than as a failure', async () => {
    serve(answer({ code: 0, data: [] }))
    expect(await backendWith(testCredential(TOKEN)).listModels(SUBJECT, idleSignal())).toEqual({ models: [] })
  })

  it('answers unreachable when the payload is not a catalog at all', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [null, 'SpaceLayer', { models: [] }]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.listModels(SUBJECT, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer listed no resource models' })
    }
  })

  it('classifies its failures exactly as the model reads do', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).listModels(SUBJECT, idleSignal())).toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    expect(await backendWith(testCredential(undefined)).listModels(SUBJECT, idleSignal())).toEqual({ kind: 'unauthenticated' })
  })
})

describe('one model\'s stored default schemes', () => {
  it('always names the model, and reads the forms and the table out of every scheme', async () => {
    serve(answer({
      code: 0,
      data: [{
        schemaType: 2,
        form: [
          { formType: 'base', formItems: [
            { relatedMetaAttr: 'zh_label', alias: '名称', isRequired: '1', isEditable: true, isShow: '1' },
            { relatedMetaAttr: 'state', relatedDict: [{ key: '1', value: '在用' }, { key: 0, value: '停用' }] },
          ] },
          { formType: 'extra', formItems: [{ relatedMetaAttr: 'city_id', relatedTrans: { relatedMeta: 'CITY' } }] },
        ],
        grid: { gridItems: [{ relatedMetaAttr: 'zh_label', isShow: '1' }] },
      }],
    }))
    expect(await backendWith(testCredential(TOKEN)).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({
      schemes: [{
        schemaType: 2,
        formItems: [
          { relatedMetaAttr: 'zh_label', alias: '名称', isRequired: true, isEditable: true, isShow: true },
          { relatedMetaAttr: 'state', relatedDict: [{ key: '1', value: '在用' }, { key: '0', value: '停用' }] },
          { relatedMetaAttr: 'city_id', relatedMeta: 'CITY' },
        ],
        columns: [{ relatedMetaAttr: 'zh_label', isShow: true }],
      }],
    })
    expect(seen[0]?.url).toBe('https://biz.example/ini-server/nrms-schema-manage/api/schema/schema'
      + '?schemaType=&metaEnName=SpaceLayer&schemaName=&isDefault=1')
  })

  it('leaves out what it cannot read, from a scheme with no kind down to a value with no text', async () => {
    serve(answer({
      code: 0,
      data: [
        null,
        'a scheme',
        { form: [] },
        { schemaType: '2' },
        { schemaType: 3, form: 'base', grid: {} },
        {
          schemaType: 1,
          form: [null, 'a group', { formItems: 'zh_label' }, { formItems: [
            null,
            { alias: '名称' },
            { relatedMetaAttr: '' },
            { relatedMetaAttr: 'zh_label', relatedDict: [null, { key: 'a' }, { value: '在用' }, { key: true, value: '停用' }] },
            { relatedMetaAttr: 'city_id', relatedTrans: 'CITY' },
            { relatedMetaAttr: 'state', relatedTrans: { relatedMeta: '' } },
          ] }],
          grid: 'gridItems',
        },
      ],
    }))
    expect(await backendWith(testCredential(TOKEN)).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({
      schemes: [
        { schemaType: 3, formItems: [], columns: [] },
        {
          schemaType: 1,
          formItems: [{ relatedMetaAttr: 'zh_label' }, { relatedMetaAttr: 'city_id' }, { relatedMetaAttr: 'state' }],
          columns: [],
        },
      ],
    })
  })

  it('reads a model with no stored scheme as an answer rather than as a failure', async () => {
    serve(answer({ code: 0, data: [] }))
    expect(await backendWith(testCredential(TOKEN)).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({ schemes: [] })
  })

  it('answers unreachable when the payload is not a scheme list, and refuses a name that is not one segment', async () => {
    serve(answer({ code: 0, data: { schemes: [] } }))
    expect(await backendWith(testCredential(TOKEN)).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'unreachable', detail: 'the answer listed no schemes' })
    expect(await backendWith(testCredential(TOKEN)).describeSchemes(SUBJECT, '../secret', idleSignal()))
      .toEqual({ kind: 'unreachable', detail: '"../secret" is not a resource model name, so nothing was requested' })
    expect(await backendWith(testCredential(undefined)).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'unauthenticated' })
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).describeSchemes(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
  })
})

describe('the signed-in person\'s own rights', () => {
  it('reads the two rights tables and copies no part of the profile beside them', async () => {
    serve(answer({
      code: 0,
      data: {
        useraccount: 'zhangsan',
        name: '张三',
        empid: '10086',
        mobile: '13900000000',
        mail: 'zhangsan@example.com',
        phoneNumber: '0531-00000000',
        auth: {
          resclass: [{
            resclassenname: 'SpaceLayer',
            search: true,
            add: true,
            update: null,
            delete: null,
            gridexp: '1',
            columns: 'zh_label,layer_id',
          }],
          rows: [{ resourceName: 'city_id', resourceValue: '531,532' }],
        },
      },
    }))
    const rights = await backendWith(testCredential(TOKEN)).userRights(SUBJECT, idleSignal())
    expect(rights).toEqual({
      resclass: [{ resclassenname: 'SpaceLayer', operations: ['add', 'gridexp', 'search'], columns: 'zh_label,layer_id' }],
      rows: [{ resourceName: 'city_id', resourceValue: '531,532' }],
    })
    // The strongest available reading of "the profile never leaves this seam":
    // none of the five personal fields appears anywhere in what was published.
    const published = JSON.stringify(rights)
    for (const personal of ['zhangsan', '张三', '10086', '13900000000', 'example.com', '0531']) {
      expect(published).not.toContain(personal)
    }
    expect(seen[0]?.url).toBe('https://biz.example/ini-server/nrms-auth/api/auth/userinfo')
    expect(seen[0]?.init.method).toBe('GET')
  })

  it('reads a row granting nothing, and leaves out a row naming no model or a narrowing missing a half', async () => {
    serve(answer({
      code: 0,
      data: {
        auth: {
          resclass: [null, 'SpaceLayer', { search: true }, { resclassenname: 'SITE' }],
          rows: [null, { resourceName: 'city_id' }, { resourceValue: '531' }, { resourceName: '', resourceValue: '531' }],
        },
      },
    }))
    expect(await backendWith(testCredential(TOKEN)).userRights(SUBJECT, idleSignal()))
      .toEqual({ resclass: [{ resclassenname: 'SITE', operations: [] }], rows: [] })
  })

  it('reads tables this deployment states as something other than lists as empty ones', async () => {
    serve(answer({ code: 0, data: { auth: { resclass: 'SpaceLayer' } } }))
    expect(await backendWith(testCredential(TOKEN)).userRights(SUBJECT, idleSignal()))
      .toEqual({ resclass: [], rows: [] })
  })

  it('answers unreachable when the answer carries no rights table at all', async () => {
    const backend = backendWith(testCredential(TOKEN))
    for (const data of [null, 'auth', { useraccount: 'zhangsan' }, { auth: null }, { auth: 'resclass' }]) {
      seen = []
      serve(answer({ code: 0, data }))
      expect(await backend.userRights(SUBJECT, idleSignal()))
        .toEqual({ kind: 'unreachable', detail: 'the answer carried no rights table' })
    }
  })

  it('classifies its failures exactly as the model reads do', async () => {
    const credential = testCredential(TOKEN)
    serve(answer({ code: 0 }, 401))
    expect(await backendWith(credential).userRights(SUBJECT, idleSignal())).toEqual({ kind: 'refused', status: 401 })
    expect(credential.dropped).toEqual(['refused-by-backend'])
    expect(await backendWith(testCredential(undefined)).userRights(SUBJECT, idleSignal())).toEqual({ kind: 'unauthenticated' })
    serve(textAnswer('<html>gateway</html>', 502))
    expect(await backendWith(testCredential(TOKEN)).userRights(SUBJECT, idleSignal()))
      .toEqual({ kind: 'unreachable', detail: 'the HTTP 502 answer was not this backend\'s envelope' })
  })
})

describe('what a model description states about one attribute', () => {
  it('publishes the stored type, the bounds and the two notes beside the two names', async () => {
    serve(answer({
      code: 0,
      data: {
        attributes: [{
          attributeEnName: 'zh_label',
          attributeCnName: '名称',
          dataType: 'VARCHAR',
          dataLength: 128,
          isNull: '0',
          isPrimaryKey: false,
          defaultValue: '未命名',
          attrGrpName: '基本信息',
          remark: '图层显示名',
          // Fields this seam never reads.
          isSearchAttr: '1',
          showAsPass: '0',
          dispIndex: 3,
        }],
      },
    }))
    expect(await backendWith(testCredential(TOKEN)).describe(SUBJECT, 'SpaceLayer', idleSignal())).toEqual({
      attributes: [{
        attributeEnName: 'zh_label',
        attributeCnName: '名称',
        dataType: 'VARCHAR',
        dataLength: 128,
        isNull: false,
        isPrimaryKey: false,
        defaultValue: '未命名',
        attrGrpName: '基本信息',
        remark: '图层显示名',
      }],
    })
  })

  it('publishes a field written neither way this backend writes it as unstated', async () => {
    serve(answer({
      code: 0,
      data: {
        attributes: [{
          attributeEnName: 'zh_label',
          attributeCnName: '名称',
          dataType: '',
          dataLength: '128',
          isNull: 1,
          isPrimaryKey: 'yes',
        }],
      },
    }))
    expect(await backendWith(testCredential(TOKEN)).describe(SUBJECT, 'SpaceLayer', idleSignal()))
      .toEqual({ attributes: [{ attributeEnName: 'zh_label', attributeCnName: '名称' }] })
  })
})

/**
 * Every operation the judgement permits on one model, in {@link BIZ_OPERATIONS} order.
 * @param rights - the rights read.
 * @param model - the model asked about.
 * @param rules - the rule table; the defaults where left out.
 * @returns the permitted operations.
 */
function permitted(
  rights: BizUserRights | BizBackendFailure,
  model: string,
  rules: BizOperationRules = DEFAULT_RULES,
): readonly BizOperation[] {
  const backend = new BizBackendService(new Context(), BIZ_UPSTREAM, soleSlot(testCredential(TOKEN)), rules)
  const permissions = backend.judge(rights)
  return BIZ_OPERATIONS.filter(operation => permissions.may(model, operation))
}

/**
 * A rights read holding one row per entry, each granting the named flags.
 * @param rows - model name to granted flags.
 * @returns the rights read.
 */
function rightsOf(rows: Readonly<Record<string, readonly string[]>>): BizUserRights {
  return {
    resclass: Object.entries(rows).map(([resclassenname, operations]) => ({ resclassenname, operations })),
    rows: [],
  }
}

describe('what the signed-in person may do, under the default rules', () => {
  it('lists the seven operations in the order the backend plans them', () => {
    expect(BIZ_OPERATIONS).toEqual(['read', 'metadata_read', 'create', 'update', 'delete', 'import', 'export'])
  })

  it('writes the default rule table out as the backend enforces it today', () => {
    expect(DEFAULT_RULES).toEqual({
      read: 'row',
      metadata_read: 'row',
      create: ['add'],
      update: ['update'],
      delete: ['delete'],
      import: ['add', 'update'],
      export: 'row',
    })
  })

  it('lets a row granting nothing read, read the description and export, and nothing else', () => {
    // What every account's row looks like on the real backend for a model it
    // may only look at: every flag null, so no operation is listed.
    expect(permitted(rightsOf({ SpaceLayer: [] }), 'SpaceLayer')).toEqual(['read', 'metadata_read', 'export'])
  })

  it('gives create for add, update for update, and delete for delete, each on its own', () => {
    expect(permitted(rightsOf({ SpaceLayer: ['add'] }), 'SpaceLayer'))
      .toEqual(['read', 'metadata_read', 'create', 'import', 'export'])
    expect(permitted(rightsOf({ SpaceLayer: ['update'] }), 'SpaceLayer'))
      .toEqual(['read', 'metadata_read', 'update', 'import', 'export'])
    expect(permitted(rightsOf({ SpaceLayer: ['delete'] }), 'SpaceLayer'))
      .toEqual(['read', 'metadata_read', 'delete', 'export'])
    expect(permitted(rightsOf({ SpaceLayer: ['add', 'delete', 'update'] }), 'SpaceLayer')).toEqual([...BIZ_OPERATIONS])
  })

  it('ignores the flags the backend does not enforce', () => {
    // `search`, `imp`, `exp` and `gridexp` are null for every account on the
    // real backend; where one does arrive true it widens nothing.
    expect(permitted(rightsOf({ SpaceLayer: ['exp', 'gridexp', 'imp', 'search'] }), 'SpaceLayer'))
      .toEqual(['read', 'metadata_read', 'export'])
  })

  it('permits nothing on a model the rights table holds no row for', () => {
    expect(permitted(rightsOf({ SpaceLayer: ['add', 'delete', 'update'] }), 'SITE')).toEqual([])
  })

  it('permits nothing at all when the rights table names no model', () => {
    expect(permitted(rightsOf({}), 'SpaceLayer')).toEqual([])
  })

  it('permits nothing at all when the rights could not be read', () => {
    const failures: readonly BizBackendFailure[] = [
      { kind: 'unauthenticated' },
      { kind: 'refused', status: 401 },
      // What an account with no grant at all is answered with.
      { kind: 'rejected', status: 400, code: 1, message: '用户未授权' },
      { kind: 'unreachable', detail: 'the answer carried no rights table' },
    ]
    for (const failure of failures) expect(permitted(failure, 'SpaceLayer')).toEqual([])
  })

  it('reaches no network to judge', () => {
    serve(answer({ code: 0 }))
    permitted(rightsOf({ SpaceLayer: ['add'] }), 'SpaceLayer')
    expect(seen).toEqual([])
  })
})

describe('the rule table a deployment writes', () => {
  it('switches one operation to a flag without touching the others', () => {
    const rules = BizOperationRules({ export: ['exp'] })
    expect(permitted(rightsOf({ SpaceLayer: [] }), 'SpaceLayer', rules)).toEqual(['read', 'metadata_read'])
    expect(permitted(rightsOf({ SpaceLayer: ['exp'] }), 'SpaceLayer', rules)).toEqual(['read', 'metadata_read', 'export'])
  })

  it('lets a flag-requiring operation fall back to the row alone', () => {
    const rules = BizOperationRules({ create: 'row' })
    expect(permitted(rightsOf({ SpaceLayer: [] }), 'SpaceLayer', rules)).toEqual(['read', 'metadata_read', 'create', 'export'])
  })

  it('refuses a rule that names no flag, names one that is not a flag name, or is neither form', () => {
    // Cast: each case is a value `cordis.yml` could hold and the type rules out.
    expect(() => BizOperationRules({ create: [] })).toThrow()
    expect(() => BizOperationRules({ create: ['a-b'] })).toThrow()
    expect(() => BizOperationRules({ create: 'everyone' } as never)).toThrow()
    expect(() => BizOperationRules({ create: true } as never)).toThrow()
  })

  it('refuses a table naming an operation there is no rule for', () => {
    const misspelled = BizOperationRules({ exprot: ['exp'], imports: 'row' } as never)
    expect(() => requireBizOperationRules(misspelled)).toThrow(
      'biz-backend: no operation is called "exprot", "imports"; '
        + 'the rule table names read, metadata_read, create, update, delete, import, export',
    )
    expect(requireBizOperationRules(DEFAULT_RULES)).toBe(DEFAULT_RULES)
  })
})
