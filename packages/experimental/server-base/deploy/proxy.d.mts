/**
 * Declarations for `proxy.mjs`, the deployment-layer login gate, so the
 * package's TypeScript tests import it with types. The behavior and every
 * contract stated here are owned by the JSDoc in `proxy.mjs`. This file is
 * maintained by hand: tests/deploy-proxy.spec.ts, which imports and calls each
 * declared export, is the only check that it matches the module.
 * @module @deepseek-ai/dsh-experimental-server-base/deploy/proxy
 */

import type { IncomingHttpHeaders, Server } from 'node:http'
import type { KeyObject } from 'node:crypto'

/** Request header that carries the member assertion to dsh. */
export const MEMBER_HEADER: 'x-dsh-member'
/** Seconds a member assertion stays valid after it is signed. */
export const ASSERTION_LIFETIME_SECONDS: 120

/** The optional claims checks; a check runs only when its field is set. */
export interface ClaimsPolicy {
  /** EXPECTED_ISS: the `iss` a token must carry. */
  expectedIss: string | undefined
  /** ALLOWED_TENANTS: a token's `tenants` must list one of these. */
  allowedTenants: string[] | undefined
  /** ALLOWED_APP_IDS: a token's `login_app_id` must be one of these. */
  allowedAppIds: string[] | undefined
}

/** What a presented credential claims before the authentication service is asked. */
export type Inspection = { ok: true; member: string; jti: string | undefined } | { ok: false; reason: string }

/** The gate's decision for one credential. */
export type Verification =
  | { outcome: 'admitted'; member: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'unavailable'; detail: string }

/** The login check with its cache and in-flight coalescing. */
export interface Gate {
  /** Decide one credential, cached and coalesced. */
  authorize(credential: string): Promise<Verification>
  /** Release the gate's outbound sockets. */
  close(): void
}

/** The log sink and clock the servers use. */
export interface Runtime {
  /** Receives every log line. */
  log(line: string): void
  /** The current time in milliseconds. */
  now(): number
}

/** Validated configuration read from the environment. */
export interface Settings {
  /** PROXY_MODE. */
  mode: 'proxy' | 'verify'
  /** LOGIN_GATE. */
  loginGate: boolean
  /** PROXY_HOST. */
  listenHost: string
  /** PROXY_PORT. */
  listenPort: number
  /** DSH_WEB_PORT, proxy mode only. */
  dshPort: number | undefined
  /** REMOTE_HOST, proxy mode only. */
  remoteHost: string | undefined
  /** REMOTE_PORT, proxy mode only. */
  remotePort: number | undefined
  /** AUTH_ORIGIN. */
  authOrigin: URL
  /** The contents of AUTH_CA_FILE. */
  authCa: Buffer | undefined
  /** AUTH_COOKIE. */
  authCookie: string
  /** AUTH_CHECK_PATH. */
  authCheckPath: string
  /** AUTH_CHECK_REPLY. */
  authCheckReply: 'renewal' | 'status'
  /** AUTH_CACHE_SECONDS. */
  authCacheSeconds: number
  /** The optional claims checks. */
  claims: ClaimsPolicy
  /** The signing key and audience, when this deployment signs. */
  assertion: { privateKey: KeyObject; deploymentId: string } | undefined
  /** DSH_LAUNCH_TOKEN_FILE, proxy mode only. */
  launchTokenFile: string | undefined
}

/**
 * The path dsh will route a request target as.
 * @param url - the raw request target.
 * @returns the pathname dsh matches routes against.
 */
export function requestPathname(url: string | undefined): string
/**
 * Whether a request path belongs to the remote application.
 * @param pathname - request path, query stripped.
 * @returns true when the remote origin owns it.
 */
export function isRemote(pathname: string): boolean
/**
 * Whether a dsh-routed path is reachable without a customer login.
 * @param pathname - request path, query stripped.
 * @returns true when the gate lets it through unchecked.
 */
export function isGateExempt(pathname: string): boolean
/**
 * Copy headers for one hop, removing any member header and attaching `assertion` when given.
 * @param headers - inbound headers.
 * @param host - replacement Host, or undefined to keep the inbound one.
 * @param assertion - a freshly signed member assertion, or undefined.
 * @returns headers for the next hop.
 */
export function forwardHeaders(headers: IncomingHttpHeaders, host: string | undefined, assertion?: string): Record<string, string | string[]>
/**
 * Strip the framing and cookie attributes that would break embedding the remote application.
 * @param headers - upstream response headers.
 * @returns headers for the client.
 */
export function remoteResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]>
/**
 * Read the mirrored customer token from a Cookie header as a credential.
 * @param header - the inbound Cookie header.
 * @param cookieName - the cookie the token is mirrored into.
 * @returns the credential, or undefined when there is no usable cookie.
 */
export function presentedCredential(header: string | undefined, cookieName: string): string | undefined
/**
 * Turn a credential carrier's value into the credential to present.
 * @param value - an Authorization header or decoded cookie value.
 * @returns the credential, or undefined when the value carries none.
 */
export function headerCredential(value: string | undefined): string | undefined
/**
 * Decode a JWT's payload claims without verifying it; numbers come back as their source digits.
 * @param token - the bare JWT.
 * @returns the payload object, or undefined when the token does not decode.
 */
export function decodeClaims(token: string): Record<string, unknown> | undefined
/**
 * The first configured claims check a token fails.
 * @param claims - decoded token claims.
 * @param policy - the configured checks.
 * @returns the failed check, or undefined when all pass.
 */
export function claimsRefusal(claims: Record<string, unknown>, policy: ClaimsPolicy): 'iss' | 'tenants' | 'app-id' | undefined
/**
 * What a presented credential claims before the authentication service is asked.
 * @param credential - the credential, scheme included.
 * @param policy - the configured claims checks.
 * @returns the member and `jti`, or the refusal reason.
 */
export function inspectCredential(credential: string, policy: ClaimsPolicy): Inspection
/**
 * Decide a credential from the authentication service's answer.
 * @param answer - the service's status and reply body.
 * @param identity - what the submitted token claims.
 * @param reply - whether the reply body is checked.
 * @returns the decision.
 */
export function verdictOf(answer: { status: number; body: string }, identity: { member: string; jti: string | undefined }, reply: 'renewal' | 'status'): Verification
/**
 * Sign one member assertion in the `v1.<payload>.<signature>` format.
 * @param member - the verified `login_uid`.
 * @param deploymentId - the audience.
 * @param privateKey - the Ed25519 private key.
 * @param nowSeconds - the issue time in Unix seconds.
 * @returns the assertion.
 */
export function signAssertion(member: string, deploymentId: string, privateKey: KeyObject, nowSeconds: number): string
/**
 * Read and validate the configuration from the environment.
 * @param env - the environment.
 * @param readFile - reads the key and trust-store files.
 * @returns the validated settings.
 */
export function readSettings(env: Record<string, string | undefined>, readFile?: (path: string) => Buffer): Settings
/**
 * The login check against the authentication service.
 * @param settings - validated settings.
 * @param runtime - the log sink and clock.
 * @returns the gate.
 */
export function createGate(settings: Settings, runtime: Runtime): Gate
/**
 * Build the unlistened PROXY_MODE=proxy server.
 * @param settings - validated settings.
 * @param runtime - the log sink and clock.
 * @returns the server and its gate.
 */
export function createProxyServer(settings: Settings, runtime: Runtime): { server: Server; gate: Gate }
/**
 * Build the unlistened PROXY_MODE=verify server for nginx `auth_request`.
 * @param settings - validated settings.
 * @param runtime - the log sink and clock.
 * @returns the server and its gate.
 */
export function createVerifierServer(settings: Settings, runtime: Runtime): { server: Server; gate: Gate }
