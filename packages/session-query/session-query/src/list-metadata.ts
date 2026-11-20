/** Session-list metadata projection definition registered by `SessionQueryEngine`. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { SessionListMetadata } from './types.ts'

const sessionListMetadataSchema: z.ZodType<SessionListMetadata> = z.object({
  blank: z.boolean(),
  lastPromptAt: z.number().nullable(),
})

/**
 * Whether `event` is a `command/run` that engages the Session (any run without `engages: false`).
 * Inspected by event name so `dsh-session-query` stays decoupled from `@deepseek-ai/dsh-commands`.
 */
function isEngagingCommandRun(event: SessionEvent): boolean {
  const eventType: string = event.type
  if (eventType !== 'command/run') return false
  const data: object = event.data
  return Reflect.get(data, 'engages') !== false
}

/**
 * Advance blankness and human-prompt recency without retaining history.
 * `blank` falls on the first `turn/start` or engaging `command/run`, and never rises again.
 */
function applySessionListMetadata(
  state: SessionListMetadata,
  event: SessionEvent,
): SessionListMetadata {
  const blank = state.blank
    && event.type !== 'turn/start'
    && !isEngagingCommandRun(event)
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/** Blankness and latest human-prompt time folded per Session; persisted at state version 1. */
export const sessionListMetadataDefinition = {
  key: 'sessionListMetadata',
  stateSchema: sessionListMetadataSchema,
  init: () => ({ blank: true, lastPromptAt: null }),
  apply: applySessionListMetadata,
  wire: { viewSchema: sessionListMetadataSchema, view: state => state },
  stateVersion: 1,
} satisfies ProjectionDefinition<'sessionListMetadata', SessionListMetadata>
