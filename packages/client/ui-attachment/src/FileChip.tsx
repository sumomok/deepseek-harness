/** Draft text-file chip row: glyph + name + size, per-item remove — the
 * file-kind counterpart of AttachmentRail's image thumbnails, rendered
 * beside them rather than inside the same fixed-square item shape (a file
 * has nothing to thumbnail). */

import clsx from 'clsx'
import { IconCloseFill14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './FileChip.module.css'

/** One rail chip; strings arrive resolved (zero-cordis atom). */
export interface FileChipItem {
  /** Stable identity for the React key. */
  id: string
  /** Display file name. */
  name: string
  /** Display-ready byte-size text. */
  size: string
  /** Accessible label of the item's remove control. */
  removeLabel: string
  /**
   * Whether this draft's name/path matched the pre-send secret-container
   * heuristic (name/path only — never a content read). Renders a color-dot,
   * outline warning, and the row's `warningLabel` on this chip; never a
   * popup, and never on its own the reason the user cannot proceed — the
   * send-time confirmation gate is a separate surface.
   */
  warning?: boolean
}

/** Fixed copy for every warning chip's inline label — identical across
 * items, so it is resolved once per row rather than per chip. */
export interface FileChipWarningLabel {
  /** Short inline text rendered after the name on a warning chip. */
  text: string
  /** Tooltip explaining the label without implying a content read. */
  title: string
}

/** Below-row notice shown once while at least one chip in the row warns. */
export interface FileChipWarningNotice {
  /** Notice line naming the first matched file. */
  text: string
  /** Visible text of the trailing remove control. */
  removeButtonText: string
  /** Accessible label of the trailing remove control. */
  removeLabel: string
  /** Remove the first matched file's draft attachment. */
  onRemove: () => void
}

/** 14px inline document glyph: no existing `ui-primitives` icon fits a plain file. */
function DocumentGlyph({ className }: { className?: string | undefined }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3.5 1.5H8.0625L10.5 3.9375V12.5H3.5V1.5Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M8.0625 1.5V3.9375H10.5" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Row of pending text-file draft chips. No open affordance of its own: a
 * sent file's default open action is the referent/open seam's inline
 * expand/collapse viewer, not a draft-time preview — draft chips only name
 * and remove. The owner decides mounting (renders this only while items
 * exist), matching AttachmentRail.
 * @param props.items - resolved chips in draft order.
 * @param props.groupLabel - accessible name of the chip row group.
 * @param props.onRemove - remove one item from the draft.
 * @param props.warningLabel - fixed copy shown on every warning chip; omitted renders no inline label.
 * @param props.warningNotice - below-row notice while at least one chip warns; omitted renders no notice.
 * @returns the chip row and, while a chip warns, the notice line beneath it.
 */
export function FileChipRow<T extends FileChipItem>({
  items, groupLabel, onRemove, warningLabel, warningNotice,
}: {
  items: readonly T[]
  groupLabel: string
  onRemove: (item: T) => void
  warningLabel?: FileChipWarningLabel | undefined
  warningNotice?: FileChipWarningNotice | undefined
}) {
  return (
    <>
      <div className={css.row} role="group" aria-label={groupLabel}>
        {items.map(item => (
          <div
            key={item.id}
            className={clsx(css.chip, item.warning === true && css.chipWarning)}
            data-secret-warning={item.warning === true || undefined}
          >
            {item.warning === true && <StateDot state="warning" size={8} className={css.warningDot} />}
            <DocumentGlyph className={css.glyph} />
            <span className={css.name} title={item.name}>{item.name}</span>
            {item.warning === true && warningLabel !== undefined && (
              <span className={css.chipLabel} title={warningLabel.title}>{warningLabel.text}</span>
            )}
            <span className={css.size}>{item.size}</span>
            <button
              type="button"
              className={css.remove}
              aria-label={item.removeLabel}
              onClick={() => { onRemove(item) }}
            >
              <IconCloseFill14 size={12} />
            </button>
          </div>
        ))}
      </div>
      {warningNotice !== undefined && (
        <div className={css.notice}>
          <StateDot state="warning" size={8} />
          <span className={css.noticeText}>{warningNotice.text}</span>
          <button
            type="button"
            className={css.noticeRemove}
            aria-label={warningNotice.removeLabel}
            onClick={warningNotice.onRemove}
          >
            {warningNotice.removeButtonText}
          </button>
        </div>
      )}
    </>
  )
}
