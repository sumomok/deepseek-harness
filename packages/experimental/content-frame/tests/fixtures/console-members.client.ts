/**
 * Test-only `consoleMembers` row: a member directory that places requests and
 * sessions from tables in its own config. Mounted from a test-only cordis.yml;
 * no shipped profile names it.
 *
 * A request is placed by its `x-test-member` header, which stands in for the
 * deployment's signed member assertion. A session is placed through its parent
 * chain: a session listed in `parents` belongs to whoever its top-level
 * ancestor belongs to, and a chain with any link missing from the tables
 * belongs to nobody — the rule the real directory follows.
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConsoleMemberDirectory, PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

/** The header this fixture places a request by. */
export const MEMBER_HEADER = 'x-test-member'

/** Stable Cordis plugin name. */
export const name = 'console-members-fixture'

/** Where the fixture's answers come from. */
export interface Config {
  /** `x-test-member` value to the member key that request is placed with. */
  requests: Record<string, string>
  /** Top-level session id to the member key it belongs to. */
  sessions: Record<string, string>
  /** Child session id to its parent session id. */
  parents: Record<string, string>
}

export const Config: z<Config> = z.object({
  requests: z.dict(z.string()).required(),
  sessions: z.dict(z.string()).required(),
  parents: z.dict(z.string()).required(),
})

/**
 * Refuse a directory member the read routes never call, so a spec that reaches one fails.
 * @param member - the member that was called.
 * @returns nothing; it always throws.
 * @throws {Error} always.
 */
function uncalled(member: string): never {
  throw new Error(`console-members fixture: content-frame does not call ${member}`)
}

/** The directory this row provides. */
export class ConsoleMembersFixture implements ConsoleMemberDirectory {
  readonly principalOfCaller = (): never => uncalled('principalOfCaller')
  readonly memberRoot = (): never => uncalled('memberRoot')
  readonly rootsOf = (): never => uncalled('rootsOf')
  readonly principals = (): never => uncalled('principals')
  readonly onChange = (): never => uncalled('onChange')
  readonly memberStore = (): never => uncalled('memberStore')
  readonly attachCustomerCredentials = (): never => uncalled('attachCustomerCredentials')

  constructor(private readonly config: Config) {}

  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined {
    const assertion = req.headers[MEMBER_HEADER]
    if (typeof assertion !== 'string' || !Object.hasOwn(this.config.requests, assertion)) return undefined
    return brandString<PrincipalKey>(this.config.requests[assertion]!)
  }

  principalOfSession(sessionId: SessionId): PrincipalKey | undefined {
    let current: string = sessionId
    while (Object.hasOwn(this.config.parents, current)) current = this.config.parents[current]!
    if (!Object.hasOwn(this.config.sessions, current)) return undefined
    return brandString<PrincipalKey>(this.config.sessions[current]!)
  }
}

/**
 * Provide the fixture directory as `consoleMembers`.
 * @param ctx - the row's context.
 * @param config - the tables it answers from.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('consoleMembers', new ConsoleMembersFixture(config))
}
