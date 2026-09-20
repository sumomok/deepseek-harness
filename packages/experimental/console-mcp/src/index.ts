/**
 * The console's MCP capability: one row a console composition always carries,
 * whose configuration is the list of external MCP servers this deployment
 * reaches and nothing else.
 *
 * The row exists so that mounting the capability and choosing the servers are
 * two different decisions made by two different people. The composition mounts
 * it once, with no server; a deployment adds servers by writing an endpoint and
 * the *name* of a credential, never a value and never a package. An empty list
 * is the ordinary state, not a failure: the row loads, registers no tool, opens
 * no connection, and adds nothing to any model request.
 *
 * Servers are configuration rather than a settings document because a console
 * end user must not be able to add one. Everything this row reads is written by
 * whoever composes the deployment, and no surface the console shows can change
 * it.
 *
 * Only Streamable HTTP endpoints are offered. A stdio server is a local program
 * this process would start outside every sandbox the product applies, under the
 * account running the host — a deployment decision this row deliberately does
 * not make available. Reaching one is `@deepseek-ai/dsh-mcp-client` composed
 * directly.
 *
 * @module @deepseek-ai/dsh-experimental-console-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
// Side-effect type import: declaration-merges `ctx.credentials` onto Context.
import type {} from '@deepseek-ai/dsh-credentials'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { resolveServers } from './servers.ts'
import type { ServerAuthRequest, ServerRequest, ServerSpec } from './servers.ts'

export { resolveServers } from './servers.ts'
export type { ServerAuthRequest, ServerRequest, ServerSpec } from './servers.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'console-mcp'

/**
 * Services required by this plugin. `credentials` is read once per configured
 * server while this row loads; the bridge rows this row mounts declare `tools`
 * for themselves. The base bundle composes a credentials provider, so a
 * composition without one leaves this row pending with the service named.
 */
export const inject = ['credentials']

/** Plugin config: which external MCP servers this deployment reaches. */
export interface Config {
  /**
   * The servers, in the order they are written. An empty list — the default —
   * is a console that carries the capability and reaches nothing, which is
   * what a deployment gets before anyone has chosen a server.
   */
  servers: ServerRequest[]
}

/** One server's credential as written, before `scheme` is defaulted. */
type ServerAuthInput = Omit<ServerAuthRequest, 'scheme'> & Partial<Pick<ServerAuthRequest, 'scheme'>>

/** One server as written. */
type ServerInput = Omit<ServerRequest, 'auth'> & { auth?: ServerAuthInput }

/** The row as written: a composition stating no list gets the empty one. */
interface ConfigInput {
  servers?: ServerInput[]
}

const ServerAuth = z.object({
  header: z.string().required(),
  credential: z.string().required(),
  scheme: z.string().default(''),
})

const Server = z.object({
  id: z.string().required(),
  url: z.string().required(),
  auth: ServerAuth,
  toolCallTimeoutMs: z.natural(),
  failOnStartupError: z.boolean(),
})

export const Config = z.object({
  servers: z.array(Server).default([]),
}) as unknown as z<ConfigInput, Config>

/**
 * Build the header table one server's requests carry. The credential is read
 * through the seam that owns it, so the configuration file names the secret
 * and never holds it.
 * @param ctx - this plugin's context, carrying the credential provider.
 * @param spec - one server, already judged by {@link resolveServers}.
 * @returns the headers to attach, empty for a server that names no credential.
 * @throws {Error} when the named reference has no value stored.
 */
async function headersFor(ctx: Context, spec: ServerSpec): Promise<Record<string, string>> {
  if (spec.auth === undefined) return {}
  const resolved = await ctx.credentials.resolve(credentialRef(spec.auth.credential))
  if (resolved === undefined) {
    // The reference is named, the value is not: this message is read wherever
    // the boot's output goes.
    throw new Error(
      `console-mcp: server "${spec.id}" names credential "${spec.auth.credential}", which nothing has stored a value for`,
    )
  }
  return { [spec.auth.header]: `${spec.auth.scheme}${resolved.value}` }
}

/**
 * Mount one MCP bridge per configured server.
 *
 * Every self-contained check runs first and throws for the whole row, so a
 * list carrying one unusable entry mounts none of them: a console that came up
 * having silently dropped a server would be a console whose operator believes
 * it is reaching one.
 * @param ctx - the plugin context.
 * @param config - the configured server list.
 * @throws {Error} when a server is unusable or names a credential with no value.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const mounts = await Promise.all(resolveServers(config.servers)
    .map(async spec => ({ spec, headers: await headersFor(ctx, spec) })))
  // Awaited, like the bridge's own activation: a console's first turn must see
  // the roster it will keep, rather than tools that appear a moment into it.
  await Promise.all(mounts.map(async ({ spec, headers }) => {
    await ctx.plugin(mcpClient, {
      transport: 'streamable-http',
      serverName: spec.id,
      url: spec.url,
      headers,
      ...spec.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: spec.toolCallTimeoutMs },
      ...spec.failOnStartupError === undefined ? {} : { failOnStartupError: spec.failOnStartupError },
    })
  }))
}
