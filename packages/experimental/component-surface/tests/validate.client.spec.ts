/**
 * Every way one `show_component` call can be refused, and the text the model is
 * refused with.
 *
 * The refusals are asserted rather than merely counted because they are the
 * only channel the model has: a call carrying eight nodes gets one sentence
 * back, and unless that sentence names the offending path the next call is a
 * guess. Every case below therefore pins the parameter path, and the unknown
 * component case pins the whole catalog the refusal hands back.
 */

import { describe, expect, it } from 'vitest'
import {
  COMPONENT_CATALOG,
  describeCatalog,
  MAX_ENTRY_ID_LENGTH,
  MAX_NODES,
  MAX_SPEC_BYTES,
  MAX_SPEC_DEPTH,
  MAX_TITLE_LENGTH,
  type PropsFieldSchema,
  type PropsSchema,
} from '../src/component-call.ts'
import { validateComponentCall, validateComponentSpec, type ComponentCallFailure } from '../src/validate.ts'

/** One accepted confirmation bar, the shape every rejection case starts from. */
function confirmBar(props: Record<string, unknown> = { buttons: [{ id: 'ok', label: '确认' }] }): Record<string, unknown> {
  return { id: 'n1', component: 'el.confirm-bar', props }
}

/** One accepted call around a spec. */
function call(spec: unknown): { id: string; title: string; spec: unknown } {
  return { id: 'budget', title: '预算确认', spec }
}

/** The refusal one call produced; fails the spec when the call was accepted. */
function refusal(args: { id?: unknown; title?: unknown; spec?: unknown }): ComponentCallFailure {
  const result = validateComponentCall(args)
  if (result.ok) throw new Error('expected a refusal, got an accepted call')
  return result.failure
}

/** The refusal one spec's props produced. */
function propsRefusal(props: Record<string, unknown>): ComponentCallFailure {
  return refusal(call({ nodes: [confirmBar(props)] }))
}

describe('an accepted call', () => {
  it('keeps the trimmed identity, the title, and the nodes in order', () => {
    const result = validateComponentCall({
      id: '  budget  ',
      title: '  预算确认  ',
      spec: {
        nodes: [
          confirmBar({ title: '本月预算', message: '同意后立即生效。', buttons: [{ id: 'ok', label: '确认', tone: 'primary' }, { id: 'no', label: '再想想' }] }),
          { id: 'n2', component: 'el.confirm-bar', props: { buttons: [{ id: 'x', label: '取消' }] } },
        ],
      },
    })
    expect(result).toEqual({
      ok: true,
      call: {
        id: 'budget',
        title: '预算确认',
        spec: {
          nodes: [
            { id: 'n1', component: 'el.confirm-bar', props: { title: '本月预算', message: '同意后立即生效。', buttons: [{ id: 'ok', label: '确认', tone: 'primary' }, { id: 'no', label: '再想想' }] } },
            { id: 'n2', component: 'el.confirm-bar', props: { buttons: [{ id: 'x', label: '取消' }] } },
          ],
        },
      },
    })
  })

  it('accepts a spec on its own, the pass the browser seat repeats on the wire', () => {
    expect(validateComponentSpec({ nodes: [confirmBar()] }).ok).toBe(true)
  })

  it('leaves an accepted node\'s properties frozen, which is what a Vue renderer is given', () => {
    // The seat reaches every renderer through here, so this is where a block's
    // properties become something a framework below cannot rewrite.
    const result = validateComponentSpec({ nodes: [confirmBar({ title: '本月预算', buttons: [{ id: 'ok', label: '确认' }] })] })
    if (!result.ok) throw new Error(result.failure.text)
    const props = result.spec.nodes[0]?.props as Record<string, unknown>
    expect(Object.isFrozen(props)).toBe(true)
    expect(Object.isFrozen(props['buttons'])).toBe(true)
    expect(Object.isFrozen((props['buttons'] as readonly unknown[])[0])).toBe(true)
  })

  it('answers with the record the tightening pass rebuilt, not the one the call carried', () => {
    // The other half of the same wiring: freezing alone would be satisfied by
    // freezing the caller's own object in place. The pass walks the schema
    // instead, so what comes back is a new record carrying the declared
    // properties in the schema's order, whatever order the call wrote them in.
    const buttons = [{ label: '确认', id: 'ok' }]
    const props = { buttons, message: '同意后立即生效。' }
    const result = validateComponentSpec({ nodes: [confirmBar(props)] })
    if (!result.ok) throw new Error(result.failure.text)
    const accepted = result.spec.nodes[0]?.props as Record<string, unknown>
    expect(accepted).not.toBe(props)
    expect(Object.keys(accepted)).toEqual(['message', 'buttons'])
    expect(accepted['buttons']).not.toBe(buttons)
    expect(Object.keys((accepted['buttons'] as Record<string, unknown>[])[0] as object)).toEqual(['id', 'label'])
    expect(Object.isFrozen(props)).toBe(false)
  })
})

/** One accepted value for a declared property, built to the deepest shape its schema allows. */
function sampleField(schema: PropsFieldSchema): unknown {
  switch (schema.kind) {
    case 'string': return 'a'
    case 'number': return schema.min
    case 'enum': return schema.values[0]
    case 'object': return sampleProps(schema.fields)
    case 'array': return Array.from(
      { length: Math.max(schema.minItems, 1) },
      (_unused, index) => ({
        ...sampleProps(schema.item.fields),
        ...(schema.uniqueBy === undefined ? {} : { [schema.uniqueBy]: `i${index}` }),
      }),
    )
  }
}

/** Every declared property of one schema, each carrying its deepest accepted value. */
function sampleProps(schema: PropsSchema): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).map(([name, field]) => [name, sampleField(field.schema)]))
}

describe('the deepest document the catalog declares as legal', () => {
  // The ceilings are measured off the catalog, and this is what that has to buy:
  // a component's own schema and the depth a spec is refused at cannot drift
  // apart, so a catalog entry declaring a deeper property fails here rather than
  // reaching a model as a spec refused for nesting it was invited to write.
  it.each(COMPONENT_CATALOG.map(entry => [entry.id, entry] as const))('accepts a fully populated %s', (id, entry) => {
    expect(validateComponentSpec({ nodes: [{ id: 'n1', component: id, props: sampleProps(entry.propsSchema) }] }))
      .toMatchObject({ ok: true })
  })
})

describe('the record detail', () => {
  /** One node drawing a record detail. */
  function record(props: Record<string, unknown>): Record<string, unknown> {
    return { id: 'n1', component: 'toy.record', props }
  }

  it('accepts rows, an optional label width, and an optional column count', () => {
    expect(validateComponentSpec({
      nodes: [record({
        dataList: [{ label: '编号', display: 'A-1' }, { label: '状态', display: '在用' }],
        labelWidth: 120,
        columnNum: 2,
      })],
    })).toMatchObject({ ok: true })
  })

  it('accepts two rows carrying the same label, because a row is not something the user points at', () => {
    expect(validateComponentSpec({
      nodes: [record({ dataList: [{ label: '附件', display: 'a.pdf' }, { label: '附件', display: 'b.pdf' }] })],
    })).toMatchObject({ ok: true })
  })

  it.each([
    ['no rows at all', { dataList: [] }, 'spec.nodes[0].props.dataList', /lists 0 items; between 1 and 60 are accepted/],
    ['more rows than a panel holds', { dataList: Array.from({ length: 61 }, (_unused, index) => ({ label: `l${index}`, display: 'v' })) }, 'spec.nodes[0].props.dataList', /lists 61 items; between 1 and 60 are accepted/],
    ['an oversized label', { dataList: [{ label: '编'.repeat(41), display: 'A-1' }] }, 'spec.nodes[0].props.dataList[0].label', /is 41 characters; at most 40 are accepted/],
    ['an oversized value', { dataList: [{ label: '编号', display: 'A'.repeat(401) }] }, 'spec.nodes[0].props.dataList[0].display', /is 401 characters; at most 400 are accepted/],
    ['a row with no value', { dataList: [{ label: '编号' }] }, 'spec.nodes[0].props.dataList[0].display', /is required/],
    ['a label width that is not a number', { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: '120' }, 'spec.nodes[0].props.labelWidth', /must be a number/],
    ['a label width no layout can carry', { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: Infinity }, 'spec.nodes[0].props.labelWidth', /must be a number/],
    ['a label width below the range', { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: 39 }, 'spec.nodes[0].props.labelWidth', /is 39; between 40 and 240 is accepted/],
    ['a label width above the range', { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: 241 }, 'spec.nodes[0].props.labelWidth', /is 241; between 40 and 240 is accepted/],
    ['a column count outside the set', { dataList: [{ label: '编号', display: 'A-1' }], columnNum: 4 }, 'spec.nodes[0].props.columnNum', /must be one of 1, 2, 3/],
    ['a column count that is not a number at all', { dataList: [{ label: '编号', display: 'A-1' }], columnNum: '2' }, 'spec.nodes[0].props.columnNum', /must be one of 1, 2, 3/],
    ['a column count that is no scalar', { dataList: [{ label: '编号', display: 'A-1' }], columnNum: true }, 'spec.nodes[0].props.columnNum', /must be one of 1, 2, 3/],
  ])('refuses %s', (_case, props, path, message) => {
    const failure = refusal(call({ nodes: [record(props)] }))
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
  })
})

describe('a property the schema has no way to express', () => {
  // The judgement the whole security argument rests on: a model reaching for a
  // formatter, a template, or a handler is not refused by a sanitizer that
  // recognized a function body — there is no property to write one into, so the
  // call ends at the undeclared-property rule and the refusal names the
  // parameter the model has to drop.
  it.each([
    ['el.confirm-bar', { formatter: 'function(row){ return row.name }', buttons: [{ id: 'ok', label: '确认' }] }, 'title, message, buttons'],
    ['toy.record', { formatter: 'function(row){ return row.name }', dataList: [{ label: '编号', display: 'A-1' }] }, 'dataList, labelWidth, columnNum'],
  ])('refuses a %s carrying a function body, naming the parameter', (component, props, accepted) => {
    const failure = refusal(call({ nodes: [{ id: 'n1', component, props }] }))
    expect(failure).toEqual({
      path: 'spec.nodes[0].props.formatter',
      text: `show_component: spec.nodes[0].props.formatter — is not accepted here. Accepted properties: ${accepted}.`,
    })
  })

  it('refuses a function body inside a row as well, naming the row', () => {
    const failure = refusal(call({
      nodes: [{ id: 'n1', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1', render: 'function(){}' }] } }],
    }))
    expect(failure.path).toBe('spec.nodes[0].props.dataList[0].render')
    expect(failure.text).toContain('Accepted properties: label, display.')
  })
})

describe('refusing a call', () => {
  it.each([
    ['a missing id', { title: '预算确认', spec: { nodes: [confirmBar()] } }, 'id', /must be a non-blank string/],
    ['a blank id', { id: '   ', title: '预算确认', spec: { nodes: [confirmBar()] } }, 'id', /must be a non-blank string/],
    ['an oversized id', { id: 'b'.repeat(MAX_ENTRY_ID_LENGTH + 1), title: '预算确认', spec: { nodes: [confirmBar()] } }, 'id', /is 65 characters; at most 64 are accepted/],
    ['an id outside the alphabet', { id: 'budget confirm', title: '预算确认', spec: { nodes: [confirmBar()] } }, 'id', /may use only letters, digits, underscores and hyphens/],
    ['a missing title', { id: 'budget', spec: { nodes: [confirmBar()] } }, 'title', /must be a non-blank string/],
    ['an oversized title', { id: 'budget', title: '算'.repeat(MAX_TITLE_LENGTH + 1), spec: { nodes: [confirmBar()] } }, 'title', /is 25 characters; at most 24 are accepted/],
  ])('refuses %s', (_case, args, path, message) => {
    const failure = refusal(args)
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
    expect(failure.text).toContain(path)
  })
})

describe('refusing a spec', () => {
  it('refuses a spec that is not an object', () => {
    expect(refusal(call([]))).toMatchObject({ path: 'spec' })
    expect(refusal(call('nodes')).text).toContain('must be an object carrying a nodes array')
  })

  it('refuses a spec nested deeper than the protocol accepts', () => {
    // Depth is measured before size, so a hostile document is walked at most
    // MAX_SPEC_DEPTH frames deep whatever else is wrong with it.
    const failure = refusal(call({ nodes: [confirmBar({ buttons: [{ id: 'ok', label: '确认', tone: { deeper: { deepest: 1 } } }] })] }))
    expect(failure.path).toBe('spec')
    expect(failure.text).toContain(`nests deeper than ${MAX_SPEC_DEPTH} levels`)
  })

  it('refuses a spec past the byte ceiling', () => {
    const failure = refusal(call({ nodes: ['x'.repeat(MAX_SPEC_BYTES + 1)] }))
    expect(failure.path).toBe('spec')
    expect(failure.text).toMatch(/is \d+ bytes of JSON; at most 65536 are accepted/)
  })

  it('refuses a property a spec does not carry', () => {
    expect(refusal(call({ nodes: [confirmBar()], layout: { node: 'stack' } })))
      .toEqual({ path: 'spec.layout', text: 'show_component: spec.layout — is not part of a spec. A spec carries nodes.' })
  })

  it.each([
    ['nodes that are not a list', { nodes: {} }, 'spec.nodes', /must be an array of nodes/],
    ['an empty node list', { nodes: [] }, 'spec.nodes', /lists 0 nodes; between 1 and 8 are accepted/],
    ['more nodes than the ceiling', { nodes: Array.from({ length: MAX_NODES + 1 }, (_unused, index) => ({ id: `n${index}`, component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } })) }, 'spec.nodes', /lists 9 nodes; between 1 and 8 are accepted/],
  ])('refuses %s', (_case, spec, path, message) => {
    const failure = refusal(call(spec))
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
  })
})

describe('refusing a node', () => {
  it('refuses a node that is not an object', () => {
    const failure = refusal(call({ nodes: ['el.confirm-bar'] }))
    expect(failure.path).toBe('spec.nodes[0]')
    expect(failure.text).toContain('must be an object with id, component and props')
  })

  it('refuses a property a node does not carry', () => {
    expect(refusal(call({ nodes: [{ ...confirmBar(), flex: 2 }] })))
      .toEqual({ path: 'spec.nodes[0].flex', text: 'show_component: spec.nodes[0].flex — is not part of a node. A node carries id, component, props.' })
  })

  it.each([
    ['a missing node id', { component: 'el.confirm-bar', props: { buttons: [{ id: 'ok', label: '确认' }] } }],
    ['a node id with a space in it', { ...confirmBar(), id: 'node one' }],
    ['an oversized node id', { ...confirmBar(), id: 'n'.repeat(33) }],
  ])('refuses %s', (_case, node) => {
    const failure = refusal(call({ nodes: [node] }))
    expect(failure.path).toBe('spec.nodes[0].id')
    expect(failure.text).toContain('at most 32 letters, digits, underscores and hyphens')
  })

  it('refuses a second node reusing the first one\'s id', () => {
    const failure = refusal(call({ nodes: [confirmBar(), confirmBar()] }))
    expect(failure.path).toBe('spec.nodes[1].id')
    expect(failure.text).toContain('repeats "n1"; every node in one call needs its own id')
  })

  it('hands the whole catalog back for a component this deployment does not have', () => {
    const failure = refusal(call({ nodes: [{ ...confirmBar(), component: 'toy.table' }] }))
    expect(failure.path).toBe('spec.nodes[0].component')
    // The whole list, not a count: a model that guessed wrong is told the same
    // catalog it was offered, so the next call needs no extra round trip.
    expect(failure.text).toBe(
      `show_component: spec.nodes[0].component — names no component of this deployment. Available components:\n${describeCatalog(COMPONENT_CATALOG)}`,
    )
  })
})

describe('refusing a component\'s properties', () => {
  it('refuses props that are not an object', () => {
    expect(refusal(call({ nodes: [{ ...confirmBar(), props: [] }] })))
      .toMatchObject({ path: 'spec.nodes[0].props' })
  })

  it('refuses a property the component does not declare', () => {
    expect(propsRefusal({ subtitle: '本月', buttons: [{ id: 'ok', label: '确认' }] }))
      .toEqual({
        path: 'spec.nodes[0].props.subtitle',
        text: 'show_component: spec.nodes[0].props.subtitle — is not accepted here. Accepted properties: title, message, buttons.',
      })
  })

  it('refuses a call missing a required property', () => {
    expect(propsRefusal({ title: '本月预算' }))
      .toEqual({ path: 'spec.nodes[0].props.buttons', text: 'show_component: spec.nodes[0].props.buttons — is required.' })
  })

  it.each([
    ['a non-string where a string is declared', { title: 42, buttons: [{ id: 'ok', label: '确认' }] }, 'spec.nodes[0].props.title', /must be a string/],
    ['an oversized string', { title: '预'.repeat(81), buttons: [{ id: 'ok', label: '确认' }] }, 'spec.nodes[0].props.title', /is 81 characters; at most 80 are accepted/],
    ['a list that is not a list', { buttons: {} }, 'spec.nodes[0].props.buttons', /must be an array/],
    ['an empty list', { buttons: [] }, 'spec.nodes[0].props.buttons', /lists 0 items; between 1 and 5 are accepted/],
    ['an oversized list', { buttons: Array.from({ length: 6 }, (_unused, index) => ({ id: `b${index}`, label: '确认' })) }, 'spec.nodes[0].props.buttons', /lists 6 items; between 1 and 5 are accepted/],
    ['an item that is not a record', { buttons: ['确认'] }, 'spec.nodes[0].props.buttons[0]', /must be an object/],
    ['a property an item does not declare', { buttons: [{ id: 'ok', label: '确认', icon: 'check' }] }, 'spec.nodes[0].props.buttons[0].icon', /Accepted properties: id, label, tone/],
    ['an item missing a required property', { buttons: [{ id: 'ok' }] }, 'spec.nodes[0].props.buttons[0].label', /is required/],
    ['a value outside the declared alphabet', { buttons: [{ id: 'ok!', label: '确认' }] }, 'spec.nodes[0].props.buttons[0].id', /may use only letters, digits, underscores and hyphens/],
    ['a value outside the declared set', { buttons: [{ id: 'ok', label: '确认', tone: 'warning' }] }, 'spec.nodes[0].props.buttons[0].tone', /must be one of "primary", "default", "danger"/],
    ['two items sharing an identity', { buttons: [{ id: 'ok', label: '确认' }, { id: 'ok', label: '再确认' }] }, 'spec.nodes[0].props.buttons[1].id', /repeats "ok"; every item in this list needs its own/],
  ])('refuses %s', (_case, props, path, message) => {
    const failure = propsRefusal(props)
    expect(failure.path).toBe(path)
    expect(failure.text).toMatch(message)
    expect(failure.text).toContain(path)
  })

  it('accepts a declared property whose value is missing but optional', () => {
    expect(validateComponentSpec({ nodes: [confirmBar({ buttons: [{ id: 'ok', label: '确认' }] })] }).ok).toBe(true)
  })

  it('accepts a null where a value is expected only as a refusal, never as a blank', () => {
    // `null` is a value, not an absence: it takes the declared property's own
    // type check rather than the required-property one.
    const failure = propsRefusal({ title: null, buttons: [{ id: 'ok', label: '确认' }] })
    expect(failure.path).toBe('spec.nodes[0].props.title')
    expect(failure.text).toContain('must be a string')
  })
})
