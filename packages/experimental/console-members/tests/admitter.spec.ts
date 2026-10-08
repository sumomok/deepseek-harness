/** The row's Peer admitter and directory, driven through Connection's admit() without a Web server. */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type HostConnectionPeers, type PeerAdmitter } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RootRegistry } from '../src/registry.ts'
import type { ConsoleMemberDirectory } from '../src/types.ts'
import {
  DEPLOYMENT_ID,
  admit,
  assertionFor,
  disposeMounted,
  expectNoSecret,
  mountRow,
  nowSeconds,
  requestHeaders,
  rowConfig,
  signPayload,
  type MountedRow,
} from './fixture.ts'
import { principal, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = 'login-uid-alice-5501'
const BOB = 'login-uid-bob-7702'

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await disposeMounted()
})

/** The Peer one admission answered; fails the test on a refusal. */
function peerOf(row: MountedRow, assertion: string, header?: string): PeerScope {
  const admission = admit(row.ctx, assertion, header)
  if (!('peer' in admission)) throw new Error(`refused with ${String(admission.rejection)}`)
  return admission.peer
}

function rejectionOf(row: MountedRow, assertion: string | readonly string[] | undefined, header?: string): number | undefined {
  const admission = admit(row.ctx, assertion, header)
  return 'rejection' in admission ? admission.rejection : undefined
}

function directory(row: MountedRow): ConsoleMemberDirectory {
  return row.ctx.consoleMembers
}

async function mountMembers(overrides: Record<string, unknown> = {}): Promise<MountedRow> {
  return await mountRow(rowConfig(temp, overrides))
}

describe('admitting a request', () => {
  it('admits a signed assertion as a member Peer and refuses every other request with 401 without logging an error', async () => {
    const row = await mountMembers()
    const peer = peerOf(row, assertionFor(ALICE))
    expect(row.ctx.connection.peers.list()).toEqual([peer])
    expect(peer).not.toBe(row.ctx.connection.operator)

    const refused = [
      undefined,
      [assertionFor(ALICE)],
      'v1.not.signed',
      signPayload(JSON.stringify({ p: ALICE, aud: 'deployment-other', exp: nowSeconds() + 60 })),
      signPayload(JSON.stringify({ p: ALICE, aud: DEPLOYMENT_ID, exp: nowSeconds() + 60, extra: 1 })),
      assertionFor(ALICE, nowSeconds() - 1),
    ]
    for (const value of refused) expect(rejectionOf(row, value)).toBe(401)
    expect(row.ctx.connection.peers.list()).toEqual([peer])
    expect(row.lines.filter(line => line.startsWith('error'))).toEqual([])
  })

  it('accepts the second before exp and refuses at exp, in whole seconds of the system clock', async () => {
    const row = await mountMembers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const exp = 1_900_000_000
    const assertion = assertionFor(ALICE, exp)
    vi.setSystemTime((exp - 1) * 1000)
    expect(rejectionOf(row, assertion)).toBeUndefined()
    vi.setSystemTime(exp * 1000 - 1)
    expect(rejectionOf(row, assertion)).toBeUndefined()
    vi.setSystemTime(exp * 1000)
    expect(rejectionOf(row, assertion)).toBe(401)
  })

  it('answers one member with one Peer across admit, requestRejection and principalOfRequest', async () => {
    const row = await mountMembers()
    const assertion = assertionFor(ALICE)
    const first = peerOf(row, assertion)
    for (let index = 0; index < 3; index += 1) {
      expect(peerOf(row, assertion)).toBe(first)
      expect(row.ctx.connection.requestRejection({ headers: requestHeaders(assertion) })).toBeUndefined()
      expect(directory(row).principalOfRequest({ headers: requestHeaders(assertion) } as never)).toBe(ALICE)
    }
    expect(peerOf(row, assertionFor(ALICE, nowSeconds() + 90))).toBe(first)
    expect(row.ctx.connection.peers.list()).toEqual([first])

    const bob = peerOf(row, assertionFor(BOB))
    expect(bob).not.toBe(first)
    expect(row.ctx.connection.peers.list()).toEqual([first, bob])
  })

  it('answers principalOfRequest with the member each request asserts while several members are online', async () => {
    const row = await mountMembers()
    const alice = assertionFor(ALICE)
    const bob = assertionFor(BOB)
    peerOf(row, alice)
    peerOf(row, bob)
    expect(directory(row).principalOfRequest({ headers: requestHeaders(bob) } as never)).toBe(BOB)
    expect(directory(row).principalOfRequest({ headers: requestHeaders(alice) } as never)).toBe(ALICE)
    expect(row.ctx.connection.peers.list()).toHaveLength(2)
  })

  it('answers principalOfRequest undefined for a refused request', async () => {
    const row = await mountMembers()
    expect(directory(row).principalOfRequest({ headers: requestHeaders(undefined) } as never)).toBeUndefined()
    expect(directory(row).principalOfRequest({ headers: { 'x-dsh-member': assertionFor(ALICE) } } as never)).toBeUndefined()
    expect(row.ctx.connection.peers.list()).toEqual([])
  })

  it('registers the member root once and starts the default workspace registration on admission', async () => {
    const row = await mountMembers()
    peerOf(row, assertionFor(ALICE))
    peerOf(row, assertionFor(ALICE))
    const root = directory(row).memberRoot(principal(ALICE))
    expect(directory(row).rootsOf(principal(ALICE))).toEqual([root])
    expect(root.startsWith(join(temp.base, 'members'))).toBe(true)
    expect(root).not.toContain(ALICE)
    await vi.waitFor(() => { expect(row.workspaces.created).toEqual([join(root, 'workspace')]) })
    peerOf(row, assertionFor(ALICE))
    await Promise.resolve()
    expect(row.workspaces.created).toEqual([join(root, 'workspace')])
  })

  it('reads the configured header name in lower case, and x-dsh-member when none is configured', async () => {
    const custom = await mountMembers({ assertionHeader: 'X-Console-Member' })
    expect(rejectionOf(custom, assertionFor(ALICE), 'x-console-member')).toBeUndefined()
    expect(rejectionOf(custom, assertionFor(BOB), 'x-dsh-member')).toBe(401)

    const plain = await mountMembers()
    expect(rejectionOf(plain, assertionFor(ALICE), 'x-dsh-member')).toBeUndefined()
    expect(rejectionOf(plain, assertionFor(BOB), 'x-console-member')).toBe(401)
  })
})

describe('a failure inside the admitter', () => {
  it('refuses with 401, opens no Peer, and logs only an errno code', async () => {
    const row = await mountMembers()
    const failure = Object.assign(new Error(`ENOSPC writing roots for ${ALICE} under /srv/members-9183`), { code: 'ENOSPC' })
    const spy = vi.spyOn(RootRegistry.prototype, 'ensureMember').mockImplementation(() => { throw failure })
    const assertion = assertionFor(ALICE)
    expect(rejectionOf(row, assertion)).toBe(401)
    expect(row.ctx.connection.peers.list()).toEqual([])
    expect(row.lines.filter(line => line.includes('admitting a member failed'))).toHaveLength(1)
    expect(row.lines.some(line => line.includes('(ENOSPC)'))).toBe(true)
    // Connection logs an error only when an admitter names no member; the row answers 401 itself.
    expect(row.lines.filter(line => line.startsWith('error'))).toEqual([])
    expectNoSecret(row.lines, ALICE, assertion, '/srv/members-9183', 'writing roots')

    spy.mockRestore()
    expect(rejectionOf(row, assertion)).toBeUndefined()
    expect(row.ctx.connection.peers.list()).toHaveLength(1)
  })

  it('logs no code for a failure without an errno code', async () => {
    const row = await mountMembers()
    vi.spyOn(RootRegistry.prototype, 'ensureMember')
      .mockImplementationOnce(() => { throw new Error(`no space for ${ALICE}`) })
      .mockImplementationOnce(() => { throw Object.assign(new Error(ALICE), { code: `ERR_${ALICE}` }) })
      .mockImplementationOnce(() => { throw Object.assign(new Error(ALICE), { code: 5501 }) })
    for (let index = 0; index < 3; index += 1) expect(rejectionOf(row, assertionFor(ALICE))).toBe(401)
    const failures = row.lines.filter(line => line.includes('admitting a member failed'))
    expect(failures).toHaveLength(3)
    for (const line of failures) expect(line).toContain('admitting a member failed; the request is refused with 401')
    expectNoSecret(row.lines, ALICE, '5501')
  })

  it('refuses with 401 when the first sighting cannot create the member root', async () => {
    const membersRoot = join(temp.base, 'members')
    const row = await mountMembers({ membersRoot })
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(temp.base, { recursive: true })
    writeFileSync(membersRoot, 'not a directory')
    expect(rejectionOf(row, assertionFor(ALICE))).toBe(401)
    expect(row.lines.some(line => /admitting a member failed \(E[A-Z]+\)/.test(line))).toBe(true)
    expectNoSecret(row.lines, ALICE)
  })
})

describe('principalOfCaller', () => {
  it('answers the member of a live member Peer and undefined for the operator, a Peer it did not open, and a released Peer', async () => {
    const row = await mountMembers()
    const members = directory(row)
    const peer = peerOf(row, assertionFor(ALICE))
    expect(members.principalOfCaller(peer)).toBe(ALICE)
    expect(members.principalOfCaller(row.ctx.connection.operator)).toBeUndefined()
    const foreign = row.ctx.connection.peers.open()
    expect(members.principalOfCaller(foreign)).toBeUndefined()
    expect(members.principalOfCaller({ id: peer.id, ctx: peer.ctx } as PeerScope)).toBeUndefined()

    const closing = peer.dispose()
    expect(row.ctx.connection.peers.get(peer.id)).toBeUndefined()
    expect(members.principalOfCaller(peer)).toBeUndefined()
    await closing
    expect(members.principalOfCaller(peer)).toBeUndefined()
  })

  it('answers through the proxy another plugin receives', async () => {
    const row = await mountMembers()
    const peer = peerOf(row, assertionFor(ALICE))
    const answers: unknown[] = []
    await row.ctx.plugin({
      inject: ['consoleMembers'],
      apply: (consumer: Context) => {
        const members = consumer.consoleMembers
        answers.push(members.principalOfCaller(peer), members.principalOfCaller(consumer.connection.operator))
        answers.push(members.principals())
      },
    })
    expect(answers).toEqual([ALICE, undefined, [ALICE]])
  })
})

describe('principals and onChange', () => {
  it('reports a member opened on admission and closed when the Peer closes', async () => {
    const row = await mountMembers()
    const changes: unknown[] = []
    directory(row).onChange((change) => { changes.push(change) })
    const peer = peerOf(row, assertionFor(ALICE))
    expect(directory(row).principals()).toEqual([ALICE])
    expect(changes).toEqual([{ principal: ALICE, kind: 'opened' }])
    await peer.dispose()
    expect(directory(row).principals()).toEqual([])
    expect(changes).toEqual([{ principal: ALICE, kind: 'opened' }, { principal: ALICE, kind: 'closed' }])
  })

  it('keeps one Peer for a member whose first admission is re-entered from a connection/peer-opened listener', async () => {
    const row = await mountMembers()
    const assertion = assertionFor(ALICE)
    const changes: unknown[] = []
    directory(row).onChange((change) => { changes.push(change) })
    let reentered = false
    let inner: PeerScope | undefined
    row.ctx.on('connection/peer-opened', () => {
      if (reentered) return
      reentered = true
      inner = peerOf(row, assertion)
    })
    const outer = peerOf(row, assertion)
    expect(outer === inner).toBe(true)
    await vi.waitFor(() => { expect(row.ctx.connection.peers.list()).toEqual([outer]) })
    expect(directory(row).principals()).toEqual([ALICE])
    expect(directory(row).principalOfCaller(outer)).toBe(ALICE)
    expect(changes).toEqual([{ principal: ALICE, kind: 'opened' }])
  })

  it('keeps notifying the other listeners when one throws, and logs neither its error nor the member', async () => {
    const row = await mountMembers()
    const seen: string[] = []
    directory(row).onChange(() => { throw new Error(`listener refused ${ALICE}`) })
    directory(row).onChange((change) => { seen.push(change.kind) })
    const peer = peerOf(row, assertionFor(ALICE))
    await peer.dispose()
    expect(seen).toEqual(['opened', 'closed'])
    expect(row.lines.filter(line => line.includes('onChange listener threw'))).toHaveLength(2)
    expectNoSecret(row.lines, ALICE, 'listener refused')
  })

  it('stops notifying after the disposer runs and when the registering plugin unloads', async () => {
    const row = await mountMembers()
    const direct: string[] = []
    const stop = directory(row).onChange((change) => { direct.push(change.kind) })
    const viaPlugin: string[] = []
    const consumer = row.ctx.plugin({
      inject: ['consoleMembers'],
      apply: (ctx: Context) => { ctx.consoleMembers.onChange((change) => { viaPlugin.push(change.kind) }) },
    })
    await consumer
    peerOf(row, assertionFor(ALICE))
    stop()
    await consumer.dispose()
    peerOf(row, assertionFor(BOB))
    expect(direct).toEqual(['opened'])
    expect(viaPlugin).toEqual(['opened'])
  })

  it('reports a released Peer closed once when the member is admitted again before Connection reports it', async () => {
    const row = await mountMembers()
    const changes: string[] = []
    directory(row).onChange((change) => { changes.push(change.kind) })
    const first = peerOf(row, assertionFor(ALICE))
    const closing = first.dispose()
    const second = peerOf(row, assertionFor(ALICE))
    expect(second).not.toBe(first)
    await closing
    expect(changes).toEqual(['opened', 'closed', 'opened'])
    expect(directory(row).principals()).toEqual([ALICE])
    expect(directory(row).principalOfCaller(second)).toBe(ALICE)
  })
})

describe('idle close', () => {
  const IDLE = 60_000

  async function idleRow(): Promise<MountedRow> {
    const row = await mountMembers({ peerIdleMs: IDLE })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    return row
  }

  function socket(name: string): never {
    return name as never
  }

  it('disposes a Peer with no socket peerIdleMs after its last admission, counting every admission', async () => {
    const row = await idleRow()
    const assertion = assertionFor(ALICE, nowSeconds() + 3600)
    const peer = peerOf(row, assertion)
    await vi.advanceTimersByTimeAsync(IDLE - 1000)
    expect(peerOf(row, assertion)).toBe(peer)
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(row.ctx.connection.peers.get(peer.id)).toBe(peer)
    await vi.advanceTimersByTimeAsync(1)
    expect(row.ctx.connection.peers.get(peer.id)).toBeUndefined()
    expect(directory(row).principals()).toEqual([])
  })

  it('keeps a Peer with a socket open, and starts the idle time when its last socket closes', async () => {
    const row = await idleRow()
    const peer = peerOf(row, assertionFor(ALICE, nowSeconds() + 7200))
    row.ctx.emit('remote-stream/socket-opened', peer, socket('socket-1'))
    row.ctx.emit('remote-stream/socket-opened', peer, socket('socket-2'))
    await vi.advanceTimersByTimeAsync(IDLE * 3)
    expect(row.ctx.connection.peers.get(peer.id)).toBe(peer)
    row.ctx.emit('remote-stream/socket-closed', peer, socket('socket-1'))
    await vi.advanceTimersByTimeAsync(IDLE * 3)
    expect(row.ctx.connection.peers.get(peer.id)).toBe(peer)
    row.ctx.emit('remote-stream/socket-closed', peer, socket('socket-2'))
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(row.ctx.connection.peers.get(peer.id)).toBe(peer)
    await vi.advanceTimersByTimeAsync(1)
    expect(row.ctx.connection.peers.get(peer.id)).toBeUndefined()
  })

  it('ignores socket events of the operator and of Peers it did not open', async () => {
    const row = await idleRow()
    const peer = peerOf(row, assertionFor(ALICE, nowSeconds() + 3600))
    const foreign = row.ctx.connection.peers.open()
    for (const other of [row.ctx.connection.operator, foreign]) {
      row.ctx.emit('remote-stream/socket-opened', other, socket('other'))
      row.ctx.emit('remote-stream/socket-closed', other, socket('other'))
    }
    row.ctx.emit('connection/peer-closed', row.ctx.connection.operator)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(row.ctx.connection.peers.get(peer.id)).toBeUndefined()
    expect(row.ctx.connection.peers.get(foreign.id)).toBe(foreign)
  })

  it('handles Connection reporting the Peer closed before its socket closes, and never revives the discarded Peer', async () => {
    const row = await idleRow()
    const assertion = assertionFor(ALICE, nowSeconds() + 7200)
    const first = peerOf(row, assertion)
    row.ctx.emit('remote-stream/socket-opened', first, socket('socket-1'))
    await first.dispose()
    expect(directory(row).principals()).toEqual([])
    row.ctx.emit('remote-stream/socket-closed', first, socket('socket-1'))
    row.ctx.emit('remote-stream/socket-opened', first, socket('socket-2'))
    expect(directory(row).principals()).toEqual([])
    expect(directory(row).principalOfCaller(first)).toBeUndefined()

    const second = peerOf(row, assertion)
    expect(second).not.toBe(first)
    row.ctx.emit('remote-stream/socket-opened', first, socket('socket-3'))
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(row.ctx.connection.peers.get(second.id)).toBeUndefined()
    expect(directory(row).principals()).toEqual([])
  })
})

describe('unloading the row', () => {
  it('disposes every Peer it opened, leaves other Peers open, and a reload admits the same member as a new Peer', async () => {
    const row = await mountMembers()
    const alice = peerOf(row, assertionFor(ALICE))
    const bob = peerOf(row, assertionFor(BOB))
    const foreign = row.ctx.connection.peers.open()
    await row.fiber!.dispose()
    expect(row.ctx.connection.peers.list()).toEqual([foreign])
    expect(row.ctx.connection.peers.get(alice.id)).toBeUndefined()
    expect(row.ctx.connection.peers.get(bob.id)).toBeUndefined()
    expect(row.ctx.get('consoleMembers')).toBeUndefined()
    expect(rejectionOf(row, assertionFor(ALICE))).toBe(401)

    await row.load(rowConfig(temp))
    const again = peerOf(row, assertionFor(ALICE))
    expect(again.id).not.toBe(alice.id)
    expect(directory(row).principalOfCaller(again)).toBe(ALICE)
    expect(directory(row).principalOfCaller(alice)).toBeUndefined()
  })
})

describe('unloading during a default-workspace step', () => {
  it('finishes only after the step in flight has settled', async () => {
    const row = await mountMembers()
    let finishCreate: (() => void) | undefined
    const create = vi.spyOn(row.workspaces, 'create').mockImplementation(path => new Promise((resolve) => {
      finishCreate = () => { resolve({ id: 'workspace-pending', path, title: 'workspace', createdAt: '', updatedAt: '' } as never) }
    }))
    peerOf(row, assertionFor(ALICE))
    await vi.waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    let unloaded = false
    const unloading = row.fiber!.dispose().then(() => { unloaded = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unloaded).toBe(false)
    finishCreate!()
    await unloading
    expect(unloaded).toBe(true)
  })
})

describe('the install order', () => {
  it('registers the Peer listeners before it installs the admitter', async () => {
    const row = await mountRow(undefined)
    const root = row.ctx
    // oxlint-disable-next-line typescript/unbound-method -- the original getter is called below with the service as its receiver.
    const original = Object.getOwnPropertyDescriptor(HostConnectionService.prototype, 'peers')!.get!
    const atInstall: Array<Record<string, number>> = []
    vi.spyOn(HostConnectionService.prototype, 'peers', 'get').mockImplementation(function (this: HostConnectionService): HostConnectionPeers {
      const peers = Reflect.apply(original, this, []) as HostConnectionPeers
      return Object.assign(Object.create(Object.getPrototypeOf(peers) as object) as HostConnectionPeers, peers, {
        admitWith: (admitter: PeerAdmitter) => {
          // Nothing else in this root listens to these events, so every hook is the row's.
          const hooks = root.events._hooks as Record<string, unknown[] | undefined>
          const ownCount = (event: string): number => hooks[event]?.length ?? 0
          atInstall.push({
            peerClosed: ownCount('connection/peer-closed'),
            socketOpened: ownCount('remote-stream/socket-opened'),
            socketClosed: ownCount('remote-stream/socket-closed'),
          })
          return peers.admitWith(admitter)
        },
      })
    })
    await row.load(rowConfig(temp))
    expect(atInstall).toEqual([{ peerClosed: 1, socketOpened: 1, socketClosed: 1 }])
  })
})

describe('the directory', () => {
  it('serves the registry\'s member roots and stores, and throws for principalOfSession, which this build does not implement', async () => {
    const row = await mountMembers()
    peerOf(row, assertionFor(ALICE))
    const members = directory(row)
    await members.memberStore(principal(ALICE), 'fixture-unit').write({ ok: true })
    expect(await members.memberStore(principal(ALICE), 'fixture-unit').read()).toEqual({ ok: true })
    expect(() => members.principalOfSession('session-1' as never)).toThrow('console-members: principalOfSession is not implemented in this build')
  })
})
