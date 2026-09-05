/**
 * What one entry's payload becomes on the page: the blocks to draw, each with
 * its bindings already standing at whatever the blocks beside it have
 * published, and the arrangement to draw them in.
 *
 * The judgement is still `validate.ts`'s, and there is exactly one pass of it
 * per reading — a spec whose properties this build does not accept is a block
 * the seat refuses to draw, wherever the value came from. What is added here is
 * the one thing validation cannot do on its own: a bound property has no value
 * in the document at all, so the reference is replaced by what the source block
 * has published *before* the document is judged, and the block whose required
 * property has nothing to stand for it yet is left out of the judgement rather
 * than failing it.
 *
 * A resolved value is not a value any host judged. It came out of a component
 * in the page, and the host only checked that the output could stand where the
 * property is declared, never what it would carry. So a value that does not fit
 * — more rows ticked than the record block accepts, a table grown past the byte
 * ceiling by what was tacked onto it — refuses the document, and the reading
 * answers by leaving the fed blocks waiting rather than by blanking an entry
 * whose unfed blocks are perfectly drawable.
 *
 * Nothing here is written anywhere. The resolved values live for one render of
 * one page: they never enter the payload, never reach the host, and never reach
 * the session log, which is what keeps `Model-visible ⟺ logged` true of a spec
 * whose record block is fed by the table above it.
 * @module @deepseek-ai/dsh-experimental-component-surface/client/spec
 */

import {
  catalogEntry,
  MAX_NODES,
  type ComponentNode,
  type ComponentSurfacePayload,
} from '../component-call.ts'
import { validateComponentSpec } from '../validate.ts'
import { resolveBindings, type OutputValues } from './bindings.ts'
import { readLayout, type BlockStack } from './layout.ts'

/** One block of an entry, as the seat draws it. */
export interface SurfaceBlock {
  /** The block's identity within its call. */
  readonly id: string
  /**
   * The validated block; `undefined` while a property the component requires is
   * bound to an output nothing has published yet, which is what the seat draws
   * the waiting line for.
   */
  readonly node: ComponentNode | undefined
  /** What this block's bindings resolved to, as {@link resolveBindings} keys them; `undefined` for a block carrying none. */
  readonly bindingKey: string | undefined
}

/** One entry's whole reading: its blocks, and how they are arranged. */
export interface SurfaceView {
  /** The blocks, in the order the call wrote them. */
  readonly blocks: readonly SurfaceBlock[]
  /** Where each of them goes. */
  readonly layout: BlockStack<SurfaceBlock>
}

/** One node as the payload carries it, before anything has judged it. */
interface RawNode {
  /** The `id` property, which the seat needs before validation to key outputs by. */
  readonly id: string
  /** The `component` property, which it needs to know which properties are required. */
  readonly component: string
  /** The `props` property, bindings included. */
  readonly props: Readonly<Record<string, unknown>>
  /** The node object itself, so validation judges every property the call wrote rather than the three read here. */
  readonly record: Readonly<Record<string, unknown>>
}

/** One spec document as the payload carries it. */
interface SpecDocument {
  /** Its nodes. */
  readonly nodes: readonly RawNode[]
  /** Everything the document carries besides its nodes and its layout, kept so validation judges it. */
  readonly rest: Readonly<Record<string, unknown>>
  /** Its `layout` property, however malformed; `undefined` for a call that declared none. */
  readonly layout: unknown
}

/**
 * Read one node object far enough to resolve its bindings.
 * @param value - one item of `spec.nodes`, however malformed.
 * @returns the node, or `undefined` when it is not shaped like one at all.
 */
function readNode(value: unknown): RawNode | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const { id, component, props } = record
  if (typeof id !== 'string' || typeof component !== 'string') return undefined
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return undefined
  return { id, component, props: props as Record<string, unknown>, record }
}

/**
 * Read one payload's spec document.
 *
 * What is refused here is only what has to be understood before validation can
 * run at all: a document with no node list, a node with no id, a node naming no
 * component, a node with no properties, and two nodes claiming one id. Every
 * other judgement — the ids' alphabet, the catalog, the properties, the
 * ceilings — is validation's, and reaches the model or the page through its
 * wording rather than through this reading's silence.
 * @param payload - the entry's payload, as the column handed it over.
 * @returns the document, or `undefined` when the payload is not one.
 */
function readSpecDocument(payload: unknown): SpecDocument | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  // Read as `unknown`: the payload's declared type says the spec is a validated
  // document, and this reading runs where that is a claim rather than a fact.
  const spec: unknown = (payload as Partial<ComponentSurfacePayload>).spec
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return undefined
  const { nodes, layout, ...rest } = spec as Record<string, unknown>
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) return undefined
  const read: RawNode[] = []
  const ids = new Set<string>()
  for (const value of nodes as readonly unknown[]) {
    const node = readNode(value)
    if (node === undefined || ids.has(node.id)) return undefined
    ids.add(node.id)
    read.push(node)
  }
  return { nodes: read, rest, layout }
}

/**
 * Whether one node cannot be drawn yet: a property its component requires is
 * bound to an output nothing has published.
 * @param componentId - the component the node names.
 * @param unresolved - the bound properties with nothing to stand for them.
 * @returns true when one of them is required.
 */
function awaitsAnOutput(componentId: string, unresolved: readonly string[]): boolean {
  const schema = catalogEntry(componentId)?.propsSchema
  // No catalog entry: validation refuses the node by name, which is a better
  // answer than a waiting line for a component that does not exist.
  if (schema === undefined) return false
  return unresolved.some(name => schema[name]?.required === true)
}

/**
 * Judge the nodes that are drawable, with every resolved binding in place.
 * @param doc - the document.
 * @param waiting - ids to leave out of the judgement.
 * @param props - each node's properties with its bindings resolved, by node id.
 * @returns the accepted nodes by id, or `undefined` when the document is one this build refuses.
 */
function acceptNodes(
  doc: SpecDocument,
  waiting: ReadonlySet<string>,
  props: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): ReadonlyMap<string, ComponentNode> | undefined {
  const drawn = doc.nodes.filter(node => !waiting.has(node.id))
  // Every block is waiting on something: there is no document left to judge,
  // and the entry is a stack of waiting lines rather than an unreadable one.
  if (drawn.length === 0) return new Map()
  const result = validateComponentSpec({
    ...doc.rest,
    nodes: drawn.map(node => ({ ...node.record, props: props.get(node.id) })),
  })
  if (!result.ok) return undefined
  return new Map(result.spec.nodes.map(node => [node.id, node]))
}

/**
 * Read one entry's payload into the blocks to draw and their arrangement.
 * @param payload - the entry's payload, as the column handed it over.
 * @param outputs - what this entry's blocks have published so far.
 * @param previous - the blocks the last reading of this same payload produced,
 *   so an unchanged one keeps the object it had; empty for the first reading.
 * @returns the reading, or `undefined` when this build cannot draw the payload at all.
 */
export function acceptSurface(
  payload: unknown,
  outputs: OutputValues,
  previous: readonly SurfaceBlock[],
): SurfaceView | undefined {
  const doc = readSpecDocument(payload)
  if (doc === undefined) return undefined
  const bound = doc.nodes.map(node => ({ node, resolved: resolveBindings(node, outputs) }))
  const waiting = new Set(bound
    .filter(one => awaitsAnOutput(one.node.component, one.resolved.unresolved))
    .map(one => one.node.id))
  const props = new Map(bound.map(one => [one.node.id, one.resolved.props] as const))
  let accepted = acceptNodes(doc, waiting, props)
  if (accepted === undefined) {
    const fed = bound.filter(one => one.resolved.bindingKey !== undefined)
    // Nothing was fed anything, so the refusal is the document's own and there
    // is no smaller one to try.
    if (fed.length === 0) return undefined
    for (const one of fed) waiting.add(one.node.id)
    accepted = acceptNodes(doc, waiting, props)
    if (accepted === undefined) return undefined
  }
  const blocks = holdSteady(previous, bound.map(one => ({
    id: one.node.id,
    node: accepted.get(one.node.id),
    bindingKey: one.resolved.bindingKey,
  })))
  return { blocks, layout: readLayout(doc.layout, new Map(blocks.map(block => [block.id, block] as const))) }
}

/**
 * Carry a block over from the previous reading of the same payload wherever
 * this one cannot have changed it.
 *
 * Identity is the point. A block's validated properties are what its renderer
 * memoizes on, and a Vue table reads a new `data` array as a table whose rows
 * have been replaced — it clears the selection. Re-reading the payload because
 * some *other* block published something would do exactly that to every block
 * on screen, so a block whose bindings stand where they stood keeps the object
 * it already had, and a block that has actually been fed something new gets a
 * new one.
 *
 * The two readings must be of the same payload; a later call under the same
 * entry id draws different blocks and the seat starts afresh.
 * @param previous - the blocks the last reading of this payload produced.
 * @param next - the blocks this reading produced.
 * @returns the blocks to draw, each the previous object wherever its bindings resolved the same way.
 */
export function holdSteady(
  previous: readonly SurfaceBlock[],
  next: readonly SurfaceBlock[],
): readonly SurfaceBlock[] {
  const before = new Map(previous.map(block => [block.id, block] as const))
  return next.map((block) => {
    const held = before.get(block.id)
    return held !== undefined && held.bindingKey === block.bindingKey ? held : block
  })
}
