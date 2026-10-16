/** Forwarded waterfalls for non-owner Peers: remote access decides delivery and answers per Session. */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService, { type RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import type {
  PeerScope,
  PrincipalMap,
  TypertContextMap,
  TypertContextWire,
  TypertResource,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TypertGatewayService, { type TypertRemoteEventDispatch, type TypertRemoteEventOutcome } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the member waterfall specs. */
    'gateway-waterfall-member': { readonly kind: 'gateway-waterfall-member'; readonly member: string }
  }
  interface TypertResourceMap {
    /** Test-only resource kind the fixture's Agent Host Context adapter declares. */
    'gateway-waterfall-session': TypertResource<string>
  }
}

type Member = PrincipalMap['gateway-waterfall-member']
type AgentWireId = TypertContextWire<TypertContextMap['agent']>

const APPROVAL = 'approval/request'
const QUESTION = 'user-questions/request'
const answering = { name: 'test:answer', resource: 'gateway-waterfall-session', actions: [`event:${APPROVAL}`, `event:${QUESTION}`] } as const

/** One binding that lets its holder receive and answer approvals and questions of one Session. */
function answers(sessionId: string): RemoteAccessBinding {
  return { role: answering, resource: { kind: 'gateway-waterfall-session', id: sessionId } }
}

interface Mounted {
  readonly ctx: Context
  /** Replace one member's bindings. */
  readonly grant: (member: string, ...bindings: RemoteAccessBinding[]) => void
  /** Queue one dispatch on the forwarded-event source. */
  readonly push: (dispatch: TypertRemoteEventDispatch) => void
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(options: { readonly agentResource?: boolean; readonly policy?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  if (options.agentResource !== false) {
    ctx.typert.contexts.registerHost('agent', {
      wire: 'agentId',
      wireTypeSymbol: '@fixture/member-waterfall#AgentId',
      resource: 'gateway-waterfall-session',
      resolve: () => ctx,
    })
  }
  const held = new Map<string, readonly RemoteAccessBinding[]>()
  if (options.policy !== false) {
    ctx.remoteAccess.registerPolicy('gateway-waterfall-member', {
      bindings: (member: Member) => held.get(member.member) ?? [],
    })
  }
  const queue: TypertRemoteEventDispatch[] = []
  let wake: (() => void) | undefined
  ctx.effect(() => ctx.typertGateway.registerRemoteEvents(async function* (signal) {
    while (!signal.aborted) {
      while (queue.length > 0) yield queue.shift() as TypertRemoteEventDispatch
      await new Promise<void>((resolve) => {
        wake = resolve
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }, { home: '/fixture' }))
  return {
    ctx,
    grant: (member, ...bindings) => {
      held.set(member, bindings)
      ctx.remoteAccess.invalidate()
    },
    push: (dispatch) => {
      queue.push(dispatch)
      wake?.()
    },
  }
}

interface EventStream {
  readonly peer: PeerScope
  readonly clientId: string
  readonly next: () => Promise<IteratorResult<unknown>>
  readonly close: () => Promise<void>
}

async function events(ctx: Context, peer: PeerScope): Promise<EventStream> {
  const abort = new AbortController()
  const iterator = (await ctx.typertGateway.wireStream.open(
    '$events', { args: {} }, (async function* () {})(), peer, abort.signal,
  ))[Symbol.asyncIterator]()
  const ready = await iterator.next()
  return {
    peer,
    clientId: Reflect.get(ready.value as object, 'clientId') as string,
    next: () => iterator.next(),
    close: async () => {
      abort.abort()
      await iterator.return?.()
    },
  }
}

function member(ctx: Context, name: string): PeerScope {
  return ctx.connection.createPeer({ principal: { kind: 'gateway-waterfall-member', member: name } })
}

interface Asked {
  readonly settled: ReturnType<typeof vi.fn<(outcome: TypertRemoteEventOutcome) => void>>
  readonly rejected: ReturnType<typeof vi.fn<(reason: unknown) => void>>
}

/** Push one scoped waterfall of the Agent whose wire identity is `sessionId`. */
function ask(mounted: Mounted, event: string, sessionId: string): Asked {
  const subject = {}
  const settled = vi.fn<(outcome: TypertRemoteEventOutcome) => void>()
  const rejected = vi.fn<(reason: unknown) => void>()
  mounted.push({
    event,
    request: { text: `${event} in ${sessionId}`, agent: subject },
    context: { value: mounted.ctx.extend({}), subject, agentId: sessionId as AgentWireId },
    resolve: settled,
    reject: rejected,
  })
  return { settled, rejected }
}

/** Post one `$events/result` through Connection's shared `/api` handler as `peer`. */
async function reply(
  ctx: Context,
  peer: PeerScope,
  clientId: string,
  eventId: unknown,
  outcome: object = { kind: 'result', value: { approved: true } },
): Promise<unknown> {
  const response = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request('http://host/api/$events/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc-result',
      method: '$events/result',
      payload: { args: { clientId, eventId, outcome } },
    }),
  }), peer)
  return Reflect.get(await response.json() as object, 'result')
}

/** Read the next frame, failing the test instead of hanging when none is queued. */
async function frame(stream: EventStream): Promise<Record<string, unknown>> {
  const next = await Promise.race([
    stream.next(),
    new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error('no frame arrived')) }, 1_000) }),
  ])
  return next.value as Record<string, unknown>
}

/**
 * Prove that nothing was queued for `stream`. Callers first read the owner's copy of the same dispatch, and the
 * Gateway queues every Client's copy in the same turn, so a queued frame would settle the read at once.
 */
async function nothingQueued(stream: EventStream): Promise<void> {
  const marker = { queued: false }
  const raced = await Promise.race([stream.next(), new Promise((resolve) => { setTimeout(() => { resolve(marker) }, 30) })])
  expect(raced).toBe(marker)
}

describe('forwarded waterfalls for non-owner Peers', () => {
  it('delivers a member its own Session\'s approval and question, the owner every waterfall, and another member none of them', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    mounted.grant('bob', answers('s2'))
    const owner = await events(ctx, ctx.connection.browserPeer)
    const alice = await events(ctx, member(ctx, 'alice'))
    const bob = await events(ctx, member(ctx, 'bob'))

    ask(mounted, APPROVAL, 's1')
    ask(mounted, QUESTION, 's2')
    expect(await frame(owner)).toMatchObject({ type: 'waterfall', event: APPROVAL, agentId: 's1' })
    expect(await frame(owner)).toMatchObject({ type: 'waterfall', event: QUESTION, agentId: 's2' })
    expect(await frame(alice)).toMatchObject({ type: 'waterfall', event: APPROVAL, agentId: 's1', request: { text: `${APPROVAL} in s1` } })
    expect(await frame(bob)).toMatchObject({ type: 'waterfall', event: QUESTION, agentId: 's2' })
    await nothingQueued(alice)
    await nothingQueued(bob)
    for (const stream of [owner, alice, bob]) await stream.close()
  })

  it('lets a member answer its own Session\'s approval and question', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    const alice = await events(ctx, member(ctx, 'alice'))
    const approval = ask(mounted, APPROVAL, 's1')
    const question = ask(mounted, QUESTION, 's1')
    const asked = [await frame(alice), await frame(alice)]

    expect(await reply(ctx, alice.peer, alice.clientId, asked[0]!['eventId'])).toEqual({ ok: true })
    expect(approval.settled).toHaveBeenCalledWith({ kind: 'result', value: { approved: true } })
    expect(await reply(ctx, alice.peer, alice.clientId, asked[1]!['eventId'], { kind: 'result', value: 'blue' })).toEqual({ ok: true })
    expect(question.settled).toHaveBeenCalledWith({ kind: 'result', value: 'blue' })
    await alice.close()
  })

  it('refuses a member\'s answer to another member\'s approval and question, which stay answerable by their member', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    mounted.grant('bob', answers('s2'))
    const alice = await events(ctx, member(ctx, 'alice'))
    const bob = await events(ctx, member(ctx, 'bob'))
    const approval = ask(mounted, APPROVAL, 's1')
    const question = ask(mounted, QUESTION, 's1')
    const asked = [await frame(alice), await frame(alice)]

    for (const target of asked) {
      // Naming alice's event stream is refused: it belongs to another Peer.
      expect(await reply(ctx, bob.peer, alice.clientId, target['eventId'])).toMatchObject({
        ok: false, error: { code: 'gateway/interactions-forbidden' },
      })
      // Naming its own stream reaches nothing: that event was never delivered to bob.
      expect(await reply(ctx, bob.peer, bob.clientId, target['eventId'])).toEqual({ ok: true })
    }
    expect(approval.settled).not.toHaveBeenCalled()
    expect(question.settled).not.toHaveBeenCalled()

    expect(await reply(ctx, alice.peer, alice.clientId, asked[0]!['eventId'])).toEqual({ ok: true })
    expect(await reply(ctx, alice.peer, alice.clientId, asked[1]!['eventId'], { kind: 'next' })).toEqual({ ok: true })
    expect(approval.settled).toHaveBeenCalledWith({ kind: 'result', value: { approved: true } })
    expect(question.settled).toHaveBeenCalledWith({ kind: 'next' })
    for (const stream of [alice, bob]) await stream.close()
  })

  it('delivers no waterfall to a member without a policy, without a binding, or without the Agent resource kind', async () => {
    const cases = [
      { options: { policy: false }, bindings: [] },
      { options: {}, bindings: [] },
      { options: { agentResource: false }, bindings: [answers('s1')] },
    ]
    for (const { options, bindings } of cases) {
      const mounted = await mount(options)
      const { ctx } = mounted
      if (options.policy !== false) mounted.grant('alice', ...bindings)
      const owner = await events(ctx, ctx.connection.browserPeer)
      const alice = await events(ctx, member(ctx, 'alice'))
      ask(mounted, APPROVAL, 's1')
      expect(await frame(owner)).toMatchObject({ type: 'waterfall', event: APPROVAL })
      await nothingQueued(alice)
      for (const stream of [owner, alice]) await stream.close()
    }
  })

  it('delivers no waterfall to a member whose only grant is on the global resource', async () => {
    const globalAnswer: RemoteAccessBinding = {
      role: { name: 'test:global-answer', resource: 'global', actions: [`event:${APPROVAL}`] },
      resource: { kind: 'global' },
    }
    for (const agentResource of [false, true]) {
      const mounted = await mount({ agentResource })
      const { ctx } = mounted
      mounted.grant('alice', globalAnswer)
      const owner = await events(ctx, ctx.connection.browserPeer)
      const alice = await events(ctx, member(ctx, 'alice'))
      ask(mounted, APPROVAL, 's1')
      expect(await frame(owner)).toMatchObject({ type: 'waterfall', event: APPROVAL })
      await nothingQueued(alice)
      for (const stream of [owner, alice]) await stream.close()
    }
  })

  it('replays a pending waterfall to a member that connects later only as the policy allows', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    mounted.grant('bob', answers('s2'))
    const owner = await events(ctx, ctx.connection.browserPeer)
    ask(mounted, APPROVAL, 's1')
    expect(await frame(owner)).toMatchObject({ type: 'waterfall', event: APPROVAL })

    const alice = await events(ctx, member(ctx, 'alice'))
    const bob = await events(ctx, member(ctx, 'bob'))
    expect(await frame(alice)).toMatchObject({ type: 'waterfall', event: APPROVAL, agentId: 's1' })
    await nothingQueued(bob)
    for (const stream of [owner, alice, bob]) await stream.close()
  })

  it('refuses a member\'s answer once the policy withdraws its binding, and leaves the waterfall to the owner', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    const owner = await events(ctx, ctx.connection.browserPeer)
    const alice = await events(ctx, member(ctx, 'alice'))
    const approval = ask(mounted, APPROVAL, 's1')
    const ownerFrame = await frame(owner)
    const aliceFrame = await frame(alice)

    mounted.grant('alice')
    expect(await reply(ctx, alice.peer, alice.clientId, aliceFrame['eventId'])).toMatchObject({
      ok: false, error: { code: 'gateway/interactions-forbidden' },
    })
    expect(approval.settled).not.toHaveBeenCalled()
    expect(await reply(ctx, owner.peer, owner.clientId, ownerFrame['eventId'], { kind: 'result', value: 'owner' })).toEqual({ ok: true })
    expect(approval.settled).toHaveBeenCalledWith({ kind: 'result', value: 'owner' })
    for (const stream of [owner, alice]) await stream.close()
  })

  it('refuses the answer of a disposed member Peer', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    mounted.grant('alice', answers('s1'))
    const alice = await events(ctx, member(ctx, 'alice'))
    const approval = ask(mounted, APPROVAL, 's1')
    const asked = await frame(alice)
    await alice.peer.dispose()
    expect(await reply(ctx, alice.peer, alice.clientId, asked['eventId'])).toMatchObject({
      ok: false, error: { code: 'gateway/peer-disposed' },
    })
    expect(approval.settled).not.toHaveBeenCalled()
  })
})
