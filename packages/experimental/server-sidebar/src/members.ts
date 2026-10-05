/**
 * The server menu of a process that serves several console members: each
 * member's menu kept in that member's own store, read and written through the
 * same server-menu route a process serving one person answers from its Config.
 *
 * Every request is placed through `ctx.consoleMembers`, read at the moment the
 * request arrives: 503 while no such service is running, and 401 when the
 * service places the request with nobody. Both are answered before a body is
 * read. A placed request reads and writes `memberStore(<member>, 'server-sidebar')`
 * and nothing else: no settings write, and no profile patch. A save that names
 * a conversation the directory gives to another member is refused; one the
 * directory places with nobody, or does not know, is saved, because a menu
 * holds weak references to conversations. One member's saves are applied one
 * at a time, each reading the menu the one before it wrote; different members'
 * saves do not wait on each other.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/src/members
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.loader, whose settling is when a mismatched composition is reported.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ConsoleMemberDirectory, MemberStore, PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-settings'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import {
  decodeJson, MAX_SERVER_MENU_POST_CHARS, PATCH_SHAPE_ERROR, readPatch, renderThrown, resolvePatch, ROUTE_LABEL,
  type ServerMenuPatchBody,
} from './menu-patch.ts'
import { SERVER_MENU_ROUTE } from './route.ts'
import type { ServerMenuSettings } from './workflows.ts'

/** The unit this package's data is kept under in each member's store. */
export const MEMBER_STORE_UNIT = 'server-sidebar'

/** The menu of a member who has saved nothing. */
const EMPTY_MENU: ServerMenuSettings = { workflows: [], groups: [] }

/** The refusal of a save that names a conversation of another member; it names neither the member nor the conversation. */
const FOREIGN_CONVERSATION_ERROR = 'server-sidebar: the menu names a conversation that belongs to another member'

/** The refusal of a request whose member's saved menu does not read as a menu. */
const UNREADABLE_ERROR = 'server-sidebar: the saved server-menu could not be read'

/** The refusal of a save the member store did not take. */
const WRITE_FAILED_ERROR = 'server-sidebar: the server-menu could not be saved'

/**
 * Run one member's saves one after another.
 * @param principal - the member the save belongs to.
 * @param task - the save: read the member's menu, merge, and write it back.
 * @returns settles as the task does, once every earlier save of the same member has settled.
 */
type SerializeSaves = (principal: PrincipalKey, task: () => Promise<void>) => Promise<void>

/**
 * Create the per-member save queue.
 *
 * A save that rejects does not stop the ones queued behind it, and a member
 * with nothing in flight holds no entry.
 * @returns the queue.
 */
function serializeByMember(): SerializeSaves {
  const tails = new Map<PrincipalKey, Promise<void>>()
  const settled = (): undefined => undefined
  return (principal, task) => {
    const run = (tails.get(principal) ?? Promise.resolve()).then(task)
    const tail = run.then(settled, settled)
    tails.set(principal, tail)
    void tail.then(() => {
      if (tails.get(principal) === tail) tails.delete(principal)
    })
    return run
  }
}

/**
 * The menu as the member store keeps it: the document the route answers,
 * serialized and read back, so a field a release of the browser half does not
 * read is kept as the profile patch keeps it for a process serving one person.
 * @param menu - the resolved menu.
 * @returns the JSON value to store.
 */
function storedForm(menu: ServerMenuSettings): JsonValue {
  return JSON.parse(JSON.stringify(menu)) as JsonValue
}

/**
 * Read one member's saved menu.
 * @param store - the member's store for this package.
 * @returns the saved menu, or the empty menu when nothing is saved.
 * @throws {Error} when the store cannot be read, or what it holds is not a
 * menu document or breaks the schema or a cross-element constraint.
 */
async function readSavedMenu(store: MemberStore): Promise<ServerMenuSettings> {
  const saved: unknown = await store.read()
  if (saved === undefined) return EMPTY_MENU
  const fields = readPatch(saved)
  if (fields === undefined) throw new Error('the saved server-menu is not a menu document')
  return { ...EMPTY_MENU, ...resolvePatch(EMPTY_MENU, fields) }
}

/**
 * Read one member's saved menu, answering 500 when it does not read.
 *
 * Never read as the empty menu: a save merged onto that would replace
 * whatever the member had saved.
 * @param store - the member's store for this package.
 * @param res - the response, answered here when the menu does not read.
 * @param logger - where the failure is reported.
 * @returns the saved menu, or `undefined` once the refusal is answered.
 */
async function readOrRefuse(store: MemberStore, res: ServerResponse, logger: Logger): Promise<ServerMenuSettings | undefined> {
  try {
    return await readSavedMenu(store)
  } catch (_unreadable) {
    // Neither the member nor the saved text is repeated: the line names the
    // fault and what the route does about it.
    logger.error('a member\'s saved server-menu could not be read; the server-menu route answers 500 to that member until the saved copy is repaired')
    answerJson(res, 500, { error: UNREADABLE_ERROR })
    return undefined
  }
}

/**
 * Whether the fields a save writes name a conversation of another member.
 * @param members - the member directory.
 * @param principal - the member saving.
 * @param fields - the fields the save writes.
 * @returns true when the directory gives a workflow's conversation or the
 * workbench conversation to a member other than `principal`.
 */
function namesAnotherMembersConversation(
  members: ConsoleMemberDirectory, principal: PrincipalKey, fields: ServerMenuPatchBody,
): boolean {
  const named = [
    ...(fields.workflows ?? []).map(workflow => workflow.homeSessionId),
    ...fields.workbenchSessionId === undefined ? [] : [fields.workbenchSessionId],
  ]
  return named.some((id) => {
    const owner = members.principalOfSession(id as SessionId)
    return owner !== undefined && owner !== principal
  })
}

/** What one save acts on. */
interface Save {
  readonly members: ConsoleMemberDirectory
  readonly principal: PrincipalKey
  readonly store: MemberStore
  readonly patch: ServerMenuPatchBody
}

/**
 * Merge one patch into the member's saved menu and write it back.
 * @param save - the member, their store, and the patch.
 * @param res - the response.
 * @param logger - where a failed read or write is reported.
 */
async function applySave(save: Save, res: ServerResponse, logger: Logger): Promise<void> {
  const current = await readOrRefuse(save.store, res, logger)
  if (current === undefined) return
  let fields: ServerMenuPatchBody
  try {
    fields = resolvePatch(current, save.patch)
  } catch (error: unknown) {
    answerJson(res, 400, { error: `server-sidebar: ${renderThrown(error)}` })
    return
  }
  if (namesAnotherMembersConversation(save.members, save.principal, fields)) {
    answerJson(res, 400, { error: FOREIGN_CONVERSATION_ERROR })
    return
  }
  const next: ServerMenuSettings = { ...current, ...fields }
  try {
    await save.store.write(storedForm(next))
  } catch (_writeFailed) {
    // The store's own error is not repeated: it is foreign text, and this
    // line names neither the member nor the menu.
    logger.error('a member\'s server-menu could not be saved; the server-menu route answered 500')
    answerJson(res, 500, { error: WRITE_FAILED_ERROR })
    return
  }
  answerJson(res, 200, next)
}

/**
 * Answer one server-menu request for the member it was placed with.
 * @param ctx - the row's context, which `consoleMembers` is read from.
 * @param req - the request.
 * @param res - the response.
 * @param serialize - the per-member save queue.
 * @param logger - where a failed read or write is reported.
 */
async function answerMemberMenu(
  ctx: Context, req: IncomingMessage, res: ServerResponse, serialize: SerializeSaves, logger: Logger,
): Promise<void> {
  const posting = req.method === 'POST'
  if (!posting && req.method !== 'GET' && req.method !== 'HEAD') {
    rejectMethod(res, 'GET, HEAD, POST')
    return
  }
  if (posting && (rejectCrossSite(req, res, ROUTE_LABEL) || rejectNonJson(req, res, ROUTE_LABEL))) return
  const members = ctx.get('consoleMembers')
  if (members === undefined) {
    answerJson(res, 503, { error: `server-sidebar: the ${ROUTE_LABEL} needs the consoleMembers service, which is not running` })
    return
  }
  // Before the body is read: a request nobody is placed for has its body left unread.
  const principal = members.principalOfRequest(req)
  if (principal === undefined) {
    answerJson(res, 401, { error: `server-sidebar: the ${ROUTE_LABEL} could not tell which member sent this request` })
    return
  }
  const store = members.memberStore(principal, MEMBER_STORE_UNIT)
  if (!posting) {
    const menu = await readOrRefuse(store, res, logger)
    if (menu !== undefined) answerJson(res, 200, menu)
    return
  }
  const text = await readBoundedText(req, MAX_SERVER_MENU_POST_CHARS)
  if (text === undefined) {
    answerJson(res, 413, { error: `server-sidebar: the ${ROUTE_LABEL} body is too large` })
    return
  }
  const patch = readPatch(decodeJson(text))
  if (patch === undefined) {
    answerJson(res, 400, { error: PATCH_SHAPE_ERROR })
    return
  }
  await serialize(principal, () => applySave({ members, principal, store, patch }, res, logger))
}

/**
 * Serve the server menu per console member: the settings page policy where
 * the settings service is composed, and the server-menu route where the
 * webserver is. Neither needs the other, and neither needs a Loader entry:
 * nothing is written into a profile.
 * @param ctx - the row's context.
 * @param logger - where a failed read or write of a member's menu is reported.
 */
export function serveMemberMenus(ctx: Context, logger: Logger): void {
  ctx.inject(['settings'], (childCtx) => {
    // The menu fields stay in the schema, empty; a generated settings page
    // for them would offer an editor for a menu nobody reads.
    childCtx.effect(() => childCtx.settings.configure({ auto: false }, ctx.fiber), 'server-sidebar: settings page policy')
  })
  const serialize = serializeByMember()
  ctx.inject(['webServer'], (childCtx) => {
    childCtx.effect(() => childCtx.webServer.register({
      kind: 'exact',
      path: SERVER_MENU_ROUTE,
      handler: (req, res) => answerMemberMenu(ctx, req, res, serialize, logger),
    }), 'server-sidebar: per-member server-menu route')
  })
}

/**
 * Report, once the composition has loaded, a `perMember` setting that does not
 * match whether a member directory is running: a per-member row with no
 * directory answers every server-menu request 503, and a row without
 * `perMember` beside a running directory serves every member the one menu its
 * Config holds.
 *
 * Cordis has no host-ready event; the Loader tree settling is the point at
 * which every configured row has had its chance to start. A context with no
 * Loader — a row applied by hand — has no such point and reports nothing.
 * @param ctx - the row's context.
 * @param perMember - the row's `perMember` setting.
 * @param logger - where a mismatch is reported.
 */
export function reportDirectoryMismatch(ctx: Context, perMember: boolean, logger: Logger): void {
  const loader = ctx.get('loader')
  if (loader === undefined) return
  let live = true
  ctx.effect(() => () => { live = false }, 'server-sidebar: member directory check')
  void loader.await().then(() => {
    if (!live || perMember === (ctx.get('consoleMembers') !== undefined)) return
    logger.error(perMember
      ? 'perMember is set and no consoleMembers service is running now that the composition has loaded; the server-menu route answers 503 until one is'
      : 'perMember is off and a consoleMembers service is running now that the composition has loaded; every member reads and writes the one server-menu this row\'s configuration holds')
  })
}
