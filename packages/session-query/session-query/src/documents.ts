/** Shared event metadata and semantic-document projection. */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord, SessionEventSearchDocument, SessionEventSurface } from './types.ts'
import { SessionQueryError } from './config.ts'
import { extractSessionEventText } from './extraction.ts'

/**
 * Project a raw log into lightweight surface-aware event records.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns one record per event in ascending seq order.
 */
export function buildSessionEventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  const surfaceBySeq = classifySurface(events)
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: surfaceBySeq.get(event.seq) ?? 'log-only',
  }))
}

/**
 * Build first-party semantic documents for one complete raw event log.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns searchable documents in ascending seq order; structural events are omitted.
 */
export function buildSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  const surfaceBySeq = classifySurface(events)
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
    // Most `user/message` events are context the harness injects for the next
    // turn — time, runtime, skills, subagent settlements, compaction
    // checkpoints. Only `source.kind === 'user'` is prose the person wrote and
    // the transcript shows as their message, so the rest is not searchable.
    if (event.type === 'user/message' && !isHumanMessage(event.data.source)) continue
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: surfaceBySeq.get(event.seq) ?? 'log-only',
      text,
    })
  }
  return documents
}

/**
 * Whether one message source records text a person wrote.
 *
 * `MessageSourceMap` is merge-extensible and this program does not load every
 * declaration, so the tag is read as its own discriminant text. An unknown tag
 * falls on the non-human side: indexing scaffolding is what produced hits no
 * transcript row could show.
 * @param source - message source of one `user/message` event.
 * @returns whether the event carries the person's own message.
 */
function isHumanMessage(source: { readonly kind: string }): boolean {
  return source.kind === 'user'
}

function classifySurface(events: readonly SessionEvent[]): Map<SessionSeq, SessionEventSurface> {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events, currentSessionMessageProjections)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const result = new Map<SessionSeq, SessionEventSurface>()
  for (const seq of folded.nodes) result.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) result.set(seq, 'shadowed')
  }
  return result
}
