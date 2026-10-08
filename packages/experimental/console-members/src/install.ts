/**
 * What a loaded console member directory row registers, in order.
 *
 * Everything is registered in one synchronous call, and the Peer admitter is
 * installed last, so no request is admitted before every listener that judges
 * member Peers is in place. Cordis starts a fiber's disposers in reverse
 * registration order and does not wait for one before starting the next, so
 * unloading the row withdraws the admitter first, then removes every member
 * Peer the row opened from its table and starts disposing them, closing their
 * sockets with code 1001, then removes the listeners without waiting for the
 * Peer disposals or the default-workspace steps in flight. The unload settles
 * once both have settled.
 * @module @deepseek-ai/dsh-experimental-console-members/src/install
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-workspace'
import { CustomerCredentials } from './credentials.ts'
import { DefaultWorkspaces } from './default-workspace.ts'
import { ConsoleMembersDirectory } from './directory.ts'
import type { LoadedMembers } from './load.ts'
import { MemberPeers } from './peers.ts'

/**
 * Provide `ctx.consoleMembers`, follow member Peers and their sockets,
 * dispose the row's Peers and wait for its default-workspace steps on unload,
 * and install the Peer admitter.
 * @param ctx - the row's context, carrying Connection and the workspace registry.
 * @param loaded - the checked settings, the assertion key and the root registry.
 */
export function installDirectory(ctx: Context, loaded: LoadedMembers): void {
  const { settings, assertionKey, registry } = loaded
  const connection = ctx.connection
  const peers = connection.peers
  const logger = ctx.logger('console-members')
  const defaults = new DefaultWorkspaces(principal => registry.memberRoot(principal), ctx.workspaceRegistry, logger)
  const members = new MemberPeers({
    peers,
    assertion: { header: settings.assertionHeader, key: assertionKey, deploymentId: settings.deploymentId },
    ensureMember: principal => registry.ensureMember(principal),
    ensureDefaultWorkspace: principal => defaults.ensureDefaultWorkspace(principal),
    peerIdleMs: settings.peerIdleMs,
    logger,
  })
  new ConsoleMembersDirectory(ctx, { connection, registry, members, credentials: new CustomerCredentials(logger) })
  // Listeners that judge member Peers are registered here, before the admitter.
  ctx.on('connection/peer-closed', (peer) => { members.peerClosed(peer) })
  ctx.on('remote-stream/socket-opened', (peer, socketId) => { members.socketOpened(peer, socketId) })
  ctx.on('remote-stream/socket-closed', (peer, socketId) => { members.socketClosed(peer, socketId) })
  ctx.effect(() => async () => {
    await members.disposeAll()
    await defaults.settled()
  }, 'console-members: the row\'s member Peers and default-workspace steps')
  peers.admitWith(request => members.admit(request))
}
