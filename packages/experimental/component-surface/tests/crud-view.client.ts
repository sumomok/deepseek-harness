/**
 * The view a deployment writes to edit one table, as the specs judging it share
 * it: the table's data page opened writable with its own two forms and its own
 * card left out, the form page its add and modify buttons open, and the info
 * card its names open, side by side in one row.
 * @module @deepseek-ai/dsh-experimental-component-surface/tests/crud-view
 */

import { DATA_PAGE_ID, FORM_PAGE_ID, INFO_CARD_ID } from '../src/component-call.ts'

/** One block of a view, as the view's writer wrote it. */
export interface WrittenNode {
  /** The block's id within the view. */
  readonly id: string
  /** The catalog id of its component. */
  readonly component: string
  /** Its properties, bindings still written as `{"$from": …}`. */
  readonly props: Readonly<Record<string, unknown>>
}

/** One view's spec: its blocks, and one row placing them in the order written. */
export interface WrittenSpec {
  /** The blocks. */
  readonly nodes: readonly WrittenNode[]
  /** One row naming every block once. */
  readonly layout: {
    readonly node: 'stack'
    readonly dir: 'row'
    readonly children: readonly { readonly node: 'component'; readonly id: string }[]
  }
}

/** The data page on `SpaceLayer`, writable, drawing neither of its own forms nor its own card. */
export const CRUD_PAGE: WrittenNode = {
  id: 'page',
  component: DATA_PAGE_ID,
  props: {
    relatedMeta: 'SpaceLayer',
    metaLabel: '空间图层',
    readOnly: false,
    regions: { addForm: false, modifyForm: false, infoCard: false },
  },
}

/** The form page on {@link CRUD_PAGE}'s table, reading what that page's add and modify buttons are editing. */
export const CRUD_FORM: WrittenNode = {
  id: 'form',
  component: FORM_PAGE_ID,
  props: { relatedMeta: 'SpaceLayer', request: { $from: 'node:page.editing' } },
}

/** The info card reading the record {@link CRUD_PAGE} opened. */
export const CRUD_CARD: WrittenNode = { id: 'card', component: INFO_CARD_ID, props: { record: { $from: 'node:page.opened' } } }

/**
 * Lay blocks side by side in one row, in the order given.
 * @param nodes - the blocks.
 * @returns the spec placing exactly those blocks.
 */
export function crudSpec(...nodes: readonly WrittenNode[]): WrittenSpec {
  return { nodes, layout: { node: 'stack', dir: 'row', children: nodes.map(node => ({ node: 'component', id: node.id })) } }
}

/**
 * One block with some of its properties written differently.
 * @param node - the block.
 * @param props - the properties to write over the block's own; one set to `undefined` is left out.
 * @returns the same block carrying those properties.
 */
export function rewritten(node: WrittenNode, props: Readonly<Record<string, unknown>>): WrittenNode {
  const merged = Object.entries({ ...node.props, ...props }).filter(([, value]) => value !== undefined)
  return { ...node, props: Object.fromEntries(merged) }
}

/** The three blocks wired the way the page's own buttons, names and card regions require. */
export const CRUD_VIEW: WrittenSpec = crudSpec(CRUD_PAGE, CRUD_FORM, CRUD_CARD)
