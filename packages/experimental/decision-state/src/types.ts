/**
 * Durable decision types.
 *
 * A decision settles units of one scope. Each committed record carries the
 * complete scope state after the change, so replay never has to merge deltas.
 * Records are experimental plugin records: they stay out of the model-visible
 * surface, survive fork and resume, and their owner validates them on restore.
 *
 * @module @deepseek-ai/dsh-decision-state/types
 */

/** Disposition a submission may assign to one open unit. */
export const DISPOSITIONS = ['new', 'existing', 'unchanged', 'defer', 'exclude'] as const

/** One of {@link DISPOSITIONS}. */
export type Disposition = (typeof DISPOSITIONS)[number]

/** A recorded decision about the units it names. */
export interface Decision {
  /** Stable id within the scope; later records replace it by id. */
  readonly decisionId: string
  /** Units this decision settles. */
  readonly unitIds: readonly string[]
  /** What happens to those units. */
  readonly disposition: Disposition
  /** Target objects for `existing`/`unchanged` decisions. */
  readonly targetIds: readonly string[]
  /** Session events that justify the decision. */
  readonly sourceEventSeqs: readonly number[]
}

/** One committed record: the complete effective state of a scope. */
export interface DecisionRecord {
  readonly scope: string
  /** Monotonic revision; the next record uses `previous + 1`. */
  readonly revision: number
  /** Every decision that remains effective after this revision. */
  readonly active: readonly Decision[]
}

/** Effective decisions of one scope. */
export interface ScopeState {
  readonly revision: number
  readonly active: readonly Decision[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Complete effective decisions of one scope after one host change. */
    'plugin:decision-state/record': DecisionRecord
  }
}
