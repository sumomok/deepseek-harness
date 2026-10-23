/**
 * Replay-safe, model-free tool-result pruning service.
 *
 * @module @deepseek-ai/dsh-compaction-tool-result-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { codePointLength, DEFAULTS, PRUNE_MARKER, resolveConfig } from './config.ts'
import { resolveRecoveryAddress, splitSpillNotice } from './recovery.ts'
import type {
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
    let skipped = 0
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
      const content = resolution.notice === ''
        ? this.pruneContent(original.content)
        : this.pruneContentWithNotice(original.content, resolution.notice)
      if (content === null) {
        skipped += 1
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
    return { pruned, charsRemoved, skipped }
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
