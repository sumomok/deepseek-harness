/**
 * Test-only `consoleMembers` row: a member directory that places requests and
 * sessions from tables in its own config, records the customer credential
 * reader it is lent, and accepts one reader at a time: a second while one is
 * attached is refused, and another is accepted once the first is released.
 * Mounted by file URL from a test-only cordis.yml; no shipped profile names it.
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
import type { PrincipalKey } from '@deepseek-ai/dsh-experimental-biz-backend'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import type { ConsoleMemberDirectory, CustomerCredentialReader } from '@deepseek-ai/dsh-experimental-console-members'

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
  /** Refuse every reader offered, as a directory that already holds one does. */
  refuseReader?: boolean
  /** Throw from the disposer of an accepted reader, after recording the release. */
  throwOnRelease?: boolean
}

export const Config: z<Config> = z.object({
  requests: z.dict(z.string()).required(),
  sessions: z.dict(z.string()).required(),
  parents: z.dict(z.string()).required(),
  refuseReader: z.boolean().default(false),
  throwOnRelease: z.boolean().default(false),
})

/**
 * Refuse a directory member auth-gate never calls, so a spec that reaches one fails.
 * @param member - the member that was called.
 * @returns nothing; it always throws.
 * @throws {Error} always.
 */
function uncalled(member: string): never {
  throw new Error(`console-members fixture: auth-gate does not call ${member}`)
}

/** The directory members auth-gate never calls, each refusing with {@link uncalled}. */
export const UNCALLED_MEMBERS: Pick<ConsoleMemberDirectory, 'principalOfCaller' | 'memberRoot' | 'rootsOf' | 'principals' | 'onChange' | 'memberStore'> = {
  principalOfCaller: () => uncalled('principalOfCaller'),
  memberRoot: () => uncalled('memberRoot'),
  rootsOf: () => uncalled('rootsOf'),
  principals: () => uncalled('principals'),
  onChange: () => uncalled('onChange'),
  memberStore: () => uncalled('memberStore'),
}

/** The directory this row provides, with what it was lent kept for the test to read. */
export class ConsoleMembersFixture implements ConsoleMemberDirectory {
  readonly principalOfCaller = UNCALLED_MEMBERS.principalOfCaller
  readonly memberRoot = UNCALLED_MEMBERS.memberRoot
  readonly rootsOf = UNCALLED_MEMBERS.rootsOf
  readonly principals = UNCALLED_MEMBERS.principals
  readonly onChange = UNCALLED_MEMBERS.onChange
  readonly memberStore = UNCALLED_MEMBERS.memberStore
  /** The reader currently lent, if any. */
  reader: CustomerCredentialReader | undefined
  /** How many readers were accepted. */
  attaches = 0
  /** How many accepted readers were released. */
  releases = 0
  /** Every reader ever offered, refused ones included. */
  readonly offered: CustomerCredentialReader[] = []

  constructor(private readonly config: Config) {}

  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined {
    const assertion = req.headers[MEMBER_HEADER]
    if (typeof assertion !== 'string' || !Object.hasOwn(this.config.requests, assertion)) return undefined
    return brandString<PrincipalKey>(this.config.requests[assertion]!)
  }

  principalOfSession(sessionId: SessionId): PrincipalKey | undefined {
    let current: string = sessionId
    const visited = new Set<string>()
    while (Object.hasOwn(this.config.parents, current)) {
      if (visited.has(current)) return undefined
      visited.add(current)
      current = this.config.parents[current]!
    }
    if (!Object.hasOwn(this.config.sessions, current)) return undefined
    return brandString<PrincipalKey>(this.config.sessions[current]!)
  }

  attachCustomerCredentials(reader: CustomerCredentialReader): () => void {
    this.offered.push(reader)
    if (this.config.refuseReader === true || this.reader !== undefined) {
      throw new Error('console-members fixture: a customer credential reader is already attached')
    }
    this.reader = reader
    this.attaches += 1
    return () => {
      this.reader = undefined
      this.releases += 1
      if (this.config.throwOnRelease === true) throw new Error('console-members fixture: release failed')
    }
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
