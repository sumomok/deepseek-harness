/**
 * Host-side decision recorder.
 *
 * The host queues a decision when it observes one (an accepted proposal, an
 * external receipt); the recorder turns the queue into durable ledger messages
 * on the next pre-step and exposes the effective state through the projection.
 *
 * @module @deepseek-ai/dsh-decision-state/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { applyEntryToProjection, decisionStateProjection, type DecisionProjectionState } from './projection.ts'
import { EMPTY_SCOPE } from './state.ts'
import { Config, createProposeOpenWorkTool } from './tool.ts'
import type { Decision, LedgerEntry, ScopeState } from './types.ts'

/** One queued state change; the recorder assigns the revision when it flushes. */
export interface DecisionChange {
  readonly scope: string
  /** Decisions established by this change. */
  readonly decisions: readonly Decision[]
  /** Decision ids this change replaces. */
  readonly supersedes: readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    decisionState: DecisionStateService
  }
}

/**
 * Turn one queued change into the next ledger entry.
 * @param state - effective state of the scope before the change.
 * @param change - queued change.
 * @returns the entry with the next revision.
 */
export function nextEntry(state: ScopeState, change: DecisionChange): LedgerEntry {
  return {
    kind: 'decide',
    scope: change.scope,
    revision: state.revision + 1,
    decisions: change.decisions,
    supersedes: change.supersedes,
  }
}

/** Records decisions for one agent and exposes the folded state. */
export class DecisionStateService extends Service {
  static inject = ['sessionProjections', 'tools']
  static Config = Config

  private projection!: ProjectionHandle<DecisionProjectionState>
  private readonly pending = new Map<Agent, DecisionChange[]>()

  /**
   * @param ctx - owning plugin context.
   * @param config - configured scopes; direct composition without a config gets the schema defaults.
   */
  constructor(ctx: Context, private readonly config: Config = Config.parse({})) {
    super(ctx, 'decisionState')
  }

  protected async [Service.init](): Promise<void> {
    this.projection = await this.ctx.sessionProjections.register(decisionStateProjection)
    this.ctx.tools.register(createProposeOpenWorkTool(this, this.config))
    this.ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const changes = this.pending.get(agent)
      if (changes === undefined || changes.length === 0) return decision
      this.pending.delete(agent)
      let state = this.state(agent)
      const messages = changes.map((change) => {
        const scopeState = state.scopes[change.scope] ?? EMPTY_SCOPE
        const entry = nextEntry(scopeState, change)
        state = applyEntryToProjection(state, entry)
        return createUserMessage({
          source: { kind: 'decision-state', scope: change.scope, revision: entry.revision },
          content: [{ type: 'text', text: JSON.stringify(entry) }],
        })
      })
      return { ...decision, messages: [...decision.messages, ...messages] }
    }, { prepend: true })
  }

  /**
   * Queue a decision change; it becomes durable on the agent's next pre-step.
   * @param agent - agent whose Session records the change.
   * @param change - decisions to establish and ids to supersede.
   */
  record(agent: Agent, change: DecisionChange): void {
    const queue = this.pending.get(agent) ?? []
    queue.push(change)
    this.pending.set(agent, queue)
  }

  /**
   * Effective decisions per scope.
   * @param agent - agent whose Session carries the ledger.
   * @returns the folded projection state.
   */
  state(agent: Agent): DecisionProjectionState {
    return this.projection.stateOf(agent.session)
  }

  /**
   * Effective decisions of one scope.
   * @param agent - agent whose Session carries the ledger.
   * @param scope - scope id.
   * @returns the scope state, empty before the first recorded decision.
   */
  scope(agent: Agent, scope: string): ScopeState {
    return this.state(agent).scopes[scope] ?? EMPTY_SCOPE
  }
}

export default DecisionStateService
