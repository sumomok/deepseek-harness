/**
 * Entry-level inject binding the Host facts every Tool surface that displays a
 * path needs.
 * @module
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ToolHostInfoInjected } from './contract/slots.ts'

/**
 * Build the `inject` a registration passes so its component receives
 * `useHostInfo`. The observable reads `ctx.remote.$host` on every snapshot and
 * re-reads it on `connection/reset`, so a reconnect to a different Host is
 * seen; binding the facts as values instead would freeze them at the
 * registration's first render.
 * @param ctx - the Context owning the registration (must inject `remote`).
 * @returns the inject factory for `ctx.slots.register`.
 */
export function toolHostInject(ctx: ClientContext): () => ToolHostInfoInjected {
  const hostInfo: HostObservable<RemoteHostFacts> = {
    getSnapshot: () => ctx.remote.$host,
    subscribe: listener => ctx.on('connection/reset', listener),
  }
  return () => ({ hooks: { hostInfo } })
}
