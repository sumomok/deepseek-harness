// The marker stays at the checkpoint position and opens the associated summary.

import { memo, useEffect, useRef, useState } from 'react'
import {
  IconApiOutlineRegular,
  IconChevronRightOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import a11yCss from './accessibility.module.css'
import css from './MessageItem.module.css'

/** Session-bound checkpoint navigation for manual and automatic compaction rows. */
export interface CompactionRowInjected {
  hooks: { compactionPreview: ObservableSnapshot<boolean> }
  openCompaction: (seq: number, signal: AbortSignal) => Promise<string | null>
}

interface CompactionItemProps {
  /** Landed checkpoint marker, or null while the bracket is still open. */
  node: CompactionSummaryNode | null
  openCompaction?: CompactionRowInjected['openCompaction'] | undefined
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Renders the model-history compaction marker. An open bracket reads as the
 * running title alone: it has no counts to state and no summary to open.
 * @param props - the marker node off the snapshot cache (or null while running) and the Sidebar opener.
 * @returns the marker row; disabled while running or while no Sidebar tab type opens checkpoints.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  openCompaction,
  title,
  fallbackSummary,
  t,
}: CompactionItemProps) {
  const summarySeq = node?.summaryEventSeq ?? null
  const available = node !== null && openCompaction !== undefined && summarySeq !== null
  const pending = useRef<AbortController | null>(null)
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    pending.current = null
    setOpening(false)
    setFailure(null)
    return () => { pending.current?.abort() }
  }, [node?.seq, summarySeq, openCompaction])
  const open = async (): Promise<void> => {
    if (!available || pending.current !== null) return
    const controller = new AbortController()
    pending.current = controller
    setOpening(true)
    setFailure(null)
    try {
      const result = await openCompaction(summarySeq, controller.signal)
      if (!controller.signal.aborted) setFailure(result)
    } catch (error) {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      if (pending.current === controller) pending.current = null
      if (!controller.signal.aborted) setOpening(false)
    }
  }
  const titleText = title
    ?? (node === null ? t('message.compaction.running') : t('message.compaction'))
  const summary = node === null
    ? null
    : node.shadowedItemCount !== null && node.shadowedTokenCount !== null
      ? t('message.compaction.completed', {
        items: node.shadowedItemCount,
        tokens: node.shadowedTokenCount,
      })
      : fallbackSummary ?? t('message.compaction.landed')
  const action = t('message.compaction.open')
  return (
    <div className={css.compactionRow}>
      {node === null && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <Tooltip label={action} side="top" portal delayMs={200} disabled={!available}>
        <button
          type="button"
          className={css.compactionButton}
          disabled={!available || opening}
          aria-busy={opening}
          {...node === null ? {} : { 'data-compaction-seq': node.seq }}
          onClick={() => { void open() }}
        >
          <span className={css.compactionLeading} aria-hidden>
            <span className={css.compactionContextIcon} data-compaction-icon="context">
              <IconApiOutlineRegular />
            </span>
            <span className={css.compactionOpenIcon} data-compaction-icon="open">
              <IconChevronRightOutlineRegular />
            </span>
          </span>
          <span className={css.compactionTitle}>{titleText}</span>
          {summary !== null && (
            <>
              <span className={css.compactionSep} aria-hidden />
              <span className={css.compactionSummary}>{summary}</span>
            </>
          )}
          {available && <span className={a11yCss.visuallyHidden}>{action}</span>}
        </button>
      </Tooltip>
      {failure !== null && <p role="alert">{failure}</p>}
    </div>
  )
})
