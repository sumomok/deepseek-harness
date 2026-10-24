/**
 * Opt-in idle microcompaction: clear old completed text tool results into
 * `{sessionId, seq}` pointers after a long durable inactivity gap.
 *
 * The pass is deliberately separate from pressure compaction and from the
 * oversized-result spill preview. It never calls a model, never saves new
 * spill text, and only runs when a model-facing `session_event_read` (or an
 * explicit host-only readback choice) can resolve the pointer.
 *
 * @module @deepseek-ai/dsh-compaction-microcompact
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { originalToolResultSeq, recoveryNotice } from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
// Type-only privileges for optional sibling services.
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-tools'
import { DEFAULTS, resolveConfig } from './config.ts'
import type { MicrocompactConfig, ResolvedMicrocompactConfig } from './config.ts'

export { DEFAULTS, resolveConfig } from './config.ts'
export type { MicrocompactConfig, ResolvedMicrocompactConfig } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    microcompact: Microcompact
  }
}

/** Why one preview refused to produce any replacement. */
export type MicrocompactSkipReason =
  | 'disabled'
  | 'no-readback'
  | 'active-compaction'
  | 'active-job'
  | 'active-subagent'
  | 'not-idle'
  | 'below-count'
  | 'below-tokens'
  | 'no-candidates'

/** One skipped candidate or one whole-pass skip. */
export interface MicrocompactSkip {
  /** Candidate sequence, absent for a whole-pass skip. */
  readonly seq?: SessionSeq
  /** Why it was skipped. */
  readonly reason: MicrocompactSkipReason
}

/** One planned replacement. */
export interface MicrocompactEntry {
  /** Current surface node that will be shadowed. */
  readonly originalSeq: SessionSeq
  /** Original event sequence an address notice points at. */
  readonly addressSeq: SessionSeq
  /** Exact current message apply must still find. */
  readonly original: ToolResultMessage
  /** Replacement message containing only the address notice. */
  readonly replacement: ToolResultMessage
  /** Estimated tokens of the original message. */
  readonly tokens: number
}

/** Read-only idle-pass plan. */
export interface MicrocompactPreview {
  /** Replacement messages in surface order. */
  readonly entries: readonly MicrocompactEntry[]
  /** Candidates and whole-pass refusals. */
  readonly skipped: readonly MicrocompactSkip[]
  /** Estimated tokens the entries would remove. */
  readonly reclaimableTokens: number
  /** Durable inactivity observed by this pass, in seconds. */
  readonly idleSeconds: number
}

/** Outcome of applying one preview. */
export interface MicrocompactResult {
  /** Landed entries in apply order. */
  readonly cleared: readonly MicrocompactEntry[]
  /** Entries skipped because the surface or content changed. */
  readonly skipped: number
}

interface Candidate {
  readonly seq: SessionSeq
  readonly addressSeq: SessionSeq
  readonly message: ToolResultMessage
  readonly name: string
}

interface IdleInfo {
  readonly previousActivitySeq: SessionSeq
  readonly currentUserSeq: SessionSeq
  readonly idleMs: number
}

/** Idle microcompaction service. */
export class Microcompact extends Service {
  // The shadow-price event needs the same estimator the token meter publishes.
  static inject = ['tokenMeter']

  static Config: z<MicrocompactConfig> = z.object({
    enabled: z.boolean().default(DEFAULTS.enabled),
    minIdleSeconds: z.number().step(1).min(0).default(DEFAULTS.minIdleSeconds),
    keepRecentToolUses: z.number().step(1).min(0).default(DEFAULTS.keepRecentToolUses),
    minClearableToolUses: z.number().step(1).min(0).default(DEFAULTS.minClearableToolUses),
    clearAtLeastTokens: z.number().step(1).min(0).default(DEFAULTS.clearAtLeastTokens),
    maxClearPerRun: z.number().step(1).min(0).default(DEFAULTS.maxClearPerRun),
    keepErrors: z.boolean().default(DEFAULTS.keepErrors),
    allowHostOnlyReadback: z.boolean().default(DEFAULTS.allowHostOnlyReadback),
    excludeTools: z.array(z.string()).default([...DEFAULTS.excludeTools]),
  })

  /** Resolved immutable settings. */
  readonly config: ResolvedMicrocompactConfig

  /** One idle window is attempted at most once in this process lifecycle. */
  private readonly attemptedIdle = new WeakMap<Session, string>()

  constructor(ctx: Context, config: MicrocompactConfig = {}) {
    super(ctx, 'microcompact')
    this.config = resolveConfig(config)
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (!this.config.enabled || signal.aborted) return next()
      try {
        await this.runIdle(agent)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`idle microcompact failed: ${message}; continuing the turn`)
      }
      return next()
    })
  }

  /**
   * Heal a crash that left the last `compaction/prune` marker without its
   * adjacent replacement. It appends an identical-content replacement for a
   * single-node marker, consuming the armed claim without losing text.
   * @param session - session whose durable tail may end at an orphan marker.
   * @returns true when a healing replacement was appended.
   */
  healOrphanMarker(session: Session): boolean {
    const events = session.snapshotEvents()
    const last = events.at(-1)
    if (last?.type !== 'compaction/prune') return false
    if (last.data.shadowedSeqs.length !== 1) return false
    const seq = last.data.shadowedSeqs[0]
    if (seq === undefined || !session.surface.nodes.includes(seq)) return false
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') return false
    const message = session.deriveEventMessage(event)
    if (message === null || message.role !== 'tool') return false
    session.append('tool/result', {
      ...event.data,
      message: { ...message, content: message.content },
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    return true
  }

  /**
   * Plan one idle pass without appending or saving anything.
   * @param session - session whose durable activity and surface are inspected.
   * @returns planned replacements and reasons for refusals.
   */
  async preview(session: Session): Promise<MicrocompactPreview> {
    if (!this.config.enabled) return empty('disabled')
    if (!this.readbackAvailable()) return empty('no-readback')
    if (this.hasActiveCompaction(session)) return empty('active-compaction')
    if (await this.hasActiveJob(session)) return empty('active-job')
    if (await this.hasActiveSubagent(session)) return empty('active-subagent')
    const idle = this.idleInfo(session)
    if (idle === null) return empty('not-idle')

    const candidates = this.candidates(session)
    if (candidates.length < this.config.minClearableToolUses) {
      return { ...empty('below-count'), idleSeconds: Math.round(idle.idleMs / 1000) }
    }
    const selected = candidates.slice(0, this.config.maxClearPerRun)
    if (selected.length === 0) return { ...empty('no-candidates'), idleSeconds: Math.round(idle.idleMs / 1000) }
    const entries: MicrocompactEntry[] = []
    for (const candidate of selected) {
      const notice = recoveryNotice({
        kind: 'session',
        sessionId: session.header.id,
        seq: candidate.addressSeq,
      })
      const replacement = freezeMessage<ToolResultMessage>({
        ...candidate.message,
        content: [{ type: 'text', text: notice }],
      })
      entries.push({
        originalSeq: candidate.seq,
        addressSeq: candidate.addressSeq,
        original: candidate.message,
        replacement,
        tokens: this.ctx.tokenMeter.estimateMessage(candidate.message),
      })
    }
    const reclaimableTokens = entries.reduce((total, entry) => total + entry.tokens, 0)
    if (reclaimableTokens < this.config.clearAtLeastTokens) {
      return { ...empty('below-tokens'), idleSeconds: Math.round(idle.idleMs / 1000) }
    }
    return {
      entries,
      skipped: [],
      reclaimableTokens,
      idleSeconds: Math.round(idle.idleMs / 1000),
    }
  }

  /**
   * Apply a preview after it was produced from the current surface. Entries
   * whose sequence or message changed are skipped; a second apply is a no-op.
   * @param session - session whose surface is rewritten.
   * @param preview - plan returned by {@link preview}.
   * @returns landed entries and the count of stale entries.
   */
  apply(session: Session, preview: MicrocompactPreview): MicrocompactResult {
    const cleared: MicrocompactEntry[] = []
    let skipped = 0
    for (const entry of preview.entries) {
      if (!session.surface.nodes.includes(entry.originalSeq)) {
        skipped += 1
        continue
      }
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(entry.originalSeq)
      if (event?.type !== 'tool/result') {
        skipped += 1
        continue
      }
      const current = session.deriveEventMessage(event)
      if (current === null || current.role !== 'tool'
        || current.id !== entry.original.id
        || current.source.callId !== entry.original.source.callId
        || current.isError !== entry.original.isError
        || !deepEqualJson(current.content, entry.original.content)) {
        skipped += 1
        continue
      }
      const tokens = this.ctx.tokenMeter.estimateMessage(current)
      session.append('compaction/prune', {
        shadowedRange: { start: entry.originalSeq, end: entry.originalSeq },
        shadowedSeqs: [entry.originalSeq],
        shadowedTokenCount: tokens,
      })
      session.append('tool/result', {
        ...event.data,
        message: entry.replacement,
      }, {
        surfaceOp: { op: 'replace', startSeq: entry.originalSeq, endSeq: entry.originalSeq },
        sourceEventSeqs: [entry.originalSeq],
      })
      cleared.push(entry)
    }
    return { cleared, skipped }
  }

  /**
   * Run the idle path for one pre-step. Heals an interrupted marker, plans,
   * and applies at most once per durable idle window.
   * @param agent - agent whose session is inspected.
   * @returns the applied result, or an empty result when this window was already attempted.
   */
  async runIdle(agent: Agent): Promise<MicrocompactResult> {
    if (!this.config.enabled) return { cleared: [], skipped: 0 }
    const session = agent.session
    if (!this.readbackAvailable() || this.hasActiveCompaction(session)) return { cleared: [], skipped: 0 }
    if (this.healOrphanMarker(session)) {
      this.ctx.logger.info('idle microcompact: healed an interrupted compaction/prune marker')
    }
    const idle = this.idleInfo(session)
    if (idle === null) return { cleared: [], skipped: 0 }
    const key = `${String(idle.previousActivitySeq)}:${String(idle.currentUserSeq)}`
    if (this.attemptedIdle.get(session) === key) return { cleared: [], skipped: 0 }
    const preview = await this.preview(session)
    this.attemptedIdle.set(session, key)
    if (preview.entries.length === 0) return { cleared: [], skipped: 0 }
    return this.apply(session, preview)
  }

  /** Whether a model-facing readback tool is currently visible. */
  private readbackAvailable(): boolean {
    if (this.config.allowHostOnlyReadback) return true
    return this.ctx.get('tools')?.get('session_event_read') !== undefined
  }

  /** Whether a compaction bracket is still open. */
  private hasActiveCompaction(session: Session): boolean {
    let open = false
    for (const event of session.snapshotEvents()) {
      if (event.type === 'compaction/start') open = true
      if (event.type === 'compaction/end') open = false
    }
    return open
  }

  /** Whether this session still owns a running job. */
  private async hasActiveJob(session: Session): Promise<boolean> {
    const jobs = this.ctx.get('jobs')
    if (jobs !== undefined) {
      try {
        return jobs.list(session.header.id).some(job => job.status === 'running' || job.status === 'stopping')
      } catch {
        return true
      }
    }
    const active = new Set<string>()
    for (const event of session.snapshotEvents()) {
      if (event.type === 'job/registered') active.add(event.data.jobId)
      if (event.type === 'job/settled') active.delete(event.data.jobId)
    }
    return active.size > 0
  }

  /** Whether any direct child session is in an open turn. */
  private async hasActiveSubagent(session: Session): Promise<boolean> {
    const subagents = this.ctx.get('subagent')
    const sessions = this.ctx.get('sessions')
    if (subagents === undefined || sessions === undefined) return false
    try {
      const children = await subagents.listChildren(session.header.id)
      return children.some((child: { readonly id: SessionId }) => {
        const childSession = sessions.get(child.id)
        return childSession !== undefined && hasOpenTurn(childSession)
      })
    } catch {
      return true
    }
  }

  /** Latest durable activity before the current turn, measured against its real user message. */
  private idleInfo(session: Session): IdleInfo | null {
    const events = session.snapshotEvents()
    let turnStart = -1
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === 'turn/start') {
        turnStart = index
        break
      }
    }
    if (turnStart <= 0) return null
    const previous = events[turnStart - 1]
    const user = events.slice(turnStart).find(event => (
      event.type === 'user/message' && event.data.source.kind === 'user'
    ))
    if (previous === undefined || user === undefined) return null
    const idleMs = user.time - previous.time
    if (idleMs < this.config.minIdleSeconds * 1000) return null
    return { previousActivitySeq: previous.seq, currentUserSeq: user.seq, idleMs }
  }

  /** Select old text results after keep-recent and every exclusion. */
  private candidates(session: Session): Candidate[] {
    const events = session.snapshotEvents()
    const calls = new Map<string, string>()
    for (const event of events) {
      if (event.type === 'tool/call') calls.set(String(event.data.callId), event.data.name)
    }
    const completed: Array<{ seq: SessionSeq; message: ToolResultMessage; name: string }> = []
    for (const seq of session.surface.nodes) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/result') continue
      const message = session.deriveEventMessage(event)
      if (message === null || message.role !== 'tool') continue
      const name = calls.get(String(message.source.callId))
      if (name === undefined) continue
      completed.push({ seq, message, name })
    }
    const recent = new Set<string>()
    for (const item of completed.slice(-this.config.keepRecentToolUses)) recent.add(String(item.message.source.callId))
    return completed
      .filter(item => !recent.has(String(item.message.source.callId)))
      .filter(item => !this.config.excludeTools.includes(item.name))
      .filter(item => !(this.config.keepErrors && item.message.isError))
      .filter(item => item.message.content.every(block => block.type === 'text'))
      .filter(item => !isClearNotice(item.message.content))
      .map(item => ({
        seq: item.seq,
        addressSeq: originalToolResultSeq(session, item.seq) ?? item.seq,
        message: item.message,
        name: item.name,
      }))
  }
}

/** True when every block carries text and the joined text is an existing notice. */
function isClearNotice(blocks: readonly ContentBlock[]): boolean {
  const text = blocks.map(block => block.type === 'text' ? block.text : '').join('')
  return text.includes('Old tool result cleared.') || text.includes('Middle pruned.')
}

/** True while a child session has an unmatched turn/start. */
function hasOpenTurn(session: Session): boolean {
  let open = false
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') open = false
  }
  return open
}

/** Empty preview carrying one refusal reason. */
function empty(reason: MicrocompactSkipReason): MicrocompactPreview {
  return { entries: [], skipped: [{ reason }], reclaimableTokens: 0, idleSeconds: 0 }
}
