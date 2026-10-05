/**
 * @deepseek-ai/dsh-experimental-auth-gate — a deployment's own single sign-on,
 * wired into a dsh browser session.
 *
 * The node half serves the browser its gate settings, takes the access token
 * that browser found, and holds it in memory. It spends that token in the
 * deployment's own places: the forwarding route each configured MCP server
 * gets, where the token becomes the `Authorization` header of the request
 * going upstream, and — when `bizUpstream` is configured — `ctx.bizBackend`,
 * the reads of this deployment's data backend that
 * `@deepseek-ai/dsh-experimental-biz-backend` serves.
 *
 * It holds tokens in one of two ways. By default the process holds one token,
 * the newest any browser posted, for a deployment that runs one dsh process
 * per signed-in user behind a reverse proxy that verifies the token and picks
 * the process by it: every request reaching the process is that user's. With
 * `perMember`, one process serves several console members and holds one token
 * per member. The deployment's login gate verifies each visitor's token and
 * injects a signed member assertion into every request it passes on, and the
 * `consoleMembers` service verifies that assertion and answers which member a
 * request or a session belongs to; a posted token is held only for the member
 * its `principalClaim` names. That mode forwards to no MCP server.
 *
 * Trust: this package authenticates nobody. The token is accepted on its shape
 * alone, and per member on the one claim that names who it was issued to,
 * because the party that can verify its signature is the gate in front of this
 * process. What the token buys inside this process is exactly what that gate
 * already granted: reaching the MCP servers and the data backend this
 * deployment configured, as the person the gate admitted.
 *
 * The token is held in memory and written nowhere — no session event, no
 * settings document, no log line, no diagnostic. It is dropped when the browser
 * half gives it up, which is what the sign-out route is for; when the data
 * backend refuses it; and otherwise when the process ends. Per member, each of
 * those drops that member's token and no other. Nothing else in the process can
 * read it, and nothing else is offered a name derived from it, with one
 * exception a deployment opts into: `shareWithMemberDirectory` lends the
 * `consoleMembers` service a reader of the per-member tokens, so that service,
 * and whatever it hands a token to, can read every member's token.
 * @module @deepseek-ai/dsh-experimental-auth-gate
 */

import type { IncomingMessage } from 'node:http'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  BizBackendService,
  BizOperationRules,
  requireBizOperationRules,
  type CredentialResolver,
  type HeldCredential,
  type PrincipalKey,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import { answerJson, decodeJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { holdMemberCredentials, memberSlotResolver, tokenClaim, type MemberCredentials } from './members.ts'
import { forwardWithToken, resolveUpstreams } from './proxy.ts'
import {
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  isOwnOriginPath,
  MAX_RENEWAL_INTERVAL_SECONDS,
  parseTokenPost,
  type AuthGateRenewalSettings,
  type AuthGateSettings,
} from './route.ts'

export {
  ACCESS_TOKEN_STORAGE_KEY,
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
} from './route.ts'
export type { AuthGateRenewalSettings, AuthGateSettings } from './route.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-gate'

/** Service required before the routes can be claimed. */
export const inject = ['webServer']

/** Plugin config: where a visitor signs in, how tokens are mirrored and held, and which MCP servers they are spent on. */
export interface Config {
  /**
   * Page an unauthenticated visitor is sent to. The browser half appends
   * `?redirect=<the encoded page it came from>`, so the value may not already
   * carry a query string. A hash-routed login page (`/sign-in/#/`) takes the
   * parameter inside its fragment, which is where a hash router reads it.
   *
   * A browser-side address, assigned as it stands: a deployment served under a
   * path prefix writes that prefix into the value, because nothing resolves it
   * against the deployment base. A login page outside the shell's prefix is a
   * valid choice, and it receives no mirror cookie — that cookie is scoped to
   * the prefix.
   */
  loginUrl: string
  /**
   * Cookie the browser half mirrors the access token into, so a request that
   * carries no `Authorization` header — a navigation, an image, an iframe —
   * still identifies the visitor to whatever sits in front of this process.
   */
  cookieName: string
  /**
   * How many seconds before expiry the browser half acts on the coming expiry.
   * Zero acts at the expiry instant.
   */
  refreshMarginSeconds: number
  /**
   * MCP servers this deployment forwards to, as route segment to absolute
   * target URL. Each entry claims `/auth-gate/mcp/<name>`; point the matching
   * `dsh-mcp-client` row's `url` at that path instead of at the server itself.
   * An empty table is the deployment that gates its browser and forwards
   * nothing.
   */
  mcpUpstreams: Record<string, string>
  /**
   * Base URL of this deployment's own data backend, ending in `/` and carrying
   * the deployment's API prefix — `https://<host>/ini-server/` for a standard
   * install. That prefix is the frontend's `VUE_APP_BASE_URL`, so it is read off
   * the deployment rather than assumed: an install built without one publishes
   * its API at the origin root instead.
   *
   * There is no default. Left out, the `bizBackend` service is not registered
   * at all, and a row that consumes it stays pending with the missing service
   * named — a deployment that does not offer a data backend says so by staying
   * silent, rather than by registering reads that always fail.
   */
  bizUpstream?: string
  /**
   * How the signed-in person's rights become what they may do with each data
   * model: one rule per operation (`read`, `metadata_read`, `create`, `update`,
   * `delete`, `import`, `export`), each either `row` — the rights table holds a
   * row for the model — or a list of the rights table's own flags, at least one
   * of which that row must grant. Every consumer of `ctx.bizBackend` that hides
   * or refuses something on this person's behalf judges by this one table.
   *
   * The defaults are what this deployment's backend enforces today: `row` for
   * `read`, `metadata_read` and `export`; `[add]`, `[update]` and `[delete]`
   * for the three writes; `[add, update]` for `import`. Validated at load
   * whether or not `bizUpstream` is set, and used only where it is.
   */
  bizOperationRules: BizOperationRules
  /**
   * The deployment's own renewal endpoint, as a path on the page's own origin —
   * `/<the API prefix>/nrms-auth/api/renewal` for a standard install, where the
   * prefix is the frontend's `VUE_APP_BASE_URL`. A browser-side address, like
   * `loginUrl`: a deployment served under a path prefix writes that prefix into
   * the value, because nothing resolves it against the deployment base.
   *
   * There is no default. Left out, this deployment offers no renewal and the
   * expiry margin sends the visitor back through the login page, which is the
   * one renewal route every deployment has. Set, it must be paired with
   * {@link Config.renewalIntervalSeconds}.
   */
  renewalPath?: string
  /**
   * How many seconds the browser half holds a token before asking the renewal
   * endpoint for a new one: above zero, and at most 2147483, which is as long
   * as a browser timer waits. The deployment's own client renews on its next
   * request once the token it holds is older than `accessTokenRenewalTime`
   * minutes, 30 by default; this is that rule as a timer, so a value well under
   * the token's lifetime is what keeps a console left open signed in.
   *
   * Required when {@link Config.renewalPath} is set, and refused when it is
   * not: an interval configured against no endpoint is a deployment that
   * believes it renews and does not.
   */
  renewalIntervalSeconds?: number
  /**
   * Hold one token per console member instead of one for the whole process.
   * Which member a request or a session belongs to is the `consoleMembers`
   * service's answer, and this package reads no identity header of its own:
   * while that service is not running, the token and sign-out routes answer
   * 503 and every data-backend read answers `unauthenticated`. A posted token
   * is held only for the member its {@link Config.principalClaim} names.
   *
   * Requires {@link Config.principalClaim}, and an empty
   * {@link Config.mcpUpstreams}: a forwarded MCP request comes from the MCP
   * client inside this process, so it names no member whose token it could
   * carry. The default is false, which holds one token for the process.
   */
  perMember?: boolean
  /**
   * The claim of a posted token's payload that names the member it was issued
   * to, compared against the member the request was admitted as before the
   * token is held — `login_uid` for a toy-core deployment. A string claim is
   * compared as it stands and a numeric one by its source digits, so a 19-digit
   * id is not rounded; an empty string, or any other value, names nobody.
   * Required when {@link Config.perMember} is set, and refused without it: a
   * claim configured for a process holding one token is a deployment that
   * believes it compares members and does not.
   */
  principalClaim?: string
  /**
   * Lend the `consoleMembers` service a reader of the per-member tokens, once
   * it is running: the service and whatever it hands a token to can then read
   * every member's token. The reader reads one member's token at a time and
   * reports when one is set or dropped; it lists nobody. Refused at load
   * without {@link Config.perMember}. The default is false, which lends
   * nothing.
   */
  shareWithMemberDirectory?: boolean
}

export const Config: z<Config> = z.object({
  loginUrl: z.string().required(),
  cookieName: z.string().required(),
  refreshMarginSeconds: z.natural().required(),
  mcpUpstreams: z.dict(z.string()).required(),
  bizUpstream: z.string(),
  bizOperationRules: BizOperationRules,
  renewalPath: z.string(),
  renewalIntervalSeconds: z.natural(),
  perMember: z.boolean().default(false),
  principalClaim: z.string(),
  shareWithMemberDirectory: z.boolean().default(false),
})

/**
 * Bytes a token document can possibly need: one JWT and the JSON around it. A
 * protocol bound, not a deployment choice — nothing the browser half posts is
 * larger.
 */
const MAX_TOKEN_POST_CHARS = 8 * 1024

/** How the token route names itself in a refusal. */
const TOKEN_ROUTE_LABEL = 'token route'

/** How the sign-out route names itself in a refusal. */
const LOGOUT_ROUTE_LABEL = 'sign-out route'

/**
 * Reject a login destination the browser half cannot build a redirect from.
 * @param loginUrl - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is empty or already carries a query string.
 */
function requireLoginUrl(loginUrl: string): string {
  if (loginUrl.length === 0) throw new Error('auth-gate: loginUrl must not be empty')
  if (loginUrl.includes('?')) {
    throw new Error(`auth-gate: loginUrl must carry no query string, received "${loginUrl}"`)
  }
  return loginUrl
}

/**
 * Reject a cookie name that cannot be written as one.
 * @param cookieName - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is not a bare cookie-name token.
 */
function requireCookieName(cookieName: string): string {
  if (!/^[\w!#$%&'*+.^`|~-]+$/.test(cookieName)) {
    throw new Error(`auth-gate: cookieName must be a bare cookie name, received "${cookieName}"`)
  }
  return cookieName
}

/**
 * Drop any user name and password written into an address, so a value the
 * parser accepted can still be quoted back.
 *
 * Hand-written rather than read off the parsed URL, because the callers are the
 * branches the parser accepted and the credentials check below passed: a value
 * `URL` reads as an opaque scheme keeps its whole authority, password included,
 * inside a path, where `username` and `password` are both empty. The authority
 * is what stands between the scheme separator and the first `/`, `?` or `#`
 * after it, and anything up to the last `@` inside it is the part a password
 * can be in.
 * @param raw - the address as it was configured.
 * @returns the address with its userinfo removed, unchanged where it has none.
 */
function withoutUserinfo(raw: string): string {
  const separator = raw.indexOf('://')
  const start = separator < 0 ? 0 : separator + 3
  const rest = raw.slice(start)
  const stop = rest.search(/[/?#]/)
  const authority = stop < 0 ? rest : rest.slice(0, stop)
  const at = authority.lastIndexOf('@')
  return at < 0 ? raw : raw.slice(0, start) + raw.slice(start + at + 1)
}

/**
 * Reject a data-backend base URL a read cannot be built onto.
 *
 * Loud at load, all of it: the value decides where the visitor's credential is
 * sent, and every fault below would otherwise surface as a request to the wrong
 * place rather than as a row that fails to start. It is also what
 * {@link BizBackendService} states as its own precondition on the base it is
 * given, so the check belongs to whoever configures that base.
 *
 * A refusal quotes the value only where the parser accepted it and reported no
 * credentials in it, and even then quotes it with its userinfo removed. A value
 * the parser refuses is quoted nowhere at all: it can carry a password that no
 * check here is able to recognize, and the load failure is read by whatever
 * collects this deployment's logs.
 * @param raw - the configured `bizUpstream` value.
 * @returns the same address, normalized by the URL parser.
 * @throws {Error} when the value is not an absolute http(s) URL, carries a
 * query string, a fragment, credentials of its own, or an empty path segment,
 * or has a path that does not end in `/`.
 */
function requireBizUpstream(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (_valueIsNotAbsolute) {
    // Quoting nothing at all, like the credentials check below it. A value the
    // parser refuses can still carry a password — `//user:secret@host/` and
    // `https://user:secret@host:99999/` are both refused here, and neither ever
    // reaches a check that could recognize one — so this branch names the field
    // and stops. The field name is what makes the fault findable; the common
    // value is a relative or misspelled address, a deployment prefix alone
    // (`/ini-server/`) being the usual one.
    throw new Error('auth-gate: bizUpstream must be an absolute URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Same reason: an address the parser read a password out of is one this
    // deployment must rewrite, and the field name is the whole of what has to
    // be said to get that done.
    throw new Error('auth-gate: bizUpstream must carry no credentials of its own')
  }
  // Every message below quotes this rendering rather than the value: the check
  // above misses a password inside an address the parser read as an opaque
  // scheme, where the authority is part of a path.
  const quoted = withoutUserinfo(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`auth-gate: bizUpstream must be an http or https URL, received "${quoted}"`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`auth-gate: bizUpstream must carry no query string or fragment, received "${quoted}"`)
  }
  if (!parsed.pathname.endsWith('/')) {
    // The deployment's API prefix is a path segment, and a base missing its
    // trailing slash reads as a sibling of that segment rather than its parent.
    throw new Error(`auth-gate: bizUpstream must end in "/", received "${quoted}"`)
  }
  if (parsed.pathname.includes('//')) {
    throw new Error(`auth-gate: bizUpstream must carry no empty path segment, received "${quoted}"`)
  }
  return parsed.href
}

/**
 * Reject a renewal configuration the browser half cannot spend a token on.
 *
 * Loud at load, in both directions: a path the browser cannot address would
 * surface as a renewal that quietly never happens and a visitor signed out
 * every time a token runs out, and an interval configured against no path is a
 * deployment that believes it renews and does not.
 *
 * The path is required to name this deployment's own origin because the value
 * decides where this visitor's credential is sent, and the browser half resolves
 * it against the page's own address: a value naming another origin — a
 * protocol-relative `//host/path`, or the `/\host/path` the URL parser reads as
 * one — would send the token off this deployment. {@link isOwnOriginPath}
 * answers that by resolving the value rather than by reading its first
 * characters.
 * @param path - the configured `renewalPath`, absent where this deployment
 * offers no renewal.
 * @param intervalSeconds - the configured `renewalIntervalSeconds`.
 * @returns the renewal settings to serve the browser half, or `undefined` where
 * no renewal is configured.
 * @throws {Error} when one field is configured without the other, when the path
 * is empty or is not a path on this deployment's own origin, or when the
 * interval is zero or longer than a browser timer waits.
 */
function requireRenewal(path: string | undefined, intervalSeconds: number | undefined): AuthGateRenewalSettings | undefined {
  if (path === undefined) {
    if (intervalSeconds !== undefined) {
      throw new Error('auth-gate: renewalIntervalSeconds needs a renewalPath to spend it on')
    }
    return undefined
  }
  if (path.length === 0) throw new Error('auth-gate: renewalPath must not be empty')
  if (!isOwnOriginPath(path)) {
    throw new Error(`auth-gate: renewalPath must be a path on this deployment's own origin, received "${path}"`)
  }
  if (intervalSeconds === undefined) {
    throw new Error('auth-gate: renewalPath needs a renewalIntervalSeconds to renew on')
  }
  if (intervalSeconds === 0) {
    throw new Error('auth-gate: renewalIntervalSeconds must be above zero')
  }
  // Refused rather than slept in links the way the expiry margin's own delay is:
  // an interval past what one browser timer carries names a schedule first
  // firing 24 days out, which no token this deployment issues lives to reach.
  if (intervalSeconds > MAX_RENEWAL_INTERVAL_SECONDS) {
    throw new Error(
      `auth-gate: renewalIntervalSeconds must be at most ${String(MAX_RENEWAL_INTERVAL_SECONDS)},`
      + ` which is as long as a browser timer waits, received ${String(intervalSeconds)}`,
    )
  }
  return { path, intervalSeconds }
}

/**
 * Reject a per-member configuration this package cannot honour.
 *
 * Loud at load, and naming fields only: a per-member process with no claim to
 * compare would hold a token for whichever member posted it, a forward has no
 * member to carry a token for, a reader lent while one token serves the whole
 * process would hand the member directory a token it cannot place, and a claim
 * configured without `perMember` is a deployment that believes it holds tokens
 * per member while one token serves everybody.
 * @param config - the row's configuration.
 * @returns the claim posted tokens are compared on, or `undefined` for a
 * process that holds one token.
 * @throws {Error} when `shareWithMemberDirectory` or a non-empty
 * `principalClaim` is set without `perMember`, or `perMember` is set with no
 * `principalClaim` or with a non-empty `mcpUpstreams`.
 */
function requireMemberHolding(config: Config): string | undefined {
  const claimed = config.principalClaim !== undefined && config.principalClaim !== ''
  if (config.perMember !== true) {
    if (config.shareWithMemberDirectory === true) {
      throw new Error('auth-gate: shareWithMemberDirectory needs perMember, because only per-member tokens are lent to the member directory')
    }
    if (claimed) {
      throw new Error('auth-gate: principalClaim needs perMember, because a process holding one token compares no claim')
    }
    return undefined
  }
  if (!claimed) {
    throw new Error('auth-gate: perMember needs a principalClaim naming the token claim each member is compared on')
  }
  if (Object.keys(config.mcpUpstreams).length > 0) {
    throw new Error('auth-gate: mcpUpstreams must be empty when perMember is set, because a forwarded MCP request comes from the MCP client inside this process and names no member')
  }
  return config.principalClaim
}

/**
 * The process's memory of one access token, as the three operations anything is
 * allowed to perform on it.
 *
 * A closure rather than a service: nothing outside this plugin and the reads it
 * hands the closure to may see the token, and the fewer places name it, the
 * fewer can leak it. There is no reader that returns it to a caller outside
 * this package.
 * @returns the three operations, closed over one token slot.
 */
function holdCredential(): HeldCredential {
  let held: string | undefined
  return {
    read: () => held,
    set: (token: string) => { held = token },
    // Both reasons reach the same terminal state, so the closure reads neither;
    // the parameter names which event dropped the token at each call site.
    drop: (_reason) => { held = undefined },
  }
}

/**
 * The key this process's one slot answers every browser request with.
 *
 * Process-local, and never compared against anything a request carries: one
 * person per process means every request reaching this process is that
 * person's, so a route names a principal subject here exactly as it would in a
 * process serving several people, and that subject resolves to the one slot.
 */
const SOLE_VISITOR: PrincipalKey = brandString<PrincipalKey>('auth-gate:sole-visitor')

/**
 * Resolve every subject to the one slot this process holds.
 *
 * Every session and every request in a process this package serves belongs to
 * the one person the proxy in front of it routed here, so the subject a read
 * names changes nothing about which token it spends.
 * @param credential - the process's one slot.
 * @returns the resolver {@link BizBackendService} finds that slot through.
 */
function soleSlotResolver(credential: HeldCredential): CredentialResolver {
  return {
    resolve: () => credential,
    principalOfRequest: () => SOLE_VISITOR,
  }
}

/** Why a token-route or sign-out request acts on no slot, answered before its body is read. */
interface Refusal {
  readonly kind: 'refused'
  readonly status: 401 | 503
  /** The refusal's text, naming the route and the missing piece and no value a request carried. */
  readonly error: string
}

/** The slot one token-route or sign-out request acts on. */
interface Admission {
  readonly kind: 'admitted'
  readonly slot: HeldCredential
  /**
   * Whether a posted token may be held in this slot.
   * @param token - the JWT-shaped token the request carried.
   * @returns false when the token names somebody other than the slot's owner.
   */
  owns(token: string): boolean
}

/** How this row holds tokens: which slot each route request acts on, and which one the data backend and the forwards reach. */
interface TokenHolding {
  /**
   * The slot a token-route request may set.
   * @param req - the request, whose body is still unread.
   * @returns the slot, or why the request is refused.
   */
  admitToken(req: IncomingMessage): Admission | Refusal
  /**
   * The slot a sign-out request drops.
   * @param req - the request.
   * @returns the slot, or why the request is refused.
   */
  admitSignOut(req: IncomingMessage): Admission | Refusal
  /** Where `ctx.bizBackend` finds each read's slot. */
  readonly resolver: CredentialResolver
  /** The slot every MCP forward spends, or `undefined` where no forward can name whose token to carry. */
  readonly forwarded: HeldCredential | undefined
}

/**
 * Hold one token for the whole process: every request acts on the one slot, and
 * every posted token may be held in it.
 * @returns the holding, forwards included.
 */
function holdForProcess(): TokenHolding {
  const credential = holdCredential()
  const admission: Admission = { kind: 'admitted', slot: credential, owns: () => true }
  return {
    admitToken: () => admission,
    admitSignOut: () => admission,
    resolver: soleSlotResolver(credential),
    forwarded: credential,
  }
}

/** Whether the member directory refused the reader lent to it, which keeps the token route shut until it is replaced. */
interface ReaderLoan {
  refused: boolean
}

/**
 * Lend the member directory a reader each time a `consoleMembers` service
 * starts, and take it back when that service stops or this row is disposed.
 *
 * The reader is a new one per service, so a directory that was replaced, or one
 * that refused it, holds a revoked reader rather than a live one; it is revoked
 * before the directory's release runs, so a release that throws does not keep
 * it live. A refusal is the directory's one-taker rule — it holds one reader at
 * a time and throws for another — and leaves the token route answering 503
 * until a service that accepts one starts. This row restarting while the
 * directory keeps running releases the old reader and attaches a new one to the
 * same directory.
 * @param ctx - this row's context.
 * @param credentials - the store the reader reads.
 * @param loan - the refusal state the token route reads.
 * @param logger - where a refusal is reported.
 */
function lendToMemberDirectory(ctx: Context, credentials: MemberCredentials, loan: ReaderLoan, logger: Logger): void {
  ctx.inject(['consoleMembers'], (scope) => {
    scope.effect(() => {
      const lent = credentials.lend()
      let release: (() => void) | undefined
      try {
        release = scope.consoleMembers.attachCustomerCredentials(lent.reader)
      } catch (_readerRefused) {
        // The directory's own error is not repeated: it is foreign text, and
        // this line names neither a member nor a token.
        logger.error('the consoleMembers service refused the customer credential reader; the token route answers 503 until that service is replaced')
        lent.revoke()
      }
      loan.refused = release === undefined
      return () => {
        loan.refused = false
        // Revoked before the directory's own release runs, so a release that
        // throws still leaves the stopped directory holding a dead reader.
        lent.revoke()
        release?.()
      }
    }, 'auth-gate: customer credential reader lent to consoleMembers')
  })
}

/**
 * Report, once the composition has loaded, a per-member row with no member
 * directory to place anybody.
 *
 * Cordis has no host-ready event; the Loader tree settling is the point at
 * which every configured row has had its chance to start. A context with no
 * Loader — a row applied by hand — has no such point and reports nothing.
 * @param ctx - this row's context.
 * @param logger - where the missing service is reported.
 */
function reportMissingDirectory(ctx: Context, logger: Logger): void {
  const loader = ctx.get('loader')
  if (loader === undefined) return
  let live = true
  ctx.effect(() => () => { live = false }, 'auth-gate: member directory check')
  void loader.await().then(() => {
    if (!live || ctx.get('consoleMembers') !== undefined) return
    logger.error('perMember is set and no consoleMembers service is running now that the composition has loaded; the token and sign-out routes answer 503 until one is')
  })
}

/**
 * Hold one token per console member.
 *
 * Every route request is placed through the `consoleMembers` service — refused
 * 503 while none is running and 401 when it places the request with nobody — and
 * a posted token is held only for the member its `principalClaim` names.
 * Forwards are not offered: the configuration check refuses `mcpUpstreams`.
 * @param ctx - this row's context.
 * @param claim - the token claim each member is compared on.
 * @param share - whether to lend the member directory a reader.
 * @returns the holding.
 */
function holdForMembers(ctx: Context, claim: string, share: boolean): TokenHolding {
  const logger = ctx.logger('auth-gate')
  const credentials = holdMemberCredentials((line) => { logger.error(line) })
  const loan: ReaderLoan = { refused: false }
  if (share) lendToMemberDirectory(ctx, credentials, loan, logger)
  reportMissingDirectory(ctx, logger)
  const admit = (req: IncomingMessage, what: string, takesToken: boolean): Admission | Refusal => {
    const members = ctx.get('consoleMembers')
    if (members === undefined) {
      return { kind: 'refused', status: 503, error: `auth-gate: the ${what} needs the consoleMembers service, which is not running` }
    }
    if (takesToken && loan.refused) {
      return {
        kind: 'refused',
        status: 503,
        error: `auth-gate: the ${what} takes no token while the consoleMembers service refuses the customer credential reader`,
      }
    }
    // Before the body is read: a request nobody is placed for has its token
    // left unparsed.
    const principal = members.principalOfRequest(req)
    if (principal === undefined) {
      return { kind: 'refused', status: 401, error: `auth-gate: the ${what} could not tell which member sent this request` }
    }
    return { kind: 'admitted', slot: credentials.slotOf(principal), owns: token => tokenClaim(token, claim) === principal }
  }
  return {
    admitToken: req => admit(req, TOKEN_ROUTE_LABEL, true),
    admitSignOut: req => admit(req, LOGOUT_ROUTE_LABEL, false),
    resolver: memberSlotResolver(ctx, credentials),
    forwarded: undefined,
  }
}

/**
 * Validate the configuration, then claim the settings route, the token route,
 * the sign-out route, one forwarding route per configured MCP upstream, and —
 * when a data backend is configured — the `bizBackend` service that reads it.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load, all of it: an unusable login destination would send every
  // visitor nowhere, a cookie name that cannot be written would make the gate
  // reload forever, a half-configured renewal would sign the visitor out every
  // time a token ran out, and a malformed upstream would answer the MCP client
  // with a route that fails only on the first tool call.
  const renewal = requireRenewal(config.renewalPath, config.renewalIntervalSeconds)
  const settings: AuthGateSettings = {
    loginUrl: requireLoginUrl(config.loginUrl),
    cookieName: requireCookieName(config.cookieName),
    refreshMarginSeconds: config.refreshMarginSeconds,
    ...renewal === undefined ? {} : { renewal },
  }
  const principalClaim = requireMemberHolding(config)
  const upstreams = resolveUpstreams(config.mcpUpstreams)
  // An unusable data-backend base would send this visitor's credential to the
  // wrong place, so it fails the row here as well. Absent or empty means this
  // deployment offers no data backend, and no service is registered for one.
  const bizUpstream = config.bizUpstream === undefined || config.bizUpstream === ''
    ? undefined
    : requireBizUpstream(config.bizUpstream)
  // A misspelled operation would leave the rule it meant to change at its
  // default, so the table fails the row here as well.
  const operationRules = requireBizOperationRules(config.bizOperationRules)
  const holding = principalClaim === undefined
    ? holdForProcess()
    : holdForMembers(ctx, principalClaim, config.shareWithMemberDirectory === true)
  // The service installs itself on the context and is withdrawn with this
  // plugin's fiber, so nothing here holds the instance. It exists only where a
  // data backend is configured.
  if (bizUpstream !== undefined) new BizBackendService(ctx, bizUpstream, holding.resolver, operationRules)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_SETTINGS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rejectMethod(res, 'GET, HEAD')
        return
      }
      // The browser half reads this once per boot and the values come from the
      // row it booted with, so a cached copy would outlive its own truth.
      answerJson(res, 200, settings)
    },
  }), 'auth-gate: browser settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_TOKEN_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(res, 'POST')
        return
      }
      if (rejectCrossSite(req, res, TOKEN_ROUTE_LABEL)) return
      if (rejectNonJson(req, res, TOKEN_ROUTE_LABEL)) return
      const admission = holding.admitToken(req)
      if (admission.kind === 'refused') {
        answerJson(res, admission.status, { error: admission.error })
        return
      }
      const text = await readBoundedText(req, MAX_TOKEN_POST_CHARS)
      const token = text === undefined ? undefined : parseTokenPost(decodeJson(text))
      if (token === undefined) {
        // The refusal names the field and nothing else: a diagnostic quoting
        // what was posted would put a credential in whatever reads it.
        answerJson(res, 400, { error: 'auth-gate: expected a JSON body whose "token" field is a JWT' })
        return
      }
      if (!admission.owns(token)) {
        // Not held, and nothing is dropped: the slot keeps whatever its owner
        // posted last. A browser that switched accounts while this post was in
        // flight is the usual sender.
        answerJson(res, 409, { error: 'auth-gate: the posted token names a different member than the one who sent it' })
        return
      }
      admission.slot.set(token)
      res.writeHead(204)
      res.end()
    },
  }), 'auth-gate: token route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_LOGOUT_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(res, 'POST')
        return
      }
      // Both halves of the fence the token route carries, for the same reason:
      // same-site alone leaves the route reachable by a cross-origin page as a
      // preflight-free simple request, because a request carrying no
      // `sec-fetch-site` at all passes it. Requiring `application/json`
      // withdraws it from that set, so a cross-origin page cannot sign a visitor
      // out of the deployment they are working in. No body is read even so — the
      // route names no token, it drops the one held for whoever sent it: the
      // one visitor a process holding one token serves, or the member the
      // request was admitted as.
      if (rejectCrossSite(req, res, LOGOUT_ROUTE_LABEL)) return
      if (rejectNonJson(req, res, LOGOUT_ROUTE_LABEL)) return
      const admission = holding.admitSignOut(req)
      if (admission.kind === 'refused') {
        answerJson(res, admission.status, { error: admission.error })
        return
      }
      admission.slot.drop('sign-out')
      res.writeHead(204)
      res.end()
    },
  }), 'auth-gate: sign-out route')

  const forwarded = holding.forwarded
  if (forwarded === undefined) return
  for (const upstream of upstreams) {
    const routePath = `${AUTH_GATE_MCP_PREFIX}/${upstream.name}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: routePath,
      handler: (req, res) => { forwardWithToken(req, res, { upstream, routePath, token: forwarded.read() }) },
    }), `auth-gate: "${upstream.name}" forwarding route`)
  }
}
