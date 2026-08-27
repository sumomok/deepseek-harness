/** Draft text-file chip row: name + size, per-item remove — the file-kind
 * counterpart of AttachmentRail's image thumbnails, rendered beside them
 * rather than inside the same fixed-square item shape (a file has nothing
 * to thumbnail). */

import { IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
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
 * @returns the chip row.
 */
export function FileChipRow<T extends FileChipItem>({ items, groupLabel, onRemove }: {
  items: readonly T[]
  groupLabel: string
  onRemove: (item: T) => void
}) {
  return (
    <div className={css.row} role="group" aria-label={groupLabel}>
      {items.map(item => (
        <div key={item.id} className={css.chip}>
          <span className={css.name} title={item.name}>{item.name}</span>
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
  )
}
