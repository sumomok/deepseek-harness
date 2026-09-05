/**
 * What one block takes from the block beside it, and what the seat makes of a
 * payload whose properties are written that way.
 *
 * Three things are pinned here. The arithmetic: a reference stands for whatever
 * its source last published, one item of it, or nothing at all. The reading: a
 * block whose *required* property has nothing to stand for it yet is left out
 * of the judgement rather than failing it, so the entry beside it still draws —
 * and a value that came out of a component and does not fit where it was put
 * leaves the fed blocks waiting instead of blanking the entry. And identity: a
 * block nothing fed keeps the object it had, because a Vue table handed a new
 * row list is a table that has dropped the user's selection.
 */
import { describe, expect, it } from 'vitest'
import {
  NO_OUTPUTS,
  outputKey,
  resolveBindings,
  type OutputValues,
} from '../src/client/bindings.ts'
import { acceptSurface, holdSteady, type SurfaceBlock } from '../src/client/spec.ts'
import { CONFIRM_BAR_ID, RECORD_DETAIL_ID, TABLE_ID } from '../src/component-call.ts'

/** One table of published values. */
function published(values: Readonly<Record<string, unknown>>): OutputValues {
  return new Map(Object.entries(values).map(([key, value]) => {
    const [nodeId, outputId] = key.split('.') as [string, string]
    return [outputKey(nodeId, outputId), value]
  }))
}

/** The rows a record block draws, as a table publishes them. */
const DETAIL = [{ label: '名称', display: '一号站点' }]

describe('resolving one block bindings', () => {
  it('leaves a block that reads nothing exactly as it found it', () => {
    const props = { title: 'Approve?' }
    const resolved = resolveBindings({ id: 'ask', props }, published({ 't.selection': [] }))
    // The same object, not a copy: this is what a renderer memoizes on.
    expect(resolved.props).toBe(props)
    expect(resolved.unresolved).toEqual([])
    expect(resolved.bindingKey).toBeUndefined()
  })

  it('stands the whole output where the reference is', () => {
    const resolved = resolveBindings(
      { id: 'd', props: { dataList: { $from: 'node:t.selectionDetail' }, columnNum: 2 } },
      published({ 't.selectionDetail': DETAIL }),
    )
    expect(resolved.props).toEqual({ dataList: DETAIL, columnNum: 2 })
    expect(resolved.unresolved).toEqual([])
  })

  it('stands one item of the output where the reference names one', () => {
    const resolved = resolveBindings(
      { id: 'd', props: { record: { $from: 'node:t.selection[1]' } } },
      published({ 't.selection': [{ a: 1 }, { a: 2 }] }),
    )
    expect(resolved.props).toEqual({ record: { a: 2 } })
  })

  it.each([
    ['the source has published nothing yet', {}, 'node:t.selectionDetail'],
    ['the item is past the end of what it published', { 't.selectionDetail': DETAIL }, 'node:t.selectionDetail[5]'],
    ['what it published is not a list to take an item of', { 't.count': 3 }, 'node:t.count[0]'],
  ])('leaves the property absent while %s', (_case, values, reference) => {
    const resolved = resolveBindings({ id: 'd', props: { dataList: { $from: reference } } }, published(values))
    expect(resolved.props).toEqual({})
    expect(resolved.unresolved).toEqual(['dataList'])
    expect(resolved.bindingKey).toBe(JSON.stringify([['dataList', null]]))
  })

  it.each([
    ['carries more than the reference', { $from: 'node:t.selectionDetail', else: 1 }],
    ['carries something other than a string', { $from: 7 }],
    ['is not written in the notation', { $from: 't.selectionDetail' }],
  ])('leaves a value that %s as the ordinary property it is', (_case, value) => {
    const resolved = resolveBindings({ id: 'd', props: { dataList: value } }, published({ 't.selectionDetail': DETAIL }))
    expect(resolved.props).toEqual({ dataList: value })
    expect(resolved.bindingKey).toBeUndefined()
  })

  it('keys two passes the same way while what they resolved is the same, and apart when it changes', () => {
    const node = { id: 'd', props: { dataList: { $from: 'node:t.selectionDetail' } } }
    const first = resolveBindings(node, published({ 't.selectionDetail': DETAIL }))
    const again = resolveBindings(node, published({ 't.selectionDetail': [{ ...DETAIL[0] }] }))
    const other = resolveBindings(node, published({ 't.selectionDetail': [] }))
    expect(again.bindingKey).toBe(first.bindingKey)
    expect(other.bindingKey).not.toBe(first.bindingKey)
  })
})

/** One confirmation bar, which reads nothing from anywhere. */
const ASK = { id: 'ask', component: CONFIRM_BAR_ID, props: { buttons: [{ id: 'go', label: 'Go' }] } }

/** One record block fed by the table beside it. */
const DETAILS = { id: 'd', component: RECORD_DETAIL_ID, props: { dataList: { $from: 'node:t.selectionDetail' } } }

/** A second record block, fed by a second table. */
const OTHER_DETAILS = { id: 'g', component: RECORD_DETAIL_ID, props: { dataList: { $from: 'node:u.selectionDetail' } } }

/** One payload over the given nodes and arrangement. */
function payload(nodes: readonly unknown[], layout?: unknown): unknown {
  return { spec: layout === undefined ? { nodes } : { nodes, layout } }
}

/** Read one payload with nothing published against it. */
function accept(document: unknown, outputs: OutputValues = NO_OUTPUTS) {
  return acceptSurface(document, outputs, [])
}

describe('reading one entry payload', () => {
  it('draws the blocks in call order, arranged the way the call asked', () => {
    const view = accept(payload([ASK, DETAILS], {
      node: 'stack',
      dir: 'row',
      children: [{ node: 'component', id: 'd' }, { node: 'component', id: 'ask' }],
    }), published({ 't.selectionDetail': DETAIL }))
    expect(view?.blocks.map(block => block.id)).toEqual(['ask', 'd'])
    expect(view?.layout.dir).toBe('row')
    expect(view?.layout.children.map(child => (child.node === 'component' ? child.block.id : ''))).toEqual(['d', 'ask'])
  })

  it('stands the published value in the properties the block is drawn from', () => {
    const view = accept(payload([DETAILS]), published({ 't.selectionDetail': DETAIL }))
    expect(view?.blocks[0]?.node?.props).toEqual({ dataList: DETAIL })
  })

  it('leaves a block whose required property is still waiting without a block to draw', () => {
    const view = accept(payload([ASK, DETAILS]))
    expect(view?.blocks.map(block => block.node === undefined)).toEqual([false, true])
    // The blocks beside it are drawn: one block waiting is not an entry that
    // cannot be read.
    expect(view?.blocks[0]?.node?.component).toBe(CONFIRM_BAR_ID)
  })

  it('draws a block whose waiting property is one its component does not require', () => {
    const view = accept(payload([{
      id: 'd',
      component: RECORD_DETAIL_ID,
      props: { dataList: DETAIL, columnNum: { $from: 'node:t.columns' } },
    }]))
    expect(view?.blocks[0]?.node?.props).toEqual({ dataList: DETAIL })
  })

  it('draws nothing but waiting lines when every block is waiting', () => {
    const view = accept(payload([DETAILS]))
    expect(view?.blocks.map(block => block.node)).toEqual([undefined])
    expect(view?.layout.children).toHaveLength(1)
  })

  it('leaves the fed blocks waiting when what they were fed does not fit them', () => {
    // Published by a component in this page rather than judged by any host: the
    // record block declares a list of rows, and one string is not one.
    const view = accept(payload([ASK, DETAILS]), published({ 't.selectionDetail': 'nope' }))
    expect(view?.blocks.map(block => block.node === undefined)).toEqual([false, true])
  })

  it('leaves a block fed an empty output waiting, because the property it fills requires an item', () => {
    // What the accepted binding costs: compatibility never compared the floor,
    // so an output with nothing in it yet reaches a property that needs one.
    const view = accept(payload([ASK, DETAILS]), published({ 't.selectionDetail': [] }))
    expect(view?.blocks.map(block => block.node === undefined)).toEqual([false, true])
  })

  it('leaves every fed block waiting, including one holding a value that fits', () => {
    const view = accept(
      payload([ASK, DETAILS, OTHER_DETAILS]),
      published({ 't.selectionDetail': 'nope', 'u.selectionDetail': DETAIL }),
    )
    expect(view?.blocks.map(block => block.node === undefined)).toEqual([false, true, true])
  })

  it('leaves a block naming a component this deployment does not have to the judgement that names it', () => {
    const view = accept(payload([ASK, {
      id: 'x',
      component: 'el.not-here',
      props: { dataList: { $from: 'node:t.selectionDetail' } },
    }]), published({ 't.selectionDetail': DETAIL }))
    // The component is refused whatever it was fed, so the fed blocks are left
    // waiting and the rest of the entry is drawn.
    expect(view?.blocks.map(block => block.node === undefined)).toEqual([false, true])
  })

  it.each([
    ['a payload that is not an object', 'component'],
    ['a payload that is null', null],
    ['a payload carrying no spec', {}],
    ['a spec that is a list', { spec: [ASK] }],
    ['a spec whose nodes are not a list', { spec: { nodes: ASK } }],
    ['a spec placing no node at all', payload([])],
    ['a spec placing more nodes than the ceiling', payload(Array.from({ length: 13 }, (_one, index) => ({ ...ASK, id: `ask${index}` })))],
    ['a node that is not an object', payload(['ask'])],
    ['a node with no id', payload([{ component: CONFIRM_BAR_ID, props: {} }])],
    ['a node naming no component', payload([{ id: 'ask', props: {} }])],
    ['a node with no properties', payload([{ id: 'ask', component: CONFIRM_BAR_ID }])],
    ['two nodes claiming one id', payload([ASK, ASK])],
    ['a node carrying a property the component does not declare', payload([{ ...ASK, props: { ...ASK.props, glow: true } }])],
    ['a block this build refuses standing beside one that is fed', payload([{ ...ASK, props: { ...ASK.props, glow: true } }, DETAILS])],
  ])('answers with nothing at all for %s', (_case, document) => {
    expect(accept(document)).toBeUndefined()
  })
})

describe('holding a block steady across readings of one payload', () => {
  /** One block of the previous reading. */
  function block(id: string, bindingKey: string | undefined): SurfaceBlock {
    return { id, node: { id, component: TABLE_ID, props: {} }, bindingKey }
  }

  it('keeps the object a block already had while its bindings stand where they stood', () => {
    const before = block('t', undefined)
    const [held] = holdSteady([before], [block('t', undefined)])
    expect(held).toBe(before)
  })

  it('hands over the new object for a block that has been fed something else', () => {
    const before = block('d', '[["dataList",[]]]')
    const after = block('d', '[["dataList",[1]]]')
    expect(holdSteady([before], [after])[0]).toBe(after)
  })

  it('hands over the new object for a block the previous reading did not have', () => {
    const after = block('d', undefined)
    expect(holdSteady([], [after])[0]).toBe(after)
  })

  it('keeps every unfed block steady when the seat re-reads one payload', () => {
    const document = payload([{
      id: 't',
      component: TABLE_ID,
      props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label' }] }, displayValueList: [{ zh_label: '一号站点' }] },
    }, DETAILS])
    const first = acceptSurface(document, NO_OUTPUTS, [])
    const again = acceptSurface(document, published({ 't.selectionDetail': DETAIL }), first?.blocks ?? [])
    expect(again?.blocks[0]).toBe(first?.blocks[0])
    expect(again?.blocks[1]).not.toBe(first?.blocks[1])
    expect(again?.blocks[1]?.node?.props).toEqual({ dataList: DETAIL })
  })
})
