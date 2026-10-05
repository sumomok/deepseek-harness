/**
 * Which console member one render report comes from, and whether the call it
 * names belongs to that member.
 *
 * A row with `perMember` places every report through `ctx.consoleMembers`
 * before it reads the body: 503 while no such service is running, and 401 when
 * the service places the request with nobody. A placed report may settle only
 * a call whose session `principalOfSession` gives to the same member. A call of
 * another member's session, of a session that belongs to nobody, or made
 * outside any agent is answered exactly as a call nothing is waiting on, so a
 * report cannot tell another member's call from no call at all. Without
 * `perMember` every report may settle every call, as in a process that serves
 * one person.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/members
 */

import type { IncomingMessage } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.loader, whose settling is when a mismatched composition is reported.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: resolves ctx.consoleMembers, which places each request and each session.
import type {} from '@deepseek-ai/dsh-experimental-console-members'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** A report the route may take, and the calls it may settle. */
export interface ReporterAdmission {
  readonly kind: 'admitted'
  /**
   * Whether this report may settle a call made in one session.
   * @param sessionId - the call's session, `undefined` when no call is waiting or it runs outside any agent.
   * @returns false when the session belongs to another member or to nobody, or there is none.
   */
  owns(sessionId: SessionId | undefined): boolean
}

/** Why a report is refused before its body is read. */
interface ReporterRefusal {
  readonly kind: 'refused'
  readonly status: 401 | 503
  /** The refusal's text, naming the route and the missing piece and no value the request carried. */
  readonly error: string
}

/**
 * How a row places the reports its route takes.
 * @param req - the request, whose body is still unread.
 * @returns the admission, or why the report is refused.
 */
export type PlaceReporter = (req: IncomingMessage) => ReporterAdmission | ReporterRefusal

/** The admission every report gets from a row that serves one person. */
const EVERY_REPORTER: ReporterAdmission = { kind: 'admitted', owns: () => true }

/**
 * Admit every report for every call.
 * @returns the admission shared by every report.
 */
export const placeEveryReporter: PlaceReporter = () => EVERY_REPORTER

/**
 * Place every report with the member `ctx.consoleMembers` names, read at the
 * moment the report arrives.
 * @param ctx - the row's context.
 * @returns the placement the report route calls before reading a body.
 */
export function placeReporterByMember(ctx: Context): PlaceReporter {
  return (req) => {
    const members = ctx.get('consoleMembers')
    if (members === undefined) {
      return { kind: 'refused', status: 503, error: 'show-chart: the report route needs the consoleMembers service, which is not running' }
    }
    const principal = members.principalOfRequest(req)
    if (principal === undefined) {
      return { kind: 'refused', status: 401, error: 'show-chart: the report route could not tell which member sent this request' }
    }
    return {
      kind: 'admitted',
      owns: sessionId => sessionId !== undefined && members.principalOfSession(sessionId) === principal,
    }
  }
}

/**
 * Report, once the composition has loaded, a `perMember` setting that does not
 * match whether a member directory is running: a per-member row with no
 * directory answers every report 503, and a row without `perMember` beside a
 * running directory lets any member's console settle any session's calls.
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
  ctx.effect(() => () => { live = false }, 'show-chart: member directory check')
  void loader.await().then(() => {
    if (!live || perMember === (ctx.get('consoleMembers') !== undefined)) return
    logger.error(perMember
      ? 'perMember is set and no consoleMembers service is running now that the composition has loaded; the report route answers 503 until one is'
      : 'perMember is off and a consoleMembers service is running now that the composition has loaded; the report route takes a report for any session\'s call from any member')
  })
}
