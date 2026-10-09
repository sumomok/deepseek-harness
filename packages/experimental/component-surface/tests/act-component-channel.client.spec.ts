// @vitest-environment jsdom
/**
 * This package's browser half of the shared content channel: what a claimed
 * `act_component` call answers with.
 *
 * The channel itself belongs to another row and is stood in here — what this
 * file owns is the domain that is joined to it: which entry the call is matched
 * against, the two refusals when it is not the one in front, and what a run
 * reports. The real claim and report routes are exercised by
 * `act-component-chain.client.spec.tsx`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelOutcome, ClaimAck } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import type {
  ChannelCall, ChannelDomain, ChannelSeat,
} from '@deepseek-ai/dsh-experimental-content-frame/src/client/access/channel.ts'
import type { ActComponentCall } from '../src/act-component-call.ts'
import {
  joinActComponentChannel, type ActComponentSeatCall, type ContentChannelJoin,
} from '../src/client/act-channel.ts'

/** The entry id every case here acts on. */
const ENTRY = 'demo'

/** How a claim is acknowledged; the domain only passes it along. */
const CLAIMED: ClaimAck = { claimed: true }

/** How the console's content column is drawn around one component entry. */
const COLUMN = `
<nav data-content-surface-switcher>
  <button data-content-surface-entry="component demo" data-content-surface-selected>Demo</button>
</nav>
<div data-content-surface-seat="component" data-content-surface-active>
  <div data-component-surface>
    <button data-component-action="add">Add</button>
  </div>
</div>
`

/** The one call the cases here offer. */
function request(entry = ENTRY): ActComponentCall {
  return { callId: 'call_1', tool: 'act_component', args: { entry, steps: [{ action: 'click', key: 'add' }] } }
}

/** A channel that keeps the domain joined to it and the demand its seat was offered. */
interface Stood {
  channel: ContentChannelJoin
  domain: () => ChannelDomain<ActComponentSeatCall>
  offers: unknown[]
  parked: number
}

/** Stand in the channel another row provides, keeping what is joined and offered. */
function stood(): Stood {
  let joined: ChannelDomain<ActComponentSeatCall> | undefined
  const offers: unknown[] = []
  const state = { parked: 0 }
  const seat: ChannelSeat<ActComponentSeatCall> = {
    offer: (demand) => { offers.push(demand) },
    park: () => { state.parked += 1 },
  }
  return {
    channel: {
      join: <Call extends ChannelCall, Outcome = ChannelOutcome>(domain: ChannelDomain<Call, Outcome>) => {
        joined = domain as unknown as ChannelDomain<ActComponentSeatCall>
        return seat as unknown as ChannelSeat<Call>
      },
    },
    domain: () => joined as ChannelDomain<ActComponentSeatCall>,
    offers,
    get parked() { return state.parked },
  } as Stood
}

beforeEach(() => { document.body.innerHTML = '' })

describe('the act_component domain', () => {
  it('joins under the tool name and is always ready', () => {
    const fake = stood()
    const wiring = joinActComponentChannel(fake.channel)
    expect(fake.domain().name).toBe('act_component')
    expect(fake.domain().ready()).toBe(true)
    expect(typeof wiring.offer).toBe('function')
  })

  it('offers every open call of the session, and nothing when the seat holds none', () => {
    const fake = stood()
    const wiring = joinActComponentChannel(fake.channel)
    wiring.offer('session_1', [request()])
    expect(fake.offers).toEqual([{
      calls: [{ callId: 'call_1', sessionId: 'session_1', request: request() }],
      openCalls: ['call_1'],
    }])
    // A seat with no session offers no calls, but still reports every id open
    // on the tab, which is what prunes the calls it has taken up.
    wiring.offer(undefined, [request()])
    expect(fake.offers[1]).toEqual({ calls: [], openCalls: ['call_1'] })
  })

  it('parks the seat, which drops the calls it was offering', () => {
    const fake = stood()
    const wiring = joinActComponentChannel(fake.channel)
    wiring.park()
    expect(fake.parked).toBe(1)
  })

  it('refuses a call while no component entry is in front', async () => {
    document.body.innerHTML = '<div data-content-surface-seat="component"><div data-component-surface></div></div>'
    const fake = stood()
    joinActComponentChannel(fake.channel)
    expect(await fake.domain().answer({ callId: 'call_1', sessionId: 'session_1', request: request() }, CLAIMED))
      .toEqual({
        kind: 'outcome',
        outcome: { status: 'error', code: 'empty', message: 'No component entry is in front, so there is nothing to act on.' },
      })
  })

  it('refuses a call when the entry in front is another one', async () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="component other" data-content-surface-selected>Other</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div data-component-surface></div>
      </div>
    `
    const fake = stood()
    joinActComponentChannel(fake.channel)
    expect(await fake.domain().answer({ callId: 'call_1', sessionId: 'session_1', request: request() }, CLAIMED))
      .toEqual({
        kind: 'outcome',
        outcome: { status: 'error', code: 'front-changed', message: 'The entry in front is "other", not the one this call named.' },
      })
  })

  it('runs the steps inside the entry and reports what happened', async () => {
    document.body.innerHTML = COLUMN
    const pressed = vi.fn()
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', pressed)
    const fake = stood()
    joinActComponentChannel(fake.channel)
    const answer = await fake.domain().answer({ callId: 'call_1', sessionId: 'session_1', request: request() }, CLAIMED)
    expect(pressed).toHaveBeenCalledTimes(1)
    expect(answer).toEqual({
      kind: 'outcome',
      outcome: {
        status: 'done',
        page: { id: ENTRY, title: 'Demo' },
        title: 'Demo',
        steps: [{ index: 1, status: 'ok' }],
        text: 'Acted on the component entry "Demo" (demo).\n- click on "add": done',
        // The report carries the steps' own sentences rather than a listing, so
        // nothing here is cut short by a budget of this package's.
        truncated: false,
      },
    })
  })
})
