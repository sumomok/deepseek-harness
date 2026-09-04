/**
 * What the footer's sign-out button does, in five steps and one fixed order.
 *
 * 1. **Stop the work in progress**, for at most `STOP_TURNS_TIMEOUT_MS`. A
 *    turn left running would go on spending the deployment's credentials as a
 *    person who has just left; a cancel that never answers must not keep the
 *    visitor on the page in its place, so the wait is bounded and steps 2 to 5
 *    run whatever it did.
 * 2. **`POST /auth-gate/logout`**, so the process stops spending the access
 *    token it holds. `keepalive`, because step 5's navigation would otherwise
 *    cancel a request the document owns — which is also why the sequence
 *    sends this request rather than waiting on it: a route that never answers
 *    would otherwise hold the visitor on a page whose work is already stopped
 *    and whose token is one step from being dropped.
 * 3. **Remove the login page's stored keys, by name.** Never
 *    `localStorage.clear()`: this origin also carries the shell's own private
 *    keys and, in a deployment that serves other applications from it, theirs
 *    — a blanket clear would sign the visitor out of things this button never
 *    promised to touch.
 * 4. **Clear the mirror cookie**, so the reverse proxy in front of this
 *    process stops being handed a token the visitor has given up.
 * 5. **Leave for the login page**, carrying the address to come back to: the
 *    page the visitor was on, with the login page's own credential parameters
 *    taken out of its query and its fragment alike.
 *
 * Steps 2 to 5 duplicate what `@deepseek-ai/dsh-experimental-auth-gate`'s own
 * `leaveForLogin` does when it detects a token that is gone or expired; the
 * two routes, the cookie line, and the return-address rule here are literal
 * copies of that package's, not imports of it (`packages/client/AGENTS.md`'s
 * export-discipline section), and the sidebar must also work in a composition
 * that does not compose auth-gate — where the settings read fails, the button
 * reports that and stays put. The copies must keep step with that package; see
 * this package's README.
 *
 * Nothing here is model-visible: no session event carries it, and a model
 * request can reach none of it. Cancelling a turn is the one step a model
 * could observe at all, and only as the interruption it already sees when a
 * person presses stop.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/sign-out
 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls dsh-client-ui-conversation's `ctx.conversation` Context
// merge, which is what a session scope resolves the cancel face out of.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Must match `@deepseek-ai/dsh-experimental-auth-gate`'s `AUTH_GATE_SETTINGS_ROUTE`. */
const AUTH_GATE_SETTINGS_ROUTE = '/auth-gate/settings'

/** Must match `@deepseek-ai/dsh-experimental-auth-gate`'s `AUTH_GATE_LOGOUT_ROUTE`. */
const AUTH_GATE_LOGOUT_ROUTE = '/auth-gate/logout'

/**
 * How long step 1 may wait for the turns it asked to stop.
 *
 * A protocol-side upper bound, not a deployment choice: its whole job is to
 * keep one cancel that never answers from holding the visitor on a page they
 * asked to leave, and every step after it is what actually drops the token. A
 * host that has not answered in this long is one the browser is about to stop
 * talking to anyway.
 */
const STOP_TURNS_TIMEOUT_MS = 3000

/**
 * The login page's own storage keys, removed by name on the way out.
 *
 * A contract with the deployment's login page (toy-core), not a choice this
 * package makes: it writes the token, its clock, its encryption flag, its
 * renewal clock, two copies of the signed-in person's profile, an
 * application-permission table, and the alternate credential it accepts in a
 * query parameter — each also in an `…Auth` spelling the same page writes for
 * its own second sign-on. Everything the page put there goes; everything
 * anyone else put there stays.
 */
const SIGNED_OUT_STORAGE_KEYS = [
  'accessToken',
  'accessTokenTime',
  'accessTokenEncrypt',
  'accessTokenRenewalTime',
  'userInfo',
  'loginUserInfo',
  'AP',
  'token4a',
  'accessTokenAuth',
  'accessTokenTimeAuth',
  'accessTokenEncryptAuth',
  'accessTokenRenewalTimeAuth',
] as const

/** The two configured values signing out needs, as auth-gate's settings route answers them. */
export interface AuthGateBrowserSettings {
  /** Where the visitor is sent, with `?redirect=<the encoded return address>` appended. */
  loginUrl: string
  /** Cookie the access token is mirrored into. */
  cookieName: string
}

/**
 * The browser operations signing out performs, injected so the sequence runs
 * without a DOM and without a live session tree.
 */
export interface SignOutBrowser {
  /** Stop whatever turn is running, in the current conversation and in any other that has one. */
  stopTurns(): Promise<void>
  /**
   * Remove one stored key.
   * @param key - the key to remove.
   */
  removeStoredKey(key: string): void
  /**
   * Assign one line to the page's cookie jar.
   * @param line - the assignment, already formed.
   */
  writeCookieLine(line: string): void
  /** The address the visitor is on, which is also the address they come back to. */
  currentHref(): string
  /**
   * Leave for another address.
   * @param url - where to go.
   */
  navigate(url: string): void
}

/**
 * The line that removes one mirrored cookie from the whole origin.
 *
 * Byte-for-byte auth-gate's own `clearCookieLine`, and it must stay that way:
 * a browser matches a removal against an existing cookie by name, path, and
 * domain, so a line differing in the path writes a second, empty cookie and
 * leaves the mirrored token in place. A deployment served under a base path
 * changes `Path` in both packages together or in neither.
 * @param name - the cookie name.
 * @returns the assignment for `document.cookie`.
 */
function clearCookieLine(name: string): string {
  return `${name}=; Path=/; Secure; SameSite=Lax; Max-Age=0`
}

/**
 * Query parameters the deployment's login page reads a credential out of. A
 * return address carrying one would hand the login page a token this sequence
 * has just thrown away, and would leave that token in the browser's history
 * and in every referrer the login page sends.
 */
const CREDENTIAL_QUERY_PARAMS = new Set(['token', 'token4a'])

/**
 * One query parameter's name, as written.
 * @param pair - one `&`-separated piece of a query string.
 * @returns the text before the first `=`, or the whole piece when it carries none.
 */
function parameterName(pair: string): string {
  const at = pair.indexOf('=')
  return at === -1 ? pair : pair.slice(0, at)
}

/**
 * One piece of an address with the login page's credential parameters removed
 * from its query.
 *
 * The remaining query is spliced textually rather than re-serialized, so every
 * parameter the page was asked for comes back encoded exactly as it arrived.
 * @param piece - a path whose query, if it has one, starts at its first `?`.
 * @returns the same piece without `token` and `token4a`.
 */
function withoutCredentials(piece: string): string {
  const queryAt = piece.indexOf('?')
  if (queryAt === -1) return piece
  const kept = piece.slice(queryAt + 1).split('&')
    .filter(pair => !CREDENTIAL_QUERY_PARAMS.has(parameterName(pair)))
  return `${piece.slice(0, queryAt)}${kept.length === 0 ? '' : `?${kept.join('&')}`}`
}

/**
 * The address the visitor comes back to after signing in again: the page they
 * were on, with the login page's own credential parameters removed from the
 * query and from the fragment alike, and everything else left as it stands.
 *
 * The fragment gets the same treatment as the query because the login page
 * reads a parameter out of the whole address rather than out of its query:
 * toy-core's `getUrlParam` parses everything past the first `?` in
 * `location.href`, so a credential sitting in the fragment is one that page
 * reads — and removing only the query's would uncover it, by taking away the
 * `?` that was hiding it. Every other parameter, and the fragment's own path,
 * survive: these pages are hash-routed, so the fragment is the address of the
 * page the visitor comes back to.
 *
 * `CREDENTIAL_QUERY_PARAMS`, {@link parameterName}, {@link withoutCredentials}
 * and this function are literal copies of
 * `@deepseek-ai/dsh-experimental-auth-gate`'s own (`client/gate.ts`), for the
 * reason this module's doc gives for the routes and the cookie line. The two
 * must change together: the login page one of them sends a visitor to is the
 * login page the other one does.
 * @param currentHref - the page the visitor is on.
 * @returns the return address.
 */
function returnAddress(currentHref: string): string {
  const hashAt = currentHref.indexOf('#')
  if (hashAt === -1) return withoutCredentials(currentHref)
  const beforeHash = withoutCredentials(currentHref.slice(0, hashAt))
  return `${beforeHash}#${withoutCredentials(currentHref.slice(hashAt + 1))}`
}

/**
 * Read the two values auth-gate serves its own browser half.
 * @returns the settings that package's node half serves.
 * @throws {Error} when the route is unreachable, answers non-200, or answers
 * a document with no usable login address or cookie name — which is also what
 * a composition without auth-gate looks like from here.
 */
export async function readAuthGateSettings(): Promise<AuthGateBrowserSettings> {
  const response = await fetch(AUTH_GATE_SETTINGS_ROUTE, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`server-sidebar: ${AUTH_GATE_SETTINGS_ROUTE} answered ${String(response.status)}`)
  }
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  const { loginUrl, cookieName } = await response.json() as Partial<AuthGateBrowserSettings>
  if (typeof loginUrl !== 'string' || loginUrl.length === 0) {
    throw new Error(`server-sidebar: ${AUTH_GATE_SETTINGS_ROUTE} answered an unusable loginUrl: ${JSON.stringify(loginUrl)}`)
  }
  if (typeof cookieName !== 'string' || cookieName.length === 0) {
    throw new Error(`server-sidebar: ${AUTH_GATE_SETTINGS_ROUTE} answered an unusable cookieName: ${JSON.stringify(cookieName)}`)
  }
  return { loginUrl, cookieName }
}

/**
 * Resolve one session's cancel face, the way `dsh-client-ui-conversation`'s
 * own stop button resolves it (`scopedConversation` in its `apply.ts`) —
 * copied rather than imported, since that package exports no such helper.
 * @param ctx - client root context carrying the session tree.
 * @param sessionId - the session to address.
 * @returns the session-scoped conversation face.
 * @throws {Error} when the session resolves no scope, or the scope carries no
 * conversation service.
 */
function scopedConversation(ctx: ClientContext, sessionId: SessionId): { cancel: () => Promise<void> } {
  const scoped = ctx.sessions.scope(sessionId)
  if (scoped === undefined) throw new Error(`server-sidebar: "${sessionId}" resolved no scope`)
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('server-sidebar: conversation service unavailable through the scope')
  return conversation
}

/**
 * Stop the turn running in the current conversation, and in every other one
 * the session list reports as running.
 *
 * `SessionSummary.running` is the judgement: it is the host-pushed bit tied to
 * actual execution, the same one the shipped session list draws its activity
 * state from. The current conversation is stopped whether or not it carries
 * that bit — an idle stop is a no-op the host answers, while trusting the bit
 * for the one conversation the visitor is looking at would make signing out
 * depend on a push arriving first.
 *
 * A refusal is reported and does not stop the sweep: the visitor is leaving
 * either way, and a conversation that could not be stopped is a warning, not
 * a reason to leave the rest running.
 * @param ctx - client root context carrying the session list and scope tree.
 * @returns nothing, once every target has been asked to stop.
 */
export async function stopRunningTurns(ctx: ClientContext): Promise<void> {
  const { ids, byId, current } = ctx.sessions.list.getSnapshot()
  const targets = ids.filter(id => byId[id]?.running === true)
  if (current !== undefined && !targets.includes(current)) targets.push(current)
  for (const sessionId of targets) {
    try {
      await scopedConversation(ctx, sessionId).cancel()
    } catch (error) {
      console.warn(`server-sidebar: could not stop the work in progress in "${sessionId}"`, error)
    }
  }
}

/**
 * Tell the node half of auth-gate to drop the token it holds.
 *
 * The request declares `application/json` and carries no body, and that
 * route reads none: the declaration withdraws it from the set a cross-origin
 * page can post without a preflight. A refusal is a warning — the visitor is
 * leaving, and the token stops being reachable from the browser one step
 * later either way.
 *
 * The caller does not wait on the returned promise (see this module's doc),
 * so this function reports every outcome itself and settles for nobody.
 * @returns nothing, once the route has answered or failed.
 */
async function postLogout(): Promise<void> {
  try {
    const response = await fetch(AUTH_GATE_LOGOUT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    })
    if (!response.ok) {
      console.warn(`server-sidebar: ${AUTH_GATE_LOGOUT_ROUTE} answered ${String(response.status)}`)
    }
  } catch (error) {
    console.warn(`server-sidebar: ${AUTH_GATE_LOGOUT_ROUTE} could not be reached`, error)
  }
}

/**
 * Run one leaving step, reporting a refusal instead of abandoning the steps
 * after it.
 *
 * The page operations signing out performs can refuse: a browser told to
 * block this origin's site data throws from `localStorage.removeItem` and
 * from a cookie write, and a refusal there must not strand the visitor on the
 * page they asked to leave.
 * @param what - what the step was trying to do, named for the warning.
 * @param step - the step.
 */
function attempt(what: string, step: () => void): void {
  try {
    step()
  } catch (error) {
    console.warn(`server-sidebar: could not ${what}`, error)
  }
}

/**
 * Step 1, bounded: ask for the work in progress to stop, and give up waiting
 * after {@link STOP_TURNS_TIMEOUT_MS}.
 *
 * A refusal and a cancel that never settles are the same thing from here — the
 * visitor is leaving, and the steps that drop the token are the ones that must
 * not be skipped — so both are reported and neither propagates.
 * @param browser - the page's sessions, storage, cookies, and navigation.
 * @returns nothing, once the turns have stopped or the bound has passed.
 */
async function stopTurnsWithinBound(browser: SignOutBrowser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      browser.stopTurns(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`server-sidebar: the work in progress did not stop within ${String(STOP_TURNS_TIMEOUT_MS)}ms`)) },
          STOP_TURNS_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    console.warn('server-sidebar: could not stop the work in progress', error)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sign the visitor out: the five steps this module's doc states, in that
 * order, every one of them attempted whatever the one before it did.
 * @param browser - the page's sessions, storage, cookies, and navigation.
 * @param settings - auth-gate's login address and mirror cookie name.
 * @returns nothing, once every step has been attempted. It never rejects:
 * each step reports its own refusal, leaving the caller nothing to catch.
 */
export async function signOut(browser: SignOutBrowser, settings: AuthGateBrowserSettings): Promise<void> {
  await stopTurnsWithinBound(browser)
  void postLogout()
  for (const key of SIGNED_OUT_STORAGE_KEYS) {
    attempt(`remove the stored key "${key}"`, () => { browser.removeStoredKey(key) })
  }
  attempt('clear the mirror cookie', () => { browser.writeCookieLine(clearCookieLine(settings.cookieName)) })
  attempt('leave for the login page', () => {
    browser.navigate(`${settings.loginUrl}?redirect=${encodeURIComponent(returnAddress(browser.currentHref()))}`)
  })
}

/**
 * The sign-out browser, backed by the page's own globals and the live session
 * tree.
 * @param ctx - client root context carrying the session list and scope tree.
 * @returns the operations bound to `window`, `document`, and `localStorage`.
 */
export function windowSignOutBrowser(ctx: ClientContext): SignOutBrowser {
  return {
    stopTurns: () => stopRunningTurns(ctx),
    removeStoredKey: (key) => { localStorage.removeItem(key) },
    writeCookieLine: (line) => { document.cookie = line },
    currentHref: () => location.href,
    navigate: (url) => { location.href = url },
  }
}
