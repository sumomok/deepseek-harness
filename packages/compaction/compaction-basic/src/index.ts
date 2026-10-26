/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger, ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: the `ctx.sessionProjections` Context merge behind the declared injection.
import type {} from '@deepseek-ai/dsh-session-projection'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { PrunePreview } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
  selectCompactableRangeAtTurnBoundary,
  SummaryRejectedError,
} from './region.ts'
import { conversationTarget, pressureTarget } from './route.ts'
import { classifyCompactionError, scanCompactionSession } from './scan.ts'
import { minimumSummaryTokens, summarizeWithLlm } from './summarizer.ts'
import { WaitingCompactions } from './waiting.ts'
import type { WaitingCompaction } from './waiting.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  CompactionPolicy,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedTargetPolicy,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicy,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    compactionPolicy: CompactionPolicy
  }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(
  agent: Agent,
  target: Pick<LlmCallConfig, 'provider' | 'model'>,
  defaultMaxTokens: number | undefined,
): number {
  const header = agent.session.requestHeader()?.config
  const current = header?.provider === target.provider && header.model === target.model
    ? header.maxTokens
    : undefined
  return current ?? agent.options.maxTokens ?? defaultMaxTokens ?? 0
}
const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxConsecutiveFailuresSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const summaryMaxRatioSchema = z.number()

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxConsecutiveFailures: maxConsecutiveFailuresSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  summaryMaxRatio: summaryMaxRatioSchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxConsecutiveFailures: maxConsecutiveFailuresSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    summaryMaxRatio: summaryMaxRatioSchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    checkpointReadback: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly warnedPolicyThresholdTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  private readonly waiting = new WaitingCompactions()
  private readonly summaryFailures = new Map<string, { count: number; errorClass: string }>()


  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this._registerWaitingCompaction()
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Serve manual requests that wait for a running turn. These listeners are
   * independent of `auto`: they run only what a person asked for. The
   * step-boundary listener is registered before the automatic pressure
   * listener, so a waiting request compacts first and pressure is measured
   * on its result.
   */
  private _registerWaitingCompaction(): void {
    const { ctx } = this
    ctx.effect(() => () => { this.waiting.cancelAll() }, 'compaction-basic: waiting manual requests')

    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      const request = this.waiting.peek(agent)
      if (request !== undefined && !signal.aborted
        && (request.whileBusy === 'next-step' || request.turnEnded)) {
        // Settles the request and never rejects, so the chain always continues.
        await this.waiting.serve(agent, waiting => this.compactAtStep(waiting, signal))
      }
      return next()
    })

    ctx.on('session/event', (session, event) => {
      switch (event.type) {
        case 'turn/start':
          this.waiting.turnStarted(session)
          return
        case 'step/start':
          this.waiting.stepStarted(session)
          return
        case 'turn/end':
          this.waiting.turnEnded(session, event.data.reason.kind === 'aborted')
          return
        // Other events do not move a waiting request's boundary.
        default:
      }
    })

    // A turn that ends without a later step boundary reaches here; the
    // listener starts the idle task synchronously, before a queued prompt
    // can open the next turn.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      void this.waiting.serve(agent, waiting => this.compactIdle(agent, waiting.signal, waiting.sourceCommandId))
    })
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      // The live switch gates only this pressure path: overflow recovery is
      // the last defense against a request the provider already refused, and
      // a user who turned automatic compaction off did not ask to lose it.
      if (!signal.aborted && ctx.get('compactionPolicy')?.isEnabled() !== false) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = pressureTarget(agent)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Plan the optional prune pass without touching the session. A pruner
   * without the preview entry returns undefined; the caller then summarizes
   * first and runs the legacy prune after the commit, accepting one extra
   * summary when pruning alone would have cleared pressure.
   * @param agent - agent whose session is previewed.
   * @param prune - the resolved optional pruner service.
   * @returns the read-only plan, or undefined for an older pruner.
   */
  private previewToolResultPruning(agent: Agent, prune: ToolResultPruner): PrunePreview | undefined {
    const previewer = (prune as {
      previewSessionPrune?: (session: Session) => PrunePreview
    }).previewSessionPrune
    return typeof previewer === 'function' ? previewer.call(prune, agent.session) : undefined
  }

  /**
   * Apply a preview only after the summary transaction commits. A failure here
   * leaves the committed summary in place and is reported without rewriting it.
   * @param agent - agent whose session is pruned.
   * @param prune - the resolved optional pruner service.
   * @param preview - plan produced before summarization.
   */
  private async applyToolResultPreview(
    agent: Agent,
    prune: ToolResultPruner,
    preview: PrunePreview,
  ): Promise<void> {
    if (preview.entries.length === 0) return
    const apply = (prune as {
      applyPrunePreview?: (session: Session, plan: PrunePreview) => Promise<unknown>
    }).applyPrunePreview
    if (typeof apply !== 'function') return
    try {
      await apply.call(prune, agent.session, preview)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        'compaction: summary committed but tool-result preview apply failed: %s',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /**
   * Price a surface as if the preview had landed, without appending anything.
   * @param measurement - live measurement to adjust.
   * @param preview - read-only prune plan.
   * @returns the virtual measurement and its replacement messages/prices.
   */
  private previewMeasurement(
    measurement: TokenMeasurement,
    preview: PrunePreview,
  ): {
    measurement: TokenMeasurement
    messages: ReadonlyMap<SessionSeq, Message>
    tokens: ReadonlyMap<SessionSeq, { tokens: number; heuristicTokens: number }>
    savings: number
  } {
    const bySeq = new Map(preview.entries.map(entry => [entry.originalSeq, entry]))
    let savings = 0
    const messages = new Map<SessionSeq, Message>()
    const tokens = new Map<SessionSeq, { tokens: number; heuristicTokens: number }>()
    const nodes = measurement.nodes.map((node) => {
      const entry = bySeq.get(node.seq)
      if (entry === undefined) return node
      const delta = entry.projectedTokensAfter - entry.tokensBefore
      savings += -delta
      messages.set(node.seq, entry.message)
      const priced = {
        tokens: Math.max(0, node.tokens + delta),
        heuristicTokens: Math.max(0, node.heuristicTokens + delta),
      }
      tokens.set(node.seq, priced)
      return { ...node, ...priced }
    })
    return {
      measurement: {
        ...measurement,
        nodes,
        surfaceTokens: Math.max(0, measurement.surfaceTokens - savings),
        totalTokens: Math.max(0, measurement.totalTokens - savings),
      },
      messages,
      tokens,
      savings,
    }
  }

  /**
   * Occupancy after a virtual preview, anchored the same way as the live path.
   * @param session - session whose projection is read.
   * @param measurement - live or virtual measurement.
   * @param savings - preview token savings.
   * @returns projected occupancy after the preview.
   */
  private previewOccupancy(session: Session, measurement: TokenMeasurement, savings: number): number {
    if (measurement.baseline.kind !== 'usage') return measurement.totalTokens
    return Math.max(0, this.occupancyTokens(session, measurement) - savings)
  }

  /**
   * Tools the summary request may carry for its route. A route different from
   * the durable header omits the header's tool schemas instead of replaying a
   * schema the new provider may reject.
   * @param agent - agent owning the durable header.
   * @param target - summary route.
   * @returns header tools for a matching route, null to omit, undefined to inherit.
   */
  private summaryTools(
    agent: Agent,
    target: { readonly provider: string; readonly model: string },
  ): readonly ToolSchema[] | null | undefined {
    const header = agent.session.requestHeader()
    if (header === undefined) return undefined
    return header.config.provider === target.provider && header.config.model === target.model
      ? undefined
      : null
  }

  /**
   * Land the optional model-free prune pass, preferring the recovery-aware
   * entry that leaves each replacement addressable. An older pruner that lacks
   * the async entry keeps its synchronous behavior; a missing pruner is a
   * no-op.
   * @param agent - agent whose session is pruned.
   * @param prune - the resolved optional pruner service.
   */
  private async applyToolResultPruning(
    agent: Agent,
    prune: ToolResultPruner,
  ): Promise<void> {
    const recovery = (prune as { pruneSessionWithRecovery?: (session: Session) => Promise<unknown> })
      .pruneSessionWithRecovery
    if (typeof recovery === 'function') {
      await recovery.call(prune, agent.session)
      return
    }
    prune.pruneSession(agent.session)
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const scan = scanCompactionSession(agent.session)
    const target = scan.pending ?? scan.durable
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const breakerKey = `${String(agent.session.id)}:${target.provider}/${target.model}`
    let breaker = this.summaryFailures.get(breakerKey)
    if (breaker === undefined) {
      breaker = scan.latestRoute?.provider === target.provider
        && scan.latestRoute.model === target.model
        ? scan.seededFailure
        : undefined
      if (breaker !== undefined) this.summaryFailures.set(breakerKey, breaker)
    }
    if (policy.maxConsecutiveFailures > 0 && breaker !== undefined
      && breaker.count >= policy.maxConsecutiveFailures) {
      this.ctx.logger.info(
        'compaction (pressure): circuit open for %s after %d consecutive %s failures; skipping',
        breakerKey, breaker.count, breaker.errorClass,
      )
      return null
    }
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      const policy = resolveTargetPolicy(this.config, target)
      let preview: PrunePreview | undefined
      let previewData: ReturnType<BasicCompactionEngine['previewMeasurement']> | undefined
      let legacyPrune = false
      if (prune !== undefined) {
        preview = this.previewToolResultPruning(agent, prune)
        if (preview !== undefined) {
          previewData = this.previewMeasurement(measurement, preview)
          measurement = previewData.measurement
        } else {
          legacyPrune = true
        }
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) {
        if (preview !== undefined && prune !== undefined) await this.applyToolResultPreview(agent, prune, preview)
        else if (legacyPrune && prune !== undefined) await this.applyToolResultPruning(agent, prune)
        return null
      }
      const summaryTarget = policy.summarizationProvider.length === 0
        ? target
        : { provider: policy.summarizationProvider, model: policy.summarizationModel }
      const tools = this.summaryTools(agent, summaryTarget)
      const result = await this.compactPressureRegion(range.start, range.end, agent, signal,
        policy.summaryMaxRatio,
        previewData === undefined ? undefined : { messages: previewData.messages, tokens: previewData.tokens },
        tools)
      if (preview !== undefined && prune !== undefined) await this.applyToolResultPreview(agent, prune, preview)
      else if (legacyPrune && prune !== undefined) await this.applyToolResultPruning(agent, prune)
      return result
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = this.pressureSpec(
      policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, target, info.defaultMaxTokens),
      targetKey,
    )
    const prefix = this.fixedPrefixTokens(agent.session)
    if (prefix !== undefined && prefix.total >= spec.thresholdTokens) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: ${targetKey} fixed prefix (system ${prefix.system} + tools ${prefix.tools} `
        + `= ${prefix.total} estimated tokens) is already at or above the pressure threshold `
        + `${spec.thresholdTokens}; compaction cannot reduce it. Configure a larger model window, `
        + 'a smaller tool catalog, or turn automatic compaction off',
      )
    }
    let occupancy = this.occupancyTokens(agent.session, measurement)
    if (occupancy < spec.thresholdTokens) return null

    // Preview the model-free pass before choosing a range. The preview is
    // read-only: it becomes a virtual measurement for the trigger/retention
    // decisions and is applied only after a summary commits.
    let preview: PrunePreview | undefined
    let previewData: ReturnType<BasicCompactionEngine['previewMeasurement']> | undefined
    let legacyPrune = false
    if (prune !== undefined) {
      preview = this.previewToolResultPruning(agent, prune)
      if (preview !== undefined) {
        previewData = this.previewMeasurement(measurement, preview)
        measurement = previewData.measurement
        occupancy = this.previewOccupancy(agent.session, measurement, previewData.savings)
      } else {
        legacyPrune = true
      }
    }
    if (occupancy < spec.thresholdTokens) {
      if (preview !== undefined && prune !== undefined) await this.applyToolResultPreview(agent, prune, preview)
      return null
    }

    // A single pressure attempt can continue below the threshold only if the
    // surface outside the retained tail can cover the gap at all; the 40-token
    // case has a 44-token compactable surface against a 79-token gap, so no
    // summary request can help. The check prices the whole compactable surface,
    // not just the first selected range, because later attempts can consume an
    // earlier attempt's checkpoint and retained turn.
    const needed = occupancy - spec.thresholdTokens
    const reclaimable = Math.max(0, measurement.surfaceTokens - spec.retainTokens)
    if (reclaimable < needed) {
      this.ctx.logger.info(
        'compaction (pressure): skipping; the compactable surface (~%d route tokens) is below '
        + 'the %d-token pressure gap, so the summary cannot restore the threshold',
        reclaimable, needed,
      )
      if (preview !== undefined && prune !== undefined) await this.applyToolResultPreview(agent, prune, preview)
      return null
    }

    const summaryTarget = policy.summarizationProvider.length === 0
      ? target
      : { provider: policy.summarizationProvider, model: policy.summarizationModel }
    const summaryTools = this.summaryTools(agent, summaryTarget)
    let previewApplied = false
    let result: CompactionResult | null = null
    let stoppedForFloor = false
    let stoppedForCheckpoint = false
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = selectCompactableRangeAtTurnBoundary(agent.session, measurement, spec.retainTokens, scan.boundaries)
      if (range === null) {
        this.ctx.logger.info(
          'compaction (pressure): no selectable span remains that keeps a complete user turn '
          + 'or a balanced step group; skipping',
        )
        if (!previewApplied && preview !== undefined && prune !== undefined) {
          await this.applyToolResultPreview(agent, prune, preview)
        } else if (!previewApplied && legacyPrune && prune !== undefined) {
          await this.applyToolResultPruning(agent, prune)
        }
        return result
      }
      if (this.isOnlyCheckpointRange(agent.session, range)) {
        this.ctx.logger.info(
          'compaction (pressure): skipping; the selected span is only the previous checkpoint, '
          + 'so another summary would be a summary of a summary',
        )
        stoppedForCheckpoint = true
        break
      }
      const rangeTokens = this.rangeTokenPrice(measurement, range)
      // The selected span must be able to pay for the smallest replacement the
      // shrink guard would accept: the framing floor, under the configured
      // share of the span. Anything smaller can only spend a request to fail.
      const summaryFloor = minimumSummaryTokens(meter, this.config.checkpointReadback)
      if (Math.floor(rangeTokens * spec.summaryMaxRatio) < summaryFloor) {
        this.ctx.logger.info(
          'compaction (pressure): skipping; selected span is ~%d route tokens, below the '
          + '%d-token replacement ceiling at summaryMaxRatio %s',
          rangeTokens, summaryFloor, String(spec.summaryMaxRatio),
        )
        if (result === null) {
          if (preview !== undefined && prune !== undefined) {
            await this.applyToolResultPreview(agent, prune, preview)
          } else if (legacyPrune && prune !== undefined) {
            await this.applyToolResultPruning(agent, prune)
          }
          return null
        }
        stoppedForFloor = true
        break
      }
      this.ctx.logger.info(
        'compaction (pressure): route=%s/%s occupancy=%d threshold=%d fixedPrefix=%s '
        + 'reclaimable=%d needed=%d retain=%d',
        target.provider, target.model, occupancy, spec.thresholdTokens,
        prefix === undefined ? 'unknown' : String(prefix.total), reclaimable, needed, spec.retainTokens,
      )
      const started = performance.now()
      try {
        const committed = await this.compactPressureRegion(range.start, range.end, agent, signal,
          spec.summaryMaxRatio,
          previewData === undefined ? undefined : { messages: previewData.messages, tokens: previewData.tokens },
          summaryTools)
        result = committed
      } catch (error: unknown) {
        const errorClass = error instanceof SummaryRejectedError
          ? 'review-rejected'
          : classifyCompactionError(error)
        if (!signal.aborted && !(error instanceof SummaryRejectedError) && errorClass !== 'config') {
          const previous = this.summaryFailures.get(breakerKey)
          this.summaryFailures.set(breakerKey, { count: (previous?.count ?? 0) + 1, errorClass })
        }
        this.ctx.logger.info(
          'compaction (pressure): failed after %dms (%s, %d consecutive): %s',
          Math.round(performance.now() - started), errorClass,
          this.summaryFailures.get(breakerKey)?.count ?? 0,
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      this.summaryFailures.delete(breakerKey)
      if (!previewApplied && preview !== undefined && prune !== undefined) {
        await this.applyToolResultPreview(agent, prune, preview)
        previewApplied = true
      } else if (!previewApplied && legacyPrune && prune !== undefined) {
        await this.applyToolResultPruning(agent, prune)
        previewApplied = true
      }
      const committed = result
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const summaryEvent = agent.session.eventAt(committed.summarySeq)
      const usage = summaryEvent?.type === 'compaction/summary' ? summaryEvent.data.usage : undefined
      this.ctx.logger.info(
        'compaction (pressure): committed %d shadowed nodes (~%d tokens) in %dms; route=%s/%s usage=%s',
        committed.shadowedSeqs.length, committed.shadowedTokenCount,
        Math.round(performance.now() - started), target.provider, target.model,
        usage === undefined ? 'none' : JSON.stringify(usage),
      )
      measurement = meter.measure(agent.session)
      occupancy = this.occupancyTokens(agent.session, measurement)
      if (occupancy < spec.thresholdTokens) return result
    }

    if (!previewApplied && preview !== undefined && prune !== undefined) {
      await this.applyToolResultPreview(agent, prune, preview)
      previewApplied = true
    } else if (!previewApplied && legacyPrune && prune !== undefined) {
      await this.applyToolResultPruning(agent, prune)
      previewApplied = true
    }
    if (stoppedForCheckpoint) return result
    if (stoppedForFloor && result !== null) {
      this.ctx.logger.info(
        'compaction (pressure): threshold not reached (%d >= %d) but only a sub-envelope '
        + 'span remains; keeping the committed checkpoint and the retained turn',
        occupancy, spec.thresholdTokens,
      )
      return result
    }
    throw new Error(
      `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
      + `(${occupancy} estimated tokens >= threshold ${spec.thresholdTokens})`,
    )
  }

  /**
   * The occupancy numerator: whenever the measurement anchors on provider
   * usage, the exact value the context meter divides — `contextPressure`'s
   * published `projectedTokens`, read off the same wire object the browser
   * reads, not derived a second time from anything else.
   *
   * No arithmetic relation to `totalTokens` is claimed or relied on. The two
   * price the anchored call's own output differently — the meter with the
   * provider's `outputTokens`, the projection with the fixed heuristic applied
   * to the recorded stream — so their difference varies with the response and
   * can fall either way. The guarantee is the shared source, not a formula.
   *
   * Any other baseline means no provider figure is anchoring the measurement.
   * The projection is the weaker reading there: it prices everything after its
   * last sample with the route-independent heuristic, so it cannot see a routed
   * adapter's declared image pricing for history the provider has not billed.
   * `totalTokens` prices the whole surface under the route instead, and its
   * estimated baseline charges the anchored output only the heuristic price,
   * not the provider's — so it is both the figure that sees such pressure and
   * the one closer to the next request there.
   *
   * The same image blind spot survives inside the usage branch, on a smaller
   * scale: images admitted after the last sample ride the projection's fixed
   * heuristic until a request bills them.
   *
   * @param session - session whose published occupancy is read.
   * @param measurement - the same call's meter measurement, and the numerator whenever it does not anchor on usage.
   * @returns non-negative request-pressure tokens for the next request.
   */
  private occupancyTokens(session: Session, measurement: TokenMeasurement): number {
    if (measurement.baseline.kind !== 'usage') return measurement.totalTokens
    const pressure = this.ctx.sessionProjections
      .snapshot(session, ['contextPressure']).values.contextPressure
    /* v8 ignore next -- a usage-anchored meter implies a folded usage sample, so the projected figure is present here */
    return pressure?.projectedTokens ?? measurement.totalTokens
  }

  /**
   * Route-priced total of the selected surface span.
   * @param measurement - current priced surface.
   * @param range - selected inclusive positional span.
   * @returns summed route tokens of the span, or zero when it is not found.
   */
  private rangeTokenPrice(
    measurement: TokenMeasurement,
    range: { readonly start: SessionSeq; readonly end: SessionSeq },
  ): number {
    const nodes = measurement.nodes
    const start = nodes.findIndex(node => node.seq === range.start)
    const end = nodes.findIndex(node => node.seq === range.end)
    if (start < 0 || end < start) return 0
    return nodes.slice(start, end + 1).reduce((total, node) => total + node.tokens, 0)
  }

  /**
   * Clear every in-process breaker entry for one Session. Manual success is
   * authoritative input to the live process, not just for its current route.
   * @param session - Session whose route entries are removed.
   */
  private clearSessionSummaryFailures(session: Session): void {
    const prefix = `${String(session.id)}:`
    for (const key of [...this.summaryFailures.keys()]) {
      if (key.startsWith(prefix)) this.summaryFailures.delete(key)
    }
  }

  /**
   * Whether every node in the selected span is a prior compaction checkpoint;
   * summarizing such a span again would replace a summary with a summary.
   * @param session - session owning the surface.
   * @param range - selected inclusive positional span.
   * @returns true when the whole span is checkpoint user messages.
   */
  private isOnlyCheckpointRange(
    session: Session,
    range: { readonly start: SessionSeq; readonly end: SessionSeq },
  ): boolean {
    const surface = session.surface.nodes
    const start = surface.indexOf(range.start)
    const end = surface.indexOf(range.end)
    if (start < 0 || end < start) return false
    for (let index = start; index <= end; index += 1) {
      const seq = surface[index]
      if (seq === undefined) return false
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      if (event?.type !== 'user/message' || !isCompactCheckpointSource(event.data.source)) return false
    }
    return true
  }

  /**
   * Price the system prompt and tool catalog that no surface compaction can
   * reduce. The breakdown is heuristic and may be absent when no projection
   * registry is mounted; absence leaves the precheck off rather than treating
   * an unknown prefix as zero.
   * @param session - session whose latest request envelope is measured.
   * @returns the system and tools prices, or undefined without a breakdown.
   */
  private fixedPrefixTokens(
    session: Session,
  ): { readonly system: number; readonly tools: number; readonly total: number } | undefined {
    // A session without a request tool catalog or a surface system prompt has
    // no fixed prefix. Avoid folding the breakdown projection for that common
    // case; the zero result is compared exactly like a materialized zero.
    const tools = session.requestHeader()?.tools
    const hasTools = tools !== undefined && tools.length > 0
    if (!hasTools && !this.ctx.tokenMeter.hasSystemMessage(session)) {
      return { system: 0, tools: 0, total: 0 }
    }
    const breakdown = this.ctx.sessionProjections
      .snapshot(session, ['contextBreakdown']).values.contextBreakdown
    if (breakdown === undefined) return undefined
    return {
      system: breakdown.systemTokens,
      tools: breakdown.toolsTokens,
      total: breakdown.systemTokens + breakdown.toolsTokens,
    }
  }

  /**
   * Scale the routed policy into token budgets, letting a mounted
   * `compactionPolicy` replace the configured `thresholdRatio` — including a
   * `modelPolicies` override of it, which one live user setting outranks. The
   * rest of that per-model override, retention and headroom included, still
   * applies, so the replaced ratio sets only the window-fraction term of the
   * trigger `floor(min(W × ratio, W − O − headroomTokens))`. A ratio outside
   * `(0, 1]`, or one whose trigger would not clear the retained tail, warns
   * once per routed target and keeps the configured value.
   * @param policy - merged policy for the exact routed target.
   * @param contextWindow - adapter-owned capacity for that target.
   * @param reservedCompletionTokens - output tokens one routed request reserves.
   * @param targetKey - `provider/model` route used as the warning key.
   * @returns this step's concrete pressure and retention budget.
   */
  private pressureSpec(
    policy: ResolvedTargetPolicy,
    contextWindow: number,
    reservedCompletionTokens: number,
    targetKey: string,
  ): ResolvedCompactSpec {
    const spec = resolveCompactSpec(policy, contextWindow, reservedCompletionTokens)
    const live = this.ctx.get('compactionPolicy')
    if (live === undefined) return spec
    const ratio = live.thresholdRatio()
    // Retention and the headroom term are untouched by the override, so the
    // configured spec's tail is exactly the tail the overridden trigger would
    // have to clear, and the configured spec already proved the headroom term
    // positive.
    const trigger = Math.floor(Math.min(
      contextWindow * ratio,
      contextWindow - reservedCompletionTokens - policy.headroomTokens,
    ))
    if (ratio > 0 && ratio <= 1 && spec.retainTokens < trigger) {
      return resolveCompactSpec({ ...policy, thresholdRatio: ratio }, contextWindow, reservedCompletionTokens)
    }
    if (!this.warnedPolicyThresholdTargets.has(targetKey)) {
      this.warnedPolicyThresholdTargets.add(targetKey)
      this.ctx.logger.warn(
        `compaction policy threshold ratio ${ratio} is unusable for ${targetKey} `
        + `(retained tail ${spec.retainTokens} of context window ${contextWindow}); `
        + `keeping the configured ratio ${spec.thresholdRatio}`,
      )
    }
    return spec
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  /**
   * Tools for a manual summary: the explicit summarizer or the conversation
   * route (pending selection, header, AgentOptions). Kept separate from the
   * pressure target because manual compaction may run without a durable
   * route and still resolves AgentOptions.
   * @param agent - agent owning the session.
   * @returns header tools for a matching route, null to omit, undefined to inherit.
   */
  private manualSummaryTools(agent: Agent): readonly ToolSchema[] | null | undefined {
    const conversation = conversationTarget(agent)
    if (conversation === undefined) return undefined
    const policy = resolveTargetPolicy(this.config, conversation)
    const summaryTarget = policy.summarizationProvider.length === 0
      ? conversation
      : { provider: policy.summarizationProvider, model: policy.summarizationModel }
    return this.summaryTools(agent, summaryTarget)
  }

  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const manualTools = this.manualSummaryTools(agent)
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        manual: false,
        summaryMaxRatio: this.config.summaryMaxRatio,
        checkpointReadback: this.config.checkpointReadback,
        ...manualTools === undefined ? {} : { tools: manualTools },
      },
      signal,
    )
  }

  /**
   * Run one pressure/overflow transaction with a read-only prune preview and
   * the summary tools chosen for its route. Preview application happens in the
   * caller only after this promise commits.
   * @param start - first selected surface seq.
   * @param end - last selected surface seq.
   * @param agent - agent whose session is compacted.
   * @param signal - cancellation signal.
   * @param preview - read-only pruned messages/prices.
   * @param tools - tools for the summary route, or null to omit.
   * @returns the committed compaction result.
   */
  private compactPressureRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal: AbortSignal,
    summaryMaxRatio: number,
    preview?: {
      readonly messages: ReadonlyMap<SessionSeq, Message>
      readonly tokens: ReadonlyMap<SessionSeq, { readonly tokens: number; readonly heuristicTokens: number }>
    },
    tools?: readonly ToolSchema[] | null,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      {
        owner: 'current-turn',
        stability: 'whole-surface',
        manual: false,
        summaryMaxRatio,
        checkpointReadback: this.config.checkpointReadback,
        ...preview === undefined ? {} : { preview },
        ...tools === undefined ? {} : { tools },
      },
      signal,
    )
  }

  /**
   * Force one useful compaction below the pressure threshold. An idle agent
   * compacts now as agent maintenance with a standalone bracket; a running
   * agent with `whileBusy` waits for the requested boundary. Either way the
   * call resolves only after the closed bracket is durably checkpointed.
   * @param agent - agent whose history is compacted and whose next-turn admission an idle compaction reserves.
   * @param signal - cancellation scoped to this compaction request, including its wait.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @param whileBusy - timing for a running agent; omitted refuses it as `busy`.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
    whileBusy?: ManualCompactionWhileBusy,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (whileBusy === undefined || agent.status === 'idle') return this.compactIdle(agent, signal, sourceCommandId)
    return this.waiting.add(agent, whileBusy, signal, sourceCommandId)
  }

  /**
   * Run one manual compaction as idle-agent maintenance with a standalone bracket.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity.
   * @returns the committed result, or `null` when no safe useful range exists.
   * @throws {@link ManualCompactionError} `busy`, synchronously, when the agent is not idle.
   */
  private compactIdle(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId: CommandId | undefined,
  ): Promise<CompactionResult | null> {
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await this.compactManualRange(agent, null, sourceCommandId, operationSignal)
        } catch (error: unknown) {
          throw manualCancellation(error, agentSignal, operationSignal)
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Run one waiting manual request at a step boundary of the open turn, with
   * a bracket that turn owns. Stop aborts the turn signal and cancels it.
   * @param request - the request being served.
   * @param turnSignal - the open turn's cancellation signal.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  private async compactAtStep(request: WaitingCompaction, turnSignal: AbortSignal): Promise<CompactionResult | null> {
    const operationSignal = AbortSignal.any([turnSignal, request.signal])
    try {
      return await this.compactManualRange(request.agent, 'current-turn', request.sourceCommandId, operationSignal)
    } catch (error: unknown) {
      throw manualCancellation(error, turnSignal, operationSignal)
    }
  }

  /**
   * Select every compactable node and replace it through one manual
   * transaction that is checkpointed before it settles.
   * @param agent - agent whose Session is compacted.
   * @param owner - `null` for a standalone bracket, `current-turn` for one the open turn owns.
   * @param sourceCommandId - initiating command identity.
   * @param signal - cancellation of this compaction.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  private async compactManualRange(
    agent: Agent,
    owner: 'current-turn' | null,
    sourceCommandId: CommandId | undefined,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const range = selectCompactableRange(
      agent.session,
      this.ctx.tokenMeter.measure(agent.session),
      0,
    )
    if (range === null) return null
    const manualTools = this.manualSummaryTools(agent)
    const result = await compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      range.start,
      range.end,
      agent,
      {
        owner,
        stability: owner === null ? 'selected-span' : 'whole-surface',
        manual: true,
        summaryMaxRatio: this.config.summaryMaxRatio,
        checkpointReadback: this.config.checkpointReadback,
        ...sourceCommandId === undefined ? {} : { sourceCommandId },
        ...manualTools === undefined ? {} : { tools: manualTools },
        flush: async () => {
          await this.ctx.sessions.flush(agent.session)
        },
      },
      signal,
    )
    this.clearSessionSummaryFailures(agent.session)
    return result
  }

  /** Bind the effective token meter, dynamically dispatched summary hooks, and the review waterfall. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
      review: review => this.ctx.waterfall('compaction/summary-review', review, () => true),
    }
  }
}

/**
 * Map a failed manual compaction to its reported error: cancellation by the
 * agent's own signal is `cancelled`, the request's own abort keeps its reason.
 * @param error - the failure.
 * @param agentSignal - the maintenance or turn signal the agent owns.
 * @param operationSignal - that signal combined with the request's own.
 * @returns the error to reject with.
 */
function manualCancellation(error: unknown, agentSignal: AbortSignal, operationSignal: AbortSignal): unknown {
  if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
    return new ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
  }
  return operationSignal.aborted ? operationSignal.reason : error
}

/**
 * Stable failure class for one grouped compaction attempt.
 * @param error - failure thrown by the transaction.
 * @returns a small class name for logs and the consecutive-failure ledger.
 */
export default BasicCompactionEngine
