/** Test fixtures for the directory row: signed assertions, a workspace registry stand-in, and two ways to mount the row. */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { basename, join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import {
  HostConnectionService,
  apply as applyConnection,
  inject as connectionInject,
  type ConnectionTrustRequest,
  type PeerAdmission,
} from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { expect } from 'vitest'
import { browserCookie, provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { Config, apply, inject, name } from '../src/index.ts'
import { captureLogs, type TempHome } from './support.ts'

/** The deployment's signing key pair. */
export const signer = generateKeyPairSync('ed25519')

/** The verification key as the row's Config takes it. */
export const PUBLIC_PEM = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** The deployment id every fixture row is configured with. */
export const DEPLOYMENT_ID = 'deployment-s3-4417'

/**
 * Sign arbitrary payload text in the assertion format.
 * @param payloadJson - the payload text, JSON or not.
 * @param key - the signing key.
 * @returns `v1.<payload>.<signature>`.
 */
export function signPayload(payloadJson: string, key: KeyObject = signer.privateKey): string {
  const signed = `v1.${Buffer.from(payloadJson, 'utf8').toString('base64url')}`
  return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), key).toString('base64url')}`
}

/**
 * A well-formed assertion for one member.
 * @param principal - the member's `login_uid`.
 * @param exp - the expiry in Unix seconds.
 * @returns the signed assertion.
 */
export function assertionFor(principal: string, exp: number = nowSeconds() + 120): string {
  return signPayload(JSON.stringify({ p: principal, aud: DEPLOYMENT_ID, exp }))
}

/** @returns the current Unix time in whole seconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * The row's Config with the three required fields.
 * @param temp - the test's directories.
 * @param overrides - fields to add or replace.
 * @returns the Config.
 */
export function rowConfig(temp: TempHome, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { assertionPublicKey: PUBLIC_PEM, deploymentId: DEPLOYMENT_ID, membersRoot: join(temp.base, 'members'), ...overrides }
}

/** A workspace registry stand-in that records each `create`. */
export interface FakeWorkspaces {
  readonly created: string[]
  create(path: string): Promise<Workspace>
}

/** @returns a workspace registry stand-in whose `create` succeeds at once. */
export function fakeWorkspaces(): FakeWorkspaces {
  const created: string[] = []
  return {
    created,
    create: (path) => {
      created.push(path)
      return Promise.resolve({ id: `workspace-${String(created.length)}`, path, title: basename(path), createdAt: '', updatedAt: '' } as Workspace)
    },
  }
}

/** The row plugin as `ctx.plugin` takes it. */
export const ROW = { name, inject, Config, apply }

/** A mounted row and what the test reads from it. */
export interface MountedRow {
  readonly ctx: Context
  /** The row's fiber; `undefined` when the row was not loaded. */
  fiber: Fiber | undefined
  /** Every log line written under the root. */
  readonly lines: string[]
  readonly workspaces: FakeWorkspaces
  /** Load the row again, or for the first time, with the given Config. */
  load(config: Record<string, unknown>): Promise<Fiber>
}

const roots: Context[] = []

/** Dispose every root a fixture mounted. Call from `afterEach`. */
export async function disposeMounted(): Promise<void> {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
}

/**
 * Provide the stand-in workspace registry and return the row loader.
 * @param ctx - the root.
 * @param lines - the root's log lines.
 * @returns the mounted row, not yet loaded.
 */
function rowOn(ctx: Context, lines: string[]): MountedRow {
  const workspaces = fakeWorkspaces()
  ctx.provide('workspaceRegistry', workspaces as never)
  const mounted: MountedRow = {
    ctx,
    fiber: undefined,
    lines,
    workspaces,
    load: async (config) => {
      const fiber = ctx.plugin(ROW, config as never)
      mounted.fiber = fiber
      await fiber.await()
      return fiber
    },
  }
  return mounted
}

/** Browser authentication that accepts every request, for admission tests without HTTP. */
const ACCEPT_EVERY_BROWSER = { isAuthenticated: (_request: ConnectionTrustRequest) => true } as BrowserAuth

/**
 * Mount the row next to a Connection without a Web server; requests are
 * admitted by calling `ctx.connection.admit` directly.
 * @param config - the row's Config, or `undefined` to leave it unloaded.
 * @param requireAdmitter - Connection's `requireAdmitter`.
 * @returns the mounted row.
 */
export async function mountRow(config: Record<string, unknown> | undefined, requireAdmitter = true): Promise<MountedRow> {
  const ctx = new Context()
  roots.push(ctx)
  const lines = captureLogs(ctx)
  new HostConnectionService(ctx, [], ACCEPT_EVERY_BROWSER, requireAdmitter)
  const mounted = rowOn(ctx, lines)
  if (config !== undefined) await mounted.load(config)
  return mounted
}

/**
 * Admit one request carrying the assertion under the given header.
 * @param ctx - the root with Connection.
 * @param assertion - the header value, or `undefined` for none.
 * @param header - the header name.
 * @returns Connection's admission.
 */
export function admit(ctx: Context, assertion: string | readonly string[] | undefined, header = 'x-dsh-member'): PeerAdmission {
  return ctx.connection.admit({ headers: requestHeaders(assertion, header) })
}

/**
 * Loopback request headers with an optional assertion.
 * @param assertion - the header value, or `undefined` for none.
 * @param header - the header name.
 * @returns the headers.
 */
export function requestHeaders(assertion: string | readonly string[] | undefined, header = 'x-dsh-member'): Record<string, string | readonly string[]> {
  return assertion === undefined ? { host: '127.0.0.1' } : { host: '127.0.0.1', [header]: assertion }
}

/** A row mounted behind a real Web server, Connection and Gateway. */
export interface ServedRow extends MountedRow {
  readonly port: number
  /** The browser cookie for the loopback authority. */
  readonly cookie: string
  /** The Connection plugin's fiber. */
  readonly connectionFiber: Fiber
}

/**
 * Mount a Web server, Connection with `requireAdmitter: true`, the Typert
 * registry and Gateway, and the row.
 * @param config - the row's Config, or `undefined` to leave it unloaded.
 * @returns the served row.
 */
export async function mountServed(config: Record<string, unknown> | undefined): Promise<ServedRow> {
  const ctx = new Context()
  roots.push(ctx)
  const lines = captureLogs(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  const connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection }, { requireAdmitter: true })
  await connectionFiber
  const mounted = rowOn(ctx, lines)
  if (config !== undefined) await mounted.load(config)
  return Object.assign(mounted, { port: ctx.webServer.port, cookie: browserCookie(ctx), connectionFiber })
}

/** One HTTP answer. */
export interface Answer {
  readonly status: number
  readonly body: string
}

/**
 * Send one GET request and read the whole answer.
 * @param port - the server port.
 * @param path - the request path.
 * @param headers - the request headers.
 * @returns the status and body; a reset connection rejects.
 */
export function get(port: number, path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Send one WebSocket upgrade request to the Remote stream path and read the status line only.
 * @param port - the server port.
 * @param headers - the request headers.
 * @returns the answered status, 101 when the upgrade was accepted.
 */
export function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/remote.mux',
      agent: false,
      headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    })
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('upgrade', (response, socket) => {
      socket.destroy()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Assert that no collected text contains any of the given secrets.
 * @param texts - log lines, error messages and stacks.
 * @param secrets - principal keys, assertions and header values.
 */
export function expectNoSecret(texts: readonly string[], ...secrets: string[]): void {
  for (const text of texts) {
    for (const secret of secrets) expect(text).not.toContain(secret)
  }
}
