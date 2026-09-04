/**
 * What every reading tool of the page channel shares: the address its answer
 * prints, the page its answer names, and how it reads the settlement its wait
 * ended with.
 *
 * The four reads — the listing, the element tree, one element's attributes, one
 * element's text — differ in what the browser seat walks and in nothing this
 * side does. So the waiting, the four endings, and the sentence each ending
 * earns live here once, and a read is a description, a parameter list and a
 * kind. `content_act` keeps its own: one of its endings is a value rather than
 * a rejection, because steps that ran cannot be reported as nothing having
 * happened.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/read-value
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CallTimeouts, PendingCalls } from './pending.ts'
import {
  CANCELLED_REFUSAL, MISREPORTED_REFUSAL, NO_AGENT_REFUSAL, unansweredRefusal, unclaimedRefusal, type FrontEntry,
} from './text.ts'
import { isActOutcome, type ReadOutcome, type ReadSnapshot } from './wire.ts'

/**
 * Read the entry one session's column has in front.
 *
 * Only the unclaimed refusal reads it, and only to state what the column was
 * holding while no seat answered for it. A composition with no projection
 * registry supplies a lookup that answers `undefined`, which is the same answer
 * an empty column gives and the same sentence it earns.
 */
export type FrontEntryLookup = (session: Session) => FrontEntry | undefined

/** The channel one reading tool waits on, as its deployment settled it. */
export interface ReadWait {
  /** The table calls wait on for a browser to answer them. */
  readonly pending: PendingCalls
  /** The deployment's deadlines, also quoted in the two timeout refusals. */
  readonly timeouts: CallTimeouts
  /** Reads the entry the calling session's column has in front, for the unclaimed refusal. */
  readonly front: FrontEntryLookup
}

/**
 * The page every read names in its answer, as the deployment names it. One
 * declaration, because the four reads answer about the same column and a second
 * copy would drift the first time a field is documented.
 */
export const PAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  description: 'The page the column had in front.',
  properties: {
    id: { type: 'string', required: true, description: 'The page\'s configured id.' },
    title: { type: 'string', required: true, description: 'The page\'s configured title.' },
  },
} as const

/** The part of one posted snapshot every read's value repeats, whatever it read. */
export interface ReadBody {
  /** The rendered answer. */
  text: string
  /** True when the answer stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the answer prints. */
  shown: number
  /** How many rows the answer has in full. */
  total: number
  /** The ref to pass back as `after`; present only on an answer cut short. */
  cursor?: string
  /** False when the page was still changing when the read ran. */
  settled: boolean
}

/**
 * The body fields of one read's value.
 *
 * One home, because a second copy drifts the first time a field is added: a
 * value carrying a cursor the tool's schema does not declare is refused by the
 * registry, and the model is told its own arguments were wrong.
 * @param snapshot - the snapshot the seat posted.
 * @returns the body fields, the cursor present only where the answer was cut.
 */
export function readBody(snapshot: ReadSnapshot): ReadBody {
  return {
    text: snapshot.text,
    truncated: snapshot.truncated,
    shown: snapshot.shown,
    total: snapshot.total,
    ...snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor },
    settled: snapshot.settled,
  }
}

/**
 * The part of a frame's URL worth spending tokens on.
 *
 * The origin carries no information — every page the column can show is a path
 * on the dsh origin — so the model is told where in the application it is
 * looking, not which host it is talking to.
 * @param url - the document's own URL as the browser reported it.
 * @returns the path, query, and fragment, or the whole value when it is not a URL.
 */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (_reportedUrlIsNotAbsolute) {
    // A wire value: the browser sends `document.URL`, which is absolute, but
    // this route takes JSON from anything that can reach the origin.
    return url
  }
}

/**
 * Wait for a browser to answer one read, and turn what it posted into the
 * calling tool's own value.
 *
 * Every ending but the listing itself is a rejection stating why this call was
 * refused. None of them names a tool: the reason is the same whichever read
 * asked, and what to do about it is read off the tools' own descriptions.
 * @param wait - the table, the deadlines, and the column lookup the unclaimed refusal reads.
 * @param exec - the execution: its call id opens the wait and its signal cancels it.
 * @param take - how the calling tool reads the outcome it was answered.
 * @returns the calling tool's value.
 * @throws {Error} for a caller with no owning session, and for every ending
 * that answered this call with no read of its own.
 */
export async function awaitRead<T>(
  wait: ReadWait,
  exec: ToolRunContext,
  take: (outcome: ReadOutcome) => T,
): Promise<T> {
  // The column is per-session state, and the pending list a browser reads is
  // that session's projection; a caller with no owning session has no column to
  // be shown one.
  if (!exec.agent) throw new Error(NO_AGENT_REFUSAL)
  const settlement = await wait.pending.open(exec.callId, exec.agent.session.header.id, exec.signal, wait.timeouts)
  switch (settlement.kind) {
    case 'reported': {
      // The table holds every tool's calls and hands over whatever was posted;
      // a document reporting steps answers a different call than this one asked.
      const outcome = settlement.outcome
      if (isActOutcome(outcome)) throw new Error(MISREPORTED_REFUSAL)
      return take(outcome)
    }
    case 'unclaimed': throw new Error(unclaimedRefusal(wait.timeouts.claimTimeoutMs, wait.front(exec.agent.session)))
    case 'unanswered': throw new Error(unansweredRefusal(wait.timeouts.answerTimeoutMs))
    // Whatever this throws is replaced by the registry's aborted result; the
    // message exists for a caller reading the rejection directly.
    case 'aborted': throw new Error(CANCELLED_REFUSAL)
    /* v8 ignore next 2 -- the settlement union is closed and typed; the arm keeps a new member loud. */
    default: throw new Error(`content-frame: unknown settlement ${JSON.stringify(settlement)}`)
  }
}
