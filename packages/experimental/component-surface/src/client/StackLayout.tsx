/**
 * Draw one arrangement: nested flex rows and columns, with the blocks in them.
 *
 * The component knows nothing about blocks. It is handed a tree whose leaves
 * already carry whatever a block is and a function that draws one, so the same
 * arrangement covers the seat's validated blocks, the waiting lines it draws in
 * place of some of them, and a test's plain names.
 *
 * This lives here rather than in the component row because the row declares no
 * slot and knows no layout: which components exist is the row's fact, and where
 * a block goes is the placement package's.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/StackLayout
 */
import type { ReactNode } from 'react'
import type { BlockChild, BlockStack } from './layout.ts'
import css from './StackLayout.module.css'

/** What {@link StackLayout} draws. */
export interface StackLayoutProps<B> {
  /** The arrangement. */
  readonly layout: BlockStack<B>
  /** How one block is drawn. */
  readonly renderBlock: (block: B) => ReactNode
}

/**
 * Draw one child of a stack.
 * @param child - the child, of either kind: both ask for their share of the row the same way.
 * @param renderBlock - how one block is drawn.
 * @returns the block or the nested stack, inside the flex cell its share applies to.
 */
function StackChild<B>({ child, renderBlock }: { readonly child: BlockChild<B>; readonly renderBlock: (block: B) => ReactNode }) {
  return (
    <div className={css.item} style={child.flex === undefined ? undefined : { flexGrow: child.flex }}>
      {child.node === 'component'
        ? renderBlock(child.block)
        : <StackLayout layout={child} renderBlock={renderBlock} />}
    </div>
  )
}

/**
 * Draw one stack and everything under it.
 * @param props - the arrangement and how one block is drawn.
 * @returns the flex container and its children.
 */
export function StackLayout<B>({ layout, renderBlock }: StackLayoutProps<B>) {
  return (
    <div
      className={css.stack}
      data-component-stack={layout.dir}
      data-component-gap={layout.gap}
      data-component-wrap={layout.wrap ? 'wrap' : undefined}
    >
      {layout.children.map((child, index) => (
        // The position in the tree, which is what stays put: the arrangement
        // only changes when the call behind it does, and every block inside
        // carries its own identity, so a redraw reuses the cell a block sits in
        // rather than rebuilding the subtree the user is working in.
        <StackChild key={index} child={child} renderBlock={renderBlock} />
      ))}
    </div>
  )
}
