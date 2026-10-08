/** The row behind a real Web server, Connection and Gateway: HTTP and upgrade refusals, member sockets, and unloading. */
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  assertionFor,
  disposeMounted,
  expectNoSecret,
  get,
  mountServed,
  rowConfig,
  signPayload,
  upgradeStatus,
  type ServedRow,
} from './fixture.ts'
import { useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = 'login-uid-alice-5501'
const BOB = 'login-uid-bob-7702'

afterEach(async () => {
  await disposeMounted()
})

/** Headers of a browser request with the session cookie and, when given, an assertion. */
function browser(row: ServedRow, assertion?: string): Record<string, string> {
  return { cookie: row.cookie, ...assertion === undefined ? {} : { 'x-dsh-member': assertion } }
}

/** Register a webServer route, in a plugin that injects the directory, answering the request's member. */
async function memberRoute(row: ServedRow): Promise<void> {
  await row.ctx.plugin({
    inject: ['webServer', 'consoleMembers'],
    apply: (ctx: Context) => {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/fixture/member',
        handler: (req, res) => {
          res.writeHead(200)
          res.end(String(ctx.consoleMembers.principalOfRequest(req)))
        },
      }), 'served spec: member route')
    },
  })
}

/** Open a Remote stream socket as one member and wait for the Gateway to announce it. */
async function memberSocket(row: ServedRow, assertion: string): Promise<{ socket: WebSocket; peer: PeerScope }> {
  const announced = new Promise<PeerScope>((resolve) => {
    const stop = row.ctx.on('remote-stream/socket-opened', (peer) => {
      stop()
      resolve(peer)
    })
  })
  const socket = new WebSocket(`ws://127.0.0.1:${String(row.port)}/api/remote.mux`, { headers: browser(row, assertion) })
  await once(socket, 'open')
  return { socket, peer: await announced }
}

describe('a browser request with a valid session cookie', () => {
  it('is refused with 401 on /api and on the upgrade when the assertion is missing or forged', async () => {
    const row = await mountServed(rowConfig(temp))
    const forged = signPayload(JSON.stringify({ p: ALICE, aud: 'deployment-other', exp: Math.floor(Date.now() / 1000) + 60 }))
    for (const assertion of [undefined, forged, 'v1.forged.forged', `${assertionFor(ALICE)}x`]) {
      expect((await get(row.port, '/api/fixture', browser(row, assertion))).status).toBe(401)
      expect(await upgradeStatus(row.port, browser(row, assertion))).toBe(401)
    }
    expect(await upgradeStatus(row.port, browser(row, assertionFor(ALICE)))).toBe(101)
    expect(row.ctx.connection.peers.list()).toHaveLength(1)
    expectNoSecret(row.lines, ALICE, forged)
  })

  it('is refused with 401, not 400 or a reset connection, when the member root cannot be created', async () => {
    const membersRoot = join(temp.base, 'members')
    const row = await mountServed(rowConfig(temp, { membersRoot }))
    mkdirSync(temp.base, { recursive: true })
    writeFileSync(membersRoot, 'not a directory')
    const assertion = assertionFor(ALICE)
    expect(await get(row.port, '/api/fixture', browser(row, assertion))).toEqual({ status: 401, body: 'unauthorized' })
    expect(await upgradeStatus(row.port, browser(row, assertion))).toBe(401)
    expect(row.ctx.connection.peers.list()).toEqual([])
    expect(row.lines.filter(line => line.startsWith('error'))).toEqual([])
    expectNoSecret(row.lines, ALICE, assertion, membersRoot)
  })

  it('names its member to a route through principalOfRequest, with one Peer for repeated requests', async () => {
    const row = await mountServed(rowConfig(temp))
    await memberRoute(row)
    const assertion = assertionFor(ALICE)
    for (let index = 0; index < 3; index += 1) {
      expect(await get(row.port, '/fixture/member', browser(row, assertion))).toEqual({ status: 200, body: ALICE })
    }
    expect(row.ctx.connection.peers.list()).toHaveLength(1)
    expect((await get(row.port, '/fixture/member', browser(row))).body).toBe('undefined')
    expect((await get(row.port, '/fixture/member', { 'x-dsh-member': assertion })).body).toBe('undefined')
  })
})

describe('Connection with requireAdmitter: true and no row', () => {
  it('refuses /api and the upgrade with 401 before the row loads and after it unloads', async () => {
    const row = await mountServed(undefined)
    const assertion = assertionFor(ALICE)
    expect((await get(row.port, '/api/fixture', browser(row, assertion))).status).toBe(401)
    expect(await upgradeStatus(row.port, browser(row, assertion))).toBe(401)

    await row.load(rowConfig(temp))
    expect(await upgradeStatus(row.port, browser(row, assertion))).toBe(101)
    await row.fiber!.dispose()
    expect((await get(row.port, '/api/fixture', browser(row, assertion))).status).toBe(401)
    expect(await upgradeStatus(row.port, browser(row, assertion))).toBe(401)
  })
})

describe('unloading the row', () => {
  it('closes every member socket with 1001, and a reload admits the same assertion as a new Peer', async () => {
    const row = await mountServed(rowConfig(temp))
    const aliceAssertion = assertionFor(ALICE)
    const alice = await memberSocket(row, aliceAssertion)
    const bob = await memberSocket(row, assertionFor(BOB))
    expect(row.ctx.consoleMembers.principals()).toEqual([ALICE, BOB])
    const closes = [once(alice.socket, 'close'), once(bob.socket, 'close')]

    await row.fiber!.dispose()
    const codes = (await Promise.all(closes)).map(([code]) => code as number)
    expect(codes).toEqual([1001, 1001])
    expect(row.ctx.connection.peers.list()).toEqual([])

    await row.load(rowConfig(temp))
    const again = await memberSocket(row, aliceAssertion)
    expect(again.peer.id).not.toBe(alice.peer.id)
    expect(row.ctx.consoleMembers.principalOfCaller(again.peer)).toBe(ALICE)
    again.socket.close()
  })

  it('handles Connection unloading first without logging an error', async () => {
    const row = await mountServed(rowConfig(temp))
    const alice = await memberSocket(row, assertionFor(ALICE))
    const closed = once(alice.socket, 'close')
    await row.connectionFiber.dispose()
    await closed
    await row.fiber!.dispose()
    expect(row.lines.filter(line => line.startsWith('error'))).toEqual([])
  })
})
