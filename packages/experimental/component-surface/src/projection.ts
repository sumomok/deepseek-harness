/**
 * How one committed session event becomes a block for the column.
 *
 * This package registers no projection unit for its entries: they live in the
 * content surface's `contentSurface` fold, and what it owns there is this
 * reader. Four log shapes carry one, and all four count — a top-level
 * `tool/call`, whose `arguments` is raw JSON; a PTC mode
 * `tool/ptc-dispatch-start`, whose `arguments` is already decoded; the
 * `content-component/shown` a user's click on a configured view writes; and the
 * `content-component/resolved` the tool writes for a call whose rows it read
 * from the deployment's data backend. A model reaching the tool through
 * `run_code` logs only the second, so a reader recognizing one shape would find
 * no components at all in that session; a reader recognizing only the two tool
 * shapes would leave every view the user opened out of the column; and a reader
 * ignoring the fourth would find a call whose rows are nowhere in its own
 * arguments and draw nothing for it.
 *
 * All four answer with the same three values, so everything downstream — the
 * judgement and the entry — reads one thing and cannot treat a view, a read
 * and a hand-written call differently by accident.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  dataPageNodes,
  parseComponentCall,
  readComponentCall,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentCallArguments,
  type ComponentSpec,
} from './component-call.ts'
// Type-only: this package's own SessionEventMap merges.
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
  if (event.type === 'tool/ptc-dispatch-start') {
    if (event.data.name !== SHOW_COMPONENT_TOOL_NAME) return undefined
    return readComponentCall(event.data.arguments)
  }
  if (event.type === 'content-component/shown') {
    // The entry id is the id a call would have carried: one view owns one
    // entry, and a second click on it replaces what that entry shows.
    return { id: event.data.entryId, title: event.data.title, spec: event.data.spec }
  }
  if (event.type === 'content-component/resolved') {
    // The recorded spec already carries the rows that were read, so it is the
    // same three values a hand-written call carries — and it goes through the
    // same judgement below rather than being trusted for having been written
    // here.
    return { id: event.data.entryId, title: event.data.title, spec: event.data.spec }
  }
  return undefined
}

/**
 * Whether one recorded call is the entry it names, or a question still
 * standing in front of it.
 *
 * A call that opens the deployment's own data page is recorded as a `tool/call`
 * before the user has been asked, and the record the column draws it from is
 * the `content-component/resolved` the tool appends once they have agreed. The
 * call's own record therefore records no entry: an entry drawn from it would
 * put the page on screen — and its first request on the wire, with the user's
 * own credential — before the answer, and would keep it there after a refusal.
 * @param event - the committed session event the spec was read from.
 * @param spec - the spec, as validation accepted it.
 * @returns true when the event records the entry; false when a later record does.
 */
export function recordsEntry(event: SessionEvent, spec: ComponentSpec): boolean {
  const isCall = event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start'
  return !(isCall && dataPageNodes(spec).length > 0)
}
