/**
 * Recovery addresses for tool results the pruner shadows.
 *
 * A pruned result is still in the append-only session log at its original
 * sequence, so the default address is `{ sessionId, seq }` and no second copy
 * is written. A result the spill policy already bounded carries its locator in
 * the recorded notice; that exact notice is reused. Only an explicit spill
 * mode saves the complete text again, keyed by session and original sequence
 * so one result never gets two artifacts.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner/recovery
 */

import { originalToolResultSeq, recoveryNotice } from '@deepseek-ai/dsh-compaction'
import type {
  RecoveryAddress as GenericRecoveryAddress,
  RecoverySpillRef as GenericRecoverySpillRef,
} from '@deepseek-ai/dsh-compaction'
import type { ContentBlock, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SpillLocator } from '@deepseek-ai/dsh-spill'
import { formatSpillNotice, hasSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import type { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { PrunedEntry, PruneResult } from './types.ts'

export { originalToolResultSeq, recoveryNotice }

/** One saved spill artifact as the pruner consumes it. */
export type RecoverySpillRef = GenericRecoverySpillRef<SpillLocator>

/** The subset of the spill-service contract needed to save a complete result. */
export interface RecoverySpillStore {
  /**
   * Save complete text under the owning session.
   * @param request - owner, source, and complete text to persist.
   * @returns the saved artifact's locator, bytes, and retrieval guidance.
   */
  saveText(request: {
    readonly owner: { readonly sessionId: SessionId }
    readonly source: {
      readonly kind: 'tool'
      readonly toolName: string
      readonly callId: ToolCallId
      readonly label: 'result' | 'dispatch'
    }
    readonly suggestedName: string
    readonly content: string
  }): Promise<RecoverySpillRef>
}

/** Conservative room a saved notice needs; smaller budgets never start a new spill. */
export const MIN_SPILL_NOTICE_CHARS = 1024

/** Deployment choice for the address a pruned result points at. */
export interface ToolResultRecoveryOptions {
  /**
   * Prefer the session-log address by default. `spill` saves complete text
   * through the spill service only when no recorded spill notice exists.
   */
  readonly address?: 'session' | 'spill'
  /** Explicit store for tests or non-Cordis callers; defaults to `ctx.get('spillStore')`. */
  readonly spillStore?: RecoverySpillStore
}

/** Where the removed tool-result text can still be read. */
export type RecoveryAddress = GenericRecoveryAddress<RecoverySpillRef>

/** One landed replacement together with the address it exposes. */
export interface RecoveredPrunedEntry extends PrunedEntry {
  /** Address written into the replacement, or `unavailable` for a legacy prune. */
  readonly recovery: RecoveryAddress
}

/** Aggregate outcome of one recovery-aware pruning pass. */
export interface RecoveryPruneResult extends PruneResult {
  /** Replacements in the snapshotted surface order, each with its recovery address. */
  readonly pruned: readonly RecoveredPrunedEntry[]
  /** Replacements skipped because the recovery notice did not fit. */
  readonly noticeDropped: number
  /** Results kept unchanged because no address could be produced. */
  readonly noAddress: number
}

/**
 * Extract the recorded spill notice, if any, and the blocks before it.
 * @param blocks - recorded tool-result content.
 * @returns content without its trailing notice plus the exact notice text, or `undefined`.
 */
export function splitSpillNotice(blocks: readonly ContentBlock[]): {
  readonly blocks: readonly ContentBlock[]
  readonly notice: string
} | undefined {
  const last = blocks.at(-1)
  if (last?.type !== 'text') return undefined
  const separatorAt = last.text.lastIndexOf('\n\n(')
  const candidate = separatorAt < 0
    ? (last.text.startsWith('(') ? last.text : undefined)
    : last.text.slice(separatorAt + 2)
  if (candidate === undefined || !hasSpillNotice(candidate)) return undefined
  if (separatorAt < 0) return { blocks: [], notice: candidate }
  return {
    blocks: [...blocks.slice(0, -1), { ...last, text: last.text.slice(0, separatorAt) }],
    notice: candidate,
  }
}

/** Find the tool name paired with a call id, searching inherited and live events. */
function toolName(session: Session, callId: ToolCallId): string {
  let name: string | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'tool/call' && event.data.callId === callId) name = event.data.name
  }
  return name ?? 'tool-result'
}

/** Read the complete text of a text-only content sequence. */
function completeText(blocks: readonly ContentBlock[]): { readonly text: string; readonly textOnly: boolean } {
  return {
    textOnly: blocks.every(block => block.type === 'text'),
    text: blocks.map(block => block.type === 'text' ? block.text : '').join(''),
  }
}

/**
 * Resolve the address a pruning replacement can expose, saving complete text
 * only when the caller explicitly asks for a spill address and no recorded
 * notice exists. A save failure falls back to the session-log address.
 * @param session - session whose tool result will be shadowed.
 * @param seq - current surface node being pruned.
 * @param options - address preference and optional spill store.
 * @param cache - per-service saved-ref cache keyed by session and original seq.
 * @param noticeBudget - code points available for the notice after pruning.
 * @returns the address and the notice to append, if any.
 */
export async function resolveRecoveryAddress(
  session: Session,
  seq: SessionSeq,
  options: ToolResultRecoveryOptions,
  cache: Map<string, RecoverySpillRef>,
  noticeBudget: number,
): Promise<{ readonly address: RecoveryAddress; readonly notice: string }> {
  const originalSeq = originalToolResultSeq(session, seq)
  if (originalSeq === undefined) return { address: { kind: 'unavailable', reason: 'original-missing' }, notice: '' }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const event = session.eventAt(originalSeq)
  if (event?.type !== 'tool/result') return { address: { kind: 'unavailable', reason: 'original-missing' }, notice: '' }
  const message = session.deriveEventMessage(event)
  if (message === null || message.role !== 'tool') return { address: { kind: 'unavailable', reason: 'not-a-tool-result' }, notice: '' }
  const split = splitSpillNotice(message.content)
  if (split !== undefined) {
    const address: RecoveryAddress = { kind: 'spill', notice: split.notice }
    return { address, notice: split.notice }
  }
  if (options.address !== 'spill' || options.spillStore === undefined || noticeBudget < MIN_SPILL_NOTICE_CHARS) {
    const address: RecoveryAddress = { kind: 'session', sessionId: session.header.id, seq: originalSeq }
    return { address, notice: recoveryNotice(address) }
  }
  const complete = completeText(message.content)
  if (!complete.textOnly) {
    return { address: { kind: 'unavailable', reason: 'non-text-content' }, notice: '' }
  }
  const key = `${String(session.header.id)}:${String(originalSeq)}`
  const cached = cache.get(key)
  if (cached !== undefined) {
    const notice = formatSpillNotice({ kind: 'unknown' }, cached)
    return { address: { kind: 'spill', notice, ref: cached }, notice }
  }
  const callId = message.source.callId
  try {
    const ref = await options.spillStore.saveText({
      owner: { sessionId: session.header.id },
      source: { kind: 'tool', toolName: toolName(session, callId), callId, label: 'result' },
      suggestedName: `tool-result-${String(originalSeq)}.txt`,
      content: complete.text,
    })
    cache.set(key, ref)
    const notice = formatSpillNotice({ kind: 'unknown' }, ref)
    return { address: { kind: 'spill', notice, ref }, notice }
  } catch {
    const address: RecoveryAddress = { kind: 'session', sessionId: session.header.id, seq: originalSeq }
    return { address, notice: recoveryNotice(address) }
  }
}

/** Address a preview can promise without writing a spill artifact. */
export type PreviewRecoveryAddress =
  | {
    readonly kind: 'session'
    readonly sessionId: SessionId
    readonly seq: SessionSeq
  }
  | {
    readonly kind: 'spill-existing'
    readonly notice: string
  }
  | {
    /** Apply will save first; preview has no locator and invents none. */
    readonly kind: 'spill-deferred'
  }
  | {
    readonly kind: 'unavailable'
    readonly reason: 'not-a-tool-result' | 'original-missing' | 'non-text-content'
  }

/**
 * Resolve a recovery address for preview without saving anything. A spill
 * address with no recorded notice is deferred, never fabricated.
 * @param session - session whose tool result would be shadowed.
 * @param seq - current surface node.
 * @param options - address preference and optional spill store.
 * @param noticeBudget - code points available for a notice.
 * @returns the preview address and an existing notice, if one exists.
 */
export function previewRecoveryAddress(
  session: Session,
  seq: SessionSeq,
  options: ToolResultRecoveryOptions,
  noticeBudget: number,
): { readonly address: PreviewRecoveryAddress; readonly notice?: string } {
  const originalSeq = originalToolResultSeq(session, seq)
  if (originalSeq === undefined) return { address: { kind: 'unavailable', reason: 'original-missing' } }
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const event = session.eventAt(originalSeq)
  if (event?.type !== 'tool/result') return { address: { kind: 'unavailable', reason: 'original-missing' } }
  const message = session.deriveEventMessage(event)
  if (message === null || message.role !== 'tool') return { address: { kind: 'unavailable', reason: 'not-a-tool-result' } }
  const split = splitSpillNotice(message.content)
  if (split !== undefined) return { address: { kind: 'spill-existing', notice: split.notice }, notice: split.notice }
  if (options.address !== 'spill' || options.spillStore === undefined || noticeBudget < MIN_SPILL_NOTICE_CHARS) {
    const address: PreviewRecoveryAddress = { kind: 'session', sessionId: session.header.id, seq: originalSeq }
    return { address }
  }
  if (!message.content.every(block => block.type === 'text')) {
    return { address: { kind: 'unavailable', reason: 'non-text-content' } }
  }
  return { address: { kind: 'spill-deferred' } }
}

/** One candidate a read-only preview would prune. */
export interface PrunePreviewEntry {
  /** Original tool result still on the current surface. */
  readonly originalSeq: SessionSeq
  /** The replacement message a virtual summary would receive. */
  readonly message: ToolResultMessage
  /** The still-current original message apply must find unchanged at the sequence. */
  readonly original: ToolResultMessage
  /** Current text size in Unicode code points. */
  readonly charsBefore: number
  /** Projected replacement size; a deferred spill reserves notice room. */
  readonly projectedCharsAfter: number
  /** Current estimated tokens for the result. */
  readonly tokensBefore: number
  /** Projected estimated tokens for the replacement. */
  readonly projectedTokensAfter: number
  /** Address preview can promise without writing a spill artifact. */
  readonly address: PreviewRecoveryAddress
  /** Exact recorded notice for a session or existing-spill address. */
  readonly notice?: string
}

/** A candidate preview keeps unchanged, with why. */
export interface PrunePreviewSkip {
  /** Candidate sequence. */
  readonly originalSeq: SessionSeq
  /** Why no replacement is previewed. */
  readonly reason: 'notice-too-large' | 'no-address' | 'spill-deferred' | 'non-text'
}

/** Read-only outcome of planning one pruning pass. */
export interface PrunePreview {
  /** Replacements that apply could land, in surface order. */
  readonly entries: readonly PrunePreviewEntry[]
  /** Candidates kept unchanged. */
  readonly skipped: readonly PrunePreviewSkip[]
  /** Projected Unicode-code-point savings across entries. */
  readonly reclaimableChars: number
  /** Projected token savings across entries. */
  readonly reclaimableTokens: number
}

/** Outcome of applying a preview after the caller's compaction transaction commits. */
export interface PruneApplyResult extends RecoveryPruneResult {
  /** Entries whose original seq was replaced or removed before apply ran. */
  readonly notOnSurface: number
  /** Entries whose recorded message no longer matches the preview. */
  readonly changed: number
}
