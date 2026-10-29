/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import { previewRecoveryAddress, recoveryNotice, resolveRecoveryAddress, splitSpillNotice } from './recovery.ts'
import type {
  PruneApplyResult,
  PrunePreview,
  PrunePreviewEntry,
  PrunePreviewSkip,
  RecoveredPrunedEntry,
  RecoveryPruneResult,
  RecoverySpillRef,
  RecoverySpillStore,
  ToolResultRecoveryOptions,
} from './recovery.ts'
import type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

export { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
export type {
  PrunedEntry,
  PruneResult,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'
export { originalToolResultSeq, recoveryNotice, splitSpillNotice } from './recovery.ts'
export type {
  PruneApplyResult,
  PrunePreview,
  PrunePreviewEntry,
  PrunePreviewSkip,
  PreviewRecoveryAddress,
  RecoveredPrunedEntry,
  RecoveryAddress,
  RecoveryPruneResult,
  RecoverySpillRef,
  RecoverySpillStore,
  ToolResultRecoveryOptions,
} from './recovery.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
}

/** Deterministic head/middle/tail pruning for current tool-result surface nodes. */
export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  /** Complete-text artifacts already saved by this service, keyed by session and original seq. */
  private readonly savedResults = new Map<string, RecoverySpillRef>()

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    return this.pruneContentWithin(blocks, this.config.thresholdChars, this.config.headChars, this.config.tailChars)
  }

  /** Prune against explicit budgets, so a recovery notice can reserve its own room. */
  private pruneContentWithin(
    blocks: readonly ContentBlock[],
    thresholdChars: number,
    headChars: number,
    tailChars: number,
  ): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= thresholdChars) return null

    const removedStart = headChars
    const removedEnd = totalChars - tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune around a trailing recovery notice, keeping the notice inside budget.
   * A notice that cannot fit leaves the result unpruned so its original stays
   * reachable rather than being replaced with an unrecoverable middle.
   */
  private pruneContentWithNotice(blocks: readonly ContentBlock[], notice: string): ContentBlock[] | null {
    const split = splitSpillNotice(blocks)
    const body = split?.blocks ?? blocks
    const noticeText = `\n\n${notice}`
    const available = this.config.thresholdChars - codePointLength(noticeText)
    const room = available - codePointLength(PRUNE_MARKER)
    if (room < 0) return null
    const headChars = Math.min(this.config.headChars, room)
    const tailChars = Math.min(this.config.tailChars, room - headChars)
    const pruned = this.pruneContentWithin(body, available, headChars, tailChars)
    if (pruned === null) return null
    const last = pruned.at(-1)
    const withNotice = last?.type === 'text'
      ? [...pruned.slice(0, -1), { ...last, text: last.text + noticeText }]
      : [...pruned, { type: 'text' as const, text: noticeText }]
    const charsAfter = this.measureContent(withNotice)
    if (charsAfter > this.config.thresholdChars || charsAfter >= this.measureContent(blocks)) return null
    return withNotice
  }

  /**
   * Prune every over-budget tool result from one stable current-surface snapshot.
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session): PruneResult {
    const candidates = this.candidates(session)
    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const content = this.pruneContent(original.content)
      if (content === null) continue
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const replacement = this.replace(session, seq, event, original, content)
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }

  /**
   * Recovery-aware pruning: each replacement carries an address for its
   * complete original. The default session address writes nothing. An existing
   * spill notice is reused exactly. Only `address: 'spill'` with no notice
   * saves complete text, once per session and original sequence.
   * @param session - session whose current surface is rewritten.
   * @param options - address preference and optional spill store.
   * @returns replacements with their addresses, plus skipped replacements.
   */
  async pruneSessionWithRecovery(
    session: Session,
    options: ToolResultRecoveryOptions = {},
  ): Promise<RecoveryPruneResult> {
    const candidates = this.candidates(session)
    const store = options.spillStore ?? this.recoveryStore()
    const pruned: RecoveredPrunedEntry[] = []
    let noticeDropped = 0
    let noAddress = 0
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      // Decide whether this result needs pruning before any storage call, so a
      // below-threshold result can never cause a spill write.
      if (this.pruneContent(original.content) === null) continue
      const noticeBudget = this.config.thresholdChars - codePointLength(PRUNE_MARKER) - 2
      const resolution = await resolveRecoveryAddress(session, seq, {
        ...options,
        ...store === undefined ? {} : { spillStore: store },
      }, this.savedResults, noticeBudget)
      if (resolution.notice === '') {
        // No address means no recovery. Keep the original rather than landing
        // an address-free prune the model cannot read back.
        noAddress += 1
        continue
      }
      const content = this.pruneContentWithNotice(original.content, resolution.notice)
      if (content === null) {
        // A notice that cannot fit must not silently degrade to an address-free
        // prune: keep the original result in place instead.
        noticeDropped += 1
        continue
      }
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const replacement = this.replace(session, seq, event, original, content)
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
        recovery: resolution.address,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved, noticeDropped, noAddress }
  }

  /**
   * Plan a pruning pass without changing the session or saving a spill file.
   * The caller may run summary review first and apply the preview only after
   * its compaction transaction commits. A spill address with no recorded
   * notice is reported as deferred; preview invents no locator.
   * @param session - session whose current surface is measured.
   * @param options - address preference and optional spill store.
   * @returns candidate replacements, skipped candidates, and projected savings.
   */
  previewSessionPrune(
    session: Session,
    options: ToolResultRecoveryOptions = {},
  ): PrunePreview {
    const store = options.spillStore ?? this.recoveryStore()
    const entries: PrunePreviewEntry[] = []
    const skipped: PrunePreviewSkip[] = []
    let reclaimableChars = 0
    let reclaimableTokens = 0
    const noticeBudget = this.config.thresholdChars - codePointLength(PRUNE_MARKER) - 2
    for (const { seq, event } of this.candidates(session)) {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      if (this.pruneContent(original.content) === null) continue
      if (!original.content.every(block => block.type === 'text')) {
        // Virtual token pricing uses the heuristic estimator; rich blocks can
        // price differently on the route. Keep them out of a preview summary.
        skipped.push({ originalSeq: seq, reason: 'non-text' })
        continue
      }
      const preview = previewRecoveryAddress(session, seq, {
        ...options,
        ...store === undefined ? {} : { spillStore: store },
      }, noticeBudget)
      if (preview.address.kind === 'unavailable') {
        skipped.push({ originalSeq: seq, reason: 'no-address' })
        continue
      }
      if (preview.address.kind === 'spill-deferred') {
        // A spill save could produce different notice text than any preview
        // could know, so this candidate is not previewable. The caller may use
        // the default session address instead; no placeholder enters a summary.
        skipped.push({ originalSeq: seq, reason: 'spill-deferred' })
        continue
      }
      const notice = preview.address.kind === 'spill-existing'
        ? preview.notice
        : recoveryNotice({
          kind: 'session',
          sessionId: preview.address.sessionId,
          seq: preview.address.seq,
        })
      if (notice === undefined) {
        skipped.push({ originalSeq: seq, reason: 'no-address' })
        continue
      }
      const content = this.pruneContentWithNotice(original.content, notice)
      if (content === null) {
        skipped.push({ originalSeq: seq, reason: 'notice-too-large' })
        continue
      }
      const replacement = freezeMessage<ToolResultMessage>({ ...original, content })
      const charsBefore = this.measureContent(original.content)
      const projectedCharsAfter = this.measureContent(content)
      const tokensBefore = this.ctx.tokenMeter.estimateMessage(original)
      const projectedTokensAfter = this.ctx.tokenMeter.estimateMessage(replacement)
      entries.push({
        originalSeq: seq,
        message: replacement,
        original,
        charsBefore,
        projectedCharsAfter,
        tokensBefore,
        projectedTokensAfter,
        address: preview.address,
        ...preview.notice === undefined ? {} : { notice: preview.notice },
      })
      reclaimableChars += charsBefore - projectedCharsAfter
      reclaimableTokens += tokensBefore - projectedTokensAfter
    }
    return { entries, skipped, reclaimableChars, reclaimableTokens }
  }

  /**
   * Apply a preview after the caller's summary/replacement has committed.
   * Entries whose sequence is no longer on the surface, or whose message no
   * longer matches the preview, are skipped; applying the same preview twice
   * is idempotent. A spill save happens only here, and a save failure falls
   * back to the session address or skips the entry.
   * @param session - session whose current surface is rewritten.
   * @param preview - read-only plan produced by {@link previewSessionPrune}.
   * @param options - address preference and optional spill store.
   * @returns landed replacements and counts of skipped preview entries.
   */
  async applyPrunePreview(
    session: Session,
    preview: PrunePreview,
    options: ToolResultRecoveryOptions = {},
  ): Promise<PruneApplyResult> {
    const store = options.spillStore ?? this.recoveryStore()
    const pruned: RecoveredPrunedEntry[] = []
    let charsRemoved = 0
    let noticeDropped = 0
    let noAddress = 0
    let notOnSurface = 0
    let changed = 0
    const noticeBudget = this.config.thresholdChars - codePointLength(PRUNE_MARKER) - 2
    for (const entry of preview.entries) {
      if (!session.surface.nodes.includes(entry.originalSeq)) {
        notOnSurface += 1
        continue
      }
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(entry.originalSeq)
      if (event?.type !== 'tool/result') {
        notOnSurface += 1
        continue
      }
      const original = session.deriveEventMessage(event) as ToolResultMessage
      if (original.id !== entry.original.id
        || original.source.callId !== entry.original.source.callId
        || original.isError !== entry.original.isError
        || !deepEqualJson(original.content, entry.original.content)) {
        changed += 1
        continue
      }
      const resolution = await resolveRecoveryAddress(session, entry.originalSeq, {
        ...options,
        ...store === undefined ? {} : { spillStore: store },
      }, this.savedResults, noticeBudget)
      if (resolution.notice === '') {
        noAddress += 1
        continue
      }
      const content = this.pruneContentWithNotice(original.content, resolution.notice)
      if (content === null) {
        noticeDropped += 1
        continue
      }
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      const replacement = this.replace(session, entry.originalSeq, event, original, content)
      pruned.push({
        originalSeq: entry.originalSeq,
        replacementSeq: replacement.seq,
        callId: original.source.callId,
        charsBefore,
        charsAfter,
        recovery: resolution.address,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved, noticeDropped, noAddress, notOnSurface, changed }
  }

  /** Snapshot the current surface's tool-result nodes in surface order. */
  private candidates(session: Session): SnapshotCandidate[] {
    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }
    return candidates
  }

  /** Append the shadow-price event and its replacement adjacently. */
  private replace(
    session: Session,
    seq: SessionSeq,
    event: SessionEvent<'tool/result'>,
    original: ToolResultMessage,
    content: readonly ContentBlock[],
  ): SessionEvent<'tool/result'> {
    const message = freezeMessage<ToolResultMessage>({
      ...original,
      content,
    })
    // Shadow-price protocol: the metering event and its replacement are
    // appended synchronously adjacent, so pure consumers subtract the
    // shadowed node's heuristic price without retaining per-node state.
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
    })
    return session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
  }

  /** Optional spill backend discovered at call time, without a hard dependency on the plugin. */
  private recoveryStore(): RecoverySpillStore | undefined {
    return (this.ctx as Context & { spillStore?: RecoverySpillStore }).get('spillStore')
  }
}

export default ToolResultPruner
