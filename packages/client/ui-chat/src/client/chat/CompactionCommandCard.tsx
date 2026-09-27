// Only a structured checkpoint uses the compaction marker; all other outcomes
// retain the command's complete settlement text, localized when it is one of
// the Host command's fixed texts.

import type { COMPACT_RESULT_TEXT, CompactResultTextKey } from '@deepseek-ai/dsh-command-compact/result-text'
import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import type { ChatKey } from '../locale.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  /** The request waits for a running turn and has not started compacting. */
  waiting?: boolean
}

// Restated because the client bundle cannot import the Host command's values;
// `satisfies` fails the build when a Host text changes.
const HOST_RESULT_TEXT = {
  usage: 'Usage: /compact (no arguments)',
  empty: 'No compactable history yet.',
  busy: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  cancelled: 'Compaction cancelled.',
  changed: 'The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.',
  summary: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.',
  commit: 'Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.',
  persistence: 'Compaction finished, but the session could not be saved.',
} as const satisfies typeof COMPACT_RESULT_TEXT

const RESULT_KEYS: Readonly<Record<CompactResultTextKey, ChatKey>> = {
  usage: 'message.compaction.result.usage',
  empty: 'message.compaction.result.empty',
  busy: 'message.compaction.result.busy',
  cancelled: 'message.compaction.result.cancelled',
  changed: 'message.compaction.result.changed',
  summary: 'message.compaction.result.summary',
  commit: 'message.compaction.result.commit',
  persistence: 'message.compaction.result.persistence',
}

const RESULT_KEY_BY_TEXT: ReadonlyMap<string, ChatKey> = new Map(
  (Object.keys(RESULT_KEYS) as CompactResultTextKey[])
    .map((key): [string, ChatKey] => [HOST_RESULT_TEXT[key], RESULT_KEYS[key]]),
)

/**
 * Replace a fixed `/compact` result text with its localized counterpart.
 * @param node - a settled command.
 * @param t - Chat locale lookup.
 * @returns the command, with a recognized outcome text localized.
 */
function localizedOutcome(node: CommandRowOwnerProps['node'], t: ChatViewSlotProps['t']): CommandRowOwnerProps['node'] {
  const outcome = node.outcome
  if (outcome?.text === undefined) return node
  const key = RESULT_KEY_BY_TEXT.get(outcome.text)
  return key === undefined ? node : { ...node, outcome: { ...outcome, text: t(key) } }
}

/** Render one manual compaction lifecycle without duplicating its checkpoint marker. */
export function CompactionCommandCard({ node, compaction, waiting = false, t }: CompactionCommandCardProps) {
  if (compaction !== undefined) {
    return (
      <CompactionItem
        node={compaction}
        title={t('message.compaction.commandTitle')}
        fallbackSummary={node.outcome?.text ?? null}
        t={t}
      />
    )
  }
  if (node.outcome !== null) return <GenericCommandCard node={localizedOutcome(node, t)} t={t} />
  return (
    <GenericCommandCard
      node={node}
      t={t}
      runningSummary={t(waiting ? 'message.compaction.waiting' : 'message.compaction.running')}
    />
  )
}
