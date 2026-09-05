/**
 * How one call's blocks are arranged: nested rows and columns, and nothing else.
 *
 * A spec may carry a `layout` beside its nodes. When it does not, the blocks
 * are stacked top to bottom in the order the call wrote them, which is what the
 * column has always done. When it does, the tree says which blocks sit beside
 * which — the one arrangement a model cannot express by ordering alone, and the
 * one a bound pair needs, because a record fed by a table above it is only
 * worth having while both are on screen at once.
 *
 * One primitive: a stack, with a direction, a gap, whether it wraps, and its
 * children. No grid, no tabs, no width. A grid belongs inside a component that
 * draws N of one thing; a tab strip is what the content column already is, one
 * entry per tab; and a width in a column whose own width is solved at runtime
 * is a number the model cannot know. What is left — `flex` on a child — is a
 * share of what there is rather than a size.
 *
 * The reading here is the wire edge's, and it is a second reading rather than
 * the judgement: the host judges the tree the model sent and names the path it
 * refused, in a sentence the model can act on. This one runs where there is
 * nobody to tell — over a payload from a persisted checkpoint another build
 * wrote. It is also a reading of its own because the pass that judges the
 * nodes runs over a subset of them, leaving out whichever are still waiting on
 * what feeds them, and a full tree handed to that pass would be refused for
 * placing a node the shortened list no longer has. What is arranged here is
 * every block, the waiting ones included, so a block waiting on what feeds it
 * holds its place instead of the stack closing over it. A tree this reading
 * cannot make sense of falls back to the plain stack rather than blanking the
 * entry: the arrangement is the part that can be wrong without anything being
 * lost. The vocabulary both readings accept — the directions, the gaps, the
 * ceilings, and the keys each node may carry — is `component-call.ts`'s.
 *
 * The tree this answers with carries the blocks themselves rather than their
 * ids, and is generic in what a block is, so the same reading covers the seat's
 * drawable blocks and a test's plain names.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/layout
 */

import {
  BLOCK_KEYS,
  LAYOUT_DIRECTIONS,
  LAYOUT_GAPS,
  MAX_FLEX,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  STACK_KEYS,
  type LayoutDirection,
  type LayoutGap,
} from '../component-call.ts'

/** Direction a spec that declares no layout is stacked in. */
const DEFAULT_DIRECTION: LayoutDirection = 'col'

/** Gap a stack that declares none leaves between its children. */
export const DEFAULT_GAP: LayoutGap = 'md'

/** One block in the arrangement. */
export interface BlockLeaf<B> {
  /** Discriminant. */
  readonly node: 'component'
  /** The block itself, already looked up. */
  readonly block: B
  /** Share of the stack's free space this block takes on top of its own size; a block that names none takes none of it. */
  readonly flex?: number
}

/** One row or column of the arrangement. */
export interface BlockStack<B> {
  /** Discriminant. */
  readonly node: 'stack'
  /** Which way it runs. */
  readonly dir: LayoutDirection
  /** How much space it leaves between its children. */
  readonly gap: LayoutGap
  /** Whether a row that does not fit wraps onto a second line. */
  readonly wrap: boolean
  /** Share of the stack above it this one takes; a stack that names none takes none of it, and the outermost has none to take. */
  readonly flex?: number
  /** What it holds, in order. */
  readonly children: readonly BlockChild<B>[]
}

/** What a stack holds: a block, or another stack. */
export type BlockChild<B> = BlockLeaf<B> | BlockStack<B>

/**
 * Read one value out of a closed set.
 * @param value - the declared value, however malformed.
 * @param accepted - the values this property may take.
 * @param fallback - what an absent property means; omitted for a property the host requires, which makes an absent one unreadable here too.
 * @returns the value, or `undefined` when this build cannot read the property.
 */
function readChoice<T extends string>(value: unknown, accepted: readonly T[], fallback?: T): T | undefined {
  if (value === undefined) return fallback
  return accepted.includes(value as T) ? value as T : undefined
}

/**
 * Read the share of the stack above it one child asks for.
 * @param value - the declared `flex`, however malformed.
 * @returns what to put on the child — the share, or nothing where it asked for none — or `undefined` when the
 *   value is not one this build can draw.
 */
function readFlex(value: unknown): { readonly flex?: number } | undefined {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FLEX) return undefined
  return { flex: value }
}

/**
 * Read one stack and everything under it, collecting the blocks it places.
 * @param value - the declared node, however malformed.
 * @param blocks - the blocks this entry draws, by id.
 * @param placed - ids already placed by an earlier part of the tree; grown here.
 * @param depth - stacks still available at this level.
 * @returns the stack, or `undefined` when it is not one this build can draw.
 */
function readStack<B>(
  value: unknown,
  blocks: ReadonlyMap<string, B>,
  placed: Set<string>,
  depth: number,
): BlockStack<B> | undefined {
  if (depth <= 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['node'] !== 'stack' || Object.keys(record).some(key => !STACK_KEYS.includes(key))) return undefined
  // The direction is the one property a stack must carry: the host requires it,
  // and a tree that leaves it out is a tree this reading does not understand
  // rather than one it fills in — the same answer it gives every other tree it
  // cannot make sense of.
  const dir = readChoice(record['dir'], LAYOUT_DIRECTIONS)
  const gap = readChoice(record['gap'], LAYOUT_GAPS, DEFAULT_GAP)
  const wrap = record['wrap'] === undefined ? false : record['wrap']
  const flex = readFlex(record['flex'])
  if (dir === undefined || gap === undefined || typeof wrap !== 'boolean' || flex === undefined) return undefined
  const declared = record['children']
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_LAYOUT_CHILDREN) return undefined
  const children: BlockChild<B>[] = []
  for (const child of declared as readonly unknown[]) {
    const read = readChild(child, blocks, placed, depth)
    if (read === undefined) return undefined
    children.push(read)
  }
  return { node: 'stack', dir, gap, wrap, ...flex, children }
}

/**
 * Read one child of a stack: another stack, or a block.
 * @param value - the declared child, however malformed.
 * @param blocks - the blocks this entry draws, by id.
 * @param placed - ids already placed by an earlier part of the tree; grown here.
 * @param depth - stacks still available at the parent's level.
 * @returns the child, or `undefined` when it is not one this build can draw.
 */
function readChild<B>(
  value: unknown,
  blocks: ReadonlyMap<string, B>,
  placed: Set<string>,
  depth: number,
): BlockChild<B> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record['node'] !== 'component') return readStack(value, blocks, placed, depth - 1)
  if (Object.keys(record).some(key => !BLOCK_KEYS.includes(key))) return undefined
  const id = record['id']
  if (typeof id !== 'string') return undefined
  const block = blocks.get(id)
  // Placed twice, or naming a block this entry does not draw: either way the
  // tree is not an arrangement of these blocks, and there is no partial reading
  // of it worth showing.
  if (block === undefined || placed.has(id)) return undefined
  placed.add(id)
  const flex = readFlex(record['flex'])
  if (flex === undefined) return undefined
  return { node: 'component', block, ...flex }
}

/**
 * The arrangement a spec that declares none gets: one column, in call order.
 * @param blocks - the blocks this entry draws, by id.
 * @returns the stack.
 */
function stackedInOrder<B>(blocks: ReadonlyMap<string, B>): BlockStack<B> {
  return {
    node: 'stack',
    dir: DEFAULT_DIRECTION,
    gap: DEFAULT_GAP,
    wrap: false,
    children: [...blocks.values()].map(block => ({ node: 'component', block } as const)),
  }
}

/**
 * Read the arrangement one entry's blocks are drawn in.
 * @param value - the spec's `layout`, however malformed; absent for a call that declared none.
 * @param blocks - the blocks this entry draws, by id, in the order the call wrote them.
 * @returns the declared arrangement when it places every one of those blocks exactly once, and the plain column otherwise.
 */
export function readLayout<B>(value: unknown, blocks: ReadonlyMap<string, B>): BlockStack<B> {
  if (value === undefined) return stackedInOrder(blocks)
  const placed = new Set<string>()
  const stack = readStack(value, blocks, placed, MAX_LAYOUT_DEPTH)
  // A `flex` on the outermost stack is a share of a stack that is not there.
  // The host refuses that tree by name; here there is nobody to tell, so it is
  // a tree this reading does not understand — the answer every other one gets.
  if (stack === undefined || stack.flex !== undefined || placed.size !== blocks.size) return stackedInOrder(blocks)
  return stack
}
