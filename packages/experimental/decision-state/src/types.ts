/**
 * Durable decision types.
 *
 * A decision is a versioned statement about a scope's units: which units it
 * covers, what happens to them, and which earlier decisions it replaces.
 * Decisions reach the log as one `user/message` ledger entry per revision, so
 * every model-visible view stays reconstructable from the Session log.
 *
 * @module @deepseek-ai/dsh-decision-state/types
 */

import type {} from '@deepseek-ai/dsh-llm'

/** Disposition a submission may assign to one open unit. */
export const DISPOSITIONS = ['new', 'existing', 'unchanged', 'defer', 'exclude'] as const

/** One of {@link DISPOSITIONS}. */
export type Disposition = (typeof DISPOSITIONS)[number]

/** A recorded decision about the units it names. */
export interface Decision {
  /** Stable id within the scope; later entries supersede it by id. */
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

/** One durable ledger entry appended by the host. */
export interface LedgerEntry {
  readonly kind: 'decide'
  readonly scope: string
  /** Monotonic revision; the next entry uses `previous + 1`. */
  readonly revision: number
  /** Decisions established by this revision. */
  readonly decisions: readonly Decision[]
  /** Decision ids this revision replaces. */
  readonly supersedes: readonly string[]
}

/** Effective decisions of one scope. */
export interface ScopeState {
  readonly revision: number
  readonly active: readonly Decision[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Decision ledger entry; readers without this plugin keep the recorded text. */
    'decision-state': {
      readonly kind: 'decision-state'
      /** Scope the entry settles. */
      readonly scope: string
      /** Revision this message carries. */
      readonly revision: number
    }
  }
}
