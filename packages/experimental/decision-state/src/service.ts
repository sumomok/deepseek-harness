/**
 * Host-side decision recorder.
 *
 * The host records a change when it observes one; the record is committed
 * immediately as an experimental plugin record carrying the complete next
 * scope state. There is no in-memory queue, so a failed request cannot lose a
 * recorded decision.
 *
 * @module @deepseek-ai/dsh-decision-state/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { decisionStateProjection, parseRecord, RECORD_TYPE, UNKNOWN_SCOPE, type DecisionProjectionState } from './projection.ts'
import { EMPTY_SCOPE, foldRecord, openUnits, replaceDecisions } from './state.ts'
import { MAX_ENTRY_LENGTH, MAX_LISTED_OPEN_UNITS, renderView } from './validate.ts'
import { Config, createProposeOpenWorkTool } from './tool.ts'
import type { Decision, DecisionRecord, ScopeState } from './types.ts'

/**
 * Runtime-context placement between the task-state slot (TEAM_IDENTITY, 125)
 * and the process-specific slots (HARNESS_SOURCE, 200).
 */
const CONTEXT_ORDER = 130

declare module '@deepseek-ai/cordis' {
  interface Context {
    decisionState: DecisionStateService
  }
}

/** One queued state change; the recorder assigns the revision when it commits. */
export interface DecisionChange {
  readonly scope: string
  /** Decisions established by this change. */
  readonly decisions: readonly Decision[]
  /** Decision ids this change replaces. */
  readonly supersedes: readonly string[]
}

/** One open unit as the model submitted it. */
export interface ProposalDisposition {
  readonly unitId: string
  readonly disposition: Decision['disposition']
  readonly targetIds?: readonly string[]
}

/** The human's verdict on a pending proposal. */
export interface ApprovalOutcome {
  /** Whether the proposal may be committed. */
  readonly approved: boolean
  /** The reviewer's own words when they asked for changes. */
  readonly feedback?: string
  /** Whether the reviewer closed the review to take the turn back. */
  readonly dismissed?: boolean
}

/** Question id of the proposal review; also the answer key. */
const APPROVAL_QUESTION_ID = 'decision-proposal'
/** Option label that approves the proposal; every other selection declines it. */
const APPROVE_LABEL = '批准并记录'
/** Option label that declines the proposal and returns the reviewer's words. */
const REVISE_LABEL = '继续修改'

/**
 * Recognize the user-questions cancellation without importing its class into
 * the package runtime: every profile that can reach review mode registers the
 * service, but headless profiles that never review must still load this plugin.
 * @param cause - rejection from `userQuestions.ask`.
 * @returns whether the reviewer dismissed the question.
 */
function isAskCancelled(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null
    && 'code' in cause && cause.code === 'ASK_CANCELLED'
}

/** Records decisions for one agent and exposes the folded state. */
export class DecisionStateService extends Service {
  static inject = ['sessionProjections', 'tools', 'systemPrompt']
  static Config = Config

  private projection!: ProjectionHandle<DecisionProjectionState>

  /**
   * @param ctx - owning plugin context.
   * @param config - configured scopes; direct composition without a config gets the schema defaults.
   */
  constructor(ctx: Context, private readonly config: Config = Config.parse({})) {
    super(ctx, 'decisionState')
    for (const [scopeId, scope] of Object.entries(config.scopes)) {
      if (scope.units.length > MAX_LISTED_OPEN_UNITS) {
        throw new HarnessError(`scope ${scopeId} has ${scope.units.length} units; the view lists at most ${MAX_LISTED_OPEN_UNITS}`, 'DECISION_CONFIG_TOO_LARGE')
      }
      if (new Set(scope.units).size !== scope.units.length) {
        throw new HarnessError(`scope ${scopeId} repeats a unit id`, 'DECISION_CONFIG_INVALID')
      }
      if (scope.units.some(unitId => unitId.length === 0)) {
        throw new HarnessError(`scope ${scopeId} has an empty unit id`, 'DECISION_CONFIG_INVALID')
      }
      if (scope.units.some(unitId => unitId.length > MAX_ENTRY_LENGTH)) {
        throw new HarnessError(`scope ${scopeId} has a unit id longer than ${MAX_ENTRY_LENGTH} characters`, 'DECISION_CONFIG_INVALID')
      }
      if (scopeId === UNKNOWN_SCOPE) {
        throw new HarnessError('* is reserved as the unknown-scope mark', 'DECISION_CONFIG_INVALID')
      }
      const openLine = scope.units.join('、')
      if (openLine.length + 128 > config.viewBudget) {
        throw new HarnessError(`scope ${scopeId} does not fit viewBudget ${config.viewBudget}`, 'DECISION_CONFIG_TOO_LARGE')
      }
    }
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(decisionStateProjection)
    this.ctx.tools.register(createProposeOpenWorkTool(this, this.config))
    this.ctx.systemPrompt.context({
      name: 'decision-state:view',
      order: CONTEXT_ORDER,
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.renderView(context.agent),
    })
  }

  /**
   * Commit one decision change; the record carries the complete next state.
   * @param agent - agent whose Session records the change.
   * @param change - decisions to establish and ids to replace.
   * @throws HarnessError when the scope is unknown, its recorded state failed validation,
   * or the change repeats a decision id or a decided unit.
   */
  record(agent: Agent, change: DecisionChange): void {
    if (!Object.hasOwn(this.config.scopes, change.scope)) {
      throw new HarnessError(`unknown decision scope: ${change.scope}`, 'DECISION_UNKNOWN_SCOPE')
    }
    const projection = this.state(agent)
    if (projection.corrupt.includes(change.scope) || projection.corrupt.includes(UNKNOWN_SCOPE)) {
      throw new HarnessError(`decision state for ${change.scope} failed validation`, 'DECISION_STATE_CORRUPT')
    }
    const state = this.scope(agent, change.scope)
    this.commit(agent, state, change.scope, change.supersedes, change.decisions)
  }

  /**
   * Commit an accepted submission as one decision per unit.
   * @param agent - agent whose Session records the decisions.
   * @param scope - scope the submission settled.
   * @param dispositions - open units as the model submitted them.
   * @returns the revision after the commit.
   * @throws HarnessError when the scope is unknown or the change is invalid.
   */
  recordProposal(agent: Agent, scope: string, dispositions: readonly ProposalDisposition[]): number {
    const nextRevision = this.scope(agent, scope).revision + 1
    const approval = agent.session.snapshotEvents().at(-1)
    const evidence = approval === undefined ? [] : [approval.seq]
    const decisions: Decision[] = dispositions.map((entry, index) => ({
      decisionId: `proposal-${nextRevision}-${index}`,
      unitIds: [entry.unitId],
      disposition: entry.disposition,
      targetIds: entry.targetIds ?? [],
      sourceEventSeqs: evidence,
    }))
    this.record(agent, { scope, supersedes: [], decisions })
    return this.scope(agent, scope).revision
  }

  /**
   * Put one assembled proposal in front of the human and report the verdict.
   * The review is a plan-review intent, so a capable UI renders the proposal
   * as a plan decision; the answer encoding is the generic option list.
   * @param agent - agent whose turn is waiting for the review.
   * @param detail - the proposal text the reviewer reads.
   * @param signal - turn cancellation forwarded to the question channel.
   * @returns approval, the reviewer's feedback, or a dismissal.
   * @throws HarnessError when review mode has no user-questions service.
   */
  async requestApproval(agent: Agent, detail: string, signal: AbortSignal): Promise<ApprovalOutcome> {
    const interaction = this.ctx.get('userQuestions')
    if (interaction === undefined) {
      throw new HarnessError(
        'propose_open_work approval requires the user-questions service',
        'DECISION_NO_USER_QUESTIONS',
      )
    }
    let answer: AskUserQuestionAnswer
    try {
      answer = await interaction.ask({
        questions: [{
          id: APPROVAL_QUESTION_ID,
          header: '决策提案',
          question: '批准这份提案并写入决策账本吗？',
          detail,
          options: [
            { label: APPROVE_LABEL, description: '写入账本后本轮结束；已定单元不可再改写。' },
            { label: REVISE_LABEL, description: '不写入；把修改意见回给模型继续。' },
          ],
          intent: { kind: 'plan-review', approve: APPROVE_LABEL },
        }],
        agent,
        signal,
      })
    } catch (cause: unknown) {
      if (isAskCancelled(cause)) return { approved: false, dismissed: true }
      throw cause
    }
    const reviewed = answer.answers.filter(entry => entry.id === APPROVAL_QUESTION_ID)
    const item = reviewed.length === 1 ? reviewed[0] : undefined
    if (item !== undefined
      && item.selected.length === 1
      && item.selected[0] === APPROVE_LABEL
      && item.custom === undefined) {
      return { approved: true }
    }
    return { approved: false, feedback: item?.custom ?? '' }
  }

  /**
   * Replace a corrupt scope with a host-supplied complete state.
   * The model cannot reach this method; it exists so a bad committed record
   * does not leave the scope permanently blocked.
   * @param agent - agent whose Session records the repair.
   * @param scope - scope to restore.
   * @param decisions - complete active decisions after the repair.
   * @throws HarnessError when the scope is unknown or the repair violates the ledger invariants.
   */
  repair(agent: Agent, scope: string, decisions: readonly Decision[]): void {
    if (!Object.hasOwn(this.config.scopes, scope)) {
      throw new HarnessError(`unknown decision scope: ${scope}`, 'DECISION_UNKNOWN_SCOPE')
    }
    const state = this.scope(agent, scope)
    if (!this.state(agent).corrupt.includes(scope)) {
      throw new HarnessError(`decision state for ${scope} is healthy; use record()`, 'DECISION_NOT_CORRUPT')
    }
    this.commit(agent, state, scope, state.active.map(decision => decision.decisionId), decisions)
  }

  private commit(
    agent: Agent,
    state: ScopeState,
    scope: string,
    supersedes: readonly string[],
    decisions: readonly Decision[],
  ): void {
    const known = new Set(state.active.map(decision => decision.decisionId))
    const unknown = supersedes.filter(decisionId => !known.has(decisionId))
    if (unknown.length > 0) {
      throw new HarnessError(`unknown decision ids: ${unknown.join(', ')}`, 'DECISION_INVALID_CHANGE')
    }
    const record: DecisionRecord = {
      scope,
      revision: state.revision + 1,
      active: replaceDecisions(state, supersedes, decisions),
    }
    const parsed = parseRecord(record)
    if (parsed === undefined) {
      throw new HarnessError('decision change does not fit the record schema', 'DECISION_INVALID_CHANGE')
    }
    const catalog = new Set(this.config.scopes[scope]?.units ?? [])
    const unknownUnit = parsed.active.flatMap(decision => decision.unitIds).find(unitId => !catalog.has(unitId))
    if (unknownUnit !== undefined) {
      throw new HarnessError(`decision change names unknown unit ${unknownUnit}`, 'DECISION_INVALID_CHANGE')
    }
    const folded = foldRecord(state, parsed)
    if (!folded.ok) throw new HarnessError(`decision change rejected: ${folded.reason}`, 'DECISION_INVALID_CHANGE')
    appendPluginRecord(agent.session, RECORD_TYPE, parsed)
  }

  /**
   * Effective decisions per scope.
   * @param agent - agent whose Session carries the records.
   * @returns the folded projection state.
   */
  state(agent: Agent): DecisionProjectionState {
    return this.projection.stateOf(agent.session)
  }

  /**
   * Render the bounded view of every configured scope.
   * @param agent - agent whose Session carries the records.
   * @returns one section per scope; empty when no scope is configured.
   */
  renderView(agent: Agent): string {
    const projection = this.state(agent)
    const sections: string[] = []
    for (const [scopeId, scope] of Object.entries(this.config.scopes)) {
      const state = this.scope(agent, scopeId)
      const corrupt = projection.corrupt.includes(scopeId) || projection.corrupt.includes(UNKNOWN_SCOPE)
      sections.push(`范围 ${scopeId}\n${renderView(state, scope.units, this.config.viewLimit, this.config.viewBudget, corrupt)}`)
    }
    return sections.join('\n\n')
  }

  /**
   * Effective decisions of one scope.
   * @param agent - agent whose Session carries the records.
   * @param scope - scope id.
   * @returns the scope state, empty before the first recorded decision.
   */
  scope(agent: Agent, scope: string): ScopeState {
    const scopes = this.state(agent).scopes
    return Object.hasOwn(scopes, scope) ? scopes[scope] ?? EMPTY_SCOPE : EMPTY_SCOPE
  }

  /**
   * Units the model may still submit.
   * @param agent - agent whose Session carries the records.
   * @param scope - scope id.
   * @returns the configured catalog minus decided units; empty for an unknown scope.
   */
  open(agent: Agent, scope: string): string[] {
    const configured = Object.hasOwn(this.config.scopes, scope) ? this.config.scopes[scope] : undefined
    return configured === undefined ? [] : openUnits(this.scope(agent, scope), configured.units)
  }
}

export default DecisionStateService
