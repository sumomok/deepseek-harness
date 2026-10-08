/**
 * Test-only `consoleMembers` row: a member directory that places a request by
 * its `x-test-member` header, which stands in for the deployment's signed
 * member assertion, from a table in its own config. Mounted by file URL from a
 * test-only cordis.yml; no shipped profile names it.
 */

import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConsoleMemberDirectory, PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members/types'
import z from '@deepseek-ai/schemastery'

/** The header this fixture places a request by. */
export const MEMBER_HEADER = 'x-test-member'

/** Stable Cordis plugin name. */
export const name = 'console-members-fixture'

/** Where the fixture's answers come from. */
export interface Config {
  /** `x-test-member` value to the member key that request is placed with. */
  requests: Record<string, string>
}

export const Config: z<Config> = z.object({
  requests: z.dict(z.string()).required(),
})

/**
 * Refuse a directory member skill-pack never calls, so a spec that reaches one fails.
 * @param member - the member that was called.
 * @returns nothing; it always throws.
 * @throws {Error} always.
 */
function uncalled(member: string): never {
  throw new Error(`console-members fixture: skill-pack does not call ${member}`)
}

/** The directory this row provides. */
export class ConsoleMembersFixture implements ConsoleMemberDirectory {
  readonly principalOfSession = (): never => uncalled('principalOfSession')
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
}

/**
 * Provide the fixture directory as `consoleMembers`.
 * @param ctx - the row's context.
 * @param config - the table it answers from.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('consoleMembers', new ConsoleMembersFixture(config))
}
