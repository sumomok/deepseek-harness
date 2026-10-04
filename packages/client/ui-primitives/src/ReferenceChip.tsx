// ReferenceChip: one prompt reference shown by its label alone, with the same
// face in the composer attachment row, submission echoes, sent bubbles, and
// queue rows. The label is the only reference field any of those surfaces reads.

import clsx from 'clsx'
import { IconCloseOutlineRegular } from './icons/index.tsx'
import css from './ReferenceChip.module.css'

/**
 * Render one reference chip.
 * @param props.label - the reference label; also the hover title.
 * @param props.onActivate - optional chip action; the label becomes a button when present.
 * @param props.remove - optional in-chip remove button and its accessible name.
 * @param props.className - extra class for layout placement.
 * @returns the chip element.
 */
export function ReferenceChip({ label, onActivate, remove, className }: {
  label: string
  onActivate?: (() => void) | undefined
  remove?: { readonly label: string; readonly onRemove: () => void } | undefined
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
}) {
  return (
    <span className={clsx(css.chip, className)} title={label} data-reference-chip="">
      {onActivate === undefined
        ? <span className={css.label}>{label}</span>
        : <button type="button" className={clsx(css.label, css.activate)} onClick={onActivate}>{label}</button>}
      {remove !== undefined && (
        <button type="button" className={css.remove} aria-label={remove.label} onClick={remove.onRemove}>
          <IconCloseOutlineRegular size={12} />
        </button>
      )}
    </span>
  )
}

/**
 * Read reference labels from a message source. Sources are wire data, so any
 * value other than an array of objects with a string `label` yields no chip.
 * @param source - a user message source, or any other value.
 * @returns labels in reference order; empty when the source carries none.
 */
export function referenceLabelsOf(source: unknown): string[] {
  if (typeof source !== 'object' || source === null) return []
  const references = (source as { references?: unknown }).references
  if (!Array.isArray(references)) return []
  const labels: string[] = []
  for (const reference of references as unknown[]) {
    const label = typeof reference === 'object' && reference !== null
      ? (reference as { label?: unknown }).label
      : undefined
    if (typeof label === 'string') labels.push(label)
  }
  return labels
}
