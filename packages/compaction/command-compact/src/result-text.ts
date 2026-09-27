/**
 * The fixed English result texts of `/compact`, recorded in its
 * `command/done`. A cordis-free leaf so a client can recognize and localize
 * them. Success with a count is composed per result and is not listed.
 * @module @deepseek-ai/dsh-command-compact/result-text
 */

/** Every fixed `/compact` result text, keyed by failure code or outcome. */
export const COMPACT_RESULT_TEXT = {
  usage: 'Usage: /compact (no arguments)',
  empty: 'No compactable history yet.',
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
  summary: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.',
  commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
} as const

/** A key of {@link COMPACT_RESULT_TEXT}. */
export type CompactResultTextKey = keyof typeof COMPACT_RESULT_TEXT
