/**
 * The call table a domain's tools take, opened over one waiting table on one
 * member's behalf the way `ContentChannel.register` hands one to a domain, for
 * a case that also drives that waiting table's claims and reports itself.
 */
import type { CallTable, PendingCalls } from '../../src/access/pending.ts'

/** The member every call a case opens through {@link memberTable} is opened by. */
export const MEMBER = 'page'

/**
 * Open every call of one waiting table on {@link MEMBER}'s behalf.
 * @param pending - the waiting table.
 * @returns the table a tool takes.
 */
export function memberTable(pending: PendingCalls): CallTable {
  return {
    open: (callId, sessionId, signal, timeouts, page) => pending.open(callId, sessionId, signal, timeouts, MEMBER, page),
    sessionOf: callId => pending.sessionOf(callId),
  }
}
