/**
 * How one committed session event becomes a block for the column.
 *
 * This package registers no projection unit for its entries: they live in the
 * content surface's `contentSurface` fold, and what it owns there is this
 * reader. Three log shapes carry one, and all three count — a top-level
 * `tool/call`, whose `arguments` is raw JSON; a Code Mode
 * `tool/code-dispatch-start`, whose `arguments` is already decoded; and the
 * `content-component/shown` a user's click on a configured view writes. A model
 * reaching the tool through `run_code` logs only the second, so a reader
 * recognizing one shape would find no components at all in that session, and a
 * reader recognizing only the two tool shapes would leave every view the user
 * opened out of the column.
 *
 * All three answer with the same three values, so everything downstream — the
 * judgement, the entry, the invariant's audit — reads one thing and cannot
 * treat a view and a call differently by accident.
 *
 * Shared by the extractor and by the invariant companion, so what the column
 * shows and what the companion audits are counted the same way.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  parseComponentCall,
  readComponentCall,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentCallArguments,
} from './component-call.ts'
// Type-only: this package's own `content-component/shown` SessionEventMap merge.
import type {} from './types.ts'

/**
 * Read the block one committed event records, whoever wrote it.
 * @param event - the committed session event.
 * @returns the recorded arguments, or `undefined` when the event records no readable block.
 */
export function readComponentEvent(event: SessionEvent): ComponentCallArguments | undefined {
  if (event.type === 'tool/call') {
    if (event.data.name !== SHOW_COMPONENT_TOOL_NAME) return undefined
    return parseComponentCall(event.data.arguments)
  }
  if (event.type === 'tool/code-dispatch-start') {
    if (event.data.name !== SHOW_COMPONENT_TOOL_NAME) return undefined
    return readComponentCall(event.data.arguments)
  }
  if (event.type === 'content-component/shown') {
    // The entry id is the id a call would have carried: one view owns one
    // entry, and a second click on it replaces what that entry shows.
    return { id: event.data.entryId, title: event.data.title, spec: event.data.spec }
  }
  return undefined
}
