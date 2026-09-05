/**
 * Carry one gesture made inside a block back to the agent, and remember the
 * gestures still on their way there.
 *
 * The seat sends it as an ordinary command line, so what the user did lands in
 * the session log as the command's own recorded input before anything decides
 * whether the model should see it. The node half owns that decision, and
 * `component-call.ts` owns the line's shape; what is here is the dispatch, the
 * one limit a browser can apply before the line exists, and the page-level
 * table of presses that have not become records yet.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/action
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  COMPONENT_ACTION_COMMAND,
  formatComponentActionLine,
  MAX_ACTION_PAYLOAD_BYTES,
  type ComponentAction,
} from '../component-call.ts'

/**
 * Whether a reported gesture became a record the seat can wait for.
 *
 * The one thing the caller has to know, and the only thing a browser can find
 * out on its own. `dispatched` means the command ran: its `command/run` is in
 * the log, and what became of it arrives with the next fold of that log —
 * including a handler that refused it, which is a recorded answer rather than a
 * lost press. `failed` means no record exists and none is coming, so a block
 * that kept waiting would wait forever.
 */
export type ActionDispatch = 'dispatched' | 'failed'

/**
 * Presses that have left a block and have no record yet, one row per block.
 *
 * The table lives above every seat because the seat does not: the column
 * discards a kind's DOM whenever the user picks another entry, so a block
 * unmounted between the press and its record would come back with nothing to
 * say it is waiting and let the same decision be reported twice. A row is
 * written when the press leaves, and removed by the block that wrote it — when
 * the record arrives, or when the dispatch fails. What a row holds is the log
 * position the press is waiting past, so the block can tell the record it is
 * waiting for from the older one it could already see.
 *
 * A row whose block is never drawn again — the entry replaced by a later call
 * while the press was in flight — is left behind, because its key names a
 * placing call no block will carry again and nothing can read it. The table
 * therefore grows by at most one row per such press and is emptied with the
 * page.
 */
export type PendingPresses = Map<string, number>

/**
 * The row one block's in-flight press is held under.
 *
 * All four parts are needed: the session because one page shows several, the
 * entry and the block because a spec draws many, and the placing call's log
 * position because a later call under the same entry id draws blocks that reuse
 * every other part of the key and start unanswered.
 * @param sessionId - the session the press was made in; `undefined` where none is current, in
 *   which case the row is written and removed without ever being read.
 * @param entryId - the content entry the block belongs to.
 * @param entrySeq - log position of the call that placed the block.
 * @param nodeId - the block within that call's spec.
 * @returns the table key.
 */
export function pendingPressKey(
  sessionId: string | undefined,
  entryId: string,
  entrySeq: number,
  nodeId: string,
): string {
  return JSON.stringify([sessionId ?? null, entryId, entrySeq, nodeId])
}

/**
 * Execute `/component-action <json>` against a session, warning (never
 * throwing) on an oversized action, a failed dispatch, or a rejected input.
 *
 * The size check is the browser's copy of a limit the host applies again: the
 * command's record is written verbatim before any handler runs, so a document
 * past the ceiling would be logged and then dropped on its way to the model.
 * Refusing it here is what keeps that from happening at all — and it is the
 * only part of the trimming this half can enforce. Which properties an action
 * may carry is the catalog's declaration, and keeping to it is the renderer's
 * obligation, not something checked here (the README's Known Limitations
 * records it).
 *
 * What the user sees of the gesture's own outcome is whatever the agent does
 * next, never this call's return. What the return does say is narrower and the
 * seat cannot do without it: whether there is going to be a record at all.
 * @param ctx - client root context (remote.commands).
 * @param sessionId - the session the gesture happened in.
 * @param action - the gesture, already naming the entry, node, component, and action.
 * @returns `dispatched` when the command ran and its records are on their way, `failed` when the gesture reached no log.
 */
export async function postAction(
  ctx: ClientContext,
  sessionId: string,
  action: ComponentAction,
): Promise<ActionDispatch> {
  const bytes = new TextEncoder().encode(JSON.stringify(action)).length
  if (bytes > MAX_ACTION_PAYLOAD_BYTES) {
    console.warn(`component-surface: ${action.componentId} action ${action.actionId} carries ${bytes} bytes, over the ${MAX_ACTION_PAYLOAD_BYTES}-byte limit — not sent`)
    return 'failed'
  }
  // The gateway seam, not a same-process call: a closed socket, a gateway that
  // restarted, or a session the host no longer holds reject the promise, and a
  // seat left waiting on a record nobody is writing is the whole reason this
  // function reports back at all.
  const result = await ctx.remote.commands.execute(sessionId as SessionId, formatComponentActionLine(action), [])
    .catch((reason: unknown) => {
      console.warn(`component-surface: ${COMPONENT_ACTION_COMMAND} did not reach the host: ${String(reason)}`)
      return undefined
    })
  if (result === undefined) return 'failed'
  if (!result.ok) {
    console.warn(`component-surface: ${COMPONENT_ACTION_COMMAND} failed: ${result.error.code}: ${result.error.message}`)
    return 'failed'
  }
  // A handler that answered with an error still ran, and both of its records are
  // in the log: the block reads that refusal off the fold like any other
  // settlement rather than off this return.
  if (result.value !== undefined && result.value.result.kind === 'error') {
    console.warn(`component-surface: ${COMPONENT_ACTION_COMMAND}: ${result.value.result.text}`)
  }
  return 'dispatched'
}
