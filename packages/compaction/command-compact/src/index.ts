/**
 * Human-facing `/compact` command over the backend-independent compaction seam.
 * @module @deepseek-ai/dsh-command-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { COMPACT_RESULT_TEXT } from './result-text.ts'

export const name = 'command-compact'
export const inject = ['commands', 'compaction']


/** Fail loudly if a locally closed union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown manual compaction error code: ${String(value)}`)
}
/* v8 ignore stop */

/** Convert expected capability failures into concise human-only outcomes. */
function expectedFailure(error: ManualCompactionError): CommandResult {
  switch (error.code) {
    case 'busy':
    case 'cancelled':
    case 'changed':
    case 'summary':
    case 'commit':
    case 'persistence':
      return { kind: 'error', text: COMPACT_RESULT_TEXT[error.code] }
    /* v8 ignore next 2 -- ManualCompactionErrorCode is closed and every member is handled above */
    default: return assertNever(error.code)
  }
}

/**
 * Resolve when a request made during a running turn compacts: the mounted
 * `manualCompactionTiming` provider's live answer, or none, which the engine
 * refuses as `busy`.
 * @param ctx - context that may carry the timing provider.
 * @returns the timing to pass to `compactNow`.
 */
function resolveWhileBusy(ctx: Context): ManualCompactionWhileBusy | undefined {
  return ctx.get('manualCompactionTiming')?.whileBusy()
}

/** Execute one argument-free manual compaction request. */
async function executeCompact(
  ctx: Context,
  invocation: CommandInvocation,
  signal: AbortSignal,
): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) {
    return { kind: 'error', text: COMPACT_RESULT_TEXT.usage }
  }
  try {
    const result = await ctx.compaction.compactNow(invocation.agent, signal, invocation.commandId, resolveWhileBusy(ctx))
    if (result === null) return { kind: 'success', text: COMPACT_RESULT_TEXT.empty }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
      sourceEventSeq: result.summarySeq,
    }
  } catch (error: unknown) {
    if (signal.aborted) return { kind: 'error', text: COMPACT_RESULT_TEXT.cancelled }
    if (error instanceof ManualCompactionError) return expectedFailure(error)
    throw error
  }
}

/**
 * Register `/compact` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the compaction seam.
 */
export function apply(ctx: Context): void {
  const active = new Set<Promise<CommandResult>>()
  // Aborted at teardown so a request waiting for a running turn settles
  // instead of holding the drain below open.
  const teardown = new AbortController()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = executeCompact(ctx, invocation, AbortSignal.any([invocation.signal, teardown.signal]))
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => {
      teardown.abort(new Error('command-compact stopped'))
      await Promise.allSettled(active)
    }
    yield ctx.commands.register({
      definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-compact'),
      name: 'compact',
      description: 'Compact older conversation history',
      handler,
    })
  }, 'command-compact lifecycle')
}
