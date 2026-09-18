// A compaction marker does not replace shadowed transcript rows. It is
// expandable only when the current window includes its cited summary.

import { memo, useMemo, useState } from 'react'
import {
  IconApiOutline14,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import a11yCss from './accessibility.module.css'
import css from './MessageItem.module.css'

interface CompactionItemProps {
  /** Landed checkpoint marker, or null while the bracket is still open. */
  node: CompactionSummaryNode | null
  /** Optional command title for a manual compaction folded into this marker. */
  title?: string
  /** Command settlement text used when structured compaction counts are unavailable. */
  fallbackSummary?: string | null
  /** The owning view's locale seat. */
  t: ChatViewSlotProps['t']
}

/**
 * Renders the model-history compaction marker. An open bracket reads as the
 * running title alone: it has no counts to state and no summary to disclose.
 * @param props - the marker node off the snapshot cache, or null while running.
 * @returns the marker row, with the summary disclosure when one is available.
 */
export const CompactionItem = memo(function CompactionItem({
  node,
  title,
  fallbackSummary,
  t,
}: CompactionItemProps) {
  const [expanded, setExpanded] = useState(false)
  const labels = useMemo(() => markdownLabels(t), [t])
  const summaryText = node?.summary ?? null
  const expandable = summaryText !== null
  const open = expandable && expanded
  const titleText = title
    ?? (node === null ? t('message.compaction.running') : t('message.compaction'))
  const summary = node === null
    ? null
    : node.shadowedItemCount !== null && node.shadowedTokenCount !== null
      ? t('message.compaction.completed', {
        items: node.shadowedItemCount,
        tokens: node.shadowedTokenCount,
      })
      : fallbackSummary
        ?? (expandable ? t('message.compaction.expand') : t('message.compaction.unavailable'))
  return (
    <div className={css.compactionRow}>
      {node === null && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <button
        type="button"
        className={css.compactionButton}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => { setExpanded(value => !value) }}
      >
        <span className={css.compactionLeading} aria-hidden>
          <span className={css.compactionContextIcon} data-compaction-icon="context">
            <IconApiOutline14 />
          </span>
          <span
            className={css.compactionDisclosureIcon}
            data-compaction-disclosure={open ? 'expanded' : 'collapsed'}
          >
            {open ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
          </span>
        </span>
        <span className={css.compactionTitle}>{titleText}</span>
        {summary !== null && (
          <>
            <span className={css.compactionSep} aria-hidden />
            <span className={css.compactionSummary}>{summary}</span>
          </>
        )}
      </button>
      {open && <div className={css.compactionBody}><MarkdownText text={summaryText} labels={labels} /></div>}
    </div>
  )
})
