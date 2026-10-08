/**
 * Which console member a status request comes from, for a row with
 * `perMember`.
 *
 * Every request is placed through `ctx.consoleMembers`, read at the moment it
 * arrives: 503 while no such service is running, and 401 when the service
 * places the request with nobody. A placed member reads the same document as
 * every other member: the organization set lists the trial entries of every
 * trial, and which member is in a trial is the organization plugin's to know.
 * Without `perMember` every request is answered, as in a process that serves
 * one person.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/members
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.loader, whose settling is when a mismatched composition is reported.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: resolves ctx.consoleMembers, which places each request.
import type {} from '@deepseek-ai/dsh-experimental-console-members/types'

/** Why a status request is refused before it is answered. */
export interface RequestRefusal {
  /** 503 while no member directory runs, 401 when it places the request with nobody. */
  readonly status: 401 | 503
  /** The refusal's text, naming the route and the missing piece and no value the request carried. */
  readonly error: string
}

/**
 * How a row places the status requests it answers.
 * @param req - the request.
 * @returns the refusal, or `undefined` when the request is answered.
 */
export type PlaceRequest = (req: IncomingMessage) => RequestRefusal | undefined

/**
 * Answer every request, as a row without `perMember` does.
 * @returns `undefined`, for every request.
 */
export const admitEveryRequest: PlaceRequest = () => undefined

/**
 * Answer only a request `ctx.consoleMembers` places with a member.
 * @param ctx - the row's context, which the member directory is read from per request.
 * @returns the placement the status route calls before answering.
 */
export function placeRequestByMember(ctx: Context): PlaceRequest {
  return (req) => {
    const members: Context['consoleMembers'] | undefined = ctx.get('consoleMembers')
    if (members === undefined) {
      return { status: 503, error: 'skill-pack: the pack status route needs the consoleMembers service, which is not running' }
    }
    if (members.principalOfRequest(req) === undefined) {
      return { status: 401, error: 'skill-pack: the pack status route could not tell which member sent this request' }
    }
    return undefined
  }
}

/**
 * Report, once the composition has loaded, a `perMember` setting that does not
 * match whether a member directory is running: a per-member row with no
 * directory answers every status request 503, and a row without `perMember`
 * beside a running directory answers anyone who reaches the route.
 *
 * Cordis has no host-ready event; the Loader tree settling is the point at
 * which every configured row has had its chance to start. A context with no
 * Loader — a row applied by hand — has no such point and reports nothing.
 * @param ctx - the row's context.
 * @param perMember - the row's `perMember` setting.
 */
export function reportDirectoryMismatch(ctx: Context, perMember: boolean): void {
  const loader = ctx.get('loader')
  if (loader === undefined) return
  let live = true
  ctx.effect(() => () => { live = false }, 'skill-pack: member directory check')
  void loader.await().then(() => {
    if (!live || perMember === (ctx.get('consoleMembers') !== undefined)) return
    ctx.logger.error(perMember
      ? 'skill-pack: perMember is set and no consoleMembers service is running now that the composition has loaded; the pack status route answers 503 until one is'
      : 'skill-pack: perMember is off and a consoleMembers service is running now that the composition has loaded; the pack status route answers any request without placing it with a member')
  })
}
