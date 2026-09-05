/**
 * The two things a spec says beyond which blocks it draws: how they are
 * arranged, and which of them reads a value out of another.
 *
 * Both are judged whole here and drawn nowhere, which is the split the design
 * rests on — the host decides shapes and ceilings, and what a bound property
 * actually holds is worked out in the seat over the user's own gestures and
 * never reaches the log. Every refusal is pinned by path as well as by wording,
 * because a call carrying twelve blocks and a nested layout gets one sentence
 * back and the path is the only part of it that says where.
 */

import { describe, expect, it } from 'vitest'
import {
  BINDING_KEY,
  COMPONENT_CATALOG,
  MAX_FLEX,
  MAX_LAYOUT_CHILDREN,
  MAX_LAYOUT_DEPTH,
  MAX_SPEC_DEPTH,
  RECORD_DETAIL_ID,
  TABLE_ID,
  type LayoutStack,
  type PropsFieldSchema,
} from '../src/component-call.ts'
import { acceptsOutput, validateComponentSpec, type ComponentCallFailure } from '../src/validate.ts'

/** One table, which is the only component with something to read out of it. */
function table(id: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    component: TABLE_ID,
    props: {
      tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] },
      displayValueList: [{ zh_label: 'A-1' }],
      ...props,
    },
  }
}

/** One record detail, the block a table's ticked row is read into. */
function detail(id: string, dataList: unknown = [{ label: '编号', display: 'A-1' }]): Record<string, unknown> {
  return { id, component: RECORD_DETAIL_ID, props: { dataList } }
}

/** One property read from another block. */
function from(reference: string): Record<string, unknown> {
  return { [BINDING_KEY]: reference }
}

/** The refusal one spec produced; fails the spec when it was accepted. */
function refusal(spec: unknown): ComponentCallFailure {
  const result = validateComponentSpec(spec)
  if (result.ok) throw new Error('expected a refusal, got an accepted spec')
  return result.failure
}

/** The spec one document was accepted as; fails the spec when it was refused. */
function accepted(spec: unknown): ReturnType<typeof validateComponentSpec> & { ok: true } {
  const result = validateComponentSpec(spec)
  if (!result.ok) throw new Error(result.failure.text)
  return result
}

/** One layout of `stacks` stacks nested around a single block. */
function nest(stacks: number, id: string): unknown {
  let child: unknown = { node: 'component', id }
  for (let level = 0; level < stacks; level++) child = { node: 'stack', dir: 'col', children: [child] }
  return child
}

describe('a layout', () => {
  it('accepts a tree of stacks and keeps it beside the nodes', () => {
    const result = accepted({
      nodes: [table('t'), detail('d')],
      layout: {
        node: 'stack',
        dir: 'col',
        gap: 'md',
        wrap: false,
        children: [
          { node: 'stack', dir: 'row', children: [{ node: 'component', id: 't', flex: 2 }] },
          { node: 'component', id: 'd' },
        ],
      },
    })
    expect(result.spec.layout).toEqual({
      node: 'stack',
      dir: 'col',
      gap: 'md',
      wrap: false,
      children: [
        { node: 'stack', dir: 'row', children: [{ node: 'component', id: 't', flex: 2 }] },
        { node: 'component', id: 'd' },
      ],
    })
  })

  it('answers with a frozen tree it built itself, down to the blocks in it', () => {
    // The seat hands this to a renderer, and a Vue 2 renderer rewrites what it
    // is given property by property unless the value is frozen — a block at the
    // bottom of the tree as much as the stack around it.
    const layout = {
      node: 'stack',
      dir: 'row',
      children: [{ node: 'component', id: 't' }, { node: 'stack', dir: 'col', children: [{ node: 'component', id: 'd' }] }],
    }
    const result = accepted({ nodes: [table('t'), detail('d')], layout })
    expect(result.spec.layout).not.toBe(layout)
    expect(Object.isFrozen(result.spec.layout)).toBe(true)
    expect(Object.isFrozen(result.spec.layout?.children)).toBe(true)
    expect(result.spec.layout?.children.map(child => Object.isFrozen(child))).toEqual([true, true])
    const nested = result.spec.layout?.children[1] as LayoutStack
    expect(Object.isFrozen(nested.children[0])).toBe(true)
  })

  it('accepts a share on a nested stack, which divides its row the way a block does', () => {
    const result = accepted({
      nodes: [table('t'), detail('d')],
      layout: {
        node: 'stack',
        dir: 'row',
        children: [
          { node: 'component', id: 't', flex: 2 },
          { node: 'stack', dir: 'col', flex: 1, children: [{ node: 'component', id: 'd' }] },
        ],
      },
    })
    expect(result.spec.layout?.children[1]).toEqual({
      node: 'stack',
      dir: 'col',
      flex: 1,
      children: [{ node: 'component', id: 'd' }],
    })
  })

  it('carries no layout at all where the call wrote none, which is the flat stack', () => {
    const result = accepted({ nodes: [table('t'), detail('d')] })
    expect(result.spec.layout).toBeUndefined()
    expect('layout' in result.spec).toBe(false)
  })

  it(`accepts ${MAX_LAYOUT_DEPTH} stacks and refuses the one that opens a further one`, () => {
    expect(validateComponentSpec({ nodes: [table('t')], layout: nest(MAX_LAYOUT_DEPTH, 't') }).ok).toBe(true)
    const failure = refusal({ nodes: [table('t')], layout: nest(MAX_LAYOUT_DEPTH + 1, 't') })
    // Named at the stack that opened it, which is the one to drop.
    expect(failure.path).toBe('spec.layout.children[0].children[0].children[0].children[0]')
    expect(failure.text).toContain(`opens stack 5; at most ${MAX_LAYOUT_DEPTH} stacks may be open at once`)
  })

  it('refuses a layout so deep the document is not read at all', () => {
    // The ceiling above leaves one layout level of slack, so this is the point
    // past which the depth walk ends the call before the layout pass sees it.
    const failure = refusal({ nodes: [table('t')], layout: nest(MAX_LAYOUT_DEPTH + 2, 't') })
    expect(failure.path).toBe('spec')
    expect(failure.text).toContain(`nests deeper than ${MAX_SPEC_DEPTH} levels`)
  })

  it.each([
    [
      'a block naming a node the call does not place',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't' }, { node: 'stack', dir: 'row', children: [{ node: 'component', id: 'gone' }] }] },
      'spec.layout.children[1].children[0].id',
      /names no node of this call/,
    ],
    [
      'a block naming no node at all',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 42 }] },
      'spec.layout.children[0].id',
      /names no node of this call/,
    ],
    [
      'the same node placed twice',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't' }, { node: 'component', id: 't' }] },
      'spec.layout.children[1].id',
      /places "t" a second time; the layout places every node exactly once/,
    ],
    [
      'a layout that is not a stack',
      [{ node: 'component', id: 't' }],
      'spec.layout',
      /must be a stack/,
    ],
    [
      'a layout starting with a block',
      { node: 'component', id: 't' },
      'spec.layout.node',
      /must be "stack"; a layout starts with a row or a column/,
    ],
    [
      'a stack property nothing declares',
      { node: 'stack', dir: 'col', align: 'top', children: [{ node: 'component', id: 't' }] },
      'spec.layout.align',
      /is not part of a stack. A stack carries node, dir, gap, wrap, flex, children/,
    ],
    [
      'a block property nothing declares',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't', width: 200 }] },
      'spec.layout.children[0].width',
      /is not part of a placed block. A placed block carries node, id, flex/,
    ],
    [
      'no direction',
      { node: 'stack', children: [{ node: 'component', id: 't' }] },
      'spec.layout.dir',
      /must be one of "row", "col"/,
    ],
    [
      'a spacing outside the three',
      { node: 'stack', dir: 'col', gap: 'huge', children: [{ node: 'component', id: 't' }] },
      'spec.layout.gap',
      /must be one of "sm", "md", "lg"/,
    ],
    [
      'a wrap that is not a yes or a no',
      { node: 'stack', dir: 'col', wrap: 'yes', children: [{ node: 'component', id: 't' }] },
      'spec.layout.wrap',
      /must be true or false/,
    ],
    [
      'a share past the ceiling',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't', flex: MAX_FLEX + 1 }] },
      'spec.layout.children[0].flex',
      /must be a whole number between 1 and 12/,
    ],
    [
      'a share that is not a whole number',
      { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't', flex: 1.5 }] },
      'spec.layout.children[0].flex',
      /must be a whole number between 1 and 12/,
    ],
    [
      'a share of nothing on a nested stack',
      { node: 'stack', dir: 'col', children: [{ node: 'stack', dir: 'row', flex: 0, children: [{ node: 'component', id: 't' }] }] },
      'spec.layout.children[0].flex',
      /must be a whole number between 1 and 12/,
    ],
    [
      'children that are not a list',
      { node: 'stack', dir: 'col', children: { first: { node: 'component', id: 't' } } },
      'spec.layout.children',
      /must be an array of blocks and stacks/,
    ],
    [
      'a stack holding nothing',
      { node: 'stack', dir: 'col', children: [] },
      'spec.layout.children',
      /lists 0 children; between 1 and 12 are accepted/,
    ],
    [
      'a child that is neither a block nor a stack',
      { node: 'stack', dir: 'col', children: ['t'] },
      'spec.layout.children[0]',
      /must be \{"node": "component", "id": "<a node id>"\} or a stack/,
    ],
    [
      'a child claiming to be something else',
      { node: 'stack', dir: 'col', children: [{ node: 'panel', id: 't' }] },
      'spec.layout.children[0].node',
      /must be "component" for a block or "stack" for a further row or column/,
    ],
  ])('refuses %s', (_case, layout, path, message) => {
    const failure = refusal({ nodes: [table('t')], layout })
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
  })

  it('refuses a share on the outermost stack, which sits in nothing', () => {
    // Accepted-and-ignored is the one refusal a model can never learn from:
    // `flex` divides the stack a child sits in, and the outermost sits in no
    // stack at all, so the share it asks for would silently do nothing.
    const failure = refusal({
      nodes: [table('t')],
      layout: { node: 'stack', dir: 'col', flex: 2, children: [{ node: 'component', id: 't' }] },
    })
    expect(failure.path).toBe('spec.layout.flex')
    expect(failure.text).toContain('is not accepted on the outermost stack')
  })

  it('refuses more children than one stack holds, as too much rather than as wrong', () => {
    const failure = refusal({
      nodes: [table('t')],
      layout: {
        node: 'stack',
        dir: 'col',
        children: Array.from({ length: MAX_LAYOUT_CHILDREN + 1 }, () => ({ node: 'component', id: 't' })),
      },
    })
    expect(failure.path).toBe('spec.layout.children')
    expect(failure.oversize).toBe(true)
  })

  it('refuses a node the layout leaves out, naming the node rather than the layout', () => {
    // A node no position draws is a block the call paid for and nobody sees,
    // and the only thing the model can act on is which node it forgot.
    const failure = refusal({
      nodes: [table('t'), detail('d')],
      layout: { node: 'stack', dir: 'col', children: [{ node: 'component', id: 't' }] },
    })
    expect(failure.path).toBe('spec.nodes[1].id')
    expect(failure.text).toContain('is not placed in spec.layout')
  })
})

describe('a property read from another block', () => {
  it('accepts the pair the whole thing exists for: a table over a detail of the ticked row', () => {
    const result = accepted({
      nodes: [table('t', { selectMode: 'checkbox' }), detail('d', from('node:t.selectionDetail'))],
      layout: { node: 'stack', dir: 'row', children: [{ node: 'component', id: 't', flex: 2 }, { node: 'component', id: 'd' }] },
    })
    // The reference is what the spec carries: what it stands for is worked out
    // in the seat, over a selection that never reaches the log.
    expect(result.spec.nodes[1]?.props['dataList']).toEqual({ [BINDING_KEY]: 'node:t.selectionDetail' })
    expect(Object.isFrozen(result.spec.nodes[1]?.props['dataList'])).toBe(true)
  })

  it('accepts a bound property in place of the required value it stands for', () => {
    // `dataList` is required, and a call carrying only the binding is a call
    // whose property is present — the value arrives later, from the seat.
    expect(validateComponentSpec({ nodes: [table('t'), detail('d', from('node:t.selectionDetail'))] }).ok).toBe(true)
  })

  it('keeps the tightening pass running over every property that is not one', () => {
    const result = accepted({
      nodes: [
        table('t'),
        {
          id: 'm',
          component: 'el.metric',
          props: { process: 40, background: 'red' },
        },
        detail('d', from('node:t.selectionDetail')),
      ],
    })
    // The binding is kept as the call wrote it, and the properties around it in
    // the same call are still read the way their components declare them — so a
    // color that is not one of the accepted notations is gone.
    expect(result.spec.nodes[2]?.props['dataList']).toEqual({ [BINDING_KEY]: 'node:t.selectionDetail' })
    expect(result.spec.nodes[1]?.props).toEqual({ process: 40 })
  })

  it.each([
    [
      'a reference nothing can read',
      detail('d', from('node:t')),
      'spec.nodes[1].props.dataList.$from',
      /must be a string reading node:<node id>\.<output name>, optionally with \[index\]/,
    ],
    [
      'a binding carrying more than the reference',
      detail('d', { [BINDING_KEY]: 'node:t.selectionDetail', flex: 1 }),
      'spec.nodes[1].props.dataList.$from',
      /a bound property carries \$from and nothing else/,
    ],
    [
      'a reference that is not text',
      detail('d', { [BINDING_KEY]: 42 }),
      'spec.nodes[1].props.dataList.$from',
      /must be a string reading node:<node id>/,
    ],
    [
      'a reference nested inside a value',
      detail('d', [{ label: '编号', display: from('node:t.selectionDetail') }]),
      'spec.nodes[1].props.dataList[0].display.$from',
      /accepted only as the whole value of one of this component's own properties/,
    ],
    [
      'a block reading itself',
      detail('d', from('node:d.selectionDetail')),
      'spec.nodes[1].props.dataList.$from',
      /reads the block it is on; a binding reads another block/,
    ],
    [
      'a block this call does not place',
      detail('d', from('node:gone.selectionDetail')),
      'spec.nodes[1].props.dataList.$from',
      /reads the block "gone", which this call does not place. The blocks it places are: "t", "d"/,
    ],
    [
      'a value the block does not report',
      detail('d', from('node:t.rows')),
      'spec.nodes[1].props.dataList.$from',
      /reads "rows" from the 数据表 block "t", which reports selectionDetail/,
    ],
    [
      'an item the output never holds',
      detail('d', from('node:t.selectionDetail[99]')),
      'spec.nodes[1].props.dataList.$from',
      /takes item 99 out of selectionDetail, which is \[\{label, display\}\] \(0–30\)/,
    ],
    [
      'a value the property does not accept',
      {
        id: 'd',
        component: RECORD_DETAIL_ID,
        props: { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: from('node:t.selectionDetail') },
      },
      'spec.nodes[1].props.labelWidth.$from',
      /reads \[\{label, display\}\] \(0–30\), and labelWidth accepts number/,
    ],
    [
      'one item of a list where the property takes the list',
      detail('d', from('node:t.selectionDetail[0]')),
      'spec.nodes[1].props.dataList.$from',
      /reads \{label, display\}, and dataList accepts \[\{label, display\}\] \(1–60\)/,
    ],
  ])('refuses %s', (_case, node, path, message) => {
    const failure = refusal({ nodes: [table('t'), node] })
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
  })

  it('refuses reading from a block nothing can be read from, and says so', () => {
    // A component with no `outputs:` line at all, which is most of the catalog:
    // the sentence has to say that rather than list an empty offer.
    const failure = refusal({ nodes: [detail('a'), detail('d', from('node:a.rows'))] })
    expect(failure.path).toBe('spec.nodes[1].props.dataList.$from')
    expect(failure.text).toContain('reads "rows" from the 记录详情 block "a", which reports nothing.')
  })

  it.each([
    ['the rows the table draws', 'displayValueList', /every gesture in this table is reported to you by reading these rows back/],
    ['the values behind them', 'rawValueList', /it stands behind the drawn rows one for one/],
  ])('refuses reading into %s, which the block\'s own gestures are named from', (_case, prop, message) => {
    // A resolved value lives for one render of one page and reaches no record.
    // What names a ticked row for the agent is the call that wrote the rows, so
    // a table fed its rows by another block would report gestures to nobody.
    const failure = refusal({ nodes: [table('t'), table('u', { [prop]: from('node:t.selectionDetail') })] })
    expect(failure.path).toBe(`spec.nodes[1].props.${prop}`)
    expect(failure.text).toMatch(message)
  })

  it('refuses reading into a property the component reads as something narrower than text', () => {
    // The tightening pass runs over the value a call writes out. A bound
    // property has no such value, so a reading declared below it would be a
    // reading nothing performs — a renderer name, here, straight off a wire.
    const failure = refusal({
      nodes: [table('t'), table('u', { tableConfig: from('node:t.selectionDetail') })],
    })
    expect(failure.path).toBe('spec.nodes[1].props.tableConfig')
    expect(failure.text).toContain('cannot be read from another block')
  })

  it('refuses reading into a property declared as a color, which is one string rather than a tree', () => {
    const failure = refusal({
      nodes: [table('t'), { id: 'm', component: 'el.metric', props: { process: 40, background: from('node:t.selectionDetail') } }],
    })
    expect(failure.path).toBe('spec.nodes[1].props.background')
    expect(failure.text).toContain('cannot be read from another block')
  })

  it('refuses a binding on a property the component does not declare, naming the spelling', () => {
    const failure = refusal({
      nodes: [table('t'), { id: 'm', component: 'el.metric', props: { process: 40, glow: from('node:t.selectionDetail') } }],
    })
    expect(failure.path).toBe('spec.nodes[1].props.glow')
    expect(failure.text).toContain('is not accepted here. Accepted properties: size, process, text')
  })

})

describe('which way a value can travel', () => {
  /** The smallest accepted call of every component another block may read a value out of. */
  const REPORTING: Readonly<Record<string, Record<string, unknown>>> = {
    [TABLE_ID]: {
      tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }] },
      displayValueList: [{ zh_label: 'A-1' }],
    },
  }

  /**
   * The properties of a reporting component the host reads back out of the call
   * that wrote them, which is what makes them unwritable by another block.
   *
   * Written out rather than read off the catalog: this is the fact the no-loop
   * argument rests on, and a property that quietly lost its `unbindable` would
   * otherwise still pass on the second refusal below.
   */
  const READ_BACK: Readonly<Record<string, readonly string[]>> = {
    [TABLE_ID]: ['tableConfig', 'displayValueList', 'rawValueList'],
  }

  it('refuses every binding into a block that reports something of its own', () => {
    // The whole reason nothing here looks for a loop. A block reports what the
    // user did in it, and what a report is read against is the call that placed
    // it — so every property a reporting component draws from is one no other
    // block may write, and a chain of bindings can only ever run one way.
    const reporting = COMPONENT_CATALOG.filter(entry => entry.outputs.length > 0)
    expect(reporting.map(entry => entry.id)).toEqual(Object.keys(REPORTING))
    for (const source of reporting) {
      for (const target of reporting) {
        for (const output of source.outputs) {
          for (const prop of Object.keys(target.propsSchema)) {
            const pair = `${source.id}.${output.id} → ${target.id}.${prop}`
            const failure = refusal({
              nodes: [
                { id: 's', component: source.id, props: REPORTING[source.id] },
                { id: 'b', component: target.id, props: { ...REPORTING[target.id], [prop]: from(`node:s.${output.id}`) } },
              ],
            })
            if (READ_BACK[target.id]?.includes(prop) === true) {
              // Named on the property rather than on its reference: what is
              // wrong is the property, whatever it was going to read.
              expect(`${pair}: ${failure.path}`).toBe(`${pair}: spec.nodes[1].props.${prop}`)
              expect(`${pair}: ${failure.text}`).toContain('cannot be read from another block')
              continue
            }
            // The rest are closed by the other half of the same judgement:
            // nothing this catalog reports is a value they could hold, so the
            // refusal names the reference and what the property accepts.
            expect(`${pair}: ${failure.path}`).toBe(`${pair}: spec.nodes[1].props.${prop}.${BINDING_KEY}`)
            expect(`${pair}: ${failure.text}`).toContain(`and ${prop} accepts `)
          }
        }
      }
    }
  })
})

describe('whether one output can be the value of a property', () => {
  // Exported because the judgement is what the catalog's two halves are wired
  // together by: an output declared in one component and a property declared in
  // another meet here and nowhere else.
  const text: PropsFieldSchema = { kind: 'string', maxLength: 8 }
  const field: PropsFieldSchema = { kind: 'string', maxLength: 8, charset: { allowed: /^[a-z]+$/, hint: 'lower case' } }

  it('accepts a value of the same kind that carries no more than the property takes', () => {
    expect(acceptsOutput(text, { kind: 'string', maxLength: 9 })).toBe(true)
    expect(acceptsOutput(text, { kind: 'string', maxLength: 7 })).toBe(false)
    expect(acceptsOutput(text, { kind: 'number', min: 0, max: 1 })).toBe(false)
  })

  it('accepts a restricted alphabet only where the value comes with one', () => {
    expect(acceptsOutput(field, text)).toBe(true)
    expect(acceptsOutput(text, field)).toBe(false)
    expect(acceptsOutput(field, { kind: 'string', maxLength: 8, charset: { allowed: /^[a-z]+$/, hint: 'lower case' } })).toBe(true)
    expect(acceptsOutput(field, { kind: 'string', maxLength: 8, charset: { allowed: /^[A-Z]+$/, hint: 'upper case' } })).toBe(false)
  })

  it('keeps a number inside the range the property accepts', () => {
    const measure: PropsFieldSchema = { kind: 'number', min: 0, max: 100 }
    expect(acceptsOutput(measure, { kind: 'number', min: 0, max: 100 })).toBe(true)
    expect(acceptsOutput(measure, { kind: 'number', min: 1, max: 100 })).toBe(false)
    expect(acceptsOutput(measure, { kind: 'number', min: 0, max: 99 })).toBe(false)
    expect(acceptsOutput(measure, text)).toBe(false)
  })

  it('accepts a yes-or-no only where a yes-or-no is declared', () => {
    expect(acceptsOutput({ kind: 'boolean' }, { kind: 'boolean' })).toBe(true)
    expect(acceptsOutput({ kind: 'boolean' }, text)).toBe(false)
  })

  it('accepts a fixed set the property\'s own set covers', () => {
    const two: PropsFieldSchema = { kind: 'enum', values: ['asc', 'desc'] }
    expect(acceptsOutput(two, { kind: 'enum', values: ['asc', 'desc', 'none'] })).toBe(true)
    expect(acceptsOutput(two, { kind: 'enum', values: ['asc'] })).toBe(false)
    expect(acceptsOutput(two, text)).toBe(false)
  })

  it('measures a record whose keys are the caller\'s own by every bound it declares', () => {
    const row: PropsFieldSchema = { kind: 'record', key: text, maxKeys: 4, maxValueLength: 8, minValue: 0, maxValue: 9 }
    expect(acceptsOutput(row, { ...row })).toBe(true)
    expect(acceptsOutput(row, { ...row, maxKeys: 3 })).toBe(false)
    expect(acceptsOutput(row, { ...row, maxValueLength: 7 })).toBe(false)
    expect(acceptsOutput(row, { ...row, minValue: 1 })).toBe(false)
    expect(acceptsOutput(row, { ...row, maxValue: 8 })).toBe(false)
    expect(acceptsOutput(row, { ...row, key: { kind: 'string', maxLength: 7 } })).toBe(false)
    expect(acceptsOutput(row, text)).toBe(false)
  })

  it('measures an object property by property, and refuses one carrying anything extra', () => {
    const pair: PropsFieldSchema = {
      kind: 'object',
      fields: { label: { required: true, schema: text }, note: { required: false, schema: text } },
    }
    expect(acceptsOutput(pair, pair)).toBe(true)
    // The property may declare more, as long as it does not require it.
    expect(acceptsOutput(pair, { kind: 'object', fields: { ...pair.fields, tone: { required: false, schema: text } } })).toBe(true)
    expect(acceptsOutput(pair, { kind: 'object', fields: { ...pair.fields, tone: { required: true, schema: text } } })).toBe(false)
    // A field the value may leave out is judged the way an absent one is.
    expect(acceptsOutput(pair, { kind: 'object', fields: { ...pair.fields, note: { required: true, schema: text } } })).toBe(false)
    // A value carrying a property the component never declared is one it would
    // be handed something it does not accept.
    expect(acceptsOutput(pair, { kind: 'object', fields: { label: { required: true, schema: text } } })).toBe(false)
    expect(acceptsOutput(pair, { kind: 'object', fields: { label: { required: true, schema: { kind: 'boolean' } }, note: { required: false, schema: text } } })).toBe(false)
    expect(acceptsOutput(pair, text)).toBe(false)
  })

  it('measures a list by its ceiling and by what one item is, never by its floor or its uniqueness', () => {
    const list: PropsFieldSchema = { kind: 'array', minItems: 0, maxItems: 4, item: text }
    expect(acceptsOutput(list, { kind: 'array', minItems: 1, maxItems: 4, item: text })).toBe(true)
    expect(acceptsOutput(list, { kind: 'array', minItems: 0, maxItems: 4, item: text, uniqueBy: 'id' })).toBe(true)
    expect(acceptsOutput(list, { kind: 'array', minItems: 0, maxItems: 3, item: text })).toBe(false)
    expect(acceptsOutput(list, { kind: 'array', minItems: 0, maxItems: 4, item: { kind: 'boolean' } })).toBe(false)
    expect(acceptsOutput(list, text)).toBe(false)
  })
})
