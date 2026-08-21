/**
 * The content column's empty state. It is a fallback body passed at the
 * `content` renderSlot site rather than a low-priority registration, so it
 * disappears the moment a plugin claims the seat and never competes for it.
 * Pure presentation: both strings are resolved by the frame from its locale
 * seat.
 */
import css from './ContentPlaceholder.module.css'

/** Copy the frame resolved for the empty content column. */
export interface ContentPlaceholderProps {
  /** Headline naming the empty column. */
  title: string
  /** One line saying which slot fills it. */
  hint: string
}

/**
 * Render the content column's empty state.
 * @param props - the resolved copy.
 * @returns the centered placeholder body.
 */
export function ContentPlaceholder({ title, hint }: ContentPlaceholderProps) {
  return (
    <div className={css.placeholder} data-content-placeholder>
      <p className={css.title}>{title}</p>
      <p className={css.hint}>{hint}</p>
    </div>
  )
}
