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
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { decisionStateProjection, RECORD_TYPE, UNKNOWN_SCOPE, type DecisionProjectionState } from './projection.ts'
import { EMPTY_SCOPE, foldRecord, openUnits, replaceDecisions } from './state.ts'
import { MAX_LISTED_OPEN_UNITS, renderView } from './validate.ts'
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
    const folded = foldRecord(state, record)
    if (!folded.ok) throw new HarnessError(`decision change rejected: ${folded.reason}`, 'DECISION_INVALID_CHANGE')
    appendPluginRecord(agent.session, RECORD_TYPE, record)
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
