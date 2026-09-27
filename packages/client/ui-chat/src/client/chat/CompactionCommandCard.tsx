// Only a structured checkpoint uses the compaction marker; all other outcomes
// retain the command's complete settlement text, localized when it is one of
// the Host command's fixed texts.

import type { ChatViewSlotProps, CommandRowOwnerProps } from '../contract/slots.ts'
import { localizedOutcome } from './compact-result.ts'
import { CompactionItem } from './CompactionItem.tsx'
import { GenericCommandCard } from './GenericCommandCard.tsx'

interface CompactionCommandCardProps extends CommandRowOwnerProps {
  t: ChatViewSlotProps['t']
  /** The request waits for a running turn and has not started compacting. */
  waiting?: boolean
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
