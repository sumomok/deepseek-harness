/**
 * Test-only `consoleMembers` row: a member directory that places requests and
 * sessions from tables in its own config and keeps each member's store in
 * memory. A test reaches the row's instance to seed a store, to hold the next
 * write until it is released, to make writes fail, or to make placing one
 * session throw. Mounted by file URL or as a Loader builtin from a test-only
 * composition; no shipped profile names it.
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
import type { ConsoleMemberDirectory, MemberStore, PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
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
 * Refuse a directory member server-sidebar never calls, so a spec that reaches one fails.
 * @param member - the member that was called.
 * @returns nothing; it always throws.
 * @throws {Error} always.
 */
function uncalled(member: string): never {
  throw new Error(`console-members fixture: server-sidebar does not call ${member}`)
}

/** One member's store key: the member and the unit, which cannot contain the separator. */
function storeKey(principal: string, unit: string): string {
  return `${principal}\u0000${unit}`
}

/** The directory this row provides, with each member's store kept for the test to read. */
export class ConsoleMembersFixture implements ConsoleMemberDirectory {
  readonly principalOfCaller = () => uncalled('principalOfCaller')
  readonly memberRoot = () => uncalled('memberRoot')
  readonly rootsOf = () => uncalled('rootsOf')
  readonly principals = () => uncalled('principals')
  readonly onChange = () => uncalled('onChange')
  readonly attachCustomerCredentials = () => uncalled('attachCustomerCredentials')
  /** Every stored value, by member and unit. */
  readonly stored = new Map<string, JsonValue>()
  /** Every unit a store was asked for. */
  readonly units: string[] = []
  /** How many times a request was placed. */
  placements = 0
  /** How many reads reached a store. */
  reads = 0
  /** How many writes are waiting on {@link ConsoleMembersFixture.holdNextWrite}. */
  held = 0
  /** Make every write reject. */
  failWrites = false
  /** Session ids whose placement throws. */
  readonly failingSessions = new Set<string>()
  private hold: Promise<void> | undefined

  constructor(private readonly config: Config) {}

  /**
   * Hold the next write until the returned call releases it.
   * @returns the release.
   */
  holdNextWrite(): () => void {
    let release = (): void => {}
    this.hold = new Promise<void>((resolveHold) => { release = resolveHold })
    return () => { release() }
  }

  /**
   * One member's stored value for one unit.
   * @param principal - the member key.
   * @param unit - the unit.
   * @returns what is stored, or `undefined`.
   */
  value(principal: string, unit: string): JsonValue | undefined {
    return this.stored.get(storeKey(principal, unit))
  }

  /**
   * Store a value for one member and unit, as an earlier write would have.
   * @param principal - the member key.
   * @param unit - the unit.
   * @param value - the value.
   */
  seed(principal: string, unit: string, value: JsonValue): void {
    this.stored.set(storeKey(principal, unit), value)
  }

  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined {
    this.placements += 1
    const assertion = req.headers[MEMBER_HEADER]
    if (typeof assertion !== 'string' || !Object.hasOwn(this.config.requests, assertion)) return undefined
    return brandString<PrincipalKey>(this.config.requests[assertion]!)
  }

  principalOfSession(sessionId: SessionId): PrincipalKey | undefined {
    if (this.failingSessions.has(sessionId)) throw new Error('console-members fixture: the session could not be placed')
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

  memberStore(principal: PrincipalKey, unit: string): MemberStore {
    this.units.push(unit)
    const key = storeKey(principal, unit)
    return {
      read: () => {
        this.reads += 1
        return Promise.resolve(this.stored.get(key))
      },
      write: async (value) => {
        const hold = this.hold
        this.hold = undefined
        if (hold !== undefined) {
          this.held += 1
          await hold
          this.held -= 1
        }
        if (this.failWrites) throw new Error('console-members fixture: the store refused the write at /private/members/dir-1/server-sidebar.json')
        this.stored.set(key, structuredClone(value))
      },
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
