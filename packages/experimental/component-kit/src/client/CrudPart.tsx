/**
 * The section a form page or an info card block draws: a line saying why the
 * component is not drawn yet, or the component under a line saying where its
 * content comes from while it has none.
 */
import type { ReactNode } from 'react'
import css from './crud-part.module.css'

/** One line a part draws above its component, or in its place. */
export interface PartLine {
  /** Why the line is drawn, which `data-part-line` carries. */
  readonly reason: string
  /** The line, translated. */
  readonly text: string
}

/** What one part block draws. */
export interface CrudPartProps {
  /** The catalog id the block names. */
  readonly componentId: string
  /** The block's node id. */
  readonly nodeId: string
  /** The line to draw, absent while the component has something to show. */
  readonly line?: PartLine | undefined
  /** The component, absent while it cannot be drawn. */
  readonly children?: ReactNode
}

/**
 * Draw one part block's section.
 * @param props - the block's identity, its line, and its component.
 * @returns the section.
 */
export function CrudPart({ componentId, nodeId, line, children }: CrudPartProps) {
  return (
    <section className={css.section} data-component-block={componentId} data-component-node={nodeId}>
      {line !== undefined && <p className={css.notice} data-part-line={line.reason}>{line.text}</p>}
      {children}
    </section>
  )
}
