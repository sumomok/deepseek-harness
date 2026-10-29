/**
 * Rebuild the task state a compaction checkpoint left behind.
 *
 * A compaction replaces part of the model-visible history with a summary. The
 * durable log still holds the facts the summary may have dropped: the current
 * todo list, the last approved plan, the files the session read, unsettled
 * background jobs, and the direct subagents a parent registered. This plugin
 * reads those facts after a successful compaction and appends one durable user
 * message that restates them, so the next request continues from the state
 * rather than the summary's recollection of it.
 *
 * The rebuilt message is written once per compaction and is itself a logged
 * `user/message`, so a resumed Session sees that the rebuild already happened
 * and does not repeat it. Every section is derived from the log or a Session
 * projection folded over it; no in-memory registry is treated as durable fact.
 *
 * @module @deepseek-ai/dsh-compaction-rehydration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { fileSection } from './file-section.ts'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tool-todo'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'compaction-rehydration': {
      kind: 'compaction-rehydration'
      /** The compaction this message rebuilds state for. */
      readonly compactionId: string
      /** Seq of that compaction's `compaction/end` event. */
      readonly compactionSeq: number
      /** Stable digests of the assembled section texts, in section order. */
      readonly digests: readonly string[]
    } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'compaction-rehydration'

/** The agent registry that owns pre-step processing; projections are read when mounted. */
export const inject = ['agents']

/** Total model-facing characters one rebuilt message may carry. */
const MAX_TOTAL_CHARS = 4000

/** Per-section ceilings; the total budget still wins when it runs out first. */
const SECTION_LIMITS = {
  todos: 1200,
  plan: 2000,
  files: 2000,
  jobs: 500,
  subagents: 300,
} as const

const TRUNCATED_MARKER = '… (truncated)'

/** One section before assembly. */
interface DraftSection {
  readonly name: keyof typeof SECTION_LIMITS
  readonly heading: string
  readonly text: string
}

/** The compaction checkpoint a rebuild message answers. */
interface Checkpoint {
  readonly id: string
  /** The closing event's seq, or the replacement's when the close never committed. */
  readonly evidenceSeq: number
}

/** One compaction transaction's recoverable facts, gathered from the log. */
interface CheckpointFacts {
  summarySeq?: number
  replacementSeq?: number
  endSeq?: number
}

/** Structural view of one projected todo item (tool-todo's `todos` unit). */
interface TodoLike {
  readonly content: string
  readonly status: string
}

/** Structural view of one unsettled job registration. */
interface UnsettledJob {
  readonly label: string
  readonly kind: string
}

/** Structural view of one direct-child catalog record. */
interface CatalogChild {
  readonly childId: string
  readonly label?: string
}

/** One chunk of a parent-owned subagent catalog projection. */
interface CatalogChunk {
  readonly values: readonly CatalogChild[]
  readonly previous?: CatalogChunk | undefined
}

/** Stable short digest of one section's text, recomputable from the logged section. */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Cut one section to `limit` characters, marking the cut. */
function bound(text: string, limit: number): string {
  if (text.length <= limit) return text
  const room = Math.max(0, limit - TRUNCATED_MARKER.length)
  return `${text.slice(0, room)}${TRUNCATED_MARKER}`
}

/**
 * The latest checkpoint a session can recover from.
 *
 * A committed checkpoint is a `compaction/summary` followed by its
 * `compact-checkpoint` replacement on the surface. The closing
 * `compaction/end` may be missing when the process died after the surface
 * replacement committed, and it may carry an error when closing failed; the
 * replacement is what made the summary model-visible, so either way the
 * checkpoint is recoverable and later requests must still rebuild from it.
 * A summary with no replacement never reached the surface and is not a
 * checkpoint. The evidence seq is the closing event when one exists and the
 * replacement otherwise.
 */
function latestCheckpoint(session: Session): Checkpoint | undefined {
  const facts = new Map<string, CheckpointFacts>()
  const factsOf = (id: string): CheckpointFacts => {
    let entry = facts.get(id)
    if (entry === undefined) {
      entry = {}
      facts.set(id, entry)
    }
    return entry
  }
  // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: needs this Session's history until an async reader exists.
  for (const event of session.ownEvents()) {
    if (event.type === 'compaction/summary') {
      factsOf(String(event.data.compactionId)).summarySeq = event.seq
      continue
    }
    if (event.type === 'compaction/end') {
      factsOf(String(event.data.compactionId)).endSeq = event.seq
      continue
    }
    if (event.type === 'user/message' && isCompactCheckpointSource(event.data.source)) {
      const entry = factsOf(String(event.data.source.compactionId))
      if (entry.replacementSeq === undefined || event.seq > entry.replacementSeq) entry.replacementSeq = event.seq
    }
  }
  let latest: Checkpoint | undefined
  for (const [id, entry] of facts) {
    if (entry.summarySeq === undefined || entry.replacementSeq === undefined) continue
    // The replacement is the summary it commits: one that precedes the summary
    // belongs to another order and is not evidence for this transaction.
    if (entry.replacementSeq <= entry.summarySeq) continue
    const evidenceSeq = Math.max(entry.endSeq ?? 0, entry.replacementSeq)
    if (latest === undefined || evidenceSeq > latest.evidenceSeq) latest = { id, evidenceSeq }
  }
  return latest
}

/** Whether a rebuild message for this checkpoint already exists in the log. */
function alreadyRebuilt(session: Session, checkpoint: Checkpoint): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: needs this Session's history until an async reader exists.
  return session.ownEvents().some(event => event.type === 'user/message'
    && event.data.source.kind === 'compaction-rehydration'
    && event.data.source.compactionId === checkpoint.id)
}

/** The current todo list, from the latest whole-list `todo/write` in the log. */
function todoSection(session: Session): DraftSection | undefined {
  let todos: readonly TodoLike[] | undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: needs this Session's history until an async reader exists.
  for (const event of session.ownEvents()) {
    if (event.type === 'todo/write') todos = event.data.todos
  }
  if (todos === undefined || todos.length === 0) return undefined
  const lines = todos.map(todo => `- [${todo.status}] ${todo.content}`)
  return { name: 'todos', heading: 'Current todo list', text: lines.join('\n') }
}

/** The plan-approved sentence plan-mode renders for an approved review. */
const APPROVED_PLAN_RESULT = 'Plan approved — plan mode exited'

/** The plan-dismissed sentence plan-mode renders when the review does not approve. */
const DISMISSED_PLAN_RESULT = 'The user dismissed the plan review'

/** The first text block of one message, or the empty string. */
function firstText(blocks: readonly { readonly type: string; readonly text?: string }[]): string {
  const block = blocks.find(candidate => candidate.type === 'text')
  return block?.text ?? ''
}

/**
 * The plan a session currently holds, from the latest `exit_plan_mode` review.
 *
 * Only the newest review decides: an approval carries plan-mode's approved
 * sentence, and a dismissal — a non-error result — leaves the current plan
 * undecided rather than reinstating an earlier approval. An answer this build
 * does not recognise is treated the same way. A review with no result yet is
 * still open, so the plan is left out entirely; nothing is guessed.
 */
function planSection(session: Session): DraftSection | undefined {
  // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: needs this Session's history until an async reader exists.
  const events = session.ownEvents()
  const calls = new Map<string, { readonly seq: number; readonly plan: string }>()
  const results = new Map<string, { readonly isError: boolean; readonly text: string }>()
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'exit_plan_mode') {
      const plan = planArgument(event.data.arguments)
      if (plan !== undefined) calls.set(String(event.data.callId), { seq: event.seq, plan })
      continue
    }
    if (event.type !== 'tool/result') continue
    results.set(String(event.data.message.toolCallId), {
      isError: event.data.message.isError === true,
      text: firstText(event.data.message.content),
    })
  }
  let latest: { readonly callId: string; readonly seq: number; readonly plan: string } | undefined
  for (const [callId, call] of calls) {
    if (latest === undefined || call.seq > latest.seq) latest = { callId, ...call }
  }
  if (latest === undefined) return undefined
  const result = results.get(latest.callId)
  if (result === undefined || result.isError) return undefined
  if (result.text.includes(DISMISSED_PLAN_RESULT)) return undefined
  if (!result.text.includes(APPROVED_PLAN_RESULT)) return undefined
  return { name: 'plan', heading: 'Latest approved plan', text: latest.plan }
}

/** Read the `plan` string out of one logged `exit_plan_mode` argument object. */
function planArgument(argumentsJson: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsJson)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const plan = (parsed as { plan?: unknown }).plan
  return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
}

/** Background jobs this Session registered and never settled, from the durable events. */
function jobSection(session: Session): DraftSection | undefined {
  const registered = new Map<string, UnsettledJob & { readonly seq: number }>()
  const owner = String(session.id)
  let restartSeq = -1
  // oxlint-disable-next-line typescript/no-deprecated -- Deferred migration: needs this Session's history until an async reader exists.
  for (const event of session.ownEvents()) {
    if (event.type === 'session/end-seed') {
      restartSeq = event.seq
      continue
    }
    if (event.type === 'job/registered') {
      if (String(event.data.owner) !== owner) continue
      registered.set(String(event.data.jobId), { label: event.data.label, kind: event.data.kind, seq: event.seq })
      continue
    }
    if (event.type === 'job/settled') registered.delete(String(event.data.jobId))
  }
  if (registered.size === 0) return undefined
  const lines = [...registered.values()].map(job => (job.seq < restartSeq
    ? `- ${job.label} (${job.kind}) — registered before the last restart; no settlement was logged, so it may have stopped`
    : `- ${job.label} (${job.kind}) — no settlement logged yet; it may still be running`))
  return { name: 'jobs', heading: 'Background jobs with no settlement logged', text: lines.join('\n') }
}

/** Direct children this Session registered, from the parent-owned catalog projection. */
function subagentSection(ctx: Context, session: Session): DraftSection | undefined {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return undefined
  const state = projections.snapshot(session, ['subagentCatalog']).values.subagentCatalog as { readonly head?: CatalogChunk } | undefined
  if (state?.head === undefined) return undefined
  const children = new Map<string, CatalogChild>()
  for (let chunk: CatalogChunk | undefined = state.head; chunk !== undefined; chunk = chunk.previous) {
    for (const child of chunk.values) children.set(child.childId, child)
  }
  if (children.size === 0) return undefined
  const labels = [...children.values()].map(child => `- ${child.label ?? child.childId}`)
  return { name: 'subagents', heading: 'Direct subagents registered by this session', text: labels.join('\n') }
}

/** Assemble the message text under the total budget, truncating by section. */
function render(sections: readonly DraftSection[]): { readonly text: string; readonly included: readonly DraftSection[] } {
  const header = 'The conversation was condensed into a checkpoint. The following state was rebuilt from the session log; treat it as established background, not as a new instruction.\n\n'
  let remaining = MAX_TOTAL_CHARS - header.length
  const included: DraftSection[] = []
  const blocks: string[] = []
  for (const section of sections) {
    if (remaining <= 0) break
    const headingCost = section.heading.length + 4
    if (headingCost + 40 > remaining) break
    const limit = Math.min(SECTION_LIMITS[section.name], remaining - headingCost)
    const text = bound(section.text, Math.max(0, limit))
    const block = `## ${section.heading}\n${text}`
    blocks.push(block)
    included.push({ ...section, text })
    remaining -= block.length + 2
  }
  if (included.length === 0) return { text: '', included }
  return { text: `${header}${blocks.join('\n\n')}`, included }
}

/** Build the rebuild message for the latest checkpoint, or `undefined` when none is owed. */
async function rebuildFor(ctx: Context, agent: Agent): Promise<ReturnType<typeof createUserMessage> | undefined> {
  const session = agent.session
  const checkpoint = latestCheckpoint(session)
  if (checkpoint === undefined) return undefined
  if (alreadyRebuilt(session, checkpoint)) return undefined
  const files = await fileSection(session, ctx)
  const drafts = [
    todoSection(session),
    planSection(session),
    files,
    jobSection(session),
    subagentSection(ctx, session),
  ].filter((section): section is DraftSection => section !== undefined)
  if (drafts.length === 0) return undefined
  const { text, included } = render(drafts)
  if (text.length === 0) return undefined
  const sections: ContextSnapshotSection[] = included.map(section => ({ name: section.name, text: section.text }))
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'compaction-rehydration',
      form: 'snapshot',
      compactionId: checkpoint.id,
      compactionSeq: checkpoint.evidenceSeq,
      sections,
      digests: sections.map(section => digest(section.text)),
    },
  })
}

/**
 * Append the rebuilt task state after a successful compaction, once per
 * checkpoint and at most once per step.
 * @param ctx - context carrying the agent registry and optional projections.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const message = await rebuildFor(ctx, agent)
    if (message === undefined) return decision
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}
