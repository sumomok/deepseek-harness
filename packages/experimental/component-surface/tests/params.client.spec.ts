/**
 * `{"$param": "<name>"}` — what a view file may write it as, where it may
 * stand, and what each refusal names.
 *
 * The cases are about the notation rather than about the catalog: what a
 * substituted spec is then judged by is the tool's own pass, which
 * `views.client.spec.ts` covers.
 */

import { describe, expect, it } from 'vitest'
import { applyViewParams } from '../src/params.ts'

/** The refusal of a result that must be one, so a case reads as one assertion. */
function refusal(spec: unknown, params: Record<string, unknown>): { path: string; reason: string } {
  const result = applyViewParams(spec, params)
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.spec)}`)
  return { path: result.failure.path, reason: result.failure.reason }
}

/** The substituted spec of a result that must be one. */
function substituted(spec: unknown, params: Record<string, unknown>): unknown {
  const result = applyViewParams(spec, params)
  if (!result.ok) throw new Error(result.failure.reason)
  return result.spec
}

describe('a view file\'s parameter references', () => {
  it('replaces a whole property value, however deep the property sits', () => {
    const spec = {
      nodes: [{ id: 'page', component: 'toy.data-page', props: { relatedMeta: { $param: 'meta' }, isInitQuery: { $param: 'open' } } }],
    }
    expect(substituted(spec, { meta: 'sys_layer', open: true })).toEqual({
      nodes: [{ id: 'page', component: 'toy.data-page', props: { relatedMeta: 'sys_layer', isInitQuery: true } }],
    })
  })

  it('carries a spec with no references through unchanged', () => {
    const spec = { nodes: [{ id: 'a', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }] } }] }
    expect(substituted(spec, {})).toEqual(spec)
  })

  it('leaves a $from binding exactly as written', () => {
    // The two notations never meet: one is settled before anything is drawn,
    // and the other stands for what a block currently reports, which no host
    // has.
    const spec = { nodes: [{ id: 'detail', props: { dataList: { $from: 'node:sites.selectionDetail' }, columnNum: { $param: 'columns' } } }] }
    expect(substituted(spec, { columns: 2 })).toEqual({
      nodes: [{ id: 'detail', props: { dataList: { $from: 'node:sites.selectionDetail' }, columnNum: 2 } }],
    })
  })

  it('refuses a name the view declares no param for, and lists the ones it does', () => {
    expect(refusal({ nodes: [{ props: { relatedMeta: { $param: 'table' } } }] }, { meta: 'sys_layer' })).toEqual({
      path: 'spec.nodes[0].props.relatedMeta',
      reason: 'names the parameter "table", which this view\'s params do not declare. Declared params: meta.',
    })
  })

  it('says so plainly where the view declares no params at all', () => {
    expect(refusal({ nodes: [{ props: { relatedMeta: { $param: 'meta' } } }] }, {}).reason)
      .toContain('This view declares no params.')
  })

  it('refuses a param whose value is not text, a number or a yes-or-no', () => {
    expect(refusal({ props: { columns: { $param: 'columns' } } }, { columns: ['a', 'b'] })).toEqual({
      path: 'spec.props.columns',
      reason: 'names the parameter "columns", whose value is object; a param is text, a number or a yes-or-no',
    })
    expect(refusal({ props: { columns: { $param: 'columns' } } }, { columns: null }).reason).toContain('whose value is null')
  })

  it('refuses a reference standing where one item of a list would', () => {
    // A list whose length depends on a parameter is a different document, not a
    // different value, which is the same reason a `$from` binding is refused
    // where it sits.
    expect(refusal({ nodes: [{ props: { buttons: [{ $param: 'ok' }] } }] }, { ok: '确认' })).toEqual({
      path: 'spec.nodes[0].props.buttons[0]',
      reason: 'is a "$param" reference, which stands for a whole property\'s value and not for one item of a list',
    })
  })

  it('accepts a reference inside an object that is itself a list item', () => {
    const spec = { nodes: [{ id: 'a', props: { dataList: [{ label: '表', display: { $param: 'meta' } }] } }] }
    expect(substituted(spec, { meta: 'sys_layer' })).toEqual({
      nodes: [{ id: 'a', props: { dataList: [{ label: '表', display: 'sys_layer' }] } }],
    })
  })

  it('refuses a reference written beside another key', () => {
    expect(refusal({ props: { relatedMeta: { $param: 'meta', fallback: 'x' } } }, { meta: 'm' })).toEqual({
      path: 'spec.props.relatedMeta',
      reason: 'carries "$param" beside "fallback"; a parameter reference is the whole value or nothing',
    })
  })

  it('refuses a reference naming no parameter', () => {
    expect(refusal({ props: { relatedMeta: { $param: 42 } } }, { meta: 'm' }).reason)
      .toBe('names no parameter: "$param" must be the name of one entry of this view\'s params')
    expect(refusal({ props: { relatedMeta: { $param: '' } } }, { meta: 'm' }).reason)
      .toContain('names no parameter')
  })

  it('names the first refusal and stops, wherever in the document it is', () => {
    expect(refusal({ nodes: [{ props: { a: 'fine' } }, { props: { b: { $param: 'nope' } } }] }, {}).path)
      .toBe('spec.nodes[1].props.b')
  })
})

describe('an alias in a view file', () => {
  /** The sentence an alias that refers back to a value containing it is refused in. */
  const CYCLE = 'is an alias of a mapping or list that contains it, so the value written here would contain itself without end'

  // Each value is built the way the YAML reader builds an anchor that one of
  // its own entries aliases: the alias is the very object that contains it.
  it('refuses a mapping that one of its own entries aliases, at that entry', () => {
    const layout: Record<string, unknown> = { node: 'stack', dir: 'row', children: [{ node: 'component', id: 'page' }] }
    layout['self'] = layout
    expect(refusal({ nodes: [], layout }, {})).toEqual({ path: 'spec.layout.self', reason: CYCLE })
  })

  it('refuses a list that one of its own items aliases, at that item', () => {
    const children: unknown[] = [{ node: 'component', id: 'page' }]
    children.push(children)
    expect(refusal({ nodes: [], layout: { node: 'stack', dir: 'row', children } }, {}))
      .toEqual({ path: 'spec.layout.children[1]', reason: CYCLE })
  })

  it('refuses an alias that refers back through more than one level', () => {
    const props: Record<string, unknown> = { relatedMeta: 'T' }
    props['regions'] = { infoCard: false, again: [props] }
    expect(refusal({ nodes: [{ id: 'page', props }] }, {}))
      .toEqual({ path: 'spec.nodes[0].props.regions.again[0]', reason: CYCLE })
  })

  it('substitutes a value aliased twice side by side once at each place', () => {
    // Two aliases of one anchor that neither contains: the document repeats a
    // value, and each copy is substituted like any other.
    const shared = { label: '表', display: { $param: 'meta' } }
    expect(substituted({ nodes: [{ props: { dataList: [shared, shared] } }] }, { meta: 'sys_layer' })).toEqual({
      nodes: [{ props: { dataList: [{ label: '表', display: 'sys_layer' }, { label: '表', display: 'sys_layer' }] } }],
    })
  })
})

describe('a key named __proto__ in a view file', () => {
  it('stays one more key of the mapping it is written in, with its value substituted like any other', () => {
    // A YAML or JSON reader hands the key over as an ordinary key, and the walk
    // keeps it one: rebuilt by assignment, the value under it would become the
    // mapping's prototype, and every property in it a value read without being
    // written.
    const spec: unknown = JSON.parse('{"nodes":[{"props":{"relatedMeta":"T","__proto__":{"readOnly":{"$param":"open"}}}}]}')
    const result = substituted(spec, { open: false })
    expect(JSON.stringify(result)).toBe('{"nodes":[{"props":{"relatedMeta":"T","__proto__":{"readOnly":false}}}]}')
    const props = (result as { readonly nodes: readonly { readonly props: object }[] }).nodes[0]?.props
    expect(props === undefined ? undefined : Object.getPrototypeOf(props)).toBe(Object.prototype)
  })
})
