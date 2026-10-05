/**
 * Which console member one read-route request comes from, and whether the call
 * it names belongs to that member.
 *
 * A row with `perMember` places every claim, report, and picture post through
 * `ctx.consoleMembers` before it reads the body: 503 while no such service is
 * running, and 401 when the service places the request with nobody. A placed
 * request may answer only a call whose session `principalOfSession` gives to
 * the same member. A call of another member's session, or of a session that
 * belongs to nobody, is answered exactly as a call this host does not know, so
 * a post cannot tell another member's call from no call at all. Without
 * `perMember` every request answers every call, as in a process that serves
 * one person.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/members
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.loader, whose settling is when a mismatched composition is reported.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: resolves ctx.consoleMembers, which places each request and each session.
import type {} from '@deepseek-ai/dsh-experimental-console-members'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { refuseUnread } from './http.ts'

/** A request the route may answer, and the calls it may answer. */
export interface CallerAdmission {
  readonly kind: 'admitted'
  /**
   * Whether this request may answer a call opened against one session.
   * @param sessionId - the call's session, `undefined` for a call this host does not know.
   * @returns false when the session belongs to another member or to nobody, or no call is known.
   */
  owns(sessionId: SessionId | undefined): boolean
}

/** Why a request is refused before its body is read. */
interface CallerRefusal {
  readonly kind: 'refused'
  readonly status: 401 | 503
  /** The refusal's text, naming the route and the missing piece and no value the request carried. */
  readonly error: string
}

/**
 * How a row places the requests its read routes answer.
 * @param req - the request, whose body is still unread.
 * @param route - how the route names itself in a refusal.
 * @returns the admission, or why the request is refused.
 */
export type PlaceCaller = (req: IncomingMessage, route: string) => CallerAdmission | CallerRefusal

/** The admission every request gets from a row that serves one person. */
const EVERY_CALLER: CallerAdmission = { kind: 'admitted', owns: () => true }

/**
 * Admit every request for every call.
 * @returns the admission shared by every request.
 */
export const placeEveryCaller: PlaceCaller = () => EVERY_CALLER

/**
 * Place every request with the member `ctx.consoleMembers` names, read at the
 * moment the request arrives.
 * @param ctx - the row's context.
 * @returns the placement the read routes call before reading a body.
 */
export function placeByMember(ctx: Context): PlaceCaller {
  return (req, route) => {
    const members = ctx.get('consoleMembers')
    if (members === undefined) {
      return { kind: 'refused', status: 503, error: `content-frame: ${route} needs the consoleMembers service, which is not running` }
    }
    const principal = members.principalOfRequest(req)
    if (principal === undefined) {
      return { kind: 'refused', status: 401, error: `content-frame: ${route} could not tell which member sent this request` }
    }
    return {
      kind: 'admitted',
      owns: sessionId => sessionId !== undefined && members.principalOfSession(sessionId) === principal,
    }
  }
}

/**
 * Place one request, answering its refusal here without reading its body.
 * @param place - the row's placement.
 * @param req - the request.
 * @param res - the response, answered here when the request is refused.
 * @param route - how the route names itself in a refusal.
 * @param bound - how much of a refused body may be read, in bytes.
 * @returns the admission, or `undefined` once the refusal is answered.
 */
export function admitCaller(
  place: PlaceCaller,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  bound: number,
): CallerAdmission | undefined {
  const caller = place(req, route)
  if (caller.kind === 'admitted') return caller
  refuseUnread(req, res, caller.status, { error: caller.error }, bound)
  return undefined
}

/**
 * Report, once the composition has loaded, a `perMember` setting that does not
 * match whether a member directory is running: a per-member row with no
 * directory answers every read-route post 503, and a row without `perMember`
 * beside a running directory lets any member's console answer any session's
 * calls.
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
  ctx.effect(() => () => { live = false }, 'content-frame: member directory check')
  void loader.await().then(() => {
    if (!live || perMember === (ctx.get('consoleMembers') !== undefined)) return
    logger.error(perMember
      ? 'perMember is set and no consoleMembers service is running now that the composition has loaded; the page read routes answer 503 until one is'
      : 'perMember is off and a consoleMembers service is running now that the composition has loaded; the page read routes take a claim or report for any session\'s call from any member')
  })
}
