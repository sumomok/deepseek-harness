// @vitest-environment jsdom
/**
 * This package's browser half of the shared content channel: what a claimed
 * call of either tool answers with.
 *
 * The channel itself belongs to another row and is stood in here — what this
 * file owns is the domain that is joined to it: which entry a call is matched
 * against, the two refusals when it is not the one in front, what a run
 * reports, and what a reading reports. The real claim and report routes are
 * exercised by `act-component-chain.client.spec.tsx`.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaimAck } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import type {
  ChannelDomain, ChannelSeat,
} from '@deepseek-ai/dsh-experimental-content-frame/src/client/access/channel.ts'
import { COMPONENT_DOMAIN, type ComponentCall } from '../src/act-component-call.ts'
import type { ReadComponentCall } from '../src/read-component-call.ts'
import {
  joinComponentChannel, type ComponentSeatCall, type ContentChannelJoin,
} from '../src/client/component-channel.ts'

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

/** The one act call the cases here offer. */
function request(entry = ENTRY): ComponentCall {
  return { callId: 'call_1', tool: 'act_component', args: { entry, steps: [{ action: 'click', key: 'add' }] } }
}

/** One read call of the same entry. */
function reading(entry = ENTRY, node?: string): ReadComponentCall {
  return {
    callId: 'call_1',
    tool: 'read_component',
    args: { entry, ...node === undefined ? {} : { node } },
  }
}

/** A channel that keeps the domain joined to it and the demand its seat was offered. */
interface Stood {
  channel: ContentChannelJoin
  domain: () => ChannelDomain<ComponentSeatCall>
  offers: unknown[]
  parked: number
}

/** Stand in the channel another row provides, keeping what is joined and offered. */
function stood(): Stood {
  let joined: ChannelDomain<ComponentSeatCall> | undefined
  const offers: unknown[] = []
  const state = { parked: 0 }
  const seat: ChannelSeat<ComponentSeatCall> = {
    offer: (demand) => { offers.push(demand) },
    park: () => { state.parked += 1 },
  }
  return {
    channel: {
      join: (domain) => {
        joined = domain
        return seat
      },
    },
    domain: () => {
      if (joined === undefined) throw new Error('no domain joined the standing channel')
      return joined
    },
    offers,
    get parked() { return state.parked },
  }
}

beforeEach(() => { document.body.innerHTML = '' })

describe('the component domain', () => {
  it('joins under the package domain\'s name and is always ready', () => {
    const fake = stood()
    const wiring = joinComponentChannel(fake.channel)
    expect(fake.domain().name).toBe(COMPONENT_DOMAIN)
    expect(fake.domain().ready()).toBe(true)
    expect(typeof wiring.offer).toBe('function')
  })

  it('offers every open call of the session, whichever tool asked, and nothing when the seat holds none', () => {
    const fake = stood()
    const wiring = joinComponentChannel(fake.channel)
    const second = { ...reading(), callId: 'call_2' }
    wiring.offer('session_1', [request(), second])
    expect(fake.offers).toEqual([{
      calls: [
        { callId: 'call_1', sessionId: 'session_1', request: request() },
        { callId: 'call_2', sessionId: 'session_1', request: second },
      ],
      openCalls: ['call_1', 'call_2'],
    }])
    // A seat with no session offers no calls, but still reports every id open
    // on the tab, which is what prunes the calls it has taken up.
    wiring.offer(undefined, [request()])
    expect(fake.offers[1]).toEqual({ calls: [], openCalls: ['call_1'] })
  })

  it('parks the seat, which drops the calls it was offering', () => {
    const fake = stood()
    const wiring = joinComponentChannel(fake.channel)
    wiring.park()
    expect(fake.parked).toBe(1)
  })

  it('refuses a call while no component entry is in front', async () => {
    document.body.innerHTML = '<div data-content-surface-seat="component"><div data-component-surface></div></div>'
    const fake = stood()
    joinComponentChannel(fake.channel)
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
    joinComponentChannel(fake.channel)
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
    joinComponentChannel(fake.channel)
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

  it('reads the entry and answers with the reading, pressing nothing', async () => {
    document.body.innerHTML = COLUMN
    const pressed = vi.fn()
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', pressed)
    const fake = stood()
    joinComponentChannel(fake.channel)
    const answer = await fake.domain().answer({ callId: 'call_1', sessionId: 'session_1', request: reading() }, CLAIMED)
    expect(pressed).not.toHaveBeenCalled()
    expect(answer).toEqual({
      kind: 'outcome',
      outcome: {
        status: 'read',
        page: { id: ENTRY, title: 'Demo' },
        text: [
          'Read the component entry "Demo" (demo).',
          'Blocks: none.',
          'Controls:',
          '  - "add": button "Add"',
          'Fields: none.',
          'No dialog is open.',
        ].join('\n'),
      },
    })
  })

  it('refuses a read call while another entry is in front, in the same sentences', async () => {
    document.body.innerHTML = `
      <nav data-content-surface-switcher>
        <button data-content-surface-entry="page home" data-content-surface-selected>Home</button>
      </nav>
      <div data-content-surface-seat="component" data-content-surface-active>
        <div data-component-surface></div>
      </div>
    `
    const fake = stood()
    joinComponentChannel(fake.channel)
    expect(await fake.domain().answer({ callId: 'call_1', sessionId: 'session_1', request: reading() }, CLAIMED))
      .toEqual({
        kind: 'outcome',
        outcome: { status: 'error', code: 'empty', message: 'No component entry is in front, so there is nothing to act on.' },
      })
  })
})
