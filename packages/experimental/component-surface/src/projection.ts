/**
 * How one committed session event becomes a `show_component` call.
 *
 * This package registers no projection unit of its own: the entries it
 * contributes live in the content surface's `contentSurface` fold, and what it
 * owns there is this reader. Two log shapes carry a call and both count — a
 * top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode
 * `tool/code-dispatch-start`, whose `arguments` is already decoded. A model
 * reaching the tool through `run_code` logs only the second, so a reader
 * recognizing one shape would find no components at all in that session.
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

/**
 * Read the `show_component` arguments one committed event recorded.
 * @param event - the committed session event.
 * @returns the recorded arguments, or `undefined` when the event records no readable call.
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
  return undefined
}
