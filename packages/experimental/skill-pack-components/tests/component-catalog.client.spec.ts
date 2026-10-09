/**
 * The component catalog file under `tests/expected/` is the file this tree
 * generates, and its header digests are the ones a reader recomputes from it.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPONENT_KIT_ENTRIES,
  DATA_PAGE_ID,
  DATA_PAGE_VIEW_PROP_NAMES,
  readCatalog,
  withheldComponents,
  type ComponentCatalogEntry,
} from '@deepseek-ai/dsh-experimental-component-surface'
import { validateComponentCall } from '@deepseek-ai/dsh-experimental-component-surface/src/validate.ts'
import { judgeView } from '@deepseek-ai/dsh-experimental-component-surface/src/views.ts'
import {
  PACK_MANIFEST_FIELDS,
  parsePackManifest,
  parsePackView,
  reconcilePacks,
  syncPackRoot,
  type DeliveredFile,
} from '@deepseek-ai/dsh-experimental-skill-pack'
import {
  COMPONENT_CATALOG_FORMAT,
  componentCatalogText,
  readCatalogPackage,
  readComponentCatalogVersions,
} from '../src/component-catalog.ts'

/** The checked-in file. */
const EXPECTED = new URL('./expected/component-catalog.json', import.meta.url)

/**
 * The component kit's own manifest, read by its place in the workspace rather
 * than through the package (whose types reach Vue 2's global JSX declarations
 * and so stay out of this typecheck program).
 */
const COMPONENT_KIT_MANIFEST = new URL('../../component-kit/package.json', import.meta.url)

/** One field of an object property, as the file states it. */
interface FieldFacts {
  readonly schema: { readonly kind: string; readonly fields?: Readonly<Record<string, FieldFacts>> }
}

/** One of a component's own properties, as the file states it. */
interface PropFacts extends FieldFacts {
  readonly viewOnly: boolean
  readonly unbindable: boolean
}

/** One component, as the file states it. */
interface ComponentFacts {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly placement: string
  readonly deploymentSwitches: readonly string[]
  readonly props: Readonly<Record<string, PropFacts>>
  readonly outputs: readonly { readonly id: string; readonly readers?: string }[]
  readonly actions: readonly { readonly id: string; readonly report: string }[]
  readonly sanitize?: Readonly<Record<string, string>>
}

/** The parts of the file these cases read. */
interface CatalogFile {
  readonly header: {
    readonly catalogFormat: number
    readonly componentKit: { readonly package: string; readonly version: string }
    readonly toyCrudKit: { readonly package: string; readonly version: string }
    readonly bodySha256: string
    readonly exampleViewSha256: string | null
  }
  readonly body: {
    readonly components: readonly ComponentFacts[]
    readonly rules: {
      readonly view: { readonly nodes: { readonly min: number; readonly max: number }; readonly rules: readonly string[] }
      readonly layout: {
        readonly root: string
        readonly children: { readonly min: number; readonly max: number }
        readonly flex: { readonly min: number; readonly max: number; readonly integer: boolean }
        readonly rules: readonly string[]
      }
      readonly binding: { readonly rules: readonly string[] }
      readonly param: { readonly rules: readonly string[] }
      readonly viewFile: { readonly otherKeys: string }
      readonly manifest: { readonly key: string; readonly otherKeys: string; readonly rules: readonly string[] }
    }
  }
}

/** Read and parse the checked-in file. */
async function checkedIn(): Promise<{ text: string; file: CatalogFile }> {
  const text = await readFile(EXPECTED, 'utf8')
  return { text, file: JSON.parse(text) as CatalogFile }
}

/** Every component the kit registers, as a deployment offering all of them judges a call against. */
const catalog = readCatalog(COMPONENT_KIT_ENTRIES)

/**
 * Per key a catalog entry may carry, a check that the file's component states
 * what the entry carries under it. Typed over the entry, so a key added to
 * `ComponentCatalogEntry` fails the typecheck here until a check for it is
 * written.
 */
const ENTRY_CHECKS: Readonly<Record<keyof ComponentCatalogEntry, (entry: ComponentCatalogEntry, component: ComponentFacts) => void>> = {
  id: (entry, component) => {
    expect(component.id).toBe(entry.id)
  },
  label: (entry, component) => {
    expect(component.label).toBe(entry.label)
  },
  purpose: (entry, component) => {
    expect(component.purpose).toBe(entry.purpose)
  },
  propsSchema: (entry, component) => {
    expect(Object.keys(component.props)).toEqual(Object.keys(entry.propsSchema))
  },
  placement: (entry, component) => {
    expect(component.placement).toBe(entry.placement ?? 'call')
  },
  outputs: (entry, component) => {
    expect(component.outputs.map(output => [output.id, output.readers])).toEqual(entry.outputs.map(output => [output.id, output.readers]))
  },
  actions: (entry, component) => {
    expect(component.actions).toEqual(entry.actions.map(action => ({ id: action.id, report: action.report })))
  },
  sanitize: (entry, component) => {
    if (entry.sanitize === undefined) expect(component).not.toHaveProperty('sanitize')
    else expect(component.sanitize).toEqual(entry.sanitize)
  },
}

/** A node every catalog built from the kit accepts on its own. */
const METRIC = { id: 'a', component: 'el.metric', props: { process: 50 } }

/** A table every catalog built from the kit accepts on its own, which reports `selectionDetail`. */
const TABLE = { id: 't', component: 'toy.table', props: { tableConfig: { gridItems: [{ relatedMetaAttr: 'a' }] }, displayValueList: [{ a: 1 }] } }

/**
 * A record, node `r`, whose `dataList` is the given value.
 * @param dataList - the value, a `$from` reference or a list.
 * @returns the node.
 */
function record(dataList: unknown): unknown {
  return { id: 'r', component: 'toy.record', props: { dataList } }
}

/**
 * A data page with the given properties beside the two it requires.
 * @param id - the node id, or a reference standing for it.
 * @param extra - the other properties.
 * @returns the node.
 */
function dataPage(id: unknown, extra: Readonly<Record<string, unknown>> = {}): unknown {
  return { id, component: DATA_PAGE_ID, props: { relatedMeta: 'orders', metaLabel: '订单', ...extra } }
}

/**
 * A layout of one column placing the given children.
 * @param children - the stack's children.
 * @returns the layout.
 */
function column(children: readonly unknown[]): unknown {
  return { node: 'stack', dir: 'col', children }
}

/**
 * Judge one spec the way a call is judged.
 * @param spec - the spec.
 * @returns the refusal's path, or `undefined` where the spec is accepted.
 */
function refusedAt(spec: unknown): string | undefined {
  const result = validateComponentCall(catalog, { id: 'v', title: 't', spec })
  return result.ok ? undefined : result.failure.path
}

/**
 * Judge one view the way a pack view is judged, on a deployment offering the data page.
 * @param spec - the spec as the view file writes it.
 * @param params - the view file's params.
 * @returns the refusal's path, or `undefined` where the view is accepted.
 */
function viewRefusedAt(spec: unknown, params: Readonly<Record<string, unknown>> = {}): string | undefined {
  const result = judgeView(catalog, true, { id: 'v', title: 't', spec, params })
  return result.ok ? undefined : result.refusal.path
}

/** Where a pack's one view file sits. */
const VIEW_PATH = 'views/v.yml'

/** A view file the pack root reads. */
const VIEW_TEXT = 'id: v\ntitle: V\nspec: []\n'

/** One pack's format fields, and what a pack root and a delivery hold against it. */
interface FormatCase {
  /** The format fields `metadata.pack` states beside its version. */
  readonly pack: Readonly<Record<string, number>>
  /** Whether the pack lists a view. */
  readonly views: boolean
  /** The unmet requirement the pack is withheld for; absent where nothing withholds it. */
  readonly refused?: 'view-format' | 'anchor-format'
}

/**
 * The files of pack `p`, its manifest written as the given metadata.
 * @param metadata - the `metadata` its `SKILL.md` frontmatter carries.
 * @param views - whether it carries the view file at {@link VIEW_PATH}.
 * @returns the files.
 */
function packFiles(metadata: Readonly<Record<string, unknown>>, views: boolean): DeliveredFile[] {
  const skill = ['---', 'name: p', 'description: d', `metadata: ${JSON.stringify(metadata)}`, '---', 'Body.'].join('\n')
  return [{ path: 'SKILL.md', content: skill }, ...views ? [{ path: VIEW_PATH, content: VIEW_TEXT }] : []]
}

let world: string | undefined

afterEach(async () => {
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

describe('the component catalog file', () => {
  it('is byte for byte what generating it from this tree writes', async () => {
    const { text } = await checkedIn()
    expect(componentCatalogText(readComponentCatalogVersions())).toBe(text)
    expect(text.endsWith('}\n')).toBe(true)
  })

  it('carries the SHA-256 of its compact body in its header, and no example view yet', async () => {
    const { file } = await checkedIn()
    expect(file.header.catalogFormat).toBe(COMPONENT_CATALOG_FORMAT)
    expect(file.header.bodySha256).toBe(createHash('sha256').update(JSON.stringify(file.body), 'utf8').digest('hex'))
    expect(file.header.exampleViewSha256).toBeNull()
  })

  it('states the component kit version its own manifest states, and the kit version it vendors', async () => {
    const { file } = await checkedIn()
    const manifest = JSON.parse(await readFile(COMPONENT_KIT_MANIFEST, 'utf8')) as {
      name: string
      version: string
      dependencies: Record<string, string>
    }
    expect(file.header.componentKit).toEqual({ package: manifest.name, version: manifest.version })
    expect(manifest.dependencies['@sumomok/toy-crud-kit'])
      .toBe(`file:./vendor/sumomok-toy-crud-kit-${file.header.toyCrudKit.version}.tgz`)
    expect(file.header.toyCrudKit.package).toBe('@sumomok/toy-crud-kit')
  })

  it('states every key of each catalog entry as the entry carries it', async () => {
    const { file } = await checkedIn()
    const unchecked = COMPONENT_KIT_ENTRIES.flatMap(entry =>
      Object.keys(entry).filter(key => !Object.hasOwn(ENTRY_CHECKS, key)).map(key => `${entry.id}.${key}`))
    expect(unchecked).toEqual([])
    expect(file.body.components.map(component => component.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    file.body.components.forEach((component, index) => {
      const entry = COMPONENT_KIT_ENTRIES[index]
      if (entry === undefined) return
      for (const check of Object.values(ENTRY_CHECKS)) check(entry, component)
    })
  })

  it('lists every component the kit registers, in registration order, each placed by a call', async () => {
    const { file } = await checkedIn()
    expect(file.body.components.map(component => component.id)).toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(new Set(file.body.components.map(component => component.placement))).toEqual(new Set(['call']))
  })

  it('states which outputs only a component a view places reads', async () => {
    const { file } = await checkedIn()
    const outputs = new Map(file.body.components.map(component => [component.id, component.outputs]))
    expect(outputs.get(DATA_PAGE_ID)?.map(output => [output.id, output.readers])).toEqual([['opened', 'view'], ['editing', 'view']])
    expect(outputs.get('toy.table')?.every(output => output.readers === undefined)).toBe(true)
  })

  it('names dataPage as the switch the data page needs, and no switch for a component every composition offers', async () => {
    const { file } = await checkedIn()
    const switches = new Map(file.body.components.map(component => [component.id, component.deploymentSwitches]))
    expect(switches.get('toy.data-page')).toEqual(['dataPage'])
    const withheld = withheldComponents({ dataPage: false, dataSource: false, defaultPageSize: 1, dataPageLoadTimeoutMs: 1 })
    expect(withheld).toContain('toy.data-page')
    for (const entry of COMPONENT_KIT_ENTRIES.filter(one => !withheld.includes(one.id))) {
      expect(switches.get(entry.id)).toEqual([])
    }
  })

  it('marks the data page\'s arrangement as set only in a view file', async () => {
    const { file } = await checkedIn()
    const page = file.body.components.find(component => component.id === 'toy.data-page')
    expect(Object.entries(page?.props ?? {}).filter(([, prop]) => prop.viewOnly).map(([name]) => name).sort())
      .toEqual([...DATA_PAGE_VIEW_PROP_NAMES].sort())
  })

  it('marks a property unbindable exactly where the component surface refuses a $from on it as unbindable', async () => {
    const { file } = await checkedIn()
    const mismatches: string[] = []
    for (const component of file.body.components) {
      for (const [name, prop] of Object.entries(component.props)) {
        const props = { [name]: { $from: 'node:b.x' } }
        const result = validateComponentCall(catalog, { id: 'v', title: 't', spec: { nodes: [{ id: 'a', component: component.id, props }] } })
        const refused = !result.ok
          && result.failure.path === `spec.nodes[0].props.${name}`
          && result.failure.text.includes('cannot be read from another block')
        if (refused !== prop.unbindable) mismatches.push(`${component.id}.${name}`)
      }
    }
    expect(mismatches).toEqual([])
    const unbindable = (id: string, name: string): boolean | undefined =>
      file.body.components.find(component => component.id === id)?.props[name]?.unbindable
    expect(unbindable('toy.table', 'tableConfig')).toBe(true)
    expect(unbindable('el.metric', 'background')).toBe(true)
  })

  it('states viewOnly and unbindable on a component\'s own properties and not on the fields of an object property', async () => {
    const { file } = await checkedIn()
    const nested = file.body.components.flatMap(component => Object.values(component.props))
      .flatMap(prop => Object.values(prop.schema.fields ?? {}))
    expect(nested.length).toBeGreaterThan(0)
    for (const field of nested) {
      expect(field).not.toHaveProperty('viewOnly')
      expect(field).not.toHaveProperty('unbindable')
    }
  })

  it('writes out the lower bounds and the root kind the component surface judges a spec by', async () => {
    const { file } = await checkedIn()
    const { nodes } = file.body.rules.view
    const { root, children, flex } = file.body.rules.layout
    const nodeList = (count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ ...METRIC, id: `n${index}` }))
    expect(refusedAt({ nodes: nodeList(nodes.min) })).toBeUndefined()
    expect(refusedAt({ nodes: nodeList(nodes.min - 1) })).toBe('spec.nodes')
    expect(refusedAt({ nodes: nodeList(nodes.max + 1) })).toBe('spec.nodes')
    const block = { node: 'component', id: 'a' }
    expect(refusedAt({ nodes: [METRIC], layout: column(Array.from({ length: children.min }, () => block)) })).toBeUndefined()
    expect(refusedAt({ nodes: [METRIC], layout: column(Array.from({ length: children.min - 1 }, () => block)) }))
      .toBe('spec.layout.children')
    expect(refusedAt({ nodes: [METRIC], layout: column(Array.from({ length: children.max + 1 }, () => block)) }))
      .toBe('spec.layout.children')
    const placed = (share: number): unknown => ({
      nodes: [METRIC],
      layout: { node: root, dir: 'row', children: [{ node: 'component', id: 'a', flex: share }] },
    })
    expect(refusedAt(placed(flex.min))).toBeUndefined()
    expect(refusedAt(placed(flex.max))).toBeUndefined()
    expect(refusedAt(placed(flex.min - 1))).toBe('spec.layout.children[0].flex')
    expect(flex.integer).toBe(true)
    expect(refusedAt(placed(flex.min + 0.5))).toBe('spec.layout.children[0].flex')
    expect(refusedAt({ nodes: [METRIC], layout: { node: 'component', id: 'a' } })).toBe('spec.layout.node')
  })

  it('states the view rules the component surface judges a spec, its nodes and its data page by', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.view.rules).toEqual([
      'A spec carries nodes and may leave out layout; a spec without a layout stacks its blocks in one column, in the order nodes lists them.',
      'Every node carries id, component and props, and props is an object. No two nodes of a view share an id.',
      'A view places at most one toy.data-page block; a second one is refused.',
      'The querySort of a toy.data-page block names at most one of asc and desc.',
      'No mapping anywhere in a spec, a table row included, carries a key named __proto__; a view writing one is refused at that key '
      + 'before anything else in it is judged.',
      'An alias written inside the mapping or list its anchor names is refused at that alias; an anchor aliased at two places, '
      + 'neither inside the other, is judged at each.',
    ])
    expect(refusedAt({ nodes: [METRIC] })).toBeUndefined()
    expect(refusedAt({ layout: column([{ node: 'component', id: 'a' }]) })).toBe('spec.nodes')
    expect(refusedAt({ nodes: [{ component: 'el.metric', props: { process: 50 } }] })).toBe('spec.nodes[0].id')
    expect(refusedAt({ nodes: [{ id: 'a', props: { process: 50 } }] })).toBe('spec.nodes[0].component')
    expect(refusedAt({ nodes: [{ id: 'a', component: 'el.metric' }] })).toBe('spec.nodes[0].props')
    expect(refusedAt({ nodes: [{ ...METRIC, props: [] }] })).toBe('spec.nodes[0].props')
    expect(refusedAt({ nodes: [METRIC, METRIC] })).toBe('spec.nodes[1].id')
    expect(viewRefusedAt({ nodes: [dataPage('p'), METRIC] })).toBeUndefined()
    expect(viewRefusedAt({ nodes: [dataPage('p'), dataPage('q')] })).toBe('spec.nodes[1]')
    for (const querySort of [{}, { asc: 'a' }, { desc: 'a' }]) {
      expect(viewRefusedAt({ nodes: [dataPage('p', { querySort })] })).toBeUndefined()
    }
    expect(viewRefusedAt({ nodes: [dataPage('p', { querySort: { asc: 'a', desc: 'b' } })] })).toBe('spec.nodes[0].props.querySort.desc')
    expect(viewRefusedAt(JSON.parse('{"nodes":[{"id":"t","component":"toy.table","props":{"tableConfig":{"gridItems":[{"relatedMetaAttr":"a"}]},'
      + '"displayValueList":[{"a":1,"__proto__":2}]}}]}'))).toBe('spec.nodes[0].props.displayValueList[0].__proto__')
    const looped: Record<string, unknown> = { node: 'stack', dir: 'col', children: [{ node: 'component', id: 'a' }] }
    looped['self'] = looped
    expect(viewRefusedAt({ nodes: [METRIC], layout: looped })).toBe('spec.layout.self')
    const shared = { label: 'x', display: 'y' }
    expect(viewRefusedAt({ nodes: [{ id: 'r', component: 'toy.record', props: { dataList: [shared, shared] } }] })).toBeUndefined()
  })

  it('states the layout rules the component surface judges a stack, a placed block and the placement by', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.layout.rules).toEqual([
      'A stack carries node "stack", dir and children, and may leave out gap, wrap and flex; the outermost stack carries no flex.',
      'A placed block carries node "component" and the id of a node, and may leave out flex.',
      'A layout places every node of nodes exactly once; a node it leaves out, or places twice, is refused.',
    ])
    const placing = (layout: unknown, nodes: readonly unknown[] = [METRIC]): string | undefined => refusedAt({ nodes, layout })
    const block = { node: 'component', id: 'a' }
    expect(placing(column([block]))).toBeUndefined()
    expect(placing({ node: 'stack', children: [block] })).toBe('spec.layout.dir')
    expect(placing({ node: 'stack', dir: 'col' })).toBe('spec.layout.children')
    expect(placing({ node: 'stack', dir: 'col', flex: 1, children: [block] })).toBe('spec.layout.flex')
    expect(placing(column([{ node: 'stack', dir: 'row', gap: 'sm', wrap: true, flex: 1, children: [block] }]))).toBeUndefined()
    expect(placing(column([{ node: 'component' }]))).toBe('spec.layout.children[0].id')
    expect(placing(column([{ node: 'block', id: 'a' }]))).toBe('spec.layout.children[0].node')
    expect(placing(column([block]), [METRIC, { ...METRIC, id: 'b' }])).toBe('spec.nodes[1].id')
    expect(placing(column([block, block]))).toBe('spec.layout.children[1].id')
  })

  it('states the binding rules the component surface judges a $from by', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.binding.rules).toEqual([
      'A bound property is an object whose only key is $from, written as the whole value of the property; one inside a list item or a nested object is refused.',
      'The node is another node of the same view, the output is one that node\'s component declares, and an index takes one item of a list output.',
      'A property whose unbindable is true cannot be bound, and a bound property must accept the output\'s shape: the same kind, and nothing past its limits.',
      'An output whose readers is view is read only by a property of a component whose placement is view; no property of a component a call places accepts it.',
      'The value is resolved in the page from what the other block reports; the view file carries only the reference.',
    ])
    expect(refusedAt({ nodes: [dataPage('p'), record({ $from: 'node:p.opened' })] })).toBe('spec.nodes[1].props.dataList.$from')
    const beside = (node: unknown): string | undefined => refusedAt({ nodes: [TABLE, node] })
    const bound = (from: unknown): string | undefined => beside(record(from))
    expect(bound({ $from: 'node:t.selectionDetail' })).toBeUndefined()
    expect(bound({ $from: 'node:t.selectionDetail', note: 'x' })).toBe('spec.nodes[1].props.dataList.$from')
    expect(bound([{ $from: 'node:t.selectionDetail[0]' }])).toBe('spec.nodes[1].props.dataList[0].$from')
    const filter = { id: 'f', component: 'el.filter-bar', props: { relatedMeta: 'a', metaConfig: { attributes: { $from: 'node:t.selectionDetail' } } } }
    expect(beside(filter)).toBe('spec.nodes[1].props.metaConfig.attributes.$from')
    expect(refusedAt({ nodes: [record({ $from: 'node:r.selectionDetail' })] })).toBe('spec.nodes[0].props.dataList.$from')
    expect(bound({ $from: 'node:x.selectionDetail' })).toBe('spec.nodes[1].props.dataList.$from')
    expect(bound({ $from: 'node:t.nope' })).toBe('spec.nodes[1].props.dataList.$from')
    expect(bound({ $from: 'node:t.selectionDetail[0]' })).toBe('spec.nodes[1].props.dataList.$from')
    const metric = (props: Readonly<Record<string, unknown>>): unknown => ({ id: 'm', component: 'el.metric', props: { process: 1, ...props } })
    expect(beside(metric({ text: { $from: 'node:t.selectionDetail' } }))).toBe('spec.nodes[1].props.text.$from')
    expect(beside(metric({ background: { $from: 'node:t.selectionDetail' } }))).toBe('spec.nodes[1].props.background')
    const judged = judgeView(catalog, true, { id: 'v', title: 't', spec: { nodes: [TABLE, record({ $from: 'node:t.selectionDetail' })] } })
    expect(judged.ok && judged.call.spec.nodes[1]?.props).toEqual({ dataList: { $from: 'node:t.selectionDetail' } })
  })

  it('states the param rules a view is judged with its params by', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.param.rules).toEqual([
      'A parameter reference is an object whose only key is $param. It may stand for any value in the spec except one item of a list, which is refused.',
      'It names one entry of the view file\'s params, and that entry is text, a number, true or false.',
      'It is replaced when the view is read, before the view is judged; $from references are left as written.',
    ])
    const params = { table: 'orders', node: 'p', column: 'name' }
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'table' } })] }, params)).toBeUndefined()
    expect(viewRefusedAt({ nodes: [dataPage({ $param: 'node' })] }, params)).toBeUndefined()
    expect(viewRefusedAt({ nodes: [dataPage('p', { querySort: { asc: { $param: 'column' } } })] }, params)).toBeUndefined()
    expect(viewRefusedAt({ nodes: [{ $param: 'node' }] }, params)).toBe('spec.nodes[0]')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'table', note: 'x' } })] }, params))
      .toBe('spec.nodes[0].props.relatedMeta')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'other' } })] }, params)).toBe('spec.nodes[0].props.relatedMeta')
    expect(viewRefusedAt({ nodes: [dataPage('p', { relatedMeta: { $param: 'table' } })] }, { table: { name: 'orders' } }))
      .toBe('spec.nodes[0].props.relatedMeta')
    const judged = judgeView(catalog, true, {
      id: 'v',
      title: 't',
      spec: { nodes: [TABLE, record({ $from: 'node:t.selectionDetail' }), dataPage('p', { relatedMeta: { $param: 'table' } })] },
      params,
    })
    expect(judged.ok && judged.call.spec.nodes.map(node => node.props['dataList'] ?? node.props['relatedMeta']))
      .toEqual([undefined, { $from: 'node:t.selectionDetail' }, 'orders'])
  })

  it('states the manifest key, the conditions on the two format fields, and what a delivery and the pack root do with a pack breaking one', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.manifest.rules).toEqual([
      'pack.viewFormat is required when views lists any file, and is one of viewFormats. A .dshpack delivery carrying a pack that lists views without it, or with another format, is refused whole; an organization set refuses that pack alone; a pack root withholds such a pack it already holds.',
      'pack.anchorFormat may be left out; when stated, it is one of anchorFormats. A .dshpack delivery carrying a pack that states another format is refused whole; an organization set refuses that pack alone; a pack root withholds such a pack it already holds.',
    ])
    expect(parsePackManifest({ pack: { version: '1.0.0' }, notes: 'x' }))
      .toMatchObject({ ok: false, field: `${file.body.rules.manifest.key}.notes` })
    expect(PACK_MANIFEST_FIELDS.map(field => field.path)).toEqual(expect.arrayContaining(['pack.viewFormat', 'pack.anchorFormat', 'views']))
    const base = await mkdtemp(join(tmpdir(), 'dsh-skill-pack-components-catalog-'))
    world = base
    const cases: readonly FormatCase[] = [
      { pack: {}, views: false },
      { pack: {}, views: true, refused: 'view-format' },
      { pack: { viewFormat: 1 }, views: true },
      { pack: { viewFormat: 2 }, views: true, refused: 'view-format' },
      { pack: { anchorFormat: 1 }, views: false },
      { pack: { anchorFormat: 2 }, views: false, refused: 'anchor-format' },
    ]
    for (const [index, one] of cases.entries()) {
      const metadata = { pack: { version: '1.0.0', ...one.pack }, ...one.views ? { views: [VIEW_PATH] } : {} }
      const [status] = reconcilePacks([{
        skill: 'p',
        manifest: parsePackManifest(metadata),
        views: one.views ? [parsePackView(VIEW_PATH, VIEW_TEXT)] : [],
      }], [], '0.5.2')
      expect(status?.state).toBe(one.refused === undefined ? 'active' : 'inactive')
      expect(status?.missing.map(missing => missing.kind)).toEqual(one.refused === undefined ? [] : [one.refused])
      const root = join(base, `packs-${String(index)}`)
      const delivery = syncPackRoot(root, { kind: 'packs', packs: [{ name: 'p', files: packFiles(metadata, one.views) }] })
      if (one.refused === undefined) {
        await expect(delivery).resolves.toMatchObject({ changed: true, packs: ['p'] })
      } else {
        await expect(delivery).rejects.toMatchObject({ refusal: `pack-${one.refused}`, entry: 'p/SKILL.md' })
        await expect(stat(root)).rejects.toThrow('ENOENT')
      }
    }
  })

  it('says what the pack root does with a key it does not read, as the pack root does it', async () => {
    const { file } = await checkedIn()
    expect(file.body.rules.viewFile.otherKeys).toBe('ignored')
    expect(parsePackView('v.yml', 'id: a\ntitle: A\nspec: []\nnotes: x\n')).toMatchObject({ ok: true })
    expect(file.body.rules.manifest.otherKeys).toBe('refused')
    expect(parsePackManifest({ pack: { version: '1.0.0' }, notes: 'x' })).toMatchObject({ ok: false, field: 'metadata.notes' })
  })
})

describe('reading a package version for the header', () => {
  it('reads the name and version a manifest states', () => {
    expect(readCatalogPackage({ name: 'a', version: '1.2.3' }, 'a')).toEqual({ package: 'a', version: '1.2.3' })
  })

  it('refuses a manifest naming another package, or carrying no version', () => {
    expect(() => readCatalogPackage({ name: 'b', version: '1.2.3' }, 'a'))
      .toThrow('skill-pack-components: the package.json read for a names "b"')
    expect(() => readCatalogPackage(null, 'a')).toThrow('skill-pack-components: the package.json read for a names undefined')
    expect(() => readCatalogPackage({ name: 'a' }, 'a')).toThrow('skill-pack-components: the package.json of a carries no version')
    expect(() => readCatalogPackage({ name: 'a', version: '' }, 'a')).toThrow('skill-pack-components: the package.json of a carries no version')
  })
})
