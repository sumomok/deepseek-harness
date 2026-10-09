/**
 * This package's browser half of the shared content channel.
 *
 * A host cannot address a browser, so an `act_component` call reaches the page
 * as a projection and is claimed by the tab showing that session, over the same
 * claim and report routes every content domain posts through. What this module
 * adds to that channel is one domain: which tool it answers, and what a claimed
 * call does — find the entry the column is drawing, refuse when it is not the
 * one the call named, and otherwise run the steps inside it.
 *
 * The channel itself is another row's, reached through the `contentTabChannel`
 * service and read as a value only at the moment a seat joins it: a client
 * bundle may not carry another plugin's values, and the tab identity, the bid
 * loop and the report route are exactly what this domain should not own.
 *
 * The refusal is the whole reason the entry is looked up again here rather than
 * taken from the call: the column replaces what it draws without telling this
 * seat, so the entry a call was claimed against and the entry on screen can
 * differ by the time the steps would run. Acting then would press a control the
 * call never asked for.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/act-channel
 */

// Type-only: the shared channel's own shapes, erased before any bundle carries them.
import type {
  ChannelCall, ChannelDomain, ChannelSeat,
} from '@deepseek-ai/dsh-experimental-content-frame/src/client/access/channel.ts'
import type { ChannelOutcome } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { ACT_COMPONENT_TOOL_NAME, type ActComponentCall } from '../act-component-call.ts'
import { NO_ENTRY_IN_FRONT, anotherEntryInFront } from '../act-component-text.ts'
import { runActComponent } from './act-executor.ts'
import { drawnEntry } from './entry-container.ts'

/** One `act_component` call as this seat offers it: the call, and the request behind it. */
export interface ActComponentSeatCall extends ChannelCall {
  /** The call as the projection published it. */
  readonly request: ActComponentCall
}

/** Where one seat reports what it can answer: the offering point, and the parking call that ends it. */
export interface ActComponentWiring {
  /**
   * Tell the channel what this seat can answer now.
   * @param sessionId - the session the seat is drawing, absent while none is.
   * @param pending - that session's open `act_component` calls, as the projection published them.
   */
  offer(sessionId: string | undefined, pending: readonly ActComponentCall[]): void
  /** Stop answering: the seat that offered the calls is gone. */
  park(): void
}

/** The one thing this module needs of the channel another row provides. */
export interface ContentChannelJoin {
  /**
   * Join one domain to the channel.
   * @param domain - the domain: which calls it answers, and how.
   * @returns the seat's offering point, and the parking call that ends it.
   */
  join<Call extends ChannelCall, Outcome = ChannelOutcome>(
    domain: ChannelDomain<Call, Outcome>,
  ): ChannelSeat<Call>
}

/**
 * Join this page's component seat to the shared content channel.
 * @param channel - the channel service, read at the moment this seat joins it.
 * @returns the seat's offering point and its parking call.
 */
export function joinActComponentChannel(channel: ContentChannelJoin): ActComponentWiring {
  const domain: ChannelDomain<ActComponentSeatCall> = {
    name: ACT_COMPONENT_TOOL_NAME,
    ready: () => true,
    answer: async (call: ActComponentSeatCall) => {
      // Read again here, after the claim: the column switches what it draws
      // without re-rendering this seat, so what was on screen when the call was
      // offered is not what is on screen now.
      const drawn = drawnEntry(document)
      if (drawn === undefined) return refusal('empty', NO_ENTRY_IN_FRONT)
      if (drawn.entryId !== call.request.args.entry) {
        return refusal('front-changed', anotherEntryInFront(drawn.entryId))
      }
      const run = await runActComponent(call.request.args, drawn)
      return {
        kind: 'outcome',
        outcome: {
          status: run.status,
          page: { id: drawn.entryId, title: drawn.title },
          title: drawn.title,
          steps: [...run.steps],
          text: run.text,
          // The report carries the steps' own sentences rather than a listing,
          // so nothing here is cut short by a budget of this package's.
          truncated: false,
        },
      }
    },
  }
  const seat: ChannelSeat<ActComponentSeatCall> = channel.join(domain)
  return {
    offer: (sessionId, pending) => {
      seat.offer({
        calls: sessionId === undefined
          ? []
          : pending.map(request => ({ callId: request.callId, sessionId, request })),
        openCalls: pending.map(request => request.callId),
      })
    },
    park: () => { seat.park() },
  }
}

/**
 * The answer one refusal settles as.
 *
 * The code is the shared channel's own for this ending: `empty` when the column
 * holds no component entry, `front-changed` when it holds another one. What the
 * model reads is the sentence, which says only what stopped the call.
 * @param code - which of the two endings this is.
 * @param message - what the console has to say about it.
 * @returns the domain's answer, which the channel composes a document around.
 */
function refusal(code: 'empty' | 'front-changed', message: string): { kind: 'outcome'; outcome: ChannelOutcome } {
  return { kind: 'outcome', outcome: { status: 'error', code, message } }
}
