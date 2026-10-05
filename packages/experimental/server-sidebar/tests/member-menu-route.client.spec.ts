/**
 * REAL-composition coverage for keeping the server menu per console member: a
 * profile booted through the app boot mounts the config editor, the real
 * settings service, the webserver, the server-sidebar row with `perMember`,
 * and — where a case needs one — the test-only `consoleMembers` row from
 * `fixtures/console-members.client.ts`. Every assertion observes the served
 * routes, what each member's store holds, the profile patch the settings
 * service writes, and what the composition logged.
 *
 * The configuration cases call `apply` directly: a rejected configuration
 * never reaches a served surface, so there is nothing for HTTP to observe.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import * as ServerSidebar from '../src/index.ts'
import { reportDirectoryMismatch } from '../src/members.ts'
import { SERVER_IDENTITY_ROUTE, SERVER_MENU_ROUTE } from '../src/route.ts'
import { SERVER_SIDEBAR_NAMESPACE } from '../src/workflows.ts'
import { ConsoleMembersFixture, MEMBER_HEADER, type Config as FixtureConfig } from './fixtures/console-members.client.ts'
import { bootProfile, type LogLine, type ProfileComposition } from './profile-composition.client.ts'

/** Member A's key: a 19-digit id, as the deployment's `login_uid` is. */
const MEMBER_A = '1234567890123456789'
const MEMBER_B = 'member-b'
/** What each member's requests carry in place of the signed member assertion. */
const ASSERTION_A = 'assertion-of-a'
const ASSERTION_B = 'assertion-of-b'
const ASSERTION_NOBODY = 'assertion-of-nobody'

/** The directory's tables: two members, their top-level sessions, and the children it places. */
const MEMBERS: FixtureConfig = {
  requests: { [ASSERTION_A]: MEMBER_A, [ASSERTION_B]: MEMBER_B },
  sessions: { 'session-a': MEMBER_A, 'session-b': MEMBER_B },
  parents: { 'session-a-child': 'session-a', 'session-b-child': 'session-b', 'session-orphan': 'session-gone' },
}

/** The unit this package keeps its menu under. */
const UNIT = 'server-sidebar'

const WORKFLOW = {
  id: 'w1', name: 'Alpha', order: 0, homeSessionId: 'session-a',
  navSnapshot: [{ kind: 'page', entryId: 'home' }], savedAt: 1,
}
const GROUP = { id: 'g1', name: '每日', pinned: true, order: 0 }

/** Every value no response body and no log line may carry. */
const SECRETS = [MEMBER_A, MEMBER_B, ASSERTION_A, ASSERTION_B, ASSERTION_NOBODY, 'Alpha', 'dir-1']

/** The fixed refusals and log lines of the per-member route. */
const NOT_RUNNING = { error: 'server-sidebar: the server-menu route needs the consoleMembers service, which is not running' }
const UNPLACED = { error: 'server-sidebar: the server-menu route could not tell which member sent this request' }
/**
 * The refusal of a save whose fields name another member's conversations.
 * @param paths - the field paths that name them, in the order the route lists them.
 * @returns the refusal's body.
 */
function foreign(...paths: string[]): { error: string } {
  return {
    error: paths.length === 1
      ? `server-sidebar: ${paths[0]!} names a conversation that belongs to another member`
      : `server-sidebar: ${paths.join(', ')} name conversations that belong to another member`,
  }
}
const UNREADABLE = { error: 'server-sidebar: the saved server-menu could not be read' }
const NOT_SAVED = { error: 'server-sidebar: the server-menu could not be saved' }
const UNREADABLE_LINE = 'a member\'s saved server-menu could not be read; the server-menu route answers 500 to that member until the saved copy is repaired'
const NOT_SAVED_LINE = 'a member\'s server-menu could not be saved; the server-menu route answered 500'

/** The stored document as the route answers it, with the fields the schema defaults filled in. */
function document(fields: Record<string, unknown>): Record<string, unknown> {
  return { workflows: [], groups: [], ...fields }
}

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  allow: string | null
  cacheControl: string | null
  body: string
}

/**
 * Issue one request against the running server.
 * @param ctx - the composition.
 * @param path - the route.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @param init - the rest of the request.
 * @returns the answer.
 */
async function call(ctx: Context, path: string, assertion: string | undefined, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${path}`, {
    ...init,
    headers: { ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion }, ...init.headers as Record<string, string> },
  })
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  }
}

/** GET a member's menu. */
function readMenu(ctx: Context, assertion: string | undefined): Promise<Answer> {
  return call(ctx, SERVER_MENU_ROUTE, assertion)
}

/** POST one server-menu patch for a member. */
function postPatch(ctx: Context, assertion: string | undefined, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return call(ctx, SERVER_MENU_ROUTE, assertion, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/**
 * POST to the server-menu route a body that is never finished: its declared
 * length is longer than what is sent, and the request stays open. A route that
 * read the body before answering would wait for the rest, so an answer at all
 * shows it answered without reading.
 * @param ctx - the composition.
 * @param assertion - what stands in for the member assertion; absent sends none.
 * @returns the answer, or a rejection when none arrives within two seconds.
 */
async function postUnfinished(ctx: Context, assertion: string | undefined): Promise<Answer> {
  const sent = '{"workflows":['
  const req = request(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_MENU_ROUTE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(sent.length + 64),
      ...assertion === undefined ? {} : { [MEMBER_HEADER]: assertion },
    },
  })
  try {
    return await new Promise<Answer>((resolveAnswer, reject) => {
      const timer = setTimeout(() => { reject(new Error('the server-menu route waited for the rest of the body')) }, 2000)
      req.on('error', reject)
      req.on('response', (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => {
          clearTimeout(timer)
          resolveAnswer({ status: response.statusCode ?? 0, allow: null, cacheControl: null, body })
        })
      })
      req.write(sent)
    })
  } finally {
    req.destroy()
  }
}

/** The answer's status and decoded body. */
function outcome(answer: Answer): { status: number; body: unknown } {
  const body: unknown = answer.body === '' ? '' : JSON.parse(answer.body)
  return { status: answer.status, body }
}

/**
 * Boot the per-member composition.
 * @param members - the directory's tables; `null` leaves the directory row out.
 * @returns the booted composition.
 */
function bootMembers(members: FixtureConfig | null = MEMBERS): Promise<ProfileComposition> {
  return bootProfile({ sidebar: { perMember: true }, ...members === null ? {} : { members } })
}

/**
 * The directory row's instance.
 * @param ctx - the composition.
 * @returns the fixture the row was given.
 */
function directoryOf(ctx: Context): ConsoleMembersFixture {
  const directory = ctx.get('consoleMembers')
  if (!(directory instanceof ConsoleMembersFixture)) throw new Error('the composition runs no fixture directory')
  return directory
}

/** The error lines a composition logged. */
function errorsOf(logs: readonly LogLine[]): LogLine[] {
  return logs.filter(line => line.type === 'error')
}

/**
 * Require that nothing a test sent or held reached a response body or a log line.
 * @param answers - the response bodies.
 * @param logs - the composition's log.
 */
function expectNothingQuoted(answers: readonly Answer[], logs: readonly LogLine[]): void {
  const surfaces = [...answers.map(answer => answer.body), ...logs.map(line => line.text)]
  for (const secret of SECRETS) {
    expect({ secret, quotedIn: surfaces.filter(surface => surface.includes(secret)) }).toEqual({ secret, quotedIn: [] })
  }
}

/**
 * Wait until a condition holds.
 * @param condition - checked on every turn.
 */
async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => { expect(condition()).toBe(true) })
}

describe('per-member configuration', () => {
  /** The message one configuration is refused with at load. */
  function refusalOf(input: ServerSidebar.ConfigInput): string {
    try {
      ServerSidebar.apply(new Context(), ServerSidebar.Config(input))
    } catch (refusal) {
      return String(refusal)
    }
    throw new Error('the configuration was accepted')
  }

  it('refuses a menu written into the row\'s configuration, naming the fields and not their values', () => {
    const cases: [ServerSidebar.ConfigInput, string][] = [
      [{ displayNameClaim: 'login_uname', perMember: true, workflows: [WORKFLOW as never] }, 'workflows'],
      [{ displayNameClaim: 'login_uname', perMember: true, groups: [GROUP] }, 'groups'],
      [{ displayNameClaim: 'login_uname', perMember: true, workbenchSessionId: 'session-a' }, 'workbenchSessionId'],
      [{
        displayNameClaim: 'login_uname', perMember: true, workflows: [WORKFLOW as never], groups: [GROUP], workbenchSessionId: 'session-a',
      }, 'workflows, groups, workbenchSessionId'],
    ]
    for (const [input, fields] of cases) {
      const refusal = refusalOf(input)
      expect(refusal).toBe(
        `Error: server-sidebar: ${fields} must be empty when perMember is set, because each member's menu is kept in that member's own store`,
      )
      for (const value of ['Alpha', 'w1', '每日', 'g1', 'session-a']) expect(refusal).not.toContain(value)
    }
  })

  it('names the fields, not their values, for a menu that would also fail the schema\'s cross-element constraints', () => {
    const cases: [ServerSidebar.ConfigInput, string][] = [
      [{ displayNameClaim: 'login_uname', perMember: true, workflows: [WORKFLOW as never, WORKFLOW as never] }, 'workflows'],
      [{
        displayNameClaim: 'login_uname', perMember: true,
        workflows: [{ ...WORKFLOW, groupId: 'g-secret' } as never], groups: [],
      }, 'workflows'],
    ]
    for (const [input, fields] of cases) {
      const refusal = refusalOf(input)
      expect(refusal).toBe(
        `Error: server-sidebar: ${fields} must be empty when perMember is set, because each member's menu is kept in that member's own store`,
      )
      for (const value of ['w1', 'g-secret']) expect(refusal).not.toContain(value)
    }
  })

  it('takes an empty menu with perMember, and an empty workflow list is empty', () => {
    expect(() => {
      ServerSidebar.apply(new Context(), ServerSidebar.Config({ displayNameClaim: 'login_uname', perMember: true, workflows: [], groups: [] }))
    }).not.toThrow()
  })

  it('loads a row that writes only perMember: the empty lists the schema fills in are no menu', async () => {
    const config = ServerSidebar.Config({ displayNameClaim: 'login_uname', perMember: true })
    expect([config.workflows.get(), config.groups.get(), config.workbenchSessionId.get()]).toEqual([[], [], undefined])
    expect(() => { ServerSidebar.apply(new Context(), config) }).not.toThrow()
    // The same row through the Loader, as a cordis.yml row writing only the field.
    const { ctx, logs } = await bootMembers()
    expect(errorsOf(logs)).toEqual([])
    expect((await readMenu(ctx, ASSERTION_A)).status).toBe(200)
  })

  it('defaults to one menu for the process, and does not declare the field volatile', () => {
    expect(ServerSidebar.Config({ displayNameClaim: 'login_uname' }).perMember).toBe(false)
    // A settings write reaches only fields declared `.volatile()`, so the
    // field changes only with the row's own configuration.
    expect(ServerSidebar.Config.dict?.perMember?.meta.volatile ?? false).toBe(false)
  })
})

describe('per-member server-menu route', () => {
  it('answers each member the empty menu before they save anything, uncached', async () => {
    const { ctx, logs } = await bootMembers()
    for (const assertion of [ASSERTION_A, ASSERTION_B]) {
      const answer = await readMenu(ctx, assertion)
      expect({ ...outcome(answer), cacheControl: answer.cacheControl }).toEqual({ status: 200, body: document({}), cacheControl: 'no-store' })
      expect((await call(ctx, SERVER_MENU_ROUTE, assertion, { method: 'HEAD' })).status).toBe(200)
    }
    expect(errorsOf(logs)).toEqual([])
  })

  it('keeps a save in the saving member\'s own store, and in neither the profile nor the other member\'s menu', async () => {
    const { ctx, profile, logs } = await bootMembers()
    // A write through the settings service may land after the answer, so its
    // call is watched as well as the profile patch it would change.
    const update = vi.spyOn(ctx.settings, 'update')
    const posted = await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW], workbenchSessionId: 'session-a' })
    expect(outcome(posted)).toEqual({ status: 200, body: document({ workflows: [WORKFLOW], workbenchSessionId: 'session-a' }) })
    const directory = directoryOf(ctx)
    expect(directory.value(MEMBER_A, UNIT)).toEqual(document({ workflows: [WORKFLOW], workbenchSessionId: 'session-a' }))
    expect(new Set(directory.units)).toEqual(new Set([UNIT]))
    expect(outcome(await readMenu(ctx, ASSERTION_A))).toEqual({ status: 200, body: document({ workflows: [WORKFLOW], workbenchSessionId: 'session-a' }) })
    expect(outcome(await readMenu(ctx, ASSERTION_B))).toEqual({ status: 200, body: document({}) })

    // Nothing reached the settings service: the profile patch carries no menu,
    // and the row's own fields stay empty.
    const patch: unknown = existsSync(profile.patchPath) ? parse(readFileSync(profile.patchPath, 'utf8')) : []
    expect(JSON.stringify(patch)).not.toContain('w1')
    expect(ctx.settings.describe().find(form => form.ns === SERVER_SIDEBAR_NAMESPACE)?.value)
      .toMatchObject({ workflows: [], groups: [] })

    // B's save leaves A's menu as it was.
    const other = { ...WORKFLOW, id: 'w2', name: 'Beta', homeSessionId: 'session-b' }
    expect((await postPatch(ctx, ASSERTION_B, { workflows: [other], groups: [GROUP] })).status).toBe(200)
    expect(outcome(await readMenu(ctx, ASSERTION_A))).toEqual({ status: 200, body: document({ workflows: [WORKFLOW], workbenchSessionId: 'session-a' }) })
    expect(directory.value(MEMBER_B, UNIT)).toEqual(document({ workflows: [other], groups: [GROUP] }))
    expect(update).not.toHaveBeenCalled()
    expect(errorsOf(logs)).toEqual([])
  })

  it('merges a patch into what the member saved, as the menu of one person does', async () => {
    const { ctx } = await bootMembers()
    await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    const merged = await postPatch(ctx, ASSERTION_A, { workbenchSessionId: 'session-a-child' })
    expect(outcome(merged)).toEqual({ status: 200, body: document({ workflows: [WORKFLOW], workbenchSessionId: 'session-a-child' }) })
    const grouped = await postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    expect(outcome(grouped)).toEqual({
      status: 200, body: document({ workflows: [WORKFLOW], groups: [GROUP], workbenchSessionId: 'session-a-child' }),
    })
  })

  it('keeps a field the browser half does not read through a read, a save of another field, and the write back', async () => {
    const { ctx } = await bootMembers()
    const extended = { ...WORKFLOW, colour: 'teal' }
    await postPatch(ctx, ASSERTION_A, { workflows: [extended] })
    await postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    expect(outcome(await readMenu(ctx, ASSERTION_A))).toEqual({ status: 200, body: document({ workflows: [extended], groups: [GROUP] }) })
  })

  it('refuses a save naming another member\'s conversation by the field that holds it, naming neither, and saves one the directory places with nobody', async () => {
    const { ctx, logs } = await bootMembers()
    const answers: Answer[] = []
    for (const [patch, path] of [
      [{ workflows: [{ ...WORKFLOW, homeSessionId: 'session-b' }] }, 'workflows[0].homeSessionId'],
      [{ workflows: [WORKFLOW, { ...WORKFLOW, id: 'w2', homeSessionId: 'session-b-child' }] }, 'workflows[1].homeSessionId'],
      [{ workbenchSessionId: 'session-b' }, 'workbenchSessionId'],
      [{ workbenchSessionId: 'session-b-child', groups: [GROUP] }, 'workbenchSessionId'],
    ] as const) {
      const answer = await postPatch(ctx, ASSERTION_A, patch)
      answers.push(answer)
      expect({ patch, ...outcome(answer) }).toEqual({ patch, status: 400, body: foreign(path) })
      expect(answer.body).not.toContain('session-b')
    }
    expect(directoryOf(ctx).value(MEMBER_A, UNIT)).toBeUndefined()

    // A conversation the directory does not know, or places with nobody, is a
    // weak reference the menu may hold; A's own child conversation is A's.
    for (const id of ['session-gone', 'session-orphan', 'session-a-child']) {
      const answer = await postPatch(ctx, ASSERTION_A, { workflows: [{ ...WORKFLOW, homeSessionId: id }], workbenchSessionId: id })
      expect({ id, status: answer.status }).toEqual({ id, status: 200 })
    }
    // B's own conversation is B's to save.
    expect((await postPatch(ctx, ASSERTION_B, { workbenchSessionId: 'session-b' })).status).toBe(200)
    expectNothingQuoted(answers, logs)
  })

  it('refuses a save that resends an old reference now another member\'s, by its index in the list, naming neither', async () => {
    const { ctx, logs } = await bootMembers()
    const directory = directoryOf(ctx)
    // The third workflow was saved while its conversation was nobody's; the
    // directory now gives that conversation to B.
    const saved = [
      WORKFLOW,
      { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1, homeSessionId: 'session-a-child' },
      { ...WORKFLOW, id: 'w3', name: 'Gamma', order: 2, homeSessionId: 'session-b' },
    ]
    const stored = { workflows: saved, groups: [] }
    directory.seed(MEMBER_A, UNIT, stored)
    const renamed = await postPatch(ctx, ASSERTION_A, { workflows: [{ ...saved[0]!, name: 'Alpha 2' }, saved[1]!, saved[2]!] })
    expect(outcome(renamed)).toEqual({ status: 400, body: foreign('workflows[2].homeSessionId') })
    expect(renamed.body).not.toContain(MEMBER_B)
    expect(renamed.body).not.toContain('session-b')
    expect(directory.value(MEMBER_A, UNIT)).toEqual(stored)
    expectNothingQuoted([renamed], logs)
  })

  it('names the workbench field when the workbench is another member\'s', async () => {
    const { ctx, logs } = await bootMembers()
    const answer = await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW], workbenchSessionId: 'session-b-child' })
    expect(outcome(answer)).toEqual({ status: 400, body: foreign('workbenchSessionId') })
    expect(answer.body).not.toContain(MEMBER_B)
    expect(answer.body).not.toContain('session-b')
    expect(directoryOf(ctx).value(MEMBER_A, UNIT)).toBeUndefined()
    expectNothingQuoted([answer], logs)
  })

  it('lists every field naming another member\'s conversation, workflows in list order and then the workbench', async () => {
    const { ctx, logs } = await bootMembers()
    const answer = await postPatch(ctx, ASSERTION_A, {
      workflows: [
        { ...WORKFLOW, homeSessionId: 'session-b-child' },
        { ...WORKFLOW, id: 'w2', homeSessionId: 'session-a' },
        { ...WORKFLOW, id: 'w3', homeSessionId: 'session-b' },
      ],
      workbenchSessionId: 'session-b',
    })
    expect(outcome(answer)).toEqual({
      status: 400, body: foreign('workflows[0].homeSessionId', 'workflows[2].homeSessionId', 'workbenchSessionId'),
    })
    expect(answer.body).not.toContain(MEMBER_B)
    expect(answer.body).not.toContain('session-b')
    expect(directoryOf(ctx).value(MEMBER_A, UNIT)).toBeUndefined()
    expectNothingQuoted([answer], logs)
  })

  it('refuses a merged menu that breaks a cross-element constraint before asking whose conversations it names', async () => {
    const { ctx } = await bootMembers()
    await postPatch(ctx, ASSERTION_A, { workflows: [{ ...WORKFLOW, groupId: GROUP.id }], groups: [GROUP] })
    const orphaned = await postPatch(ctx, ASSERTION_A, { groups: [] })
    expect(outcome(orphaned)).toEqual({
      status: 400, body: { error: 'server-sidebar: workflow "w1" names group "g1", which no group defines' },
    })
    // A duplicate id naming B's conversation is refused for the duplicate.
    const duplicate = await postPatch(ctx, ASSERTION_A, {
      workflows: [{ ...WORKFLOW, homeSessionId: 'session-b' }, { ...WORKFLOW, homeSessionId: 'session-b' }],
    })
    expect(outcome(duplicate)).toEqual({ status: 400, body: { error: 'server-sidebar: duplicate workflow id "w1"' } })
    expect(directoryOf(ctx).value(MEMBER_A, UNIT)).toEqual(document({ workflows: [{ ...WORKFLOW, groupId: GROUP.id }], groups: [GROUP] }))
  })

  it('refuses a body shaped wrong or past the bound once the member is placed', async () => {
    const { ctx } = await bootMembers()
    for (const body of ['not json', {}, { workflows: 'nope' }, { workbenchSessionId: 42 }]) {
      const answer = await postPatch(ctx, ASSERTION_A, body)
      expect({ sent: body, ...outcome(answer) }).toEqual({
        sent: body,
        status: 400,
        body: { error: 'server-sidebar: expected a JSON body shaped { workflows?: [...], groups?: [...], workbenchSessionId?: string }' },
      })
    }
    const oversized = await postPatch(ctx, ASSERTION_A, { workflows: [{ ...WORKFLOW, name: 'A'.repeat(80 * 1024) }] })
    expect(outcome(oversized)).toEqual({ status: 413, body: { error: 'server-sidebar: the server-menu route body is too large' } })
    expect(directoryOf(ctx).reads).toBe(0)
  })

  it('answers 401 before reading the body of a request it places with nobody, and reads no store for it', async () => {
    const { ctx, logs } = await bootMembers()
    const answers: Answer[] = []
    for (const assertion of [undefined, ASSERTION_NOBODY]) {
      const unfinished = await postUnfinished(ctx, assertion)
      const oversized = await postPatch(ctx, assertion, { workflows: [{ ...WORKFLOW, name: 'A'.repeat(80 * 1024) }] })
      const malformed = await postPatch(ctx, assertion, 'not json at all')
      const read = await readMenu(ctx, assertion)
      answers.push(unfinished, oversized, malformed, read)
      expect([unfinished, oversized, malformed, read].map(outcome)).toEqual([
        { status: 401, body: UNPLACED }, { status: 401, body: UNPLACED }, { status: 401, body: UNPLACED }, { status: 401, body: UNPLACED },
      ])
    }
    const directory = directoryOf(ctx)
    expect([directory.reads, directory.units, directory.stored.size]).toEqual([0, [], 0])
    expectNothingQuoted(answers, logs)
  })

  it('keeps the method, same-site, and JSON fences ahead of placing the member', async () => {
    // No directory: a fence that ran after placement would answer 503 here.
    const { ctx } = await bootMembers(null)
    const method = await call(ctx, SERVER_MENU_ROUTE, ASSERTION_A, { method: 'DELETE' })
    expect({ status: method.status, allow: method.allow }).toEqual({ status: 405, allow: 'GET, HEAD, POST' })
    expect(outcome(await postPatch(ctx, ASSERTION_A, { workflows: [] }, { 'sec-fetch-site': 'cross-site' })))
      .toEqual({ status: 403, body: { error: 'server-sidebar: the server-menu route serves same-site requests only' } })
    expect(outcome(await postPatch(ctx, ASSERTION_A, '{}', { 'content-type': 'text/plain' })))
      .toEqual({ status: 415, body: { error: 'server-sidebar: the server-menu route accepts application/json only' } })
  })

  it('answers 500 for a saved menu that does not read, logs it without the member or the menu, and keeps it as it was', async () => {
    const { ctx, logs } = await bootMembers()
    const directory = directoryOf(ctx)
    const answers: Answer[] = []
    for (const saved of [
      'Alpha', null, [], {}, { workflows: 'Alpha' }, { workflows: [{ id: 'w1' }] },
      { workflows: [WORKFLOW, WORKFLOW] }, { groups: [{ ...GROUP, name: ' ' }] },
    ]) {
      directory.seed(MEMBER_A, UNIT, saved)
      const read = await readMenu(ctx, ASSERTION_A)
      const posted = await postPatch(ctx, ASSERTION_A, { workflows: [] })
      answers.push(read, posted)
      expect({ saved, outcomes: [outcome(read), outcome(posted)] })
        .toEqual({ saved, outcomes: [{ status: 500, body: UNREADABLE }, { status: 500, body: UNREADABLE }] })
      expect(directory.value(MEMBER_A, UNIT)).toEqual(saved)
    }
    expect(errorsOf(logs).map(line => line.text)).toEqual(Array.from({ length: 16 }, () => UNREADABLE_LINE))
    // The other member reads and saves as usual.
    expect((await postPatch(ctx, ASSERTION_B, { groups: [GROUP] })).status).toBe(200)
    expectNothingQuoted(answers, logs)
  })

  it('answers 500 when the store refuses the write, logs it without the store\'s text, and takes the next save', async () => {
    const { ctx, logs } = await bootMembers()
    const directory = directoryOf(ctx)
    await postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    directory.failWrites = true
    const refused = await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    expect(outcome(refused)).toEqual({ status: 500, body: NOT_SAVED })
    expect(directory.value(MEMBER_A, UNIT)).toEqual(document({ groups: [GROUP] }))
    expect(errorsOf(logs)).toEqual([{ name: 'server-sidebar', type: 'error', text: NOT_SAVED_LINE }])
    directory.failWrites = false
    expect(outcome(await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })))
      .toEqual({ status: 200, body: document({ workflows: [WORKFLOW], groups: [GROUP] }) })
    expectNothingQuoted([refused], logs)
  })

  it('applies one member\'s concurrent saves one after another, so neither loses the other\'s field', async () => {
    const { ctx } = await bootMembers()
    const directory = directoryOf(ctx)
    const release = directory.holdNextWrite()
    const first = postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    await until(() => directory.held === 1)
    const second = postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    await until(() => directory.placements === 2)
    // Long enough for the second save to read the store, had it not waited.
    await new Promise((resolveWait) => { setTimeout(resolveWait, 100) })
    expect(directory.reads).toBe(1)
    release()
    expect((await Promise.all([first, second])).map(answer => answer.status)).toEqual([200, 200])
    expect(directory.value(MEMBER_A, UNIT)).toEqual(document({ workflows: [WORKFLOW], groups: [GROUP] }))
    expect(outcome(await readMenu(ctx, ASSERTION_A))).toEqual({ status: 200, body: document({ workflows: [WORKFLOW], groups: [GROUP] }) })
  })

  it('keeps a third save behind the second while the second is being written, so no save loses another\'s field', async () => {
    const { ctx } = await bootMembers()
    const directory = directoryOf(ctx)
    const releaseFirst = directory.holdNextWrite()
    const first = postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    await until(() => directory.held === 1)
    const second = postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    await until(() => directory.placements === 2)
    const releaseSecond = directory.holdNextWrite()
    releaseFirst()
    expect((await first).status).toBe(200)
    // The second save has read what the first wrote and is now being written.
    await until(() => directory.held === 1 && directory.reads === 2)
    const third = postPatch(ctx, ASSERTION_A, { workbenchSessionId: 'session-a' })
    await until(() => directory.placements === 3)
    // Long enough for the third save to read the store, had it not waited.
    await new Promise((resolveWait) => { setTimeout(resolveWait, 100) })
    expect(directory.reads).toBe(2)
    releaseSecond()
    expect((await Promise.all([second, third])).map(answer => answer.status)).toEqual([200, 200])
    expect(directory.value(MEMBER_A, UNIT)).toEqual(document({ workflows: [WORKFLOW], groups: [GROUP], workbenchSessionId: 'session-a' }))
  })

  it('applies the saves queued behind one whose member directory threw', async () => {
    const { ctx } = await bootMembers()
    const directory = directoryOf(ctx)
    directory.failingSessions.add('session-unplaceable')
    const release = directory.holdNextWrite()
    const first = postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    await until(() => directory.held === 1)
    const failing = postPatch(ctx, ASSERTION_A, { workbenchSessionId: 'session-unplaceable' })
    await until(() => directory.placements === 2)
    const third = postPatch(ctx, ASSERTION_A, { groups: [GROUP] })
    await until(() => directory.placements === 3)
    release()
    const answers = await Promise.all([first, failing, third])
    // The middle save's rejection is the webserver's to answer.
    expect(answers.map(answer => answer.status)).toEqual([200, 400, 200])
    expect(directory.value(MEMBER_A, UNIT)).toEqual(document({ workflows: [WORKFLOW], groups: [GROUP] }))
  })

  it('does not make one member\'s save wait on another member\'s', async () => {
    const { ctx } = await bootMembers()
    const directory = directoryOf(ctx)
    const release = directory.holdNextWrite()
    const held = postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })
    await until(() => directory.held === 1)
    expect(outcome(await postPatch(ctx, ASSERTION_B, { groups: [GROUP] }))).toEqual({ status: 200, body: document({ groups: [GROUP] }) })
    expect(directory.held).toBe(1)
    release()
    expect((await held).status).toBe(200)
  })

  it('serves the identity route to a request it places with nobody, and without a member directory', async () => {
    const { ctx } = await bootMembers(null)
    const answer = await call(ctx, SERVER_IDENTITY_ROUTE, undefined)
    expect(outcome(answer)).toEqual({ status: 200, body: { displayNameClaim: 'login_uname' } })
  })

  it('releases the route when the fiber disposes (HMR safety)', async () => {
    const { ctx } = await bootMembers()
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-sidebar')
    await row?.fiber?.dispose()
    expect((await readMenu(ctx, ASSERTION_A)).status).toBe(404)
  })
})

describe('per-member server-menu route without a member directory', () => {
  it('answers 503 naming the missing service, without waiting for the body, and logs it once the composition has loaded', async () => {
    const { ctx, logs } = await bootMembers(null)
    await vi.waitFor(() => { expect(errorsOf(logs)).toHaveLength(1) })
    expect(errorsOf(logs)).toEqual([{
      name: 'server-sidebar',
      type: 'error',
      text: 'perMember is set and no consoleMembers service is running now that the composition has loaded; the server-menu route answers 503 until one is',
    }])
    const answers = [
      await readMenu(ctx, ASSERTION_A),
      await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] }),
      await postUnfinished(ctx, ASSERTION_A),
      await postPatch(ctx, ASSERTION_A, 'not json at all'),
    ]
    expect(answers.map(outcome)).toEqual(answers.map(() => ({ status: 503, body: NOT_RUNNING })))
    expectNothingQuoted(answers, logs)
  })

  it('logs nothing about a directory that is running', async () => {
    const { ctx, logs } = await bootMembers()
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(errorsOf(logs)).toEqual([])
  })
})

describe('server-menu route without perMember beside a member directory', () => {
  it('serves the row\'s one menu to every request, and logs that a member directory is running', async () => {
    const { ctx, logs } = await bootProfile({ members: MEMBERS })
    await vi.waitFor(() => { expect(errorsOf(logs)).toHaveLength(1) })
    expect(errorsOf(logs)).toEqual([{
      name: 'server-sidebar',
      type: 'error',
      text: 'perMember is off and a consoleMembers service is running now that the composition has loaded; every member reads and writes the one server-menu this row\'s configuration holds',
    }])
    expect((await postPatch(ctx, ASSERTION_A, { workflows: [WORKFLOW] })).status).toBe(200)
    expect(outcome(await readMenu(ctx, ASSERTION_B))).toEqual({ status: 200, body: document({ workflows: [WORKFLOW] }) })
    expect(directoryOf(ctx).units).toEqual([])
  })

  it('logs nothing where no member directory is running', async () => {
    const { ctx, logs } = await bootProfile()
    await ctx.loader.await()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(errorsOf(logs)).toEqual([])
  })
})

describe('member directory check', () => {
  it('logs nothing for a row disposed before the composition has loaded', async () => {
    const ctx = new Context()
    const errors: string[] = []
    ctx.logger.exporter({ export: (message) => { if (message.type === 'error') errors.push(message.name) } })
    let settle = (): void => {}
    const loaded = new Promise<void>((resolveLoaded) => { settle = resolveLoaded })
    // A Loader whose tree has not settled yet; the check reads nothing else of it.
    ctx.provide('loader', { await: () => loaded } as never)
    const gone = ctx.plugin({
      name: 'disposed-row',
      apply: (scope: Context) => { reportDirectoryMismatch(scope, true, scope.logger('disposed-row')) },
    })
    const live = ctx.plugin({
      name: 'live-row',
      apply: (scope: Context) => { reportDirectoryMismatch(scope, true, scope.logger('live-row')) },
    })
    // Both rows have started, and so registered their check, before one goes.
    await Promise.all([gone.await(), live.await()])
    await gone.dispose()
    settle()
    await new Promise((resolveTick) => { setImmediate(resolveTick) })
    expect(errors).toEqual(['live-row'])
    await ctx.fiber.dispose()
  })
})
